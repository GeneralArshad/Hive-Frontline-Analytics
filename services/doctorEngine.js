'use strict';

const db   = require('./db');
const hive = require('./hiveClient');

// ── State normalization ────────────────────────────────────────────────────────
const STATE_MAP = {
  'MH': 'Maharashtra', 'maharastra': 'Maharashtra', 'MAHARASHTRA': 'Maharashtra',
  'TN': 'Tamil Nadu',  'tamilnadu': 'Tamil Nadu',   'TAMILNADU': 'Tamil Nadu',
  'Tamilnadu': 'Tamil Nadu', 'tamil nadu': 'Tamil Nadu',
  'KA': 'Karnataka',   'karnataka': 'Karnataka',    'KARNATAKA': 'Karnataka',
  'KL': 'Kerala',      'kerala': 'Kerala',           'KERALA': 'Kerala',
  'AP': 'Andhra Pradesh', 'andhra pradesh': 'Andhra Pradesh',
  'TS': 'Telangana',   'telangana': 'Telangana',
  'DL': 'Delhi',       'delhi': 'Delhi',
  'GJ': 'Gujarat',     'gujarat': 'Gujarat',
  'RJ': 'Rajasthan',   'rajasthan': 'Rajasthan',
  'UP': 'Uttar Pradesh', 'uttar pradesh': 'Uttar Pradesh',
  'MP': 'Madhya Pradesh', 'madhya pradesh': 'Madhya Pradesh',
  'PB': 'Punjab',      'HR': 'Haryana',
  'WB': 'West Bengal', 'west bengal': 'West Bengal',
  'OR': 'Odisha',      'odisha': 'Odisha',
  'BR': 'Bihar',       'CG': 'Chhattisgarh',
  'JK': 'Jammu & Kashmir', 'HP': 'Himachal Pradesh',
  'PY': 'Puducherry',  'pondicherry': 'Puducherry',
};

function normalizeState(raw) {
  if (!raw) return 'Unknown';
  const s = raw.trim();
  if (STATE_MAP[s]) return STATE_MAP[s];
  // Title-case fallback
  return s.replace(/\b\w/g, c => c.toUpperCase())
          .replace(/\b(And|Of|In|The)\b/g, w => w.toLowerCase());
}

function normalizeStr(raw, sep = ', ') {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.filter(Boolean).join(sep) || null;
  return String(raw);
}

function parseDoctor(d) {
  const code = d.doctorCode ?? d.code ?? String(d._id);
  return {
    doctor_code:          code,
    hive_id:              String(d._id),
    full_name:            d.fullName ?? `${d.firstName||''} ${d.lastName||''}`.trim() || 'Unknown',
    specialization:       normalizeStr(d.specialization),
    qualification:        normalizeStr(d.qualification),
    category:             d.category ?? null,
    approval_status:      (d.approvalStatus ?? 'UNKNOWN').toUpperCase(),
    status:               (d.status ?? 'UNKNOWN').toUpperCase(),
    doctor_type:          d.doctorType ?? null,
    practice_type:        d.practiceSetupType ?? null,
    clinic_name:          d.clinicName ?? null,
    city:                 d.address?.city ?? null,
    state:                normalizeState(d.address?.state),
    pincode:              d.address?.pincode ?? null,
    gender:               d.gender ?? null,
    avg_patients_per_day: parseInt(d.avgPatientsPerDay) || 0,
    total_visits:         parseInt(d.totalVisits) || 0,
    rep_count:            1,
  };
}

// ── Computation state ─────────────────────────────────────────────────────────
const state = {
  running:   false,
  progress:  0,
  total:     0,
  startedAt: null,
  error:     null,
};

function getState() { return { ...state }; }

async function computeStats() {
  if (state.running) return { alreadyRunning: true };
  state.running = true; state.progress = 0; state.total = 0;
  state.error = null; state.startedAt = new Date();
  _doCompute().catch(err => { state.error = err.message; state.running = false; });
  return { started: true };
}

async function _doCompute() {
  const { rows: emps } = await db.pool.query(
    'SELECT ec, hive_id FROM employees WHERE hive_id IS NOT NULL'
  );
  state.total = emps.length;

  // Collect all unique doctors
  const uniqueMap = new Map();   // doctorCode → parsed doctor
  const repCount  = new Map();   // doctorCode → # reps who cover them
  let totalAssignments = 0;
  const BATCH = 20;

  for (let i = 0; i < emps.length; i += BATCH) {
    const batch = emps.slice(i, i + BATCH);
    await Promise.all(batch.map(async emp => {
      const doctors = await hive.fetchAllEmployeeDoctors(emp.hive_id);
      totalAssignments += doctors.length;
      doctors.forEach(d => {
        const code = d.doctorCode ?? d.code ?? String(d._id);
        if (!code) return;
        repCount.set(code, (repCount.get(code) || 0) + 1);
        if (!uniqueMap.has(code)) uniqueMap.set(code, parseDoctor(d));
      });
    }));
    state.progress = Math.min(i + BATCH, emps.length);
  }

  // Apply rep counts
  repCount.forEach((count, code) => {
    if (uniqueMap.has(code)) uniqueMap.get(code).rep_count = count;
  });

  // Persist to DB (clear then batch upsert)
  await db.clearDoctors();
  const all = [...uniqueMap.values()];
  const DBATCH = 100;
  for (let i = 0; i < all.length; i += DBATCH) {
    await Promise.all(all.slice(i, i + DBATCH).map(d => db.upsertDoctor(d)));
  }

  // Aggregate stats from normalized data
  const byCategory = {}, byApproval = {}, bySpec = {}, byPType = {}, byState = {}, byGender = {}, byQual = {};

  for (const d of all) {
    const inc = (obj, key) => { if (key) obj[key] = (obj[key] || 0) + 1; };
    inc(byCategory, d.category || 'unknown');
    inc(byApproval, d.approval_status);
    inc(byPType,    d.practice_type || 'unknown');
    inc(byState,    d.state);
    inc(byGender,   d.gender || 'unknown');
    // Specialization & qualification can be comma-separated strings
    (d.specialization || '').split(',').forEach(s => inc(bySpec, s.trim()));
    (d.qualification  || '').split(',').forEach(q => inc(byQual, q.trim()));
  }

  const stats = {
    uniqueDoctors: all.length,
    totalAssignments,
    overlap: totalAssignments - all.length,
    byCategory:        sortDesc(byCategory),
    byApprovalStatus:  sortDesc(byApproval),
    bySpecialization:  sortDesc(bySpec),
    byPracticeType:    sortDesc(byPType),
    byState:           sortDesc(byState),
    byGender:          sortDesc(byGender),
    byQualification:   sortDesc(byQual),
  };

  await db.storeDoctorStats(stats);
  state.running = false;
  state.progress = emps.length;
  console.log(`[doctors] Done — ${all.length} unique, ${totalAssignments} assignments`);
}

function sortDesc(obj) {
  return Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));
}

module.exports = { computeStats, getState };

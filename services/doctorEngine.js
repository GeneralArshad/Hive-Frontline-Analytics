'use strict';

const db   = require('./db');
const hive = require('./hiveClient');

// ── In-memory computation state ───────────────────────────────────────────────
const state = {
  running:   false,
  progress:  0,
  total:     0,
  startedAt: null,
  error:     null,
};

function getState() { return { ...state }; }

// ── Background computation ────────────────────────────────────────────────────
async function computeStats() {
  if (state.running) return { alreadyRunning: true };

  state.running   = true;
  state.progress  = 0;
  state.total     = 0;
  state.error     = null;
  state.startedAt = new Date();

  _doCompute().catch(err => {
    state.error   = err.message;
    state.running = false;
    console.error('[doctors] Fatal:', err.message);
  });

  return { started: true };
}

async function _doCompute() {
  const { rows: emps } = await db.pool.query(
    'SELECT ec, hive_id FROM employees WHERE hive_id IS NOT NULL'
  );
  state.total = emps.length;

  const uniqueMap      = new Map();   // doctorCode → doctor object
  let totalAssignments = 0;
  const BATCH = 20;

  for (let i = 0; i < emps.length; i += BATCH) {
    const batch = emps.slice(i, i + BATCH);
    await Promise.all(batch.map(async emp => {
      const doctors = await hive.fetchAllEmployeeDoctors(emp.hive_id);
      totalAssignments += doctors.length;
      doctors.forEach(d => {
        const code = d.doctorCode ?? d.code ?? d._id;
        if (code && !uniqueMap.has(String(code))) uniqueMap.set(String(code), d);
      });
    }));
    state.progress = Math.min(i + BATCH, emps.length);
  }

  // ── Aggregate ────────────────────────────────────────────────────────────────
  const byCategory      = {};
  const byApproval      = {};
  const bySpecialization= {};
  const byPracticeType  = {};
  const byState         = {};

  for (const d of uniqueMap.values()) {
    // Category
    const cat = d.category ?? 'unknown';
    byCategory[cat] = (byCategory[cat] || 0) + 1;

    // Approval status
    const appr = (d.approvalStatus ?? 'UNKNOWN').toUpperCase();
    byApproval[appr] = (byApproval[appr] || 0) + 1;

    // Specialization (can be array)
    const specs = Array.isArray(d.specialization) ? d.specialization : [d.specialization ?? 'unknown'];
    specs.forEach(s => { if (s) bySpecialization[s] = (bySpecialization[s] || 0) + 1; });

    // Practice type
    const pt = d.practiceSetupType ?? 'unknown';
    byPracticeType[pt] = (byPracticeType[pt] || 0) + 1;

    // State
    const st = d.address?.state ?? 'Unknown';
    byState[st] = (byState[st] || 0) + 1;
  }

  const stats = {
    uniqueDoctors:    uniqueMap.size,
    totalAssignments,
    overlap:          totalAssignments - uniqueMap.size,
    byCategory:       sortDesc(byCategory),
    byApprovalStatus: sortDesc(byApproval),
    bySpecialization: sortDesc(bySpecialization),
    byPracticeType:   sortDesc(byPracticeType),
    byState:          sortDesc(byState),
  };

  await db.storeDoctorStats(stats);

  state.running  = false;
  state.progress = emps.length;
  console.log(`[doctors] Done — ${uniqueMap.size} unique doctors, ${totalAssignments} assignments`);
}

function sortDesc(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => b[1] - a[1])
  );
}

module.exports = { computeStats, getState };

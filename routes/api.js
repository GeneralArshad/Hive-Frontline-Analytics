'use strict';
const express    = require('express');
const router     = express.Router();
const db         = require('../services/db');
const hive       = require('../services/hiveClient');
const syncEngine = require('../services/syncEngine');

// ── Helper: current month/year with optional override ────────────────────────
function getMonthYear(query) {
  const now   = new Date();
  const month = parseInt(query.month) || now.getMonth() + 1;
  const year  = parseInt(query.year)  || now.getFullYear();
  return { month, year };
}

// ── GET /api/summary ──────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const { month, year } = getMonthYear(req.query);
    const [summary, lastSync] = await Promise.all([
      db.getSummary(month, year),
      db.getLastSync(),
    ]);
    res.json({ ok: true, month, year, summary, lastSync });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/employees ─────────────────────────────────────────────────────────
// Returns all employees with their tour plan status and visit data
// Optional filters: ?designation=MR&state=Karnataka&hq=Bangalore
router.get('/employees', async (req, res) => {
  try {
    const { month, year } = getMonthYear(req.query);
    const filters = {
      designation: req.query.designation || null,
      state:       req.query.state       || null,
      hq:          req.query.hq          || null,
    };
    const employees = await db.getEmployeesWithPlans(month, year, filters);
    res.json({ ok: true, month, year, count: employees.length, employees });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/employees/:ec/days ───────────────────────────────────────────────
// Returns day-by-day visit breakdown for one employee (live from Hive API)
router.get('/employees/:ec/days', async (req, res) => {
  try {
    const { month, year } = getMonthYear(req.query);
    const emp = await db.getEmployeeByEc(req.params.ec);
    if (!emp) return res.status(404).json({ ok: false, error: 'Employee not found' });

    const days = await hive.fetchDayPlanDetails(emp.hive_id, month, year);
    res.json({ ok: true, ec: emp.ec, name: emp.name, month, year, days });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/filter-options ───────────────────────────────────────────────────
// Returns distinct states, HQs, and designations for filter dropdowns
router.get('/filter-options', async (req, res) => {
  try {
    const { month, year } = getMonthYear(req.query);
    const options = await db.getFilterOptions(month, year);
    res.json({ ok: true, ...options });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/designations ─────────────────────────────────────────────────────
router.get('/designations', async (req, res) => {
  try {
    const { month, year } = getMonthYear(req.query);
    const rows = await db.getDesignationBreakdown(month, year);
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/top-performers ───────────────────────────────────────────────────
router.get('/top-performers', async (req, res) => {
  try {
    const { month, year } = getMonthYear(req.query);
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const rows = await db.getTopPerformers(month, year, limit);
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/non-reporters ────────────────────────────────────────────────────
router.get('/non-reporters', async (req, res) => {
  try {
    const { month, year } = getMonthYear(req.query);
    const all = await db.getEmployeesWithPlans(month, year);
    const nr  = all.filter(e => ['MISSING', 'DRAFT', 'REJECTED'].includes(e.may_status));
    res.json({ ok: true, count: nr.length, employees: nr });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/sync/status ──────────────────────────────────────────────────────
router.get('/sync/status', async (req, res) => {
  try {
    const state   = syncEngine.getState();
    const lastLog = await db.getLastSync();
    res.json({ ok: true, sync: state, lastLog });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/sync ────────────────────────────────────────────────────────────
// Starts an async sync — returns immediately, poll /api/sync/status for progress
router.post('/sync', async (req, res) => {
  try {
    const { month, year } = getMonthYear(req.body || req.query);
    const result = await syncEngine.runSync(month, year);
    if (result.alreadyRunning) {
      return res.status(409).json({ ok: false, message: 'Sync already in progress' });
    }
    res.json({ ok: true, message: 'Sync started', logId: result.logId, month, year });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/doctors ──────────────────────────────────────────────────────────
// Probes the Hive API for doctor count using the first known employee
router.get('/doctors', async (req, res) => {
  try {
    // Use a provided employeeId, or pick the first employee from DB
    let hiveId = req.query.employeeId;
    if (!hiveId) {
      const { rows } = await db.pool.query('SELECT hive_id FROM employees WHERE hive_id IS NOT NULL LIMIT 1');
      hiveId = rows[0]?.hive_id;
    }
    if (!hiveId) return res.status(400).json({ ok: false, error: 'No employees synced yet. Run a sync first.' });
    const result = await hive.fetchDoctorCount(hiveId);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/doctors/unique ───────────────────────────────────────────────────
// Counts unique doctors across ALL employees by sampling pages.
// Warning: this is slow (~1 req per employee). Use sparingly.
router.get('/doctors/unique', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50; // sample first N employees
    const { rows: emps } = await db.pool.query(
      'SELECT ec, hive_id FROM employees WHERE hive_id IS NOT NULL LIMIT $1', [limit]
    );
    if (!emps.length) return res.status(400).json({ ok: false, error: 'No employees synced yet.' });

    const uniqueDoctors = new Map(); // doctorCode → doctor object
    let totalAssignments = 0;

    await Promise.all(emps.map(async emp => {
      const doctors = await hive.fetchAllEmployeeDoctors(emp.hive_id);
      totalAssignments += doctors.length;
      doctors.forEach(d => {
        const code = d.doctorCode ?? d.code ?? d._id ?? d.id;
        if (code && !uniqueDoctors.has(String(code))) uniqueDoctors.set(String(code), d);
      });
    }));

    const sample = [...uniqueDoctors.values()].slice(0, 3);
    res.json({
      ok: true,
      employeesSampled: emps.length,
      uniqueDoctors: uniqueDoctors.size,
      totalAssignments,
      note: limit < 503 ? `Sampled ${limit} of 503 employees. Add ?limit=503 for full count (slow).` : 'Full count across all employees.',
      sampleDoctors: sample,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/health ───────────────────────────────────────────────────────────
router.get('/health', async (req, res) => {
  try {
    await db.pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected', ts: new Date() });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'error', error: err.message });
  }
});

module.exports = router;

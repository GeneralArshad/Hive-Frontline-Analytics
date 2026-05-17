'use strict';

const db         = require('./db');
const hive       = require('./hiveClient');

// ── Global sync state (in-memory) ────────────────────────────────────────────
const syncState = {
  running:      false,
  logId:        null,
  startedAt:    null,
  phase:        'idle',     // idle | auth | employees | plans | done | error
  totalEmployees: 0,
  processed:    0,
  error:        null,
  lastSync:     null,       // { completedAt, employeesFetched }
};

function getState() {
  return { ...syncState };
}

// ── Main sync ─────────────────────────────────────────────────────────────────
async function runSync(month, year) {
  if (syncState.running) {
    return { alreadyRunning: true };
  }

  syncState.running   = true;
  syncState.startedAt = new Date();
  syncState.phase     = 'auth';
  syncState.processed = 0;
  syncState.error     = null;

  const logId = await db.createSyncLog();
  syncState.logId = logId;

  // Run async — don't await so the HTTP response returns immediately
  _doSync(month, year, logId).catch(err => {
    console.error('[sync] Fatal error:', err.message);
  });

  return { started: true, logId };
}

async function _doSync(month, year, logId) {
  let employeesFetched = 0;
  try {
    // ── 1. Fetch all employees ──────────────────────────────────────────────
    syncState.phase = 'employees';
    const employees = await hive.fetchAllEmployees(count => {
      syncState.totalEmployees = count;
    });
    employeesFetched = employees.length;
    syncState.totalEmployees = employees.length;

    // ── 2. Process each employee in batches of 20 ───────────────────────────
    syncState.phase = 'plans';
    const BATCH = 20;

    for (let i = 0; i < employees.length; i += BATCH) {
      const batch = employees.slice(i, i + BATCH);
      await Promise.all(batch.map(emp => _processEmployee(emp, month, year)));
      syncState.processed = Math.min(i + BATCH, employees.length);
    }

    // ── 3. Done ─────────────────────────────────────────────────────────────
    syncState.phase   = 'done';
    syncState.running = false;
    syncState.lastSync = { completedAt: new Date(), employeesFetched };
    await db.completeSyncLog(logId, employeesFetched);
    console.log(`[sync] Completed — ${employeesFetched} employees in ${
      ((Date.now() - syncState.startedAt) / 1000).toFixed(1)}s`);

  } catch (err) {
    syncState.phase   = 'error';
    syncState.error   = err.message;
    syncState.running = false;
    await db.completeSyncLog(logId, employeesFetched, err.message);
    console.error('[sync] Failed:', err.message);
  }
}

async function _processEmployee(emp, month, year) {
  try {
    const { ec, hiveId, name, designation } = hive.parseEmployee(emp);
    if (!ec) return;

    // Upsert employee
    await db.upsertEmployee(ec, hiveId, name, designation);

    // Tour plans (current month + previous month in parallel)
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear  = month === 1 ? year - 1 : year;

    const [plans] = await Promise.all([
      hive.fetchTourPlans(hiveId),
    ]);

    const { status: curStatus, planCount } = hive.parseTourPlanStatus(plans, month, year);
    const { status: prevStatus }           = hive.parseTourPlanStatus(plans, prevMonth, prevYear);

    await Promise.all([
      db.upsertTourPlan(ec, month,     year,     curStatus,  planCount),
      db.upsertTourPlan(ec, prevMonth, prevYear, prevStatus, planCount),
    ]);

    // Day plans
    const dpSummary = await hive.fetchDayPlans(hiveId, month, year);
    await db.upsertDayPlan(ec, month, year, dpSummary);

  } catch (err) {
    // Don't fail the whole sync for one employee
    console.warn(`[sync] Employee error (${emp._id}):`, err.message);
  }
}

module.exports = { runSync, getState };

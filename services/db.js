'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

// ── Schema init ─────────────────────────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      ec           TEXT PRIMARY KEY,
      hive_id      TEXT UNIQUE,
      name         TEXT NOT NULL,
      designation  TEXT,
      state        TEXT,
      hq           TEXT,
      synced_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tour_plans (
      id           SERIAL PRIMARY KEY,
      ec           TEXT REFERENCES employees(ec) ON DELETE CASCADE,
      month        SMALLINT NOT NULL,
      year         SMALLINT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'MISSING',
      plan_count   INT DEFAULT 0,
      synced_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (ec, month, year)
    );

    CREATE TABLE IF NOT EXISTS day_plan_summary (
      id              SERIAL PRIMARY KEY,
      ec              TEXT REFERENCES employees(ec) ON DELETE CASCADE,
      month           SMALLINT NOT NULL,
      year            SMALLINT NOT NULL,
      days_logged     INT DEFAULT 0,
      days_with_visits INT DEFAULT 0,
      total_visits    INT DEFAULT 0,
      avg_vpd         NUMERIC(6,2) DEFAULT 0,
      pending_approval INT DEFAULT 0,
      synced_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (ec, month, year)
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id                SERIAL PRIMARY KEY,
      started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at      TIMESTAMPTZ,
      status            TEXT NOT NULL DEFAULT 'running',
      employees_fetched INT DEFAULT 0,
      error_message     TEXT
    );

    CREATE TABLE IF NOT EXISTS session (
      sid    VARCHAR NOT NULL COLLATE "default",
      sess   JSON NOT NULL,
      expire TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (sid)
    );
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON session(expire);
  `);

  // Safe migrations for existing databases
  await pool.query(`
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS state TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS hq    TEXT;
  `);

  console.log('[db] Schema ready');
}

// ── Upserts ─────────────────────────────────────────────────────────────────
async function upsertEmployee(ec, hiveId, name, designation, state = null, hq = null) {
  await pool.query(`
    INSERT INTO employees (ec, hive_id, name, designation, state, hq, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (ec) DO UPDATE SET
      hive_id     = EXCLUDED.hive_id,
      name        = EXCLUDED.name,
      designation = EXCLUDED.designation,
      state       = EXCLUDED.state,
      hq          = EXCLUDED.hq,
      synced_at   = NOW()
  `, [ec, hiveId, name, designation, state, hq]);
}

async function getEmployeeByEc(ec) {
  const { rows } = await pool.query(
    'SELECT ec, hive_id, name, designation, state, hq FROM employees WHERE ec=$1',
    [ec]
  );
  return rows[0] || null;
}

async function getFilterOptions(month, year) {
  const { rows } = await pool.query(`
    SELECT DISTINCT
      NULLIF(TRIM(state), '')       AS state,
      NULLIF(TRIM(hq), '')          AS hq,
      NULLIF(TRIM(designation), '') AS designation
    FROM employees
    ORDER BY state, hq, designation
  `);
  const states = [...new Set(rows.map(r => r.state).filter(Boolean))].sort();
  const hqs    = [...new Set(rows.map(r => r.hq).filter(Boolean))].sort();
  const desigs = [...new Set(rows.map(r => r.designation).filter(Boolean))].sort();
  return { states, hqs, designations: desigs };
}

async function upsertTourPlan(ec, month, year, status, planCount) {
  await pool.query(`
    INSERT INTO tour_plans (ec, month, year, status, plan_count, synced_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (ec, month, year) DO UPDATE SET
      status     = EXCLUDED.status,
      plan_count = EXCLUDED.plan_count,
      synced_at  = NOW()
  `, [ec, month, year, status, planCount]);
}

async function upsertDayPlan(ec, month, year, data) {
  await pool.query(`
    INSERT INTO day_plan_summary
      (ec, month, year, days_logged, days_with_visits, total_visits, avg_vpd, pending_approval, synced_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    ON CONFLICT (ec, month, year) DO UPDATE SET
      days_logged      = EXCLUDED.days_logged,
      days_with_visits = EXCLUDED.days_with_visits,
      total_visits     = EXCLUDED.total_visits,
      avg_vpd          = EXCLUDED.avg_vpd,
      pending_approval = EXCLUDED.pending_approval,
      synced_at        = NOW()
  `, [ec, month, year,
      data.daysLogged, data.daysWithVisits,
      data.totalVisits, data.avgVpd, data.pendingApproval]);
}

// ── Reads ────────────────────────────────────────────────────────────────────
async function getSummary(month, year) {
  const [empCount, tpStats, visitStats, dayPlanStats] = await Promise.all([
    pool.query('SELECT COUNT(*) AS total, COUNT(DISTINCT designation) AS desigs FROM employees'),
    pool.query(`
      SELECT status, COUNT(*) AS cnt
      FROM tour_plans WHERE month=$1 AND year=$2
      GROUP BY status
    `, [month, year]),
    pool.query(`
      SELECT
        SUM(total_visits)                                  AS total_visits,
        ROUND(AVG(CASE WHEN total_visits>0 THEN avg_vpd END),1) AS avg_vpd,
        COUNT(CASE WHEN avg_vpd>=10 THEN 1 END)            AS high,
        COUNT(CASE WHEN avg_vpd>=5 AND avg_vpd<10 THEN 1 END) AS mid,
        COUNT(CASE WHEN avg_vpd>0  AND avg_vpd<5  THEN 1 END) AS low,
        COUNT(CASE WHEN total_visits=0 THEN 1 END)         AS zero
      FROM day_plan_summary WHERE month=$1 AND year=$2
    `, [month, year]),
    pool.query(`
      SELECT
        SUM(pending_approval) AS pending,
        COUNT(CASE WHEN pending_approval>0 THEN 1 END) AS employees_with_pending
      FROM day_plan_summary WHERE month=$1 AND year=$2
    `, [month, year]),
  ]);

  const tpMap = {};
  tpStats.rows.forEach(r => { tpMap[r.status] = parseInt(r.cnt); });
  const total = parseInt(empCount.rows[0].total);
  const tracked = Object.values(tpMap).reduce((a, b) => a + b, 0);
  tpMap['MISSING'] = (tpMap['MISSING'] || 0) + (total - tracked);

  return {
    totalEmployees: total,
    tourPlans: tpMap,
    visits: visitStats.rows[0],
    dayPlans: dayPlanStats.rows[0],
  };
}

async function getEmployeesWithPlans(month, year, filters = {}) {
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;

  const params = [month, year, prevMonth, prevYear];
  const wheres = [];

  if (filters.designation) {
    params.push(filters.designation);
    wheres.push(`e.designation = $${params.length}`);
  }
  if (filters.state) {
    params.push(filters.state);
    wheres.push(`e.state = $${params.length}`);
  }
  if (filters.hq) {
    params.push(filters.hq);
    wheres.push(`e.hq = $${params.length}`);
  }

  const whereClause = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

  const { rows } = await pool.query(`
    SELECT
      e.ec, e.name, e.designation, e.state, e.hq,
      COALESCE(tp_cur.status,  'MISSING')  AS may_status,
      COALESCE(tp_cur.plan_count, 0)       AS plan_count,
      COALESCE(tp_prev.status, 'MISSING')  AS apr_status,
      COALESCE(dp.days_logged, 0)          AS days_logged,
      COALESCE(dp.days_with_visits, 0)     AS days_with_visits,
      COALESCE(dp.total_visits, 0)         AS total_visits,
      COALESCE(dp.avg_vpd, 0)             AS avg_vpd,
      COALESCE(dp.pending_approval, 0)     AS pending_approval
    FROM employees e
    LEFT JOIN tour_plans  tp_cur  ON tp_cur.ec=e.ec  AND tp_cur.month=$1  AND tp_cur.year=$2
    LEFT JOIN tour_plans  tp_prev ON tp_prev.ec=e.ec AND tp_prev.month=$3 AND tp_prev.year=$4
    LEFT JOIN day_plan_summary dp ON dp.ec=e.ec       AND dp.month=$1      AND dp.year=$2
    ${whereClause}
    ORDER BY e.name
  `, params);
  return rows;
}

async function getDesignationBreakdown(month, year) {
  const { rows } = await pool.query(`
    SELECT
      e.designation,
      COUNT(*)                                              AS total,
      COUNT(CASE WHEN tp.status='APPROVED'  THEN 1 END)   AS approved,
      COUNT(CASE WHEN tp.status='SUBMITTED' THEN 1 END)   AS submitted,
      COUNT(CASE WHEN tp.status='DRAFT'     THEN 1 END)   AS draft,
      COUNT(CASE WHEN tp.status='MISSING' OR tp.status IS NULL THEN 1 END) AS missing,
      COUNT(CASE WHEN tp.status='REJECTED'  THEN 1 END)   AS rejected
    FROM employees e
    LEFT JOIN tour_plans tp ON tp.ec=e.ec AND tp.month=$1 AND tp.year=$2
    GROUP BY e.designation
    ORDER BY total DESC
  `, [month, year]);
  return rows;
}

async function getTopPerformers(month, year, limit = 10) {
  const { rows } = await pool.query(`
    SELECT
      e.ec, e.name, e.designation,
      dp.total_visits, dp.days_logged, dp.avg_vpd
    FROM employees e
    JOIN day_plan_summary dp ON dp.ec=e.ec AND dp.month=$1 AND dp.year=$2
    WHERE dp.total_visits > 0
    ORDER BY dp.total_visits DESC
    LIMIT $3
  `, [month, year, limit]);
  return rows;
}

async function getLastSync() {
  const { rows } = await pool.query(`
    SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 1
  `);
  return rows[0] || null;
}

async function createSyncLog() {
  const { rows } = await pool.query(
    'INSERT INTO sync_log (started_at, status) VALUES (NOW(),\'running\') RETURNING id'
  );
  return rows[0].id;
}

async function completeSyncLog(id, employeesFetched, error = null) {
  await pool.query(`
    UPDATE sync_log
    SET completed_at=NOW(), status=$2, employees_fetched=$3, error_message=$4
    WHERE id=$1
  `, [id, error ? 'error' : 'completed', employeesFetched, error]);
}

module.exports = {
  pool, initDb,
  upsertEmployee, upsertTourPlan, upsertDayPlan,
  getEmployeeByEc, getFilterOptions,
  getSummary, getEmployeesWithPlans, getDesignationBreakdown,
  getTopPerformers, getLastSync, createSyncLog, completeSyncLog,
};

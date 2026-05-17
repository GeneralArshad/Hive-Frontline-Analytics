'use strict';

const BASE_URL  = process.env.HIVE_API_URL;
const ORG_ID    = process.env.HIVE_ORG_ID;
const USERNAME  = process.env.HIVE_USERNAME;
const PASSWORD  = process.env.HIVE_PASSWORD;

// In-memory token cache
let tokenCache = { token: null, expiresAt: 0 };

// ── Auth ────────────────────────────────────────────────────────────────────
async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  console.log('[hive] Authenticating…');
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Hive login failed: ${res.status}`);
  const data = await res.json();
  const token = data.accessToken || data.token || data.access_token;
  if (!token) throw new Error('No token in Hive login response');
  // Cache for 50 minutes (tokens typically last 1h)
  tokenCache = { token, expiresAt: Date.now() + 50 * 60 * 1000 };
  console.log('[hive] Token acquired');
  return token;
}

// ── Base request ─────────────────────────────────────────────────────────────
async function hiveGet(path, retries = 1) {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-organization-id': ORG_ID,
      'Content-Type': 'application/json',
    },
  });
  if (res.status === 401 && retries > 0) {
    // Token expired — force refresh
    tokenCache = { token: null, expiresAt: 0 };
    return hiveGet(path, retries - 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Hive GET ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── Employees ────────────────────────────────────────────────────────────────
async function fetchEmployeePage(page, limit = 100) {
  const data = await hiveGet(`/admin/employees?page=${page}&limit=${limit}`);
  // API may return { data: [...] } or just [...]
  return Array.isArray(data) ? data : (data.data || data.employees || []);
}

async function fetchAllEmployees(onProgress) {
  const all = [];
  let page = 1;
  while (true) {
    const batch = await fetchEmployeePage(page);
    if (!batch.length) break;
    all.push(...batch);
    if (onProgress) onProgress(all.length);
    if (batch.length < 100) break; // last page
    page++;
  }
  console.log(`[hive] Fetched ${all.length} employees`);
  return all;
}

// ── Tour Plans ────────────────────────────────────────────────────────────────
async function fetchTourPlans(employeeId) {
  try {
    const data = await hiveGet(`/admin/employees/${employeeId}/tour-plans`);
    return Array.isArray(data) ? data : (data.data || []);
  } catch {
    return [];
  }
}

// ── Day Plans ─────────────────────────────────────────────────────────────────
async function fetchDayPlans(employeeId, month, year) {
  try {
    const data = await hiveGet(
      `/admin/employees/${employeeId}/day-plans?month=${month}&year=${year}`
    );
    const plans = Array.isArray(data) ? data : (data.data || []);
    return summariseDayPlans(plans);
  } catch {
    return { daysLogged: 0, daysWithVisits: 0, totalVisits: 0, avgVpd: 0, pendingApproval: 0 };
  }
}

function summariseDayPlans(plans) {
  if (!plans.length) {
    return { daysLogged: 0, daysWithVisits: 0, totalVisits: 0, avgVpd: 0, pendingApproval: 0 };
  }
  let totalVisits = 0, daysWithVisits = 0, pendingApproval = 0;
  const daysLogged = plans.length;

  plans.forEach(p => {
    const visits = parseInt(p.visitCount ?? p.visits ?? p.doctorsVisited ?? 0);
    totalVisits += visits;
    if (visits > 0) daysWithVisits++;
    // Pending = submitted but not yet approved by manager
    if (p.status === 'SUBMITTED' || p.approvalStatus === 'PENDING') pendingApproval++;
  });

  const avgVpd = daysLogged > 0 ? parseFloat((totalVisits / daysLogged).toFixed(2)) : 0;
  return { daysLogged, daysWithVisits, totalVisits, avgVpd, pendingApproval };
}

// ── Parse employee fields (defensive — API shape may vary) ─────────────────
function parseEmployee(emp) {
  // Try common field names for EC code
  const ec = emp.employeeCode ?? emp.empCode ?? emp.code ?? emp.ec ?? emp.employeeId ?? emp._id;
  const name = emp.name ?? emp.fullName ?? emp.employeeName ?? 'Unknown';
  const designation = emp.designation ?? emp.role ?? emp.position ?? '';
  const hiveId = emp._id ?? emp.id ?? ec;
  return { ec: String(ec).trim(), hiveId: String(hiveId), name, designation };
}

// ── Parse tour plan status for a given month/year ──────────────────────────
function parseTourPlanStatus(plans, month, year) {
  if (!plans.length) return { status: 'MISSING', planCount: 0 };
  const relevant = plans.filter(p => {
    const d = new Date(p.month ?? p.date ?? p.startDate ?? p.createdAt ?? 0);
    return d.getMonth() + 1 === month && d.getFullYear() === year;
  });
  if (!relevant.length) {
    // Try filtering by a month field directly
    const byField = plans.filter(p => {
      const m = p.month ?? p.monthNumber;
      const y = p.year ?? p.yearNumber;
      return parseInt(m) === month && parseInt(y) === year;
    });
    if (!byField.length) return { status: 'MISSING', planCount: plans.length };
    relevant.push(...byField);
  }
  // Pick the best status: APPROVED > SUBMITTED > DRAFT > REJECTED
  const order = ['APPROVED', 'SUBMITTED', 'DRAFT', 'REJECTED'];
  let best = 'MISSING';
  relevant.forEach(p => {
    const s = (p.status ?? p.approvalStatus ?? '').toUpperCase();
    if (order.indexOf(s) < order.indexOf(best === 'MISSING' ? 'MISSING' : best) ||
        best === 'MISSING') {
      if (order.includes(s)) best = s;
    }
  });
  return { status: best, planCount: plans.length };
}

module.exports = {
  fetchAllEmployees, fetchTourPlans, fetchDayPlans,
  parseEmployee, parseTourPlanStatus,
};

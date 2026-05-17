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
    const plans = Array.isArray(data) ? data : (data.data || data.tourPlans || data.plans || []);
    if (fetchTourPlans._logged < 1 && plans.length > 0) {
      console.log('[hive] Tour plan sample keys:', Object.keys(plans[0]).join(', '));
      console.log('[hive] Tour plan sample:', JSON.stringify(plans[0]).slice(0, 400));
      fetchTourPlans._logged = 1;
    }
    return plans;
  } catch (err) {
    console.log(`[hive] fetchTourPlans error for ${employeeId}: ${err.message}`);
    return [];
  }
}
fetchTourPlans._logged = 0;

// ── Day Plans ─────────────────────────────────────────────────────────────────
async function fetchDayPlans(employeeId, month, year) {
  try {
    const data = await hiveGet(
      `/admin/employees/${employeeId}/day-plans?month=${month}&year=${year}`
    );
    const plans = Array.isArray(data) ? data : (data.data || data.dayPlans || data.plans || []);
    // Log first day plan shape so we know the exact field names
    if (fetchDayPlans._logged < 1 && plans.length > 0) {
      console.log('[hive] Day plan sample keys:', Object.keys(plans[0]).join(', '));
      console.log('[hive] Day plan sample:', JSON.stringify(plans[0]).slice(0, 600));
      fetchDayPlans._logged = 1;
    }
    return summariseDayPlans(plans);
  } catch (err) {
    console.log(`[hive] fetchDayPlans error for ${employeeId}: ${err.message}`);
    return { daysLogged: 0, daysWithVisits: 0, totalVisits: 0, avgVpd: 0, pendingApproval: 0 };
  }
}
fetchDayPlans._logged = 0;

function summariseDayPlans(plans) {
  if (!plans.length) {
    return { daysLogged: 0, daysWithVisits: 0, totalVisits: 0, avgVpd: 0, pendingApproval: 0 };
  }
  let totalVisits = 0, daysWithVisits = 0, pendingApproval = 0;
  const daysLogged = plans.length;

  plans.forEach(p => {
    // Try every plausible field name for visit count
    // The Frontline Admin shows per-day visit counts combining doctors + chemists
    const raw =
      p.visitCount       ??   // most common
      p.totalVisits      ??
      p.visits           ??
      p.noOfVisits       ??
      p.numberOfVisits   ??
      p.doctorVisits     ??
      p.doctorsVisited   ??
      p.totalDoctors     ??
      p.doctorCount      ??
      // Some APIs nest visits: { doctors: [...], chemists: [...] }
      (Array.isArray(p.doctors)  ? p.doctors.length  : undefined) ??
      (Array.isArray(p.chemists) ? p.chemists.length : undefined) ??
      0;
    const visits = parseInt(raw) || 0;
    totalVisits += visits;
    if (visits > 0) daysWithVisits++;

    // Pending = any status that isn't APPROVED yet
    // Frontline Admin uses: APPROVED, IN_PROGRESS, PENDING, REJECTED
    const s = (p.status ?? p.approvalStatus ?? p.planStatus ?? '').toUpperCase();
    if (s === 'SUBMITTED' || s === 'PENDING' || s === 'IN_PROGRESS') pendingApproval++;
  });

  const avgVpd = daysLogged > 0 ? parseFloat((totalVisits / daysLogged).toFixed(2)) : 0;
  return { daysLogged, daysWithVisits, totalVisits, avgVpd, pendingApproval };
}

// ── Parse employee fields (defensive — API shape may vary) ─────────────────
function parseEmployee(emp) {
  // Log first employee shape to help debug field names
  if (parseEmployee._logged < 2) {
    console.log('[hive] Employee sample keys:', Object.keys(emp).join(', '));
    console.log('[hive] Employee sample:', JSON.stringify(emp).slice(0, 400));
    parseEmployee._logged = (parseEmployee._logged || 0) + 1;
  }

  const ec = emp.employeeCode ?? emp.empCode ?? emp.code ?? emp.ec ?? emp.employeeId ?? emp._id;
  const name = emp.name ?? emp.fullName ?? emp.employeeName ??
    (`${emp.firstName || ''} ${emp.lastName || ''}`.trim() || 'Unknown');
  const hiveId = emp._id ?? emp.id ?? ec;

  // Designation: handle string, nested object, or alternative field names
  let designation = '';
  const rawDesg = emp.designation ?? emp.designationName ?? emp.role ??
    emp.jobTitle ?? emp.position ?? emp.userDesignation ?? emp.designationTitle ?? null;
  if (typeof rawDesg === 'string') {
    designation = rawDesg;
  } else if (rawDesg && typeof rawDesg === 'object') {
    designation = rawDesg.name ?? rawDesg.title ?? rawDesg.designationName ??
      rawDesg.label ?? Object.values(rawDesg).find(v => typeof v === 'string') ?? '';
  }

  return { ec: String(ec).trim(), hiveId: String(hiveId), name, designation };
}
parseEmployee._logged = 0;

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

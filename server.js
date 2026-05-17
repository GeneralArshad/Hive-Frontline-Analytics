'use strict';
require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const pgSession    = require('connect-pg-simple')(session);
const path         = require('path');
const db           = require('./services/db');
const authRouter   = require('./routes/auth');
const apiRouter    = require('./routes/api');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Sessions (PostgreSQL-backed so they survive restarts) ─────────────────────
app.use(session({
  store: new pgSession({
    pool:            db.pool,
    tableName:       'session',
    createTableIfMissing: true,
  }),
  secret:            process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge:   8 * 60 * 60 * 1000, // 8 hours
    sameSite: 'lax',
  },
}));

// ── Auth routes (public) ──────────────────────────────────────────────────────
app.use('/auth', authRouter);

app.get('/health', async (req, res) => {
  try {
    await db.pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected', ts: new Date() });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'error', error: err.message });
  }
});
// ── Require authentication for everything below ───────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  // For API calls return 401 JSON; for page requests redirect to login
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, message: 'Not authenticated' });
  }
  res.redirect('/login');
}

// ── API routes (protected) ────────────────────────────────────────────────────
app.use('/api', requireAuth, apiRouter);

// ── Static frontend ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Login page route ──────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ── Root: serve dashboard (protected) ────────────────────────────────────────
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Catch-all ────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, message: 'Not found' });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await db.initDb();
    app.listen(PORT, () => {
      console.log(`[server] BB Analytics running on port ${PORT}`);
      console.log(`[server] Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err.message);
    process.exit(1);
  }
}

start();

# BB Analytics — Railway Deployment Guide

Field Force Analytics: live dashboard connected to the Hive Frontline API,
backed by PostgreSQL, protected by a username + password login.

---

## Prerequisites

- A [Railway](https://railway.app) account
- A GitHub account (Railway deploys from GitHub)
- Your Hive API credentials (username, password, org ID)

---

## Step 1 — Push code to GitHub

```bash
cd bb-analytics
git init
git add .
git commit -m "Initial commit — BB Analytics"
```

Go to GitHub → New Repository → create `bb-analytics` (private).

```bash
git remote add origin https://github.com/YOUR_ORG/bb-analytics.git
git push -u origin main
```

---

## Step 2 — Create Railway project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Choose **Deploy from GitHub repo** → select `bb-analytics`
3. Railway detects Node.js automatically via Nixpacks

---

## Step 3 — Add PostgreSQL database

Inside your Railway project:

1. Click **+ New** → **Database** → **Add PostgreSQL**
2. Railway creates the database and adds `DATABASE_URL` to your environment automatically

---

## Step 4 — Set environment variables

In Railway → your `bb-analytics` service → **Variables** tab, add:

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | *(auto-set by Railway)* | Already added when you created PostgreSQL |
| `SESSION_SECRET` | `a-long-random-string-min-32-chars` | Generate with: `openssl rand -hex 32` |
| `DASHBOARD_USERNAME` | `admin` | Username to log into the dashboard |
| `DASHBOARD_PASSWORD` | `your-strong-password` | Password for dashboard login |
| `HIVE_API_URL` | `https://hive-frontline-backend.com` | Hive base URL |
| `HIVE_ORG_ID` | `69bfddb4be37f4864f67ca8a` | Your organisation ID |
| `HIVE_USERNAME` | `your-hive-email@britishbiologicals.com` | Hive admin credentials |
| `HIVE_PASSWORD` | `your-hive-password` | Hive admin password |
| `NODE_ENV` | `production` | Enables secure cookies |
| `PORT` | *(auto-set by Railway)* | Railway injects this automatically |

---

## Step 5 — Deploy

Railway automatically triggers a deploy on every GitHub push.

To deploy manually: Railway dashboard → **Deploy** button.

Watch the build logs — the server starts with:
```
[server] BB Analytics running on port XXXX
[server] Environment: production
```

---

## Step 6 — First login

1. Railway will show you a public URL like `https://bb-analytics-production.up.railway.app`
2. Visit the URL — you'll be redirected to `/login`
3. Enter the `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` you set above
4. You're in! The dashboard loads with empty data until you run the first sync.

---

## Step 7 — Run first sync

1. Click **Sync Now** in the top-right of the dashboard
2. Select the month/year you want to load
3. The sync runs in the background — a progress overlay shows phase and employee count
4. First sync of ~550 employees takes approximately 3–5 minutes
5. Click "Run in Background" to dismiss the overlay; sync continues server-side

---

## Database tables (auto-created on first boot)

| Table | Purpose |
|---|---|
| `employees` | Master list: ec, hive_id, name, designation |
| `tour_plans` | Monthly TP status per employee |
| `day_plan_summary` | Monthly visit metrics per employee |
| `sync_log` | History of sync runs |
| `session` | Login sessions (managed by express-session) |

---

## Updating the dashboard

Push to GitHub → Railway auto-deploys in ~60 seconds.

```bash
git add .
git commit -m "Update dashboard"
git push
```

Sessions survive redeploys because they are stored in PostgreSQL, not in memory.

---

## Custom domain (optional)

Railway dashboard → your service → **Settings** → **Custom Domain** → add your domain and point a CNAME to Railway's generated URL.

---

## Troubleshooting

**Login not working** — check that `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` are set correctly in Railway variables.

**Sync fails immediately** — check `HIVE_API_URL`, `HIVE_ORG_ID`, `HIVE_USERNAME`, `HIVE_PASSWORD` in Railway variables. View logs in Railway dashboard.

**"Not authenticated" on API calls** — ensure `SESSION_SECRET` is set and consistent. If you change it, all active sessions are invalidated.

**Database connection error** — verify `DATABASE_URL` is set (Railway sets this automatically when PostgreSQL is added to the project).

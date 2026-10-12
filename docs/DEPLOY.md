# Deploying Meridian to Vercel

About 20 minutes. You need a GitHub account (the repo), a Vercel account, and a hosted PostgreSQL database.

## 1. Create the database

Any PostgreSQL 15+ works. Three that have a free tier:

| Provider | Use as `DATABASE_URL` (the app) | Use as `DIRECT_DATABASE_URL` (migrations) |
|---|---|---|
| **Prisma Postgres** (console.prisma.io) | the connection string it shows | not needed |
| **Neon** (neon.tech) | the **pooled** string (host contains `-pooler`) | the direct string |
| **Supabase** | the pooler string (port 6543) | the direct string (port 5432) |

Create a database, and keep the connection string(s).

## 2. Generate secrets

Run these anywhere Node is installed (Windows works too):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # NEXTAUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"      # CRON_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(12).toString('hex'))"      # DEMO_PASSWORD
```

Store them in a password manager. **Never change `ENCRYPTION_KEY` once a workspace has connected Stripe**: stored Stripe keys can only be read with it.

## 3. Create the Vercel project

1. vercel.com → **Add New → Project** → import `saas-dashboard` from GitHub.
2. Framework: Next.js (detected). Leave the build command as it is. Vercel runs the `vercel-build` script, which generates the Prisma client, **applies the migrations**, then builds.
3. Under **Environment Variables**, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | step 1 (pooled) |
| `DIRECT_DATABASE_URL` | step 1 (direct), only for Neon or Supabase |
| `NEXTAUTH_SECRET` | step 2 |
| `NEXTAUTH_URL` | `https://<your-project>.vercel.app` (or your domain) |
| `CRON_SECRET` | step 2. Vercel Cron sends it automatically. |
| `ENCRYPTION_KEY` | step 2 |
| `DEMO_EMAIL` | `demo@saas-dashboard.dev` |
| `DEMO_PASSWORD` | step 2 |
| `DEMO_PUBLIC` | `true` puts a "Try the demo" button on the site and rebuilds the demo nightly |

Optional:

| Variable | What it turns on |
|---|---|
| `RESEND_API_KEY`, `MAIL_FROM` | Real email: confirmations, password reset, invites, alerts, scheduled reports. In Resend, verify a domain first; `MAIL_FROM` must use it, e.g. `Meridian <hello@yourdomain.com>`. Without these, the email features hide themselves. |
| `GITHUB_ID`, `GITHUB_SECRET` | "Continue with GitHub". The OAuth app's callback is `https://<domain>/api/auth/callback/github`. |
| `DATABASE_POOL_MAX` | Connections per server instance. Defaults to 5. |

4. **Deploy.**

## 4. Build the demo

The seed script never runs in production. The demo is built by the daily job, so run it once now instead of waiting for tonight:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" https://<domain>/api/cron/snapshots
```

The JSON answer should include `"demoReset": true`.

## 5. Check it

- `https://<domain>/api/health` → `{"status":"ok"}`
- `/` shows the landing page; **Try the demo** opens the sample workspace.
- Register a new account → you land on onboarding → create a workspace → load sample data or import a CSV.
- Vercel → Project → **Settings → Cron Jobs** lists `/api/cron/snapshots`, daily at 00:10 UTC. It writes the day's snapshots, raises alerts, sends scheduled reports and the Monday summary, syncs Stripe, and rebuilds the public demo.

## Notes

- **Function duration.** The daily job is allowed up to 300 seconds (`maxDuration`). If your Vercel plan caps functions lower, the job still works for a handful of workspaces; it processes them one at a time and reports failures in its JSON.
- **Logs.** Server errors are single JSON lines with `"event":"request_error"`; web vitals are lines with `"event":"web_vital"`. Filter on these in Vercel → Logs.
- **Custom domain.** After adding it in Vercel, update `NEXTAUTH_URL` and redeploy. Email links and the Stripe webhook URL are built from it.

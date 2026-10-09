# Roadmap to v1

Meridian is a multi-tenant SaaS metrics product: a founder signs up, brings their
billing data (manual entry, CSV import, REST API, Stripe sync) and sees their real
MRR, churn, retention and revenue movements.

Each step ships as its own pull request. A step is done when every item under
"Done when" holds and CI is green.

## Done

| Step | What |
|---|---|
| 1 | Multi-tenant Customer / Plan model, customer-based metrics, safe per-workspace sample data |
| 2 | Billing management UI: customers, plans, subscription lifecycle, invoices, snapshot recompute |
| 3 | Onboarding, workspace creation and deletion, sample data in product, per-workspace daily cron |
| 4 | CSV import (customers, plans, subscriptions with history, invoices), preview, idempotent re-import |
| 5 | Public REST API v1 with API keys, rate limits, OpenAPI document and docs page |

## Remaining

### 6 — Email
- A mailer with one interface and two drivers: Resend (HTTP API, `fetch`, no SDK) when `RESEND_API_KEY` is set, otherwise a development driver that logs each message and keeps it readable for tests.
- Email verification after registration; unverified accounts see a banner and can resend.
- Password reset: request by email, single-use hashed token, 1-hour expiry, no account enumeration.
- Invites send an email with the link (the copyable link stays as a fallback).
- **Done when:** every flow is covered by the verify script and an e2e script that reads the message from the development driver.

### 7 — Notifications and the last placeholder content
- Notifications produced by real events: MRR milestones, churn of a customer above a threshold, failed/uncollectible invoices, import and sync results, weekly summary.
- Per-user notification preferences (in-app, and email once step 6 exists).
- Scheduled reports become real (emailed on schedule) or are removed — no "coming soon".
- The sign-in panel's invented figures are replaced, and `/` becomes a real landing page.
- **Done when:** nothing in the product shows placeholder or invented content, verified by an e2e pass over every page.

### 8 — Stripe sync
- Connect with a restricted read-only key; validated, encrypted at rest.
- Initial backfill and incremental sync of customers, prices, subscriptions (with history) and invoices through the same lib functions as the importer and the API.
- Webhook endpoint with signature verification for live updates; manual "Sync now".
- **Done when:** tested against a local fake Stripe server with recorded fixtures; sync is idempotent.

### 9 — Production readiness
- Build runs `prisma generate` and `prisma migrate deploy`; pooled connection string for serverless.
- Security headers and CSP; error tracking hook; web-vitals reporting.
- Public demo: read-only demo workspace, reset nightly.
- README and a case-study page: what it does, architecture, decisions, screenshots.
- **Done when:** a production build passes every check and the README lets a stranger run it locally in minutes.

### 10 — Deploy
- Vercel project, hosted Postgres, environment variables, cron, domain.
- **Done when:** the public URL serves the demo and a new user can sign up end to end.

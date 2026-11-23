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
| 6 | Email: confirmation, password reset with session revocation, invite emails (Resend or a local mailbox) |
| 7 | Alerts (churn, revenue dips, overdue invoices, MRR milestones), weekly summary, notification preferences, scheduled report emails, landing page, no placeholder content |
| 8 | Stripe sync: restricted read-only key (encrypted at rest), full and nightly sync through the API's own rules, signed webhooks for live updates |
| 9 | Production readiness: migrations in the Vercel build, pooled connections, CSP and security headers, structured error logs, web vitals, health check, 404 and global error pages, a fenced and nightly-rebuilt public demo, README, deploy guide |

## Launch prep (done)

- Git history checked for committed secrets before going public: none (only placeholder values in `.env.example` and CI-only test values).
- MIT license; privacy policy (`/privacy`) and terms of use (`/terms`), linked from the footer and the sign-up page.
- Next.js 16.2.10 → 16.4.6: fixes a React bug where a fast Server Action could leave its form pending forever (seen as the currency confirmation missing in about one save in six).
- Settings → currency: the dropdown no longer jumps back to the old currency after a save.

## Remaining

### 10 — Deploy
- Vercel project, hosted Postgres, environment variables, cron, domain — step by step in [DEPLOY.md](DEPLOY.md).
- **Done when:** the public URL serves the demo and a new user can sign up end to end.

## Known issues

- **Stripe sync limits:** up to 5,000 of each object per run; discounts and coupons are not applied (list prices are used); a subscription item removed from a multi-item subscription in Stripe is not ended in Meridian until its subscription ends; weekly/daily, metered and tiered prices are skipped and listed.

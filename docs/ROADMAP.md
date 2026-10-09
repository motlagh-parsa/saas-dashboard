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

## Remaining

### 9 — Production readiness
- Build runs `prisma generate` and `prisma migrate deploy`; pooled connection string for serverless.
- Security headers and CSP; error tracking hook; web-vitals reporting.
- Public demo: read-only demo workspace, reset nightly.
- README and a case-study page: what it does, architecture, decisions, screenshots.
- **Done when:** a production build passes every check and the README lets a stranger run it locally in minutes.

### 10 — Deploy
- Vercel project, hosted Postgres, environment variables, cron, domain.
- **Done when:** the public URL serves the demo and a new user can sign up end to end.

## Known issues

- **Settings → currency:** in roughly one save in six the "Amounts are now in …" confirmation does not appear, although the change is saved (the field shows the new value after a reload). Seen in a production build under e2e load; cause not yet isolated.
- **Stripe sync limits:** up to 5,000 of each object per run; discounts and coupons are not applied (list prices are used); a subscription item removed from a multi-item subscription in Stripe is not ended in Meridian until its subscription ends; weekly/daily, metered and tiered prices are skipped and listed.

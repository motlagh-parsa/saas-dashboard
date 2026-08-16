-- Subscription plan-change hand-off link + metrics index rework.
--
-- Why: getNetRevenueRetention() used to reconstruct plan-change chains by joining
-- `s."startedAt" = ch."endedAt"`. That join is not 1:1, so a root could fan out into
-- several branches (ending MRR silently dropped) and several roots could fan in to one
-- successor (ending MRR double-counted). It also enumerated every root-to-node PATH,
-- which is exponential: 49 subscription rows produced ~33M chain rows.
--
-- `previousSubscriptionId` + its UNIQUE index makes the hand-off graph a forest of
-- simple paths: at most one predecessor per row (single FK column) and at most one
-- successor per row (unique index). Fan-out and fan-in become unrepresentable.

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "previousSubscriptionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_previousSubscriptionId_key" ON "Subscription"("previousSubscriptionId");

-- AddForeignKey
-- SET NULL, not CASCADE: deleting a superseded segment must break the link, not
-- delete the customer's entire downstream lifecycle. RESTRICT/NO ACTION would block
-- the Organization -> Subscription cascade delete.
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_previousSubscriptionId_fkey" FOREIGN KEY ("previousSubscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropIndex
-- Never chosen by any plan: every query in lib/metrics.ts filters `organizationId = $1`,
-- so a global single-column index on a date column is not competitive. Worse for
-- canceledAt: churnQuery's only WHERE clause is organizationId, and canceledAt appears
-- exclusively inside FILTER clauses, which are evaluated per-row after the scan.
DROP INDEX "Subscription_startedAt_idx";

-- DropIndex
DROP INDEX "Subscription_canceledAt_idx";

-- DropIndex
-- `status` is never a predicate anywhere in the query layer (it is the TERMINAL state
-- of a segment; activity is decided by dates). The planner was using this purely as an
-- organizationId-prefix index and then filtering the date predicates on the heap.
-- "Subscription_organizationId_startedAt_endedAt_idx" below has the same leading column,
-- so it subsumes the org-prefix role AND covers the dates.
DROP INDEX "Subscription_organizationId_status_idx";

-- CreateIndex
-- Live-as-of predicate `startedAt <= t AND (endedAt IS NULL OR endedAt > t)`, tenant-scoped:
-- mrrByCurrencyQuery, the NRR opening cohort, getActiveSubscriptions. Also backs the
-- Organization -> Subscription cascade-delete FK via its leading column.
CREATE INDEX "Subscription_organizationId_startedAt_endedAt_idx" ON "Subscription"("organizationId", "startedAt", "endedAt");

-- CreateIndex
-- "which of this tenant's segments ended in this window".
CREATE INDEX "Subscription_organizationId_endedAt_idx" ON "Subscription"("organizationId", "endedAt");

-- CreateIndex
-- churnQuery numerator: canceledAt IN (start, end], tenant-scoped.
CREATE INDEX "Subscription_organizationId_canceledAt_idx" ON "Subscription"("organizationId", "canceledAt");

-- AddCheckConstraint
-- A negative subscription price breaks two things: the NRR identity
-- (ending = starting + expansion - contraction - churn), and the agreement between
-- Postgres ROUND() (half away from zero) and the seed's Math.round() (half toward
-- +Infinity) on exact halves such as -12.5. Prisma cannot express CHECK constraints in
-- schema.prisma and does not consider them for drift detection, so this lives here only.
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_amountCents_non_negative" CHECK ("amountCents" >= 0);

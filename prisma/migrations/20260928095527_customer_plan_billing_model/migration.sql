-- Customer / Plan billing model.
--
-- Organization stops being the customer: it is the founder's workspace, and the
-- founder's paying customers become Customer rows inside it. Plans become rows
-- (the PlanTier enum is dropped), BillingInterval becomes Stripe-style
-- MONTH/YEAR + intervalCount, every amount is in Organization.currency, and
-- externally sourced rows get (organizationId, externalId) for idempotent imports.
--
-- REQUIRES EMPTY BILLING TABLES. Subscription/Invoice gain NOT NULL "customerId"
-- with no backfill, and the enum swap casts 'MONTHLY'/'YEARLY' text to the new
-- 'MONTH'/'YEAR' type, which fails on existing rows. There was no production
-- data when this was written; development databases are reset and re-seeded
-- (npx prisma migrate reset).

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('MANUAL', 'CSV', 'API', 'STRIPE', 'SAMPLE');

-- AlterEnum
BEGIN;
CREATE TYPE "BillingInterval_new" AS ENUM ('MONTH', 'YEAR');
ALTER TABLE "public"."Subscription" ALTER COLUMN "interval" DROP DEFAULT;
ALTER TABLE "Subscription" ALTER COLUMN "interval" TYPE "BillingInterval_new" USING ("interval"::text::"BillingInterval_new");
ALTER TYPE "BillingInterval" RENAME TO "BillingInterval_old";
ALTER TYPE "BillingInterval_new" RENAME TO "BillingInterval";
DROP TYPE "public"."BillingInterval_old";
ALTER TABLE "Subscription" ALTER COLUMN "interval" SET DEFAULT 'MONTH';
COMMIT;

-- DropIndex
DROP INDEX "Subscription_organizationId_canceledAt_idx";

-- AlterTable
ALTER TABLE "Invoice" DROP COLUMN "currency",
ADD COLUMN     "customerId" TEXT NOT NULL,
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "source" "DataSource" NOT NULL DEFAULT 'MANUAL',
ALTER COLUMN "subscriptionId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "MetricSnapshot" DROP COLUMN "activeUsers",
DROP COLUMN "newUsers",
ADD COLUMN     "activeCustomers" INTEGER NOT NULL,
ADD COLUMN     "churnedCustomers" INTEGER NOT NULL,
ADD COLUMN     "newCustomers" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD';

-- AlterTable
ALTER TABLE "Subscription" DROP COLUMN "currency",
DROP COLUMN "tier",
ADD COLUMN     "customerId" TEXT NOT NULL,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "intervalCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "planId" TEXT,
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "source" "DataSource" NOT NULL DEFAULT 'MANUAL',
ALTER COLUMN "interval" SET DEFAULT 'MONTH';

-- DropEnum
DROP TYPE "PlanTier";

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "externalId" TEXT,
    "source" "DataSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "intervalCount" INTEGER NOT NULL DEFAULT 1,
    "externalId" TEXT,
    "source" "DataSource" NOT NULL DEFAULT 'MANUAL',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Customer_organizationId_name_idx" ON "Customer"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_organizationId_externalId_key" ON "Customer"("organizationId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_organizationId_externalId_key" ON "Plan"("organizationId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_organizationId_name_key" ON "Plan"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_externalId_key" ON "Invoice"("organizationId", "externalId");

-- CreateIndex
CREATE INDEX "Subscription_organizationId_customerId_idx" ON "Subscription"("organizationId", "customerId");

-- CreateIndex
CREATE INDEX "Subscription_customerId_idx" ON "Subscription"("customerId");

-- CreateIndex
CREATE INDEX "Subscription_planId_idx" ON "Subscription"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_organizationId_externalId_key" ON "Subscription"("organizationId", "externalId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CheckConstraints — Prisma has no schema syntax for these and does not track
-- them for drift, so this migration is the only place they appear.
--
-- A negative plan price would break the expansion/contraction identity, exactly
-- as for Subscription.amountCents (see 20260816121500_…).
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_amountCents_non_negative" CHECK ("amountCents" >= 0);
-- MRR divides by the interval length in months; zero would divide by zero.
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_intervalCount_positive" CHECK ("intervalCount" >= 1);
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_intervalCount_positive" CHECK ("intervalCount" >= 1);
-- A subscription for zero units bills nothing forever and would still count as live.
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_quantity_positive" CHECK ("quantity" >= 1);

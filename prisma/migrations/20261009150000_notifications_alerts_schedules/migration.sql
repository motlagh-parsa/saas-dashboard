-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'WEEKLY_SUMMARY';

-- CreateEnum
CREATE TYPE "ReportFrequency" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY');

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "inApp" BOOLEAN NOT NULL,
    "email" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId","type")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "frequency" "ReportFrequency" NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertMark" (
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertMark_pkey" PRIMARY KEY ("organizationId","key")
);

-- CreateIndex
CREATE INDEX "ReportSchedule_nextRunAt_idx" ON "ReportSchedule"("nextRunAt");

-- CreateIndex
CREATE INDEX "ReportSchedule_organizationId_userId_idx" ON "ReportSchedule"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "ReportSchedule_userId_idx" ON "ReportSchedule"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSchedule_organizationId_userId_reportId_key" ON "ReportSchedule"("organizationId", "userId", "reportId");

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertMark" ADD CONSTRAINT "AlertMark_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

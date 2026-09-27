-- DropIndex
DROP INDEX "Notification_organizationId_readAt_createdAt_idx";

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Notification_organizationId_readAt_archivedAt_createdAt_idx" ON "Notification"("organizationId", "readAt", "archivedAt", "createdAt");


-- CreateTable
CREATE TABLE "ReportRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReportRun_organizationId_reportId_generatedAt_idx" ON "ReportRun"("organizationId", "reportId", "generatedAt");

-- AddForeignKey
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

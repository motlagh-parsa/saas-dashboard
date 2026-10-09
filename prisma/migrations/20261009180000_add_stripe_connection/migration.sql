-- CreateTable
CREATE TABLE "StripeConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "keyHint" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "encryptedWebhookSecret" TEXT,
    "syncState" TEXT NOT NULL DEFAULT 'idle',
    "syncStartedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncSummary" JSONB,
    "lastSyncError" TEXT,
    "lastWebhookAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StripeConnection_organizationId_key" ON "StripeConnection"("organizationId");

-- CreateIndex
CREATE INDEX "StripeConnection_createdById_idx" ON "StripeConnection"("createdById");

-- AddForeignKey
ALTER TABLE "StripeConnection" ADD CONSTRAINT "StripeConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeConnection" ADD CONSTRAINT "StripeConnection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

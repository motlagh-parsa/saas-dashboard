import "server-only";

// The ONLY way server code writes an audit entry.
//
// `server-only` with no `"use server"`, for the reason lib/notification-writer.ts
// gives: a `"use server"` export is a public endpoint, and an audit log anyone
// could post to would record nothing worth trusting. Callers are trusted server
// code that has already authorized the change being recorded.
//
// Called from `after()` once a mutation has succeeded, so the entry never delays
// the response and never exists for a write that failed. The trade-off is that
// it is not in the mutation's transaction: if this insert fails, the change
// stands and the entry is missing. That failure is logged, never thrown — an
// audit hiccup must not turn a successful action into an error.
import type { Prisma } from "@prisma/client";

import type { AuditAction, AuditTargetType } from "@/lib/audit-view";
import { prisma } from "@/lib/prisma";

export async function writeAudit(data: {
  organizationId: string;
  /** The signed-in user who acted. Omitted for system-initiated entries. */
  actorId?: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId?: string;
  /** A human name for the target, snapshotted — it must survive the target's deletion. */
  targetLabel?: string;
  metadata?: Prisma.InputJsonObject;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: data.organizationId,
        actorId: data.actorId ?? null,
        action: data.action,
        targetType: data.targetType,
        targetId: data.targetId ?? null,
        targetLabel: data.targetLabel ?? null,
        metadata: data.metadata,
      },
    });
  } catch (error: unknown) {
    console.error("[audit] failed to write entry", {
      action: data.action,
      organizationId: data.organizationId,
      targetId: data.targetId,
      error,
    });
  }
}

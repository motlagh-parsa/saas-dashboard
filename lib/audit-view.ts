/**
 * The audit log's vocabulary: which actions exist, how each reads on screen, and
 * how an entry's `metadata` becomes a one-line detail.
 *
 * A plain module with type-only Prisma imports, so the writer (server-only) and
 * the page share one closed list. `writeAudit` only accepts an `AuditAction`, so
 * a typo in a call site is a compile error rather than an unlabelled row.
 */
import type { Prisma } from "@prisma/client";

import { EM_DASH, formatEnumLabel, formatMoneyExact } from "@/lib/format";

export const AUDIT_ACTION_LABELS = {
  "user.created": "Added user",
  "user.updated": "Renamed user",
  "user.suspended": "Suspended user",
  "user.unsuspended": "Unsuspended user",
  "user.deleted": "Deleted user",
  "role.changed": "Changed role",
  "workspace.renamed": "Renamed workspace",
  "workspace.left": "Left workspace",
  "subscription.created": "Added subscription",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTION_LABELS;

export type AuditTargetType = "user" | "workspace" | "subscription";

function isAuditAction(value: string): value is AuditAction {
  return Object.hasOwn(AUDIT_ACTION_LABELS, value);
}

/**
 * The label for a stored action. Unknown strings — a row written by an older or
 * newer build — render as themselves rather than as a blank cell.
 */
export function auditActionLabel(action: string): string {
  return isAuditAction(action) ? AUDIT_ACTION_LABELS[action] : action;
}

// ---------------------------------------------------------------------------
// Details — metadata is untyped JSON on the way back out, so it is narrowed
// field by field and anything unexpected falls back to an em-dash.
// ---------------------------------------------------------------------------

type JsonObject = Prisma.JsonObject;

function asObject(value: Prisma.JsonValue | null): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(object: JsonObject, key: string): string | null {
  const value = object[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function integer(object: JsonObject, key: string): number | null {
  const value = object[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** `Member → Admin`, `Old name → New name`, `Pro · Monthly · $49.00`, or an em-dash. */
export function auditDetails(action: string, metadata: Prisma.JsonValue | null): string {
  const data = asObject(metadata);
  if (data === null) return EM_DASH;

  switch (action) {
    case "role.changed": {
      const from = text(data, "from");
      const to = text(data, "to");
      return from && to ? `${formatEnumLabel(from)} → ${formatEnumLabel(to)}` : EM_DASH;
    }
    case "workspace.renamed": {
      const from = text(data, "from");
      const to = text(data, "to");
      return from && to ? `${from} → ${to}` : EM_DASH;
    }
    case "user.updated": {
      const from = text(data, "from");
      const to = text(data, "to");
      return to ? `${from ?? EM_DASH} → ${to}` : EM_DASH;
    }
    case "subscription.created": {
      const tier = text(data, "tier");
      const interval = text(data, "interval");
      const amountCents = integer(data, "amountCents");
      if (!tier || !interval || amountCents === null) return EM_DASH;
      return `${formatEnumLabel(tier)} · ${formatEnumLabel(interval)} · ${formatMoneyExact(amountCents, "USD")}`;
    }
    default:
      return EM_DASH;
  }
}

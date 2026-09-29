/**
 * The audit log's vocabulary: which actions exist, how each reads on screen, and
 * how an entry's `metadata` becomes a one-line detail.
 *
 * A plain module with type-only Prisma imports, so the writer (server-only) and
 * the page share one closed list. `writeAudit` only accepts an `AuditAction`, so
 * a typo in a call site is a compile error rather than an unlabelled row.
 */
import type { Prisma } from "@prisma/client";

import { EM_DASH, formatBillingInterval, formatEnumLabel, formatMoneyExact } from "@/lib/format";

export const AUDIT_ACTION_LABELS = {
  "user.created": "Added user",
  "user.updated": "Renamed user",
  "user.suspended": "Suspended user",
  "user.unsuspended": "Unsuspended user",
  "user.deleted": "Deleted user",
  "user.invite_resent": "Resent invite",
  "users.exported": "Exported users",
  "role.changed": "Changed role",
  "workspace.created": "Created workspace",
  "workspace.renamed": "Renamed workspace",
  "workspace.currency_changed": "Changed currency",
  "workspace.left": "Left workspace",
  "sample_data.loaded": "Loaded sample data",
  "sample_data.removed": "Removed sample data",
  "subscription.created": "Added subscription",
  "subscription.changed": "Changed plan",
  "subscription.canceled": "Canceled subscription",
  "subscription.cancel_undone": "Undid cancellation",
  "subscription.corrected": "Corrected subscription",
  "subscription.deleted": "Deleted subscription",
  "customer.created": "Added customer",
  "customer.updated": "Edited customer",
  "customer.archived": "Archived customer",
  "customer.unarchived": "Unarchived customer",
  "customer.deleted": "Deleted customer",
  "customer.exported": "Exported customers",
  "plan.created": "Created plan",
  "plan.updated": "Edited plan",
  "plan.archived": "Archived plan",
  "plan.unarchived": "Unarchived plan",
  "plan.deleted": "Deleted plan",
  "invoice.created": "Recorded invoice",
  "invoice.paid": "Marked invoice paid",
  "invoice.voided": "Voided invoice",
  "invoice.uncollectible": "Marked uncollectible",
  "invoice.deleted": "Deleted invoice",
  "invoice.exported": "Exported invoices",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTION_LABELS;

export type AuditTargetType = "user" | "workspace" | "subscription" | "customer" | "plan" | "invoice";

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
    case "users.exported": {
      const count = integer(data, "count");
      const query = text(data, "query");
      if (count === null) return EM_DASH;
      const rows = `${count} ${count === 1 ? "user" : "users"} to CSV`;
      return query ? `${rows}, matching “${query}”` : rows;
    }
    case "subscription.created": {
      // Entries from this build carry a prepared `detail`; older ones are
      // rebuilt from their structured fields below.
      const detail = text(data, "detail");
      if (detail) return detail;
      const plan = text(data, "plan");
      const interval = text(data, "interval");
      const intervalCount = integer(data, "intervalCount") ?? 1;
      const amountCents = integer(data, "amountCents");
      if (!plan || amountCents === null || (interval !== "MONTH" && interval !== "YEAR")) {
        return EM_DASH;
      }
      const currency = text(data, "currency") ?? "USD";
      return `${plan} · ${formatBillingInterval(interval, intervalCount)} · ${formatMoneyExact(amountCents, currency)}`;
    }
    default:
      // Billing entries (customer.*, plan.*, subscription.*, invoice.*) are
      // written with a prepared one-line `detail` — "Growth → Pro from 01 Mar
      // 2026", "Start 01 Jan → 15 Jan" — formatted once, in the workspace
      // currency, when the change happened. Their structured before/after values
      // sit beside it in the metadata.
      return text(data, "detail") ?? EM_DASH;
  }
}

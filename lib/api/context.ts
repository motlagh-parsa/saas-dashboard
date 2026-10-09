// What a REST API resource function works with: the workspace (from the key),
// the clock, and a collector for the side effects of its writes.
//
// Resource functions (lib/api/resources/*) call the billing operations of
// lib/billing-ops.ts — the same ones the UI's Server Actions call — and hand
// each result to `applied`. A success is recorded (its audit entry, and the
// earliest day whose snapshots it moved); a refusal becomes the API's 409 with
// the UI's own message. The route wrapper (lib/api/handler.ts) flushes the
// collected effects after the response, exactly as `finishWrite` does for a
// form. Keeping this free of request and Next context is what lets the verify
// script drive the resources directly.
import type { AuditDraft, OpResult } from "@/lib/billing-ops";

import { ApiError, conflict, notFound } from "./errors";

export class WriteEffects {
  readonly audits: AuditDraft[] = [];
  affectedFrom: Date | null = null;

  record(audit: AuditDraft, affectedFrom: Date | null): void {
    this.audits.push(audit);
    if (affectedFrom !== null && (this.affectedFrom === null || affectedFrom < this.affectedFrom)) {
      this.affectedFrom = affectedFrom;
    }
  }
}

export interface ApiWriteContext {
  readonly organizationId: string;
  /** Recorded on every row the write creates: the REST API, or the Stripe sync (lib/stripe/sync.ts). */
  readonly source: "API" | "STRIPE";
  /** The workspace currency — every amount in and out is in its minor units. */
  readonly currency: string;
  readonly now: Date;
  readonly effects: WriteEffects;
}

export function writeContext(
  organizationId: string,
  currency: string,
  now: Date = new Date(),
  source: "API" | "STRIPE" = "API",
): ApiWriteContext {
  return { organizationId, source, currency, now, effects: new WriteEffects() };
}

const STALE_PREFIX = "This page is out of date";

/**
 * An operation's value, with its effects recorded — or its refusal thrown as an
 * ApiError. `params` maps the operation's form-field names to the API's
 * snake_case names, so a refusal points at the field the caller sent.
 */
export function applied<T>(
  ctx: ApiWriteContext,
  result: OpResult<T>,
  params: Readonly<Record<string, string>> = {},
): T {
  if (result.ok) {
    ctx.effects.record(result.audit, result.affectedFrom);
    return result.value;
  }
  throw refusalError(result, params);
}

export function refusalError(
  result: { readonly message: string | null; readonly fieldErrors: Readonly<Record<string, string>> },
  params: Readonly<Record<string, string>> = {},
): ApiError {
  const [field, fieldMessage] = Object.entries(result.fieldErrors)[0] ?? [];
  const message = result.message ?? fieldMessage ?? "The request conflicts with the current state.";
  // The UI's "reload the page" means the record vanished between our read and
  // the write — to an API caller, that is simply not found.
  if (message.startsWith(STALE_PREFIX)) return notFound("That record no longer exists.");
  return conflict(message, field === undefined ? undefined : (params[field] ?? field));
}

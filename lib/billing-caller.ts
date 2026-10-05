import "server-only";

// The two ends every billing Server Action shares.
//
// `billingWriter` — who may write. Each form carries the organization id it was
// RENDERED for; the caller's membership in exactly that org is looked up by
// composite key (the `callerMembership` pattern of lib/workspace-actions.ts). A
// missing, malformed or foreign id matches nothing and is refused as a stale
// page. OWNER and ADMIN may write; MEMBER is refused here, on the server, even
// though the UI never shows them a write control.
//
// `finishWrite` — what every successful write does next, after the response is
// on its way (`after()`): record the audit entry (lib/audit-writer.ts) and, when
// the change reaches into dated history, rewrite that workspace's snapshots from
// the first affected day (lib/snapshots.ts). Then revalidate the dashboard, so
// the next render shows the change everywhere its numbers appear.
//
// Not a `"use server"` module: these are helpers for actions, not endpoints.
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { z } from "zod";

import { writeAudit } from "@/lib/audit-writer";
import { requireSession } from "@/lib/auth";
import { ID_PATTERN, fieldErrorsOf, readForm, type BillingFormState } from "@/lib/billing-form";
import type { OpResult } from "@/lib/billing-ops";
import { prisma } from "@/lib/prisma";
import { scheduleRecompute } from "@/lib/snapshots";

export const STALE_PAGE = "This page is out of date. Reload it and try again.";
export const WRITERS_ONLY = "Only owners and admins can change billing data.";

export interface BillingCaller {
  readonly userId: string;
  readonly organizationId: string;
  /** The workspace's ISO 4217 currency — money input is parsed in it. */
  readonly currency: string;
  /** For export filenames. */
  readonly slug: string;
}

export type CallerCheck =
  | { readonly ok: true; readonly caller: BillingCaller }
  | { readonly ok: false; readonly state: BillingFormState };

function refusal(message: string): CallerCheck {
  return { ok: false, state: { status: "error", message, fieldErrors: {} } };
}

/** The signed-in OWNER or ADMIN of the organization named by `organizationId`. */
export async function billingWriter(organizationId: unknown): Promise<CallerCheck> {
  const session = await requireSession();
  if (typeof organizationId !== "string" || !ID_PATTERN.test(organizationId)) return refusal(STALE_PAGE);

  // Composite primary key — an index seek, and a miss for any org the caller
  // does not belong to.
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: session.user.id, organizationId } },
    select: { role: true, organization: { select: { currency: true, slug: true } } },
  });
  if (membership === null) return refusal(STALE_PAGE);
  if (membership.role === "MEMBER") return refusal(WRITERS_ONLY);

  return {
    ok: true,
    caller: {
      userId: session.user.id,
      organizationId,
      currency: membership.organization.currency,
      slug: membership.organization.slug,
    },
  };
}

export type ParsedForm<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly state: BillingFormState };

/** Reads the named fields as strings and parses them with the form's schema. */
export function parseForm<T>(
  schema: z.ZodType<T>,
  formData: FormData,
  fields: readonly string[],
): ParsedForm<T> {
  const parsed = schema.safeParse(readForm(formData, fields));
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, state: { status: "error", message: null, fieldErrors: fieldErrorsOf(parsed.error) } };
}

/** A record id from the form, cuid-shaped, or the stale-page refusal. */
export function readId(formData: FormData, field: string): ParsedForm<string> {
  const value = formData.get(field);
  if (typeof value === "string" && ID_PATTERN.test(value)) return { ok: true, data: value };
  return { ok: false, state: { status: "error", message: STALE_PAGE, fieldErrors: {} } };
}

/**
 * Turns an operation's result into the form state, and on success schedules the
 * audit entry and the snapshot recompute and revalidates the dashboard.
 */
export function finishWrite<T>(caller: BillingCaller, result: OpResult<T>): BillingFormState {
  if (!result.ok) {
    return { status: "error", message: result.message, fieldErrors: result.fieldErrors };
  }

  const { audit, affectedFrom } = result;
  after(async () => {
    await writeAudit({ organizationId: caller.organizationId, actorId: caller.userId, ...audit });
    // Coalesced with any recompute of this workspace already running; logged,
    // never thrown — see lib/snapshots.ts.
    if (affectedFrom !== null) await scheduleRecompute(caller.organizationId, affectedFrom);
  });

  // Layout scope: a billing write moves numbers on the overview, revenue,
  // retention, customers, plans and invoices pages alike.
  revalidatePath("/dashboard", "layout");
  return { status: "success", message: result.message, fieldErrors: {} };
}

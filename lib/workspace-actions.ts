"use server";

// Workspace mutations: create (the switcher dialog and onboarding), and from
// Settings: rename, change currency, leave, delete.
//
// File-level `"use server"` for the same reason as `lib/notifications.ts`: the
// forms that call these are client islands. Every export is therefore a public
// endpoint, and everything in the submitted FormData is untrusted input.
//
// ---------------------------------------------------------------------------
// Which workspace
// ---------------------------------------------------------------------------
// Each form carries the organization id it was RENDERED for, and every action
// starts by looking up the caller's membership in exactly that org by composite
// key. Two consequences, both intended:
//   - An id the caller is not a member of matches nothing and is refused, so the
//     id selects nothing the caller could not already see.
//   - The action acts on the workspace that was on screen — never on whatever the
//     server would resolve NOW. Resolving fresh would let a stale tab (the user
//     already left X in another tab) silently leave or rename workspace Y.
//
// Creating a workspace is the one action with no workspace to check: the caller
// becomes its OWNER. Every write records an audit entry once it has actually
// changed something, via `after()` — see lib/audit-writer.ts — except delete,
// whose audit log is deleted with the workspace.
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { Prisma, type Role } from "@prisma/client";

import { ACTIVE_ORG_COOKIE, ACTIVE_ORG_COOKIE_MAX_AGE } from "@/lib/active-org";
import { writeAudit } from "@/lib/audit-writer";
import { requireSession } from "@/lib/auth";
import { readForm, type BillingFormState } from "@/lib/billing-form";
import { parseForm } from "@/lib/billing-caller";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { demoRefusal } from "@/lib/demo";
import type { WorkspaceActionState } from "@/lib/workspace-action-state";
import {
  CREATE_WORKSPACE_FIELDS,
  CURRENCY_LOCKED,
  createWorkspaceSchema,
  slugify,
  workspaceCurrencySchema,
  workspaceNameSchema,
} from "@/lib/workspace-form";

const STALE_PAGE = "This page is out of date. Reload it and try again.";

interface CallerMembership {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: Role;
}

function failure(message: string): WorkspaceActionState {
  return { status: "error", message };
}

/**
 * The signed-in caller's membership in the org the form was rendered for, or
 * null when the id is missing or the caller is not (or no longer) a member.
 */
async function callerMembership(formData: FormData): Promise<CallerMembership | null> {
  const session = await requireSession();
  const organizationId = formData.get("organizationId");
  if (typeof organizationId !== "string" || organizationId === "") return null;

  // Composite primary key — an index seek, and a miss for any org the caller
  // does not belong to.
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: session.user.id, organizationId } },
    select: { role: true },
  });
  if (membership === null) return null;

  return { userId: session.user.id, organizationId, role: membership.role };
}

/**
 * Renames the workspace. OWNER and ADMIN only; the name is trimmed and must be
 * 2–50 characters. Layout-scoped revalidation, because the name also appears in
 * the header's workspace switcher, not only on this page.
 */
export async function renameWorkspace(
  _previous: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const caller = await callerMembership(formData);
  if (caller === null) return failure(STALE_PAGE);
  if (caller.role === "MEMBER") {
    return failure("Only owners and admins can rename this workspace.");
  }

  const parsed = workspaceNameSchema.safeParse(formData.get("name"));
  if (!parsed.success) {
    return failure(parsed.error.issues[0]?.message ?? "Enter a valid workspace name.");
  }

  const before = await prisma.organization.findUniqueOrThrow({
    where: { id: caller.organizationId },
    select: { name: true },
  });
  if (before.name !== parsed.data) {
    await prisma.organization.update({
      where: { id: caller.organizationId },
      data: { name: parsed.data },
    });
    after(() =>
      writeAudit({
        organizationId: caller.organizationId,
        actorId: caller.userId,
        action: "workspace.renamed",
        targetType: "workspace",
        targetId: caller.organizationId,
        targetLabel: parsed.data,
        metadata: { from: before.name, to: parsed.data },
      }),
    );
  }

  revalidatePath("/dashboard", "layout");
  return { status: "success", message: "Workspace name saved." };
}

type LeaveOutcome =
  | { readonly kind: "left"; readonly workspaceName: string }
  | { readonly kind: "last-owner" }
  | { readonly kind: "already-gone" };

/**
 * Removes the caller's own membership, then sends them to /dashboard, which
 * resolves their next workspace or shows the no-workspace state.
 *
 * Refused for the LAST owner — a workspace nobody can manage is unrecoverable
 * from inside the product. The owner count and the delete run in one SERIALIZABLE
 * transaction: two co-owners leaving at the same instant would each count two
 * owners under a weaker level and both succeed, orphaning the workspace. Postgres
 * aborts one of them instead (Prisma P2034), and that caller is asked to retry —
 * at which point they are the last owner and are refused properly.
 */
export async function leaveWorkspace(
  _previous: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const caller = await callerMembership(formData);
  if (caller === null) return failure(STALE_PAGE);
  const demo = await demoRefusal(caller.userId);
  if (demo !== null) return failure(demo);

  const key = {
    userId_organizationId: { userId: caller.userId, organizationId: caller.organizationId },
  };

  let outcome: LeaveOutcome;
  try {
    outcome = await prisma.$transaction(
      async (tx): Promise<LeaveOutcome> => {
        // Re-read inside the transaction: the role may have changed since the
        // check above, and the row may already be gone.
        const mine = await tx.membership.findUnique({
          where: key,
          select: { role: true, organization: { select: { name: true } } },
        });
        if (mine === null) return { kind: "already-gone" };

        if (mine.role === "OWNER") {
          const owners = await tx.membership.count({
            where: { organizationId: caller.organizationId, role: "OWNER" },
          });
          if (owners <= 1) return { kind: "last-owner" };
        }

        await tx.membership.delete({ where: key });
        return { kind: "left", workspaceName: mine.organization.name };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return failure(
        "Someone else changed this workspace's members at the same moment. Try again.",
      );
    }
    throw error;
  }

  if (outcome.kind === "last-owner") {
    return failure(
      "You're the last owner of this workspace, so you can't leave it. Another member has to become an owner first.",
    );
  }

  // Only a leave that happened HERE is recorded; "already-gone" was recorded by
  // the tab that did it. The remaining members see the entry — the leaver no
  // longer can.
  if (outcome.kind === "left") {
    const { workspaceName } = outcome;
    after(() =>
      writeAudit({
        organizationId: caller.organizationId,
        actorId: caller.userId,
        action: "workspace.left",
        targetType: "workspace",
        targetId: caller.organizationId,
        targetLabel: workspaceName,
      }),
    );
  }

  // "left", or "already-gone" (left from another tab): either way the caller is
  // no longer a member, so both land where leaving lands. `redirect` throws, so
  // it stays outside the try/catch above.
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard");
}

// ---------------------------------------------------------------------------
// Create, change currency, delete — form actions with the billing forms' state
// shape (per-field errors), driven by the shared dialogs and onboarding.
// ---------------------------------------------------------------------------

function formError(message: string): BillingFormState {
  return { status: "error", message, fieldErrors: {} };
}

/** Slug attempts before giving up: the bare slug, then four random suffixes. */
const SLUG_ATTEMPTS = 5;

/** A short random suffix: 6 hex chars, 16.7M values per name. */
function slugSuffix(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function selectWorkspace(organizationId: string): Promise<void> {
  (await cookies()).set(ACTIVE_ORG_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: ACTIVE_ORG_COOKIE_MAX_AGE,
    // Local dev runs over plain http, where a Secure cookie would never be sent.
    secure: env.NODE_ENV === "production",
  });
}

/**
 * Creates a workspace with the caller as its OWNER, selects it, and continues
 * to /onboarding (which opens at "Bring your data" for it).
 *
 * The slug is the name slugified. Uniqueness is left to the database: the bare
 * slug is tried first and, on a unique-constraint error, retried with a short
 * random suffix — no check-then-insert, which two creates could both pass.
 * The organization and the membership are one nested write, so a failure never
 * leaves a workspace nobody belongs to.
 */
export async function createWorkspace(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const session = await requireSession();
  const demo = await demoRefusal(session.user.id);
  if (demo !== null) return formError(demo);
  const parsed = parseForm(createWorkspaceSchema(), formData, CREATE_WORKSPACE_FIELDS);
  if (!parsed.ok) return parsed.state;
  const { name, currency } = parsed.data;

  const base = slugify(name);
  let created: { id: string; slug: string } | null = null;
  for (let attempt = 0; attempt < SLUG_ATTEMPTS && created === null; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${slugSuffix()}`;
    try {
      created = await prisma.organization.create({
        data: {
          name,
          slug,
          currency,
          memberships: { create: { userId: session.user.id, role: "OWNER" } },
        },
        select: { id: true, slug: true },
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      throw error;
    }
  }
  if (created === null) return formError("Couldn't create the workspace. Try again.");

  const workspace = created;
  await selectWorkspace(workspace.id);
  after(() =>
    writeAudit({
      organizationId: workspace.id,
      actorId: session.user.id,
      action: "workspace.created",
      targetType: "workspace",
      targetId: workspace.id,
      targetLabel: name,
      metadata: { currency, slug: workspace.slug, detail: `${name} · ${currency}` },
    }),
  );

  revalidatePath("/", "layout");
  // Outside any try: `redirect` throws by design. The workspace id in the URL
  // makes the target differ from the page the form is on (step 1 is also
  // /onboarding): a redirect to the very same URL was intermittently not
  // followed, leaving step 1 on screen over a workspace that already existed.
  redirect(`/onboarding?workspace=${workspace.id}`);
}

/**
 * Changes the reporting currency — only while the workspace holds no billing
 * data at all. Every stored amount is in minor units of this currency, so
 * changing it afterwards would silently re-denominate every figure.
 *
 * The emptiness check and the update run in one SERIALIZABLE transaction, so a
 * customer added at the same instant cannot slip in between them.
 */
export async function updateWorkspaceCurrency(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const caller = await callerMembership(formData);
  if (caller === null) return formError(STALE_PAGE);
  if (caller.role === "MEMBER") return formError("Only owners and admins can change the currency.");

  const parsed = parseForm(workspaceCurrencySchema(), formData, ["currency"]);
  if (!parsed.ok) return parsed.state;
  const { currency } = parsed.data;

  type Outcome = { kind: "locked" } | { kind: "unchanged" } | { kind: "changed"; from: string };
  let outcome: Outcome;
  try {
    outcome = await prisma.$transaction(
      async (tx): Promise<Outcome> => {
        const scope = { organizationId: caller.organizationId };
        const counts = await Promise.all([
          tx.customer.count({ where: scope }),
          tx.plan.count({ where: scope }),
          tx.subscription.count({ where: scope }),
          tx.invoice.count({ where: scope }),
        ]);
        if (counts.some((count) => count > 0)) return { kind: "locked" };
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: caller.organizationId },
          select: { currency: true },
        });
        if (organization.currency === currency) return { kind: "unchanged" };
        await tx.organization.update({ where: { id: caller.organizationId }, data: { currency } });
        return { kind: "changed", from: organization.currency };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return formError("Someone else changed this workspace at the same moment. Try again.");
    }
    throw error;
  }

  if (outcome.kind === "locked") return formError(CURRENCY_LOCKED);
  if (outcome.kind === "changed") {
    const from = outcome.from;
    after(() =>
      writeAudit({
        organizationId: caller.organizationId,
        actorId: caller.userId,
        action: "workspace.currency_changed",
        targetType: "workspace",
        targetId: caller.organizationId,
        metadata: { from, to: currency, detail: `${from} → ${currency}` },
      }),
    );
  }

  revalidatePath("/dashboard", "layout");
  return {
    status: "success",
    message: outcome.kind === "changed" ? `Amounts are now in ${currency}.` : "Currency unchanged.",
    fieldErrors: {},
  };
}

/**
 * Deletes the workspace and everything in it. OWNER only, and only with its
 * name typed exactly (re-checked here against the stored name).
 *
 * One delete of the Organization row, in a transaction: every relation that
 * points at it — memberships, customers, plans, subscriptions, invoices,
 * snapshots, notifications, report runs and the audit log — is declared
 * `onDelete: Cascade` in prisma/schema.prisma, so Postgres removes them in the
 * same statement and nothing is left orphaned. Users are accounts, not
 * workspace data: they stay, and simply lose this membership.
 *
 * No audit entry: the log is part of what is deleted.
 */
export async function deleteWorkspace(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const caller = await callerMembership(formData);
  if (caller === null) return formError(STALE_PAGE);
  if (caller.role !== "OWNER") return formError("Only an owner can delete this workspace.");
  const demo = await demoRefusal(caller.userId);
  if (demo !== null) return formError(demo);

  const { confirmName } = readForm(formData, ["confirmName"]);
  const deleted = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.findUnique({
      where: { id: caller.organizationId },
      select: { name: true },
    });
    if (organization === null) return { kind: "gone" as const };
    if (confirmName.trim() !== organization.name) {
      return { kind: "mismatch" as const, name: organization.name };
    }
    await tx.organization.delete({ where: { id: caller.organizationId } });
    return { kind: "deleted" as const };
  });

  if (deleted.kind === "mismatch") {
    return {
      status: "error",
      message: null,
      fieldErrors: { confirmName: `Type ${deleted.name} exactly to confirm.` },
    };
  }

  // The switcher's choice pointed here: drop it, so /dashboard resolves the
  // caller's next workspace — or sends someone with none to /onboarding.
  const cookieStore = await cookies();
  if (cookieStore.get(ACTIVE_ORG_COOKIE)?.value === caller.organizationId) {
    cookieStore.delete(ACTIVE_ORG_COOKIE);
  }
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

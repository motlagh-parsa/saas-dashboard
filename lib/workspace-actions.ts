"use server";

// Workspace mutations for the Settings page: rename, and leave.
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
// Both record an audit entry once they have actually changed something, via
// `after()` — see lib/audit-writer.ts.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { Prisma, type Role } from "@prisma/client";
import { z } from "zod";

import { writeAudit } from "@/lib/audit-writer";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  WORKSPACE_NAME_MAX,
  WORKSPACE_NAME_MIN,
  type WorkspaceActionState,
} from "@/lib/workspace-action-state";

const STALE_PAGE = "This page is out of date. Reload it and try again.";

const workspaceNameSchema = z
  .string({ error: "Enter a workspace name." })
  .trim()
  .min(WORKSPACE_NAME_MIN, {
    error: `Use at least ${WORKSPACE_NAME_MIN} characters.`,
  })
  .max(WORKSPACE_NAME_MAX, {
    error: `Use at most ${WORKSPACE_NAME_MAX} characters.`,
  });

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

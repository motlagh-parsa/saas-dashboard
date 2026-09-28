"use server";

// User management for /dashboard/users: suspend, unsuspend, delete, change role.
//
// File-level `"use server"`: the row controls that call these are client
// islands, so every export is a public endpoint and everything in the FormData
// is untrusted. It exports ONLY the actions; the result shape lives in
// lib/user-action-state.ts and the role rules in lib/user-permissions.ts.
//
// ---------------------------------------------------------------------------
// Which workspace, which user
// ---------------------------------------------------------------------------
// Each form carries the organization id it was RENDERED for and the target's
// user id — the same pattern as lib/workspace-actions.ts. Both are checked by
// composite key: the caller must be an OWNER or ADMIN of that org, the target
// must be a member of it, and the caller must outrank the target there.
//
// Two of these actions reach past the workspace. `suspendedAt` lives on User,
// and deleting a User removes their account everywhere. So those two also
// require authority in every workspace the target belongs to (see
// `hasAccountReach`). Without that rule, an admin of one workspace could lock
// out or delete someone who owns a different one.
//
// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------
// Every check and its write run in one SERIALIZABLE transaction, as
// `leaveWorkspace` does. Two owners demoting each other at the same instant
// would each count two owners under a weaker level, both succeed, and leave the
// workspace ownerless. Postgres aborts one of them (Prisma P2034) instead, and
// that caller is asked to retry.
import { revalidatePath } from "next/cache";
import { Prisma, type Role } from "@prisma/client";
import { z } from "zod";

import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { UserActionState } from "@/lib/user-action-state";
import { assignableRoles, canManage, hasAccountReach } from "@/lib/user-permissions";

const STALE_PAGE = "This page is out of date. Reload it and try again.";
const CONFLICT = "Someone else changed this workspace's members at the same moment. Try again.";

const USERS_PATH = "/dashboard/users";

/** cuid-shaped: nothing exotic reaches a WHERE clause. */
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const roleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);

interface Target {
  readonly callerId: string;
  readonly organizationId: string;
  readonly userId: string;
}

type RoleCheck =
  | { readonly ok: true; readonly callerRole: Role; readonly targetRole: Role }
  | { readonly ok: false; readonly message: string };

function failure(message: string): UserActionState {
  return { status: "error", message };
}

function success(message: string): UserActionState {
  return { status: "success", message };
}

/** The session plus the two ids every action needs, or null when either is malformed. */
async function readTarget(formData: FormData): Promise<Target | null> {
  const session = await requireSession();
  const organizationId = idSchema.safeParse(formData.get("organizationId"));
  const userId = idSchema.safeParse(formData.get("userId"));
  if (!organizationId.success || !userId.success) return null;

  return {
    callerId: session.user.id,
    organizationId: organizationId.data,
    userId: userId.data,
  };
}

/**
 * Both roles in the rendered workspace, read inside the transaction so they
 * cannot change between the check and the write.
 */
async function checkRoles(tx: Prisma.TransactionClient, target: Target): Promise<RoleCheck> {
  if (target.callerId === target.userId) {
    return { ok: false, message: "You can't change your own account from this page." };
  }

  const caller = await tx.membership.findUnique({
    where: {
      userId_organizationId: { userId: target.callerId, organizationId: target.organizationId },
    },
    select: { role: true },
  });
  if (caller === null) return { ok: false, message: STALE_PAGE };
  if (caller.role === "MEMBER") {
    return { ok: false, message: "Only owners and admins can manage users." };
  }

  const member = await tx.membership.findUnique({
    where: {
      userId_organizationId: { userId: target.userId, organizationId: target.organizationId },
    },
    select: { role: true },
  });
  if (member === null) {
    return {
      ok: false,
      message: "That person is no longer in this workspace. Reload to see the current list.",
    };
  }
  if (!canManage(caller.role, member.role)) {
    return { ok: false, message: "Only an owner can change another owner." };
  }

  return { ok: true, callerRole: caller.role, targetRole: member.role };
}

/** Account-wide actions: the caller must outrank the target in every workspace they share. */
async function checkAccountReach(
  tx: Prisma.TransactionClient,
  target: Target,
): Promise<string | null> {
  const select = { organizationId: true, role: true } as const;
  const theirs = await tx.membership.findMany({ where: { userId: target.userId }, select });
  const mine = await tx.membership.findMany({ where: { userId: target.callerId }, select });

  return hasAccountReach(mine, theirs)
    ? null
    : "This person also belongs to workspaces you don't manage, so only an owner there can suspend or delete their account.";
}

async function inTransaction(
  work: (tx: Prisma.TransactionClient) => Promise<UserActionState>,
): Promise<UserActionState> {
  try {
    return await prisma.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return failure(CONFLICT);
    }
    throw error;
  }
}

async function setSuspended(formData: FormData, suspend: boolean): Promise<UserActionState> {
  const target = await readTarget(formData);
  if (target === null) return failure(STALE_PAGE);

  const result = await inTransaction(async (tx) => {
    const roles = await checkRoles(tx, target);
    if (!roles.ok) return failure(roles.message);
    const reach = await checkAccountReach(tx, target);
    if (reach !== null) return failure(reach);

    // Filtered on the current state, so a repeat from a stale tab keeps the
    // original suspension time instead of restamping it.
    await tx.user.updateMany({
      where: { id: target.userId, suspendedAt: suspend ? null : { not: null } },
      data: { suspendedAt: suspend ? new Date() : null },
    });
    return success(suspend ? "Account suspended." : "Account unsuspended.");
  });

  if (result.status === "success") revalidatePath(USERS_PATH);
  return result;
}

export async function suspendUser(
  _previous: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  return setSuspended(formData, true);
}

export async function unsuspendUser(
  _previous: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  return setSuspended(formData, false);
}

/**
 * Deletes the ACCOUNT, not just the membership: sessions, OAuth links and every
 * membership cascade, and their personal notifications revert to org-wide
 * (see the schema). Refused for yourself, and for the last owner of any
 * workspace the target belongs to.
 */
export async function deleteUser(
  _previous: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  const target = await readTarget(formData);
  if (target === null) return failure(STALE_PAGE);

  const result = await inTransaction(async (tx) => {
    const roles = await checkRoles(tx, target);
    if (!roles.ok) return failure(roles.message);
    const reach = await checkAccountReach(tx, target);
    if (reach !== null) return failure(reach);

    const owned = await tx.membership.findMany({
      where: { userId: target.userId, role: "OWNER" },
      select: { organizationId: true, organization: { select: { name: true } } },
    });
    for (const membership of owned) {
      const owners = await tx.membership.count({
        where: { organizationId: membership.organizationId, role: "OWNER" },
      });
      if (owners <= 1) {
        return failure(
          `They're the last owner of ${membership.organization.name}. Make someone else an owner there first.`,
        );
      }
    }

    await tx.user.delete({ where: { id: target.userId } });
    return success("Account deleted.");
  });

  if (result.status === "success") revalidatePath(USERS_PATH);
  return result;
}

/** Changes the target's role in the rendered workspace only. */
export async function updateUserRole(
  _previous: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  const target = await readTarget(formData);
  if (target === null) return failure(STALE_PAGE);

  const nextRole = roleSchema.safeParse(formData.get("role"));
  if (!nextRole.success) return failure("Choose Owner, Admin or Member.");
  const role = nextRole.data;

  const result = await inTransaction(async (tx) => {
    const roles = await checkRoles(tx, target);
    if (!roles.ok) return failure(roles.message);
    if (roles.targetRole === role) return success("Role unchanged.");
    if (!assignableRoles(roles.callerRole).includes(role)) {
      return failure("Only an owner can make someone an owner.");
    }

    if (roles.targetRole === "OWNER") {
      const owners = await tx.membership.count({
        where: { organizationId: target.organizationId, role: "OWNER" },
      });
      if (owners <= 1) {
        return failure("They're the last owner of this workspace. Make someone else an owner first.");
      }
    }

    await tx.membership.update({
      where: {
        userId_organizationId: { userId: target.userId, organizationId: target.organizationId },
      },
      data: { role },
    });
    return success("Role updated.");
  });

  if (result.status === "success") revalidatePath(USERS_PATH);
  return result;
}

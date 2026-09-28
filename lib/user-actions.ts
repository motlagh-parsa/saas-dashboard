"use server";

// User management for /dashboard/users: add, rename, suspend, unsuspend, delete,
// change role.
//
// File-level `"use server"`: the row controls that call these are client
// islands, so every export is a public endpoint and everything in the FormData
// is untrusted. It exports ONLY the actions; the result shapes live in
// lib/user-action-state.ts and lib/user-form.ts, and the role rules in
// lib/user-permissions.ts.
//
// ---------------------------------------------------------------------------
// Which workspace, which user
// ---------------------------------------------------------------------------
// Each form carries the organization id it was RENDERED for and the target's
// user id — the same pattern as lib/workspace-actions.ts. Both are checked by
// composite key: the caller must be an OWNER or ADMIN of that org, the target
// must be a member of it, and the caller must outrank the target there.
//
// Three of these actions reach past the workspace. `name` and `suspendedAt` live
// on User, and deleting a User removes their account everywhere. So those three
// also require authority in every workspace the target belongs to (see
// `hasAccountReach`). Without that rule, an admin of one workspace could rename,
// lock out or delete someone who owns a different one.
//
// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------
// Every check and its write run in one SERIALIZABLE transaction, as
// `leaveWorkspace` does. Two owners demoting each other at the same instant
// would each count two owners under a weaker level, both succeed, and leave the
// workspace ownerless. Postgres aborts one of them (Prisma P2034) instead, and
// that caller is asked to retry.
//
// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
// Every write that CHANGED something records an entry in the rendered
// workspace's audit log, scheduled with `after()` so it never delays the
// response (see lib/audit-writer.ts). A no-op — a repeat suspend from a stale
// tab, a role set to what it already was — records nothing.
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { Prisma, type Role } from "@prisma/client";
import { z } from "zod";

import { writeAudit } from "@/lib/audit-writer";
import { requireSession } from "@/lib/auth";
import { formatPersonName } from "@/lib/format";
import { issueInvite } from "@/lib/invite-token";
import { prisma } from "@/lib/prisma";
import type {
  ExportUsersResult,
  ResendInviteState,
  UserActionState,
} from "@/lib/user-action-state";
import {
  EMAIL_TAKEN,
  createUserSchema,
  updateUserSchema,
  userFormFieldErrors,
  type CreateUserFormState,
  type UserFormState,
} from "@/lib/user-form";
import { parseSortDirection, parseUserQuery, parseUserSort } from "@/lib/user-list";
import { assignableRoles, canManage, hasAccountReach } from "@/lib/user-permissions";
import { userListOrderBy, userListWhere } from "@/lib/user-query";

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
  | {
      readonly ok: true;
      readonly callerRole: Role;
      readonly targetRole: Role;
      /** The target's stored name, for audit metadata. */
      readonly targetName: string | null;
      /** How the target reads in the audit log — snapshotted before any delete. */
      readonly targetLabel: string;
    }
  | { readonly ok: false; readonly message: string };

type AuditEntry = Parameters<typeof writeAudit>[0];

/** Records an entry once the response is on its way. Never throws. */
function audit(entry: AuditEntry): void {
  after(() => writeAudit(entry));
}

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
    select: { role: true, user: { select: { name: true, email: true } } },
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

  return {
    ok: true,
    callerRole: caller.role,
    targetRole: member.role,
    targetName: member.user.name,
    targetLabel: formatPersonName(member.user.name, member.user.email),
  };
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
    : "This person also belongs to workspaces you don't manage, so only an owner there can edit, suspend or delete their account.";
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

  let entry: AuditEntry | null = null;
  const result = await inTransaction(async (tx) => {
    const roles = await checkRoles(tx, target);
    if (!roles.ok) return failure(roles.message);
    const reach = await checkAccountReach(tx, target);
    if (reach !== null) return failure(reach);

    // Filtered on the current state, so a repeat from a stale tab keeps the
    // original suspension time instead of restamping it.
    const { count } = await tx.user.updateMany({
      where: { id: target.userId, suspendedAt: suspend ? null : { not: null } },
      data: { suspendedAt: suspend ? new Date() : null },
    });
    if (count > 0) {
      entry = {
        organizationId: target.organizationId,
        actorId: target.callerId,
        action: suspend ? "user.suspended" : "user.unsuspended",
        targetType: "user",
        targetId: target.userId,
        targetLabel: roles.targetLabel,
      };
    }
    return success(suspend ? "Account suspended." : "Account unsuspended.");
  });

  if (result.status === "success") {
    if (entry !== null) audit(entry);
    revalidatePath(USERS_PATH);
  }
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

  let entry: AuditEntry | null = null;
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
    entry = {
      organizationId: target.organizationId,
      actorId: target.callerId,
      action: "user.deleted",
      targetType: "user",
      targetId: target.userId,
      targetLabel: roles.targetLabel,
    };
    return success("Account deleted.");
  });

  if (result.status === "success") {
    if (entry !== null) audit(entry);
    revalidatePath(USERS_PATH);
  }
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

  let entry: AuditEntry | null = null;
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
    entry = {
      organizationId: target.organizationId,
      actorId: target.callerId,
      action: "role.changed",
      targetType: "user",
      targetId: target.userId,
      targetLabel: roles.targetLabel,
      metadata: { from: roles.targetRole, to: role },
    };
    return success("Role updated.");
  });

  if (result.status === "success") {
    if (entry !== null) audit(entry);
    revalidatePath(USERS_PATH);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Add and rename — form actions with per-field errors (lib/user-form.ts)
// ---------------------------------------------------------------------------

function formFailure(message: string): UserFormState {
  return { status: "error", message, fieldErrors: {} };
}

/** A `createUser` refusal: never carries a token. */
function createFailure(
  message: string | null,
  fieldErrors: CreateUserFormState["fieldErrors"] = {},
): CreateUserFormState {
  return { status: "error", message, fieldErrors, inviteToken: null };
}

/**
 * Creates a NEW account and adds it to the rendered workspace, in one nested
 * write, so a failure never leaves an account that belongs to no workspace.
 *
 * No password: the account gets a one-time invite instead (lib/invite-token.ts).
 * Only the token's hash is stored; the raw token is returned ONCE, for the
 * dialog to turn into a link, and is never readable again. The invitee sets
 * their own password at /invite/<token>.
 *
 * An email that already has an account is refused rather than added to this
 * workspace. "Email already in use" says no more than the public register form
 * already does.
 */
export async function createUser(
  _previous: CreateUserFormState,
  formData: FormData,
): Promise<CreateUserFormState> {
  const session = await requireSession();

  const organizationId = idSchema.safeParse(formData.get("organizationId"));
  if (!organizationId.success) return createFailure(STALE_PAGE);

  // Composite primary key — a miss for any org the caller does not belong to.
  const caller = await prisma.membership.findUnique({
    where: {
      userId_organizationId: { userId: session.user.id, organizationId: organizationId.data },
    },
    select: { role: true },
  });
  if (caller === null) return createFailure(STALE_PAGE);
  if (caller.role === "MEMBER") return createFailure("Only owners and admins can add users.");

  const parsed = createUserSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) return createFailure(null, userFormFieldErrors(parsed.error));
  const { name, email, role } = parsed.data;

  if (!assignableRoles(caller.role).includes(role)) {
    return createFailure(null, { role: "Only an owner can add an owner." });
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing !== null) return createFailure(null, { email: EMAIL_TAKEN });

  const invite = issueInvite();

  let created: { id: string };
  try {
    created = await prisma.user.create({
      data: {
        name,
        email,
        inviteToken: invite.tokenHash,
        inviteExpiresAt: invite.expiresAt,
        memberships: { create: { organizationId: organizationId.data, role } },
      },
      select: { id: true },
    });
  } catch (error: unknown) {
    // The unique index is the real guard: two adds racing with one email both
    // pass the check above, and exactly one of them lands here.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return createFailure(null, { email: EMAIL_TAKEN });
    }
    throw error;
  }

  // The token stays out of the audit entry: the log is readable by every admin,
  // and a token there would be a working link.
  audit({
    organizationId: organizationId.data,
    actorId: session.user.id,
    action: "user.created",
    targetType: "user",
    targetId: created.id,
    targetLabel: name,
    metadata: { role },
  });
  revalidatePath(USERS_PATH);
  return { status: "success", message: null, fieldErrors: {}, inviteToken: invite.token };
}

/**
 * Renames a member of the rendered workspace. `User.name` is account-wide, so
 * this takes the same reach as suspend and delete, not only a role check here.
 */
export async function updateUser(
  _previous: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const target = await readTarget(formData);
  if (target === null) return formFailure(STALE_PAGE);

  const parsed = updateUserSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { status: "error", message: null, fieldErrors: userFormFieldErrors(parsed.error) };
  }
  const { name } = parsed.data;

  let entry: AuditEntry | null = null;
  const result = await inTransaction(async (tx) => {
    const roles = await checkRoles(tx, target);
    if (!roles.ok) return failure(roles.message);
    const reach = await checkAccountReach(tx, target);
    if (reach !== null) return failure(reach);

    if (roles.targetName === name) return success("Name unchanged.");
    await tx.user.update({ where: { id: target.userId }, data: { name }, select: { id: true } });
    entry = {
      organizationId: target.organizationId,
      actorId: target.callerId,
      action: "user.updated",
      targetType: "user",
      targetId: target.userId,
      targetLabel: name,
      metadata: { from: roles.targetName, to: name },
    };
    return success("User updated.");
  });

  if (result.status !== "success") return formFailure(result.message ?? STALE_PAGE);

  if (entry !== null) audit(entry);
  revalidatePath(USERS_PATH);
  return { status: "success", message: null, fieldErrors: {} };
}

// ---------------------------------------------------------------------------
// Resend invite
// ---------------------------------------------------------------------------

/**
 * Issues a fresh invite link for an account that was invited and never set a
 * password, and returns the new raw token ONCE for the row's dialog to show.
 * The new hash overwrites the old one, so the previous link stops working.
 *
 * "Was invited" is decided by an outstanding invite (`inviteToken` set — an
 * expired one included), NOT by a missing `passwordHash` alone. The demo
 * account and GitHub-only users have no hash either, and a fresh invite for one
 * of them would hand the admin a link that sets a password on someone else's
 * account. Account reach applies for the same reason as suspend and delete.
 */
export async function resendInvite(
  _previous: ResendInviteState,
  formData: FormData,
): Promise<ResendInviteState> {
  const target = await readTarget(formData);
  if (target === null) return { ...failure(STALE_PAGE), token: null };

  let token: string | null = null;
  let entry: AuditEntry | null = null;
  const result = await inTransaction(async (tx) => {
    const roles = await checkRoles(tx, target);
    if (!roles.ok) return failure(roles.message);
    const reach = await checkAccountReach(tx, target);
    if (reach !== null) return failure(reach);

    const invite = issueInvite();
    // Conditional on the invite still being outstanding, so an acceptance that
    // lands in the meantime cannot be undone by a fresh token.
    const { count } = await tx.user.updateMany({
      where: { id: target.userId, passwordHash: null, inviteToken: { not: null } },
      data: { inviteToken: invite.tokenHash, inviteExpiresAt: invite.expiresAt },
    });
    if (count === 0) {
      return failure("This user has already accepted their invite, or was never invited.");
    }

    token = invite.token;
    entry = {
      organizationId: target.organizationId,
      actorId: target.callerId,
      action: "user.invite_resent",
      targetType: "user",
      targetId: target.userId,
      targetLabel: roles.targetLabel,
      metadata: { resendInvite: true },
    };
    return success("Invite resent.");
  });

  if (result.status !== "success" || token === null) return { ...result, token: null };

  if (entry !== null) audit(entry);
  revalidatePath(USERS_PATH);
  return { ...result, token };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/**
 * Leading characters a spreadsheet treats as the start of a formula. Names are
 * user-controlled (registration, Profile, Add user), so a name like
 * `=HYPERLINK(...)` must arrive as text, not run on the admin's machine.
 * Prefixing an apostrophe is OWASP's recommended neutralisation.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One RFC 4180 field: formula-guarded, quotes doubled, always quoted. */
function csvField(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Every member of the rendered workspace matching the table's current search,
 * in the table's current order — all pages, not just the one on screen — as CSV.
 *
 * OWNER and ADMIN only: the table itself is visible to members, but a one-click
 * file of every email address is an administrator's tool. The export is
 * recorded in the audit log for the same reason.
 *
 * The file starts with a UTF-8 byte-order mark so Excel reads accented names
 * correctly, and uses CRLF line endings, per RFC 4180.
 */
export async function exportUsersCSV(
  organizationId: string,
  rawQuery: string,
  rawSort: string,
  rawDir: string,
): Promise<ExportUsersResult> {
  const session = await requireSession();

  const org = idSchema.safeParse(organizationId);
  if (!org.success) return { status: "error", message: STALE_PAGE };

  // Composite primary key — a miss for any org the caller does not belong to.
  const caller = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: session.user.id, organizationId: org.data } },
    select: { role: true, organization: { select: { slug: true } } },
  });
  if (caller === null) return { status: "error", message: STALE_PAGE };
  if (caller.role === "MEMBER") {
    return { status: "error", message: "Only owners and admins can export users." };
  }

  // The same narrowing the page applies to its URL — nothing reaches the query raw.
  const query = parseUserQuery(rawQuery);
  const rows = await prisma.membership.findMany({
    where: userListWhere(org.data, query),
    orderBy: userListOrderBy(parseUserSort(rawSort), parseSortDirection(rawDir)),
    select: {
      role: true,
      createdAt: true,
      user: { select: { name: true, email: true, suspendedAt: true } },
    },
  });

  const header = ["Name", "Email", "Role", "Status", "Joined"];
  const lines = rows.map((row) =>
    [
      row.user.name ?? "",
      row.user.email,
      row.role,
      row.user.suspendedAt === null ? "Active" : "Suspended",
      row.createdAt.toISOString(),
    ]
      .map(csvField)
      .join(","),
  );
  const csv = `﻿${[header.map(csvField).join(","), ...lines].join("\r\n")}\r\n`;

  audit({
    organizationId: org.data,
    actorId: session.user.id,
    action: "users.exported",
    targetType: "workspace",
    targetId: org.data,
    metadata: { count: rows.length, query: query || null },
  });

  const day = new Date().toISOString().slice(0, 10);
  return {
    status: "success",
    csv,
    filename: `users-${caller.organization.slug}-${day}.csv`,
    count: rows.length,
  };
}

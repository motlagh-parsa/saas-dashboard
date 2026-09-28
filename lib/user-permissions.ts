import type { Role } from "@prisma/client";

/**
 * Who may do what to whom on /dashboard/users.
 *
 * Pure functions over roles, with no database access, so the page (deciding what
 * to OFFER) and `lib/user-actions.ts` (deciding what to ALLOW) apply one rule
 * set. The page's answer is a courtesy; the action's is the check that counts.
 *
 * Type-only Prisma import, so this module is safe on either side of the
 * server/client boundary — the same reason `lib/invoice-list.ts` can name an
 * `InvoiceStatus`.
 *
 * The ladder:
 *   - OWNER manages everyone, and is the only role that can grant OWNER.
 *   - ADMIN manages ADMINs and MEMBERs, never an OWNER.
 *   - MEMBER manages nobody.
 * Nobody manages themselves here: self-service lives in Settings (Leave
 * workspace), where the last-owner rule already has a home.
 */

/** Role enum order, most privileged first — the same order Postgres sorts it. */
export const ROLES: readonly Role[] = ["OWNER", "ADMIN", "MEMBER"];

/** Whether `caller` may change, suspend or delete someone holding `target`. */
export function canManage(caller: Role, target: Role): boolean {
  if (caller === "OWNER") return true;
  if (caller === "ADMIN") return target !== "OWNER";
  return false;
}

/** The roles `caller` may hand out. An admin cannot mint owners. */
export function assignableRoles(caller: Role): readonly Role[] {
  if (caller === "OWNER") return ROLES;
  if (caller === "ADMIN") return ["ADMIN", "MEMBER"];
  return [];
}

export interface WorkspaceRole {
  readonly organizationId: string;
  readonly role: Role;
}

/**
 * Suspending or deleting acts on the whole ACCOUNT, and an account can belong
 * to several workspaces. Being an admin of one of them must not reach into the
 * others, so an account-wide action needs authority in EVERY workspace the
 * target belongs to.
 *
 * This also makes the last-owner rule hold by construction: wherever the target
 * is an OWNER, the caller must be an OWNER too, so a second owner always remains.
 * The delete action still re-checks the owner count explicitly.
 */
export function hasAccountReach(
  callerMemberships: readonly WorkspaceRole[],
  targetMemberships: readonly WorkspaceRole[],
): boolean {
  const callerRoleByOrg = new Map<string, Role>(
    callerMemberships.map((membership) => [membership.organizationId, membership.role]),
  );
  return targetMemberships.every((membership) => {
    const callerRole = callerRoleByOrg.get(membership.organizationId);
    return callerRole !== undefined && canManage(callerRole, membership.role);
  });
}

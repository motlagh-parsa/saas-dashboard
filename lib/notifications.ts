"use server";

// Notification data layer — the only module that reads or writes the feed.
//
// The hardcoded demo feed this replaced is gone. Nothing in this file knows
// about icons or Tailwind classes: presentation lookups live in
// `components/dashboard/notification-meta.ts`, and the serializable shape that
// crosses into the client is `lib/notification-view.ts`. Keep it that way.
//
// ---------------------------------------------------------------------------
// Why `"use server"` is on the FILE and not on the two mutations
// ---------------------------------------------------------------------------
// `markAsRead` / `markAllAsRead` have to be callable from a Client Component (the
// bell popover is a client island). Next.js only supports that for functions
// exported from a module carrying the file-level directive — an inline
// `"use server"` inside a function body in an otherwise-normal server module
// would drag this module, and Prisma with it, into the client graph.
//
// There is no `import "server-only"` here for the same reason: a `"use server"`
// module is already server-only by construction (client imports are replaced with
// a reference stub), and the redundant guard only risks tripping the client
// bundler.
//
// The cost of the file-level directive is that EVERY export — including the two
// reads — becomes a callable endpoint, so `orgId` arriving from a caller is
// untrusted input. That is why each function starts with `assertMembership`:
// passing someone else's organization id must fail, not return their feed.
//
// ---------------------------------------------------------------------------
// Tenancy contract
// ---------------------------------------------------------------------------
//   - Every query and mutation filters on `organizationId`. No exceptions.
//   - `markAsRead` scopes the WRITE itself by `organizationId` (updateMany), so a
//     notification id belonging to another tenant matches zero rows rather than
//     being marked read. Checking ownership and then updating by id alone would
//     be the same bug with extra steps.
//   - `userId = NULL` is an ORG-WIDE notification; a set `userId` is personal to
//     that member. Both are part of the org feed, which is why the reads filter on
//     the organization only.
//   - `archivedAt` set means filed away. Archived rows are out of the default
//     feed, the unread feed, and the unread count — they appear only when asked
//     for with `archivedOnly`. Archiving never touches `readAt`.
//
// Creating notifications does NOT live here: every export of this module is a
// public endpoint, and a create would let any member post arbitrary rows into
// their workspace's feed. Server code writes through `lib/notification-writer.ts`.
import { revalidatePath } from "next/cache";
import type { Notification, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";

// NOTE: the row and enum types are NOT re-exported from here, deliberately.
//
// Next's Server Action transform turns every export of a `"use server"` module
// into a registered action endpoint, and it does that from the export list alone
// — a `export type { … }` re-export is registered too, then fails to resolve at
// build time ("Export NotificationType doesn't exist in target module"). Import
// the types straight from `@prisma/client`, which is where they are generated;
// `lib/notification-view.ts` is the shape everything above the data layer
// actually passes around.

/** Hard cap on `options.limit`, so a caller cannot ask for the whole table. */
const MAX_LIMIT = 100;

export interface GetNotificationsOptions {
  /** Restrict to `readAt IS NULL`. */
  readonly unreadOnly?: boolean;
  /**
   * Return ONLY archived rows (`archivedAt IS NOT NULL`). Without it every read
   * excludes archived rows, so they never pollute the main or unread feed.
   */
  readonly archivedOnly?: boolean;
  /** Page size. Clamped to [1, 100]; omitted means "no limit". */
  readonly limit?: number;
}

/**
 * Verifies the session user actually belongs to `orgId`.
 *
 * `requireSession()` answers "is anyone signed in"; this answers "may THIS user
 * see THIS tenant". Both are needed: the file-level `"use server"` directive
 * publishes these functions as endpoints, so `orgId` is caller-controlled.
 */
async function assertMembership(orgId: string): Promise<string> {
  const session = await requireSession();
  const userId = session.user?.id;
  if (!userId) {
    throw new Error("Not authenticated.");
  }

  // Composite primary key — an index seek, not a scan.
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId: orgId } },
    select: { organizationId: true },
  });
  if (membership === null) {
    throw new Error("Organization not found.");
  }

  return userId;
}

/** Clamps an untrusted page size into range; `undefined` means unbounded. */
function resolveLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/**
 * The org feed, newest first — the live feed by default, or the archive with
 * `archivedOnly`.
 *
 * Served by `@@index([organizationId, readAt, archivedAt, createdAt])`: the
 * tenant filter leads, and the read/archived filters and the `createdAt` sort
 * are the columns after it.
 */
export async function getNotifications(
  orgId: string,
  options?: GetNotificationsOptions,
): Promise<Notification[]> {
  await assertMembership(orgId);

  const where: Prisma.NotificationWhereInput = {
    organizationId: orgId,
    archivedAt: options?.archivedOnly === true ? { not: null } : null,
    ...(options?.unreadOnly === true ? { readAt: null } : {}),
  };

  return prisma.notification.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: resolveLimit(options?.limit),
  });
}

/**
 * How many unread notifications this tenant has — the number on the bell.
 *
 * Counted in Postgres, never by reading rows and measuring the array. Hits the
 * `[organizationId, readAt, archivedAt]` prefix of the same index as the feed.
 * Archived rows are excluded: the bell must never count something the feed it
 * opens onto no longer shows.
 */
export async function getUnreadCount(orgId: string): Promise<number> {
  await assertMembership(orgId);

  return prisma.notification.count({
    where: { organizationId: orgId, readAt: null, archivedAt: null },
  });
}

/**
 * Marks one notification read. Returns the number of rows actually updated — 0
 * when the id does not exist OR belongs to a different tenant, which are
 * deliberately indistinguishable to the caller.
 *
 * The tenant filter is part of the UPDATE's own WHERE clause, so there is no
 * window between a check and the write.
 */
export async function markAsRead(
  notificationId: string,
  orgId: string,
): Promise<number> {
  await assertMembership(orgId);

  const result = await prisma.notification.updateMany({
    where: { id: notificationId, organizationId: orgId, readAt: null },
    data: { readAt: new Date() },
  });

  if (result.count > 0) {
    // Layout scope: the unread count lives in the dashboard header, not just on
    // the notifications page.
    revalidatePath("/dashboard", "layout");
  }

  return result.count;
}

/**
 * Marks every unread notification in the tenant read. Returns the number cleared.
 *
 * `readAt: null` in the filter keeps this idempotent-ish: re-running does not
 * rewrite the timestamp on items that were already read, so "when did I read
 * this" survives a second click.
 */
export async function markAllAsRead(orgId: string): Promise<number> {
  await assertMembership(orgId);

  const result = await prisma.notification.updateMany({
    where: { organizationId: orgId, readAt: null },
    data: { readAt: new Date() },
  });

  if (result.count > 0) {
    revalidatePath("/dashboard", "layout");
  }

  return result.count;
}

/**
 * Archives one notification, read or not. Returns the number of rows archived —
 * 0 when the id does not exist, belongs to another tenant, or is already
 * archived, all deliberately indistinguishable. Tenant-scoped in the UPDATE's own
 * WHERE clause, same as `markAsRead`.
 */
export async function archiveNotification(
  notificationId: string,
  orgId: string,
): Promise<number> {
  await assertMembership(orgId);

  const result = await prisma.notification.updateMany({
    where: { id: notificationId, organizationId: orgId, archivedAt: null },
    data: { archivedAt: new Date() },
  });

  if (result.count > 0) {
    // Layout scope: an archived unread row also leaves the bell's count.
    revalidatePath("/dashboard", "layout");
  }

  return result.count;
}

/**
 * Archives every READ notification still in the live feed. Unread rows are left
 * where they are — clearing the inbox must not bury something nobody has seen.
 * Returns the number archived.
 */
export async function archiveAllRead(orgId: string): Promise<number> {
  await assertMembership(orgId);

  const result = await prisma.notification.updateMany({
    where: { organizationId: orgId, readAt: { not: null }, archivedAt: null },
    data: { archivedAt: new Date() },
  });

  if (result.count > 0) {
    revalidatePath("/dashboard", "layout");
  }

  return result.count;
}

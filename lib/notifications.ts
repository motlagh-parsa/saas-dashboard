"use server";

// Notification data layer — real rows, not the demo feed.
//
// The hardcoded UI feed that used to live at this path now lives in
// `lib/notification-demo-data.ts` (display keys, icon/tone lookups, hand-written
// time labels). Nothing in this file knows about icons or Tailwind classes, and
// nothing in that file touches the database. Keep it that way.
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
import { revalidatePath } from "next/cache";
import type { Notification, NotificationType, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";

// The persisted vocabulary is Prisma's enum, re-exported so callers have one
// obvious import for both the row and its type. NOT the kebab-case display union
// in `lib/notification-demo-data.ts` — the two are different alphabets.
export type { Notification, NotificationType };

/** Hard cap on `options.limit`, so a caller cannot ask for the whole table. */
const MAX_LIMIT = 100;

export interface GetNotificationsOptions {
  /** Restrict to `readAt IS NULL`. */
  readonly unreadOnly?: boolean;
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
 * The org feed, newest first.
 *
 * Served by `@@index([organizationId, readAt, createdAt])`: the tenant filter and
 * the optional `readAt IS NULL` filter are both index prefixes, and `createdAt`
 * is the trailing sort column, so the ordering comes off the index rather than
 * from a sort node.
 */
export async function getNotifications(
  orgId: string,
  options?: GetNotificationsOptions,
): Promise<Notification[]> {
  await assertMembership(orgId);

  const where: Prisma.NotificationWhereInput = {
    organizationId: orgId,
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
 * `[organizationId, readAt, ...]` prefix of the same index as the feed.
 */
export async function getUnreadCount(orgId: string): Promise<number> {
  await assertMembership(orgId);

  return prisma.notification.count({
    where: { organizationId: orgId, readAt: null },
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

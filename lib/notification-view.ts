// The notification shape that crosses the server/client boundary.
//
// `lib/notifications.ts` returns Prisma rows, whose `createdAt` / `readAt` are
// real `Date` objects. Those get flattened to ISO strings here, once, at the edge
// where the server hands data to a client island:
//
//   - Props are serialized. Every client surface would otherwise have to guess
//     whether it holds a `Date` or the string it deserialized into, and the two
//     behave differently under `.getTime()`.
//   - A row also carries fields the interface has no use for (`organizationId`,
//     `userId`). Shipping the tenant id into the browser on every row is noise at
//     best; the org id the client needs for its actions is passed once, deliberately.
//
// Type-only imports, no runtime dependencies: safe for a client component to
// import the type from here without pulling Prisma anywhere near the bundle.
// (Straight from `@prisma/client`, not from `lib/notifications.ts` — a
// `"use server"` module cannot re-export a type without Next trying to publish it
// as an action.)
import type { Notification, NotificationType } from "@prisma/client";

export interface NotificationView {
  readonly id: string;
  /** Prisma's `NotificationType` — an enum of string literals, so it serializes as-is. */
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string;
  /** ISO-8601. Format it through `lib/format.ts`, never by hand. */
  readonly createdAt: string;
  /** ISO-8601, or `null` while the notification is still unread. */
  readonly readAt: string | null;
  /** ISO-8601, or `null` while the notification is in the live feed. */
  readonly archivedAt: string | null;
}

export function toNotificationView(row: Notification): NotificationView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
  };
}

export function toNotificationViews(
  rows: readonly Notification[],
): NotificationView[] {
  return rows.map(toNotificationView);
}

/** Unread is the absence of a read timestamp — stated once so nothing re-derives it. */
export function isUnread(item: NotificationView): boolean {
  return item.readAt === null;
}

/** Archived is the presence of an archive timestamp — same rule, stated once. */
export function isArchived(item: NotificationView): boolean {
  return item.archivedAt !== null;
}

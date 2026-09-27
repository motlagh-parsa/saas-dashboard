// Notifications. Render mode: dynamic — it reads the session cookie and a query
// param, so it is never statically rendered.
//
// Data flow, in order:
//   1. `requireSession()` is the authorization gate. Middleware is edge-only and
//      is NOT authz; the line is held server-side in every protected page.
//   2. The organization is resolved SERVER-SIDE by lib/active-org.ts: the
//      workspace picked in the switcher, honoured only while the caller is a
//      member of it, else their most privileged one.
//   3. The feed comes from `lib/notifications.ts` — real rows, tenant-filtered
//      there as well as here — and is flattened to a serializable view before it
//      reaches the client island that renders it.
//
// The writes live in that same module and are called from the island; this page
// only reads. After a write the island calls `router.refresh()`, which re-runs
// this page and the dashboard layout, so the rows, the header count, and the
// bell in the header all move together.
import type { ComponentType } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Archive, Bell, Building2, CheckCheck } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { getNotifications, getUnreadCount } from "@/lib/notifications";
import { isUnread, toNotificationViews, type NotificationView } from "@/lib/notification-view";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { NavChip } from "@/components/dashboard/nav-chip";
import { NotificationPanel } from "@/components/dashboard/notification-panel";

export const metadata: Metadata = {
  title: "Notifications",
  description: "Billing failures, churn risk, and metric threshold alerts.",
};

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/**
 * URL state for the tabs. Same shape as `lib/invoice-filter.ts` — a fixed
 * whitelist, a parser that falls back to the default on anything unrecognised,
 * and an option record that carries its own empty copy — kept local because
 * three static values do not need their own module.
 */
type NotificationFilterKey = "all" | "unread" | "archived";

interface NotificationFilterOption {
  readonly key: NotificationFilterKey;
  readonly label: string;
  /** Names the subset for screen readers, since the tabs are the only visible cue. */
  readonly listLabel: string;
  readonly emptyIcon: ComponentType<{ className?: string }>;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
}

/**
 * Three buckets:
 *
 *   all      — the live feed (everything not archived), read and unread together.
 *   unread   — the subset of the live feed where `readAt` is still null.
 *   archived — rows filed away with `archivedAt`. A separate query, run only when
 *              this tab is open; archived rows never appear in the other two.
 */
const NOTIFICATION_FILTERS: readonly NotificationFilterOption[] = [
  {
    key: "all",
    label: "All",
    listLabel: "All notifications",
    emptyIcon: Bell,
    emptyTitle: "No notifications yet",
    emptyDescription:
      "Billing failures, churn risk, and metric threshold alerts land here as they happen.",
  },
  {
    key: "unread",
    label: "Unread",
    listLabel: "Unread notifications",
    emptyIcon: CheckCheck,
    emptyTitle: "You're all caught up",
    emptyDescription:
      "Every notification in your inbox has been read. New alerts will show up here first.",
  },
  {
    key: "archived",
    label: "Archived",
    listLabel: "Archived notifications",
    emptyIcon: Archive,
    emptyTitle: "No archived notifications",
    emptyDescription: "Notifications you archive are stored here.",
  },
];

const DEFAULT_FILTER: NotificationFilterKey = "all";

/**
 * Narrows an untrusted `?filter=` param to a known key. Anything unrecognised —
 * including the repeated-param array form — falls back to "all" rather than
 * erroring, because a mangled URL should still render the inbox.
 */
function parseNotificationFilter(
  raw: string | string[] | undefined,
): NotificationFilterKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = NOTIFICATION_FILTERS.find((option) => option.key === value);
  return match ? match.key : DEFAULT_FILTER;
}

function notificationFilterOption(
  key: NotificationFilterKey,
): NotificationFilterOption {
  return NOTIFICATION_FILTERS.find((option) => option.key === key) ?? NOTIFICATION_FILTERS[0];
}

/** The default filter stays out of the URL, so the canonical link is the bare path. */
function notificationsHref(key: NotificationFilterKey): string {
  return key === DEFAULT_FILTER
    ? "/dashboard/notifications"
    : `/dashboard/notifications?filter=${key}`;
}

/**
 * Which rows a tab shows. "Unread" is filtered in memory rather than re-queried:
 * the live feed is already in hand, and unread is a property of a row we are
 * holding. "Archived" is a different set of rows, fetched only for that tab.
 */
function selectNotifications(
  key: NotificationFilterKey,
  feed: readonly NotificationView[],
  archived: readonly NotificationView[],
): readonly NotificationView[] {
  if (key === "unread") return feed.filter(isUnread);
  if (key === "archived") return archived;
  return feed;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface NotificationsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function NotificationsPage({
  searchParams,
}: NotificationsPageProps) {
  const session = await requireSession();
  const params = await searchParams;

  const filter = parseNotificationFilter(params.filter);
  const option = notificationFilterOption(filter);

  // Tenant resolution: the workspace picked in the switcher (verified against the
  // caller's memberships), else their most privileged one — lib/active-org.ts.
  const organizationId = await getActiveOrgId(session.user.id);

  if (organizationId === null) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="Notifications are scoped to a workspace. Ask an owner to add you to theirs, or create one to start tracking revenue."
          action={
            <Button
              asChild
              className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9"
            >
              <Link href="/dashboard/settings">Open workspace settings</Link>
            </Button>
          }
          className="rise mt-2"
        />
      </main>
    );
  }

  // The count is asked of Postgres rather than measured off the array: the two
  // agree here, but the bell in the layout asks the same question the same way,
  // and only one of them holds the rows. The archive is only fetched when its
  // tab is open — nothing else on this page reads it.
  const [rows, unreadCount, archivedRows] = await Promise.all([
    getNotifications(organizationId),
    getUnreadCount(organizationId),
    filter === "archived"
      ? getNotifications(organizationId, { archivedOnly: true })
      : Promise.resolve([]),
  ]);

  const feed = toNotificationViews(rows);
  const visible = selectNotifications(filter, feed, toNotificationViews(archivedRows));
  const archivableCount = feed.filter((item) => !isUnread(item)).length;

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {/*
        Hierarchy. There is no headline figure on this page, so the number that
        matters — how much is waiting for you — is stated once, in the header, in
        words. Everything below it is a register, and the register itself gets no
        second heading: the h1 already names it.
      */}
      <header className="rise">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          Notifications
        </h1>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">
          {unreadCount === 0 ? "Nothing unread" : `${unreadCount} unread`}
          <span aria-hidden className="px-1.5 text-muted-foreground/40">
            ·
          </span>
          {feed.length} in your inbox
        </p>
      </header>

      <section className="rise mt-3 [animation-delay:60ms]">
        <NotificationPanel
          orgId={organizationId}
          items={visible}
          listLabel={option.listLabel}
          unreadCount={unreadCount}
          archivableCount={archivableCount}
          showArchiveAll={filter !== "archived"}
          tabs={NOTIFICATION_FILTERS.map((entry) => (
            <NavChip
              key={entry.key}
              href={notificationsHref(entry.key)}
              active={entry.key === filter}
            >
              {entry.label}
            </NavChip>
          ))}
          empty={
            <EmptyState
              icon={option.emptyIcon}
              title={option.emptyTitle}
              description={option.emptyDescription}
              action={
                filter === DEFAULT_FILTER ? undefined : (
                  <Button asChild variant="outline" className="h-11 px-4 sm:h-9">
                    <Link href={notificationsHref(DEFAULT_FILTER)}>
                      Show all notifications
                    </Link>
                  </Button>
                )
              }
              className="m-4 border-0 bg-transparent py-10"
            />
          }
        />
      </section>
    </main>
  );
}

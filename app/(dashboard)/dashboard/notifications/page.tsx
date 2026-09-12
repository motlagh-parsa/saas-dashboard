// Notifications. Render mode: dynamic — it reads the session cookie and a query
// param, so it is never statically rendered.
//
// This page still renders the DEMO feed. The hardcoded notifications and their
// type/tone lookups live in `lib/notification-demo-data.ts`, shared with the bell
// dropdown in the dashboard shell so the two surfaces can never disagree about
// what is waiting for you. Every relative timestamp there is a hand-written
// display string, not a value derived from `Date.now()`.
//
// The database-backed query/mutation layer is `lib/notifications.ts`. This page
// does not consume it yet — wiring the real rows in is a separate hand-off.
//
// `requireSession()` is still the first statement and its result is discarded on
// purpose. Middleware is edge-only and is NOT authz; the security line is held
// server-side in every protected page, including the ones with nothing to leak.
// "No data, so no gate" is exactly the reasoning this codebase has already
// rejected on Customers, Reports and Settings.
//
// UI ONLY. "Mark all as read" has no handler and the rows are not links. Writes
// are a separate hand-off.
import type { ComponentType } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Archive, Bell, CheckCheck } from "lucide-react";

import { requireSession } from "@/lib/auth";
import { cn } from "@/lib/utils";
import {
  archivedNotifications,
  inboxNotifications,
  unreadNotifications,
  TONE_CLASS,
  TYPE_META,
  type DemoNotification,
} from "@/lib/notification-demo-data";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/dashboard/empty-state";
import { NavChip } from "@/components/dashboard/nav-chip";

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
 * Three buckets, and they are NOT three slices of one list:
 *
 *   all      — everything not archived. The inbox, read and unread together.
 *   unread   — the subset of the inbox where `read` is false.
 *   archived — everything archived, regardless of read state. A separate bucket,
 *              not a subset of the inbox.
 *
 * Stating it this way is what keeps "All" from lying: an archived notification
 * has been filed, so it is not in the inbox any more.
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
    emptyTitle: "Nothing archived",
    emptyDescription:
      "Notifications you file away are kept here. Your inbox is still the place to start.",
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

/** Maps a tab to the shared selector that defines that bucket. */
function selectNotifications(key: NotificationFilterKey): readonly DemoNotification[] {
  if (key === "unread") return unreadNotifications();
  if (key === "archived") return archivedNotifications();
  return inboxNotifications();
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
  await requireSession();
  const params = await searchParams;

  const filter = parseNotificationFilter(params.filter);
  const option = notificationFilterOption(filter);
  const visible = selectNotifications(filter);

  const inbox = selectNotifications("all");
  const unreadCount = selectNotifications("unread").length;

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {/*
        Hierarchy. There is no headline figure on this page, so the number that
        matters — how much is waiting for you — is stated once, in the header,
        in words. Everything below it is a register, and the register itself
        gets no second heading: the h1 already names it.
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
          {inbox.length} in your inbox
        </p>
      </header>

      <section className="rise mt-3 [animation-delay:60ms]">
        <Card className="gap-0 py-0">
          {/*
            The filter strip sits above everything it scopes and nothing else —
            the same grammar as the invoice ledger, so "tabs scoping a list"
            looks the same everywhere in the product. Plain links, not toggle
            state: the tab lives in the URL, so it is shareable, back-button
            correct, and works with JavaScript off.
          */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div
              role="group"
              aria-label="Filter notifications"
              className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5"
            >
              {NOTIFICATION_FILTERS.map((entry) => (
                <NavChip
                  key={entry.key}
                  href={notificationsHref(entry.key)}
                  active={entry.key === filter}
                >
                  {entry.label}
                </NavChip>
              ))}
            </div>

            {/*
              Inert by design — no handler, no action. `type="button"` so it can
              never submit a form it is nested inside. Disabled when there is
              nothing to mark, because a live control that provably does nothing
              is worse than one that says so.
            */}
            <Button
              type="button"
              variant="outline"
              disabled={unreadCount === 0}
              className="h-11 px-4 sm:h-9"
            >
              <CheckCheck />
              Mark all as read
            </Button>
          </div>

          {visible.length === 0 ? (
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
          ) : (
            /*
              `role="list"` is explicit: Tailwind's reset strips the marker, and
              some screen readers drop list semantics along with it.
            */
            <ul role="list" aria-label={option.listLabel}>
              {visible.map((item) => {
                const meta = TYPE_META[item.type];
                const Icon = meta.icon;

                return (
                  /*
                    NOT a link and NOT a button — there is nowhere for a row to
                    go. The hover is a scanning affordance only, which is why it
                    is the same quiet `accent/60` wash the nav chips use rather
                    than anything that reads as "clickable".
                  */
                  <li
                    key={item.id}
                    className="flex items-start gap-3 border-t border-border px-4 py-3 transition-colors first:border-t-0 hover:bg-accent/60"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        item.read ? "bg-muted-foreground/40" : "bg-brand",
                      )}
                    />
                    <Icon
                      aria-hidden
                      className={cn("mt-0.5 size-4 shrink-0", TONE_CLASS[meta.tone])}
                    />

                    <div className="min-w-0 flex-1">
                      {/*
                        Unread is carried by weight and by the brass dot, never
                        by dimming the read rows: a notification you have already
                        seen is still something you need to be able to read.
                      */}
                      <p
                        className={cn(
                          "truncate text-[0.8125rem] leading-snug text-foreground",
                          item.read ? "font-medium" : "font-semibold",
                        )}
                      >
                        {item.title}
                        {item.read ? null : <span className="sr-only"> (unread)</span>}
                      </p>
                      <p className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
                        {item.description}
                      </p>
                    </div>

                    {/*
                      Fixed width so the timestamps form a real column edge
                      rather than a ragged one — the same tabular alignment the
                      ledger's amount column gets.
                    */}
                    <span className="mt-0.5 w-[5.5rem] shrink-0 text-right font-mono text-[0.6875rem] whitespace-nowrap text-muted-foreground">
                      {item.timeLabel}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>
    </main>
  );
}

// Notifications. Render mode: dynamic — it reads the session cookie and a query
// param, so it is never statically rendered.
//
// This page has NO data layer. Every notification below is a hardcoded demo
// object and every relative timestamp is a hand-written display string, not a
// value derived from `Date.now()`. Computing real elapsed time against invented
// content would be fake precision: the events did not happen, so "2 hours ago"
// is copy, not a measurement.
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
import {
  Archive,
  Bell,
  CheckCheck,
  Clock,
  Database,
  FileText,
  Receipt,
  TrendingDown,
  TrendingUp,
  UserMinus,
  UserPlus,
} from "lucide-react";

import { requireSession } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/dashboard/empty-state";
import { NavChip } from "@/components/dashboard/nav-chip";

export const metadata: Metadata = {
  title: "Notifications",
  description: "Billing failures, churn risk, and metric threshold alerts.",
};

// ---------------------------------------------------------------------------
// Notification model
// ---------------------------------------------------------------------------

/**
 * The kinds of event this workspace emits. A closed union rather than a free
 * string: the icon and the tone are both looked up from it, so an unknown type
 * should be a compile error, not a blank cell.
 */
type NotificationType =
  | "mrr-milestone"
  | "invoice-paid"
  | "invoice-overdue"
  | "churn"
  | "member"
  | "revenue-dip"
  | "report"
  | "system";

/**
 * Direction, not category.
 *
 * `positive` is money in, `negative` is money at risk, `neutral` is everything
 * operational. This is the same `--positive` / `--negative` pair the metric
 * deltas already use, so a row's tone means the same thing here as it does on
 * the overview.
 *
 * Colour is never the only cue: every toned row also says what it is in words
 * ("Churn alert", "Revenue dip detected"), so the ramp is redundant by design.
 */
type NotificationTone = "positive" | "negative" | "neutral";

interface NotificationTypeMeta {
  readonly icon: ComponentType<{ className?: string }>;
  readonly tone: NotificationTone;
}

/**
 * Icons are reused from elsewhere in the product wherever a precedent exists —
 * `TrendingUp` from the Revenue nav item, `Receipt` from the invoice table,
 * `UserMinus` from the churn tile, `UserPlus` from Settings' invite button,
 * `FileText` from the Reports nav item. Only backup and overdue are new, and
 * both stay size-4 stroke icons like every other icon in this app.
 */
const TYPE_META: Record<NotificationType, NotificationTypeMeta> = {
  "mrr-milestone": { icon: TrendingUp, tone: "positive" },
  "invoice-paid": { icon: Receipt, tone: "positive" },
  "invoice-overdue": { icon: Clock, tone: "negative" },
  churn: { icon: UserMinus, tone: "negative" },
  member: { icon: UserPlus, tone: "neutral" },
  "revenue-dip": { icon: TrendingDown, tone: "negative" },
  report: { icon: FileText, tone: "neutral" },
  system: { icon: Database, tone: "neutral" },
};

/**
 * Bare icons on the card surface rather than the `bg-x/12 text-x` chip used for
 * status badges. Measured on paper, `--positive` and `--negative` sit near
 * 3.5:1 against a white card and comfortably higher on graphite — fine for a
 * graphical mark, and putting them on a 12% wash of themselves would drop them
 * under the floor the way `text-brand` on `bg-brand/15` does. Bare is also
 * denser, which is what a list of ten rows wants.
 */
const TONE_CLASS: Record<NotificationTone, string> = {
  positive: "text-positive",
  negative: "text-negative",
  neutral: "text-muted-foreground",
};

interface DemoNotification {
  readonly id: string;
  readonly type: NotificationType;
  readonly title: string;
  readonly description: string;
  /**
   * A literal display string, written by hand. NOT derived from a `Date`.
   * Rendered in a plain `<span>` rather than `<time>` for the same reason:
   * there is no real datetime to put in a `dateTime` attribute.
   */
  readonly timeLabel: string;
  readonly read: boolean;
  readonly archived: boolean;
}

/**
 * Newest first. Three unread, which is deliberate: the sidebar hardcodes
 * `count: 3` on the Notifications nav item, and a badge that disagrees with the
 * page it points at is the kind of detail that reads as a bug.
 *
 * The last two are archived so the Archived tab has real content — a tab that is
 * always empty teaches the reader nothing about what the tab is for.
 */
const NOTIFICATIONS: readonly DemoNotification[] = [
  {
    id: "n-mrr-1k",
    type: "mrr-milestone",
    title: "MRR milestone reached",
    description: "Recurring revenue crossed $1,000 for the first time.",
    timeLabel: "2 hours ago",
    read: false,
    archived: false,
  },
  {
    id: "n-invoice-paid-enterprise",
    type: "invoice-paid",
    title: "Invoice paid",
    description: "Northwind Labs settled the Enterprise plan invoice for $999.00.",
    timeLabel: "5 hours ago",
    read: false,
    archived: false,
  },
  {
    id: "n-churn-pro",
    type: "churn",
    title: "Churn alert",
    description: "1 subscription was cancelled — Pro plan, $199.00 of MRR lost.",
    timeLabel: "Yesterday",
    read: false,
    archived: false,
  },
  {
    id: "n-invoice-overdue-pro",
    type: "invoice-overdue",
    title: "Invoice overdue",
    description: "The Pro plan invoice for $199.00 is now 6 days past due.",
    timeLabel: "Yesterday",
    read: true,
    archived: false,
  },
  {
    id: "n-member-joined",
    type: "member",
    title: "New member joined",
    description: "Priya Raman accepted your invite and joined as a member.",
    timeLabel: "2 days ago",
    read: true,
    archived: false,
  },
  {
    id: "n-revenue-dip",
    type: "revenue-dip",
    title: "Revenue dip detected",
    description: "MRR is down 12% against last month, driven by two downgrades.",
    timeLabel: "3 days ago",
    read: true,
    archived: false,
  },
  {
    id: "n-monthly-report",
    type: "report",
    title: "Monthly report ready",
    description: "Your monthly revenue and retention summary is ready to review.",
    timeLabel: "5 days ago",
    read: true,
    archived: false,
  },
  {
    id: "n-backup-complete",
    type: "system",
    title: "Database backup completed",
    description: "The nightly backup finished in 42 seconds with no errors.",
    timeLabel: "1 week ago",
    read: true,
    archived: false,
  },
  {
    id: "n-invoice-paid-starter",
    type: "invoice-paid",
    title: "Invoice paid",
    description: "Bell & Co settled the Starter plan invoice for $49.00.",
    timeLabel: "2 weeks ago",
    read: true,
    archived: true,
  },
  {
    id: "n-rate-limit",
    type: "system",
    title: "API rate limit raised",
    description: "This workspace can now make 10,000 requests per minute.",
    timeLabel: "3 weeks ago",
    read: true,
    archived: true,
  },
];

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

function selectNotifications(key: NotificationFilterKey): readonly DemoNotification[] {
  if (key === "unread") {
    return NOTIFICATIONS.filter((item) => !item.archived && !item.read);
  }
  if (key === "archived") {
    return NOTIFICATIONS.filter((item) => item.archived);
  }
  return NOTIFICATIONS.filter((item) => !item.archived);
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

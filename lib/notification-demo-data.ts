// Demo notification feed — the single source of truth for BOTH the notifications
// page and the bell dropdown in the dashboard shell. It was previously inlined in
// `app/(dashboard)/dashboard/notifications/page.tsx`; it moved here the moment a
// second surface needed it, so the two can never drift apart.
//
// THIS IS THE UI-ONLY DEMO FEED, NOT THE DATA LAYER. Every notification below is
// a hardcoded demo object and every relative timestamp is a hand-written display
// string, not a value derived from `Date.now()`. Computing real elapsed time
// against invented content would be fake precision: the events did not happen, so
// "2 hours ago" is copy, not a measurement.
//
// The database-backed layer lives in `lib/notifications.ts` (Prisma queries and
// the `markAsRead` / `markAllAsRead` Server Actions). The two are deliberately
// separate modules: this one owns presentation lookups keyed by a UI union
// (`DemoNotificationType`), that one owns rows keyed by the Prisma
// `NotificationType` enum. Do not merge the two vocabularies by accident — the
// union here is kebab-case display keys, the enum there is SCREAMING_SNAKE_CASE
// database values.
//
// No `server-only` import on purpose: the bell dropdown is a client island and
// imports this module directly (icon components cannot cross the server/client
// prop boundary anyway).
import type { ComponentType } from "react";
import {
  Clock,
  Database,
  FileText,
  Receipt,
  TrendingDown,
  TrendingUp,
  UserMinus,
  UserPlus,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * The kinds of event this workspace emits, as DISPLAY keys. A closed union rather
 * than a free string: the icon and the tone are both looked up from it, so an
 * unknown type should be a compile error, not a blank cell.
 *
 * Distinct from the Prisma `NotificationType` enum exported by
 * `lib/notifications.ts` — that one is the persisted database vocabulary. These
 * are the demo feed's own display keys and are intentionally NOT interchangeable.
 */
export type DemoNotificationType =
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
export type NotificationTone = "positive" | "negative" | "neutral";

export interface NotificationTypeMeta {
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
export const TYPE_META: Record<DemoNotificationType, NotificationTypeMeta> = {
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
export const TONE_CLASS: Record<NotificationTone, string> = {
  positive: "text-positive",
  negative: "text-negative",
  neutral: "text-muted-foreground",
};

/**
 * The same ramp as `TONE_CLASS`, as a fill. The dropdown has no room for the
 * type icon the full page shows, so the tone moves onto the dot — same three
 * tokens, same meaning, just a different mark. The dropdown still spells the
 * event out in words next to it, so colour is not carrying the meaning alone.
 */
export const TONE_DOT_CLASS: Record<NotificationTone, string> = {
  positive: "bg-positive",
  negative: "bg-negative",
  neutral: "bg-muted-foreground",
};

export interface DemoNotification {
  readonly id: string;
  readonly type: DemoNotificationType;
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
export const NOTIFICATIONS: readonly DemoNotification[] = [
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
// Selectors
// ---------------------------------------------------------------------------

/**
 * The inbox: everything not filed away, newest first (the array order above).
 * Archived items are a separate bucket, not a subset of the inbox — that is what
 * keeps "All" from lying on the page, and it is why the bell never surfaces a
 * notification the operator has already filed.
 */
export function inboxNotifications(): readonly DemoNotification[] {
  return NOTIFICATIONS.filter((item) => !item.archived);
}

export function unreadNotifications(): readonly DemoNotification[] {
  return NOTIFICATIONS.filter((item) => !item.archived && !item.read);
}

export function archivedNotifications(): readonly DemoNotification[] {
  return NOTIFICATIONS.filter((item) => item.archived);
}

/** The newest `limit` inbox items — what the bell dropdown shows. */
export function recentNotifications(limit: number): readonly DemoNotification[] {
  return inboxNotifications().slice(0, limit);
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const COMPACT_UNIT: Record<string, string> = {
  minute: "m",
  hour: "h",
  day: "d",
  week: "w",
  month: "mo",
  year: "y",
};

const ELAPSED_PATTERN = /^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/;

/**
 * Shortens the hand-written label for the bell dropdown: "2 hours ago" → "2h
 * ago". This is a pure re-spelling of an existing string, NOT a second timestamp
 * — the dropdown column is ~4rem wide and the full-page phrasing does not fit.
 * Anything that does not match the "N units ago" shape (e.g. "Yesterday") is
 * passed through untouched rather than guessed at.
 */
export function compactTimeLabel(timeLabel: string): string {
  const match = ELAPSED_PATTERN.exec(timeLabel);
  if (!match) return timeLabel;

  const [, amount, unit] = match;
  const short = COMPACT_UNIT[unit];
  return short ? `${amount}${short} ago` : timeLabel;
}

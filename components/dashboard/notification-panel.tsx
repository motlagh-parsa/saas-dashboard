"use client";

// The notifications register: filter strip, "mark all as read", "archive all
// read", and the rows (each with its own mark-read and archive controls).
//
// A client island only because the rows and the toolbar button write. Everything
// that can stay on the server does: the page resolves the tenant and the feed,
// renders the filter chips and the empty state itself, and passes both in as
// nodes. This component holds no copy of the feed — it renders the props it is
// given and calls `router.refresh()` (via `useNotificationActions`) to get new
// ones, so the list, the page header count, and the header bell can never
// disagree about what is unread.
import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Archive, CheckCheck, CircleCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format";
import { isArchived, isUnread, type NotificationView } from "@/lib/notification-view";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TONE_CLASS, TYPE_META } from "@/components/dashboard/notification-meta";
import { useNotificationActions } from "@/components/dashboard/use-notification-actions";

export interface NotificationPanelProps {
  /** Tenant for the writes; re-validated server-side against the session. */
  orgId: string;
  /** The rows for the active filter, newest first. */
  items: readonly NotificationView[];
  /** Names the subset for screen readers, since the tabs are the only visible cue. */
  listLabel: string;
  /** Unread across the whole feed, not just the visible rows — gates the toolbar button. */
  unreadCount: number;
  /** Read rows still in the live feed — gates "Archive all read". */
  archivableCount: number;
  /** Whether "Archive all read" belongs on this tab (not on the Archived tab). */
  showArchiveAll: boolean;
  /** Server-rendered filter chips. */
  tabs: React.ReactNode;
  /** Server-rendered empty state for the active filter. */
  empty: React.ReactNode;
}

export function NotificationPanel({
  orgId,
  items,
  listLabel,
  unreadCount,
  archivableCount,
  showArchiveAll,
  tabs,
  empty,
}: NotificationPanelProps) {
  const { pending, error, markOne, markAll, archiveOne, archiveRead } =
    useNotificationActions(orgId);

  // One instant for the whole list, so two rows five minutes apart can never
  // both render "1 hour ago" because the clock ticked between them.
  const now = new Date();

  return (
    <Card className="gap-0 py-0">
      {/*
        The filter strip sits above everything it scopes and nothing else — the
        same grammar as the invoice ledger. The chips themselves are plain links
        rendered on the server: the tab lives in the URL, so it is shareable,
        back-button correct, and works with JavaScript off.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div
          role="group"
          aria-label="Filter notifications"
          className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5"
        >
          {tabs}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Only where there is a live feed to clear — the Archived tab has none. */}
          {showArchiveAll ? (
            <Button
              type="button"
              variant="outline"
              onClick={archiveRead}
              disabled={archivableCount === 0 || pending}
              className="h-11 px-4 sm:h-9"
            >
              <Archive />
              Archive all read
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={markAll}
            // Disabled when there is nothing to mark, because a live control that
            // provably does nothing is worse than one that says so.
            disabled={unreadCount === 0 || pending}
            className="h-11 px-4 sm:h-9"
          >
            <CheckCheck />
            Mark all as read
          </Button>
        </div>
      </div>

      {/*
        A failed write is stated, never swallowed. `role="alert"` because it is
        the consequence of something the operator just did, and the button that
        did it has already returned to its resting state.
      */}
      {error ? (
        <p
          role="alert"
          className="border-b border-border px-4 py-2.5 text-[0.8125rem] text-negative"
        >
          {error}
        </p>
      ) : null}

      {items.length === 0 ? (
        empty
      ) : (
        /*
          One tooltip provider for the whole list rather than one per row: Radix
          requires a provider above every `Tooltip`, and a shared one is also what
          gives the rows a single shared open-delay as the pointer runs down them.
        */
        <TooltipProvider delayDuration={400}>
          {/*
            `role="list"` is explicit: Tailwind's reset strips the marker, and some
            screen readers drop list semantics along with it.
          */}
          <ul role="list" aria-label={listLabel}>
            {items.map((item) => (
              <NotificationRow
                key={item.id}
                item={item}
                now={now}
                pending={pending}
                onMarkRead={markOne}
                onArchive={archiveOne}
              />
            ))}
          </ul>
        </TooltipProvider>
      )}
    </Card>
  );
}

interface NotificationRowProps {
  item: NotificationView;
  now: Date;
  pending: boolean;
  onMarkRead: (notificationId: string) => void;
  onArchive: (notificationId: string) => void;
}

/**
 * One row. The row itself is inert text — its actions are dedicated controls at
 * the right edge, revealed on hover: "mark as read" only while unread, "archive"
 * only while still in the live feed.
 *
 * The whole surface used to be the button. That is gone: with discrete
 * affordances present, a row-wide click target turns "I clicked to read the body"
 * into a silent state change, and it fights the hover-reveal (you cannot move onto
 * an icon without crossing the thing that would also fire). A row with no action
 * left — read and archived — renders no control: a focusable no-op is a dead stop
 * in the tab order.
 */
function NotificationRow({ item, now, pending, onMarkRead, onArchive }: NotificationRowProps) {
  const meta = TYPE_META[item.type];
  const Icon = meta.icon;
  const unread = isUnread(item);
  const archived = isArchived(item);
  const hasActions = unread || !archived;

  return (
    <li
      className={cn(
        // `group` is what the action buttons' `group-hover` reveal keys off.
        // Hover tint only where there is something to reveal: highlighting a row
        // with no actions would promise an interaction it does not have.
        "group flex w-full items-start gap-3 border-t border-border px-4 py-3 text-left transition-colors first:border-t-0",
        hasActions && "hover:bg-accent/40",
      )}
    >
      {/* Read state is the dot; tone is the icon. Two marks, two meanings. */}
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          unread ? "bg-brand" : "bg-muted-foreground/40",
        )}
      />
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", TONE_CLASS[meta.tone])} />

      <div className="min-w-0 flex-1">
        {/*
          Unread is carried by weight and by the brass dot, never by dimming the
          read rows: a notification you have already seen is still something you
          need to be able to read.
        */}
        <p
          className={cn(
            "truncate text-[0.8125rem] leading-snug text-foreground",
            unread ? "font-semibold" : "font-medium",
          )}
        >
          {item.title}
          {/*
            The dot is decorative and the weight is invisible to a screen reader,
            so unread has to be said in words somewhere. Same phrasing as the bell
            popover's rows.
          */}
          {unread ? <span className="sr-only"> (unread)</span> : null}
        </p>
        <p className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
          {item.body}
        </p>
      </div>

      {/*
        Fixed width so the timestamps form a real column edge rather than a ragged
        one. `suppressHydrationWarning` because the label is measured against the
        clock: the server renders it at request time and the browser re-measures
        at hydration, and a one-minute disagreement is correct on both sides.
        The machine-readable instant is in `dateTime`, which never drifts.
      */}
      <time
        dateTime={item.createdAt}
        suppressHydrationWarning
        className="mt-0.5 w-[5.5rem] shrink-0 text-right font-mono text-[0.6875rem] whitespace-nowrap text-muted-foreground"
      >
        {formatRelativeTime(item.createdAt, now)}
      </time>

      {/*
        The slot is always present, the controls are not. Each renders only while
        it has something to do, but the reserved width (two 28px buttons and the
        gap) keeps the timestamp column on the same edge in every state, so marking
        or archiving a row does not shuffle the column. Mark-read sits outermost,
        where it always was.
      */}
      <div className="flex w-[3.625rem] shrink-0 justify-end gap-0.5">
        {archived ? null : (
          <RowActionButton
            icon={Archive}
            label="Archive"
            title={item.title}
            pending={pending}
            onClick={() => onArchive(item.id)}
          />
        )}
        {unread ? (
          <RowActionButton
            icon={CircleCheck}
            label="Mark as read"
            title={item.title}
            pending={pending}
            onClick={() => onMarkRead(item.id)}
          />
        ) : null}
      </div>
    </li>
  );
}

interface RowActionButtonProps {
  icon: LucideIcon;
  /** The verb, shown in the tooltip and leading the accessible name. */
  label: string;
  /** The row's title, for the control's accessible name. */
  title: string;
  pending: boolean;
  onClick: () => void;
}

/**
 * A per-row action — mark as read, or archive.
 *
 * Quiet by default: no background, no border, and on pointer devices no paint at
 * all until the row is hovered. It is never hidden from the keyboard — `opacity-0`
 * leaves it focusable, and focus paints it — and it stays visible unconditionally
 * below `sm`, where "hover" does not exist and an invisible control would be an
 * unreachable one.
 */
function RowActionButton({ icon: Icon, label, title, pending, onClick }: RowActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        onClick={onClick}
        disabled={pending}
        // Named for the row it acts on: a list of nine identical "Archive"
        // buttons tells a screen reader user nothing about which is which.
        aria-label={`${label}: ${title}`}
        className={cn(
          "-mt-0.5 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-[color,background-color,opacity]",
          "hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 sm:data-[state=delayed-open]:opacity-100",
          // The in-flight state is carried by colour, not opacity: opacity is
          // already spoken for by the hover reveal, and two rules fighting over
          // the same property is how a disabled control ends up faintly visible
          // on every row at once.
          "disabled:cursor-default disabled:text-muted-foreground/50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/50",
        )}
      >
        <Icon className="size-4" aria-hidden />
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

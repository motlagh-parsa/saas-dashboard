"use client";

// The bell in the app header: a peek at the inbox, not a jump to it.
//
// A Popover rather than a DropdownMenu on purpose. The rows are information, not
// commands — marking one read is the full page's job, where the row has room to
// say so. A `role="menu"` full of things that are not menu items is a lie to a
// screen reader; a popover containing a list, one button, and one link is what
// this actually is. Escape, outside click, and focus return to the bell all come
// from the primitive.
//
// Data comes down as props from `app/(dashboard)/layout.tsx`, which reads it
// through `lib/notifications.ts` on the server. This island keeps NO copy of it:
// after "mark all as read" it calls `router.refresh()` (inside
// `useNotificationActions`), the layout re-runs on the server, and the new count
// and rows arrive as new props. That is also what makes a mark-as-read performed
// on the notifications page move this badge — same refresh, same layout, same
// props.
import * as React from "react";
import Link from "next/link";
import { ArrowRight, Bell, CheckCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatRelativeTimeShort } from "@/lib/format";
import { isUnread, type NotificationView } from "@/lib/notification-view";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useNotificationActions } from "@/components/dashboard/use-notification-actions";

/** Two digits is all the pip has room for; past that the exact number stops mattering. */
const BADGE_CEILING = 9;

export interface NotificationsMenuProps {
  /** Tenant for the write; `null` when the user belongs to no workspace. */
  orgId: string | null;
  /** Unread across the whole feed — the number on the badge. */
  unreadCount: number;
  /** The newest few rows, newest first. The full page owns the rest. */
  items: readonly NotificationView[];
  /** Layout-owned visibility/spacing for the trigger. */
  className?: string;
}

export function NotificationsMenu({
  orgId,
  unreadCount,
  items,
  className,
}: NotificationsMenuProps) {
  // Controlled only so the footer link can dismiss the panel: the header lives
  // in the layout, so it survives the navigation the link kicks off and would
  // otherwise stay open over the page it just sent you to.
  const [open, setOpen] = React.useState(false);
  const { pending, error, markAll } = useNotificationActions(orgId);

  const now = new Date();
  const summary = unreadCount === 0 ? "Nothing unread" : `${unreadCount} unread`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Notifications, ${summary.toLowerCase()}`}
        className={cn(
          "relative size-9 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent aria-expanded:text-foreground",
          className,
        )}
      >
        <Bell className="size-4" />
        {/*
          The count, in brass. `aria-hidden` because the trigger's own label
          already says it in words — announcing "3" twice is noise, and the digit
          alone is meaningless out of context.
        */}
        {unreadCount > 0 ? (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 font-mono text-[0.5625rem] leading-none font-semibold text-brand-foreground tabular-nums ring-2 ring-background"
          >
            {unreadCount > BADGE_CEILING ? `${BADGE_CEILING}+` : unreadCount}
          </span>
        ) : null}
      </PopoverTrigger>

      {/* Radix gives the panel `role="dialog"`, so it needs a name of its own. */}
      <PopoverContent aria-label="Notifications" align="end" className="w-80 p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="font-heading text-sm font-medium">Notifications</p>
            <p className="truncate text-[0.6875rem] text-muted-foreground">{summary}</p>
          </div>

          {/*
            A button, not an icon: "mark all as read" is destructive-ish enough
            that it should say what it does. Hidden entirely when there is
            nothing unread rather than sitting there disabled — the panel header
            is 20rem wide and a dead control is not worth the room.
          */}
          {unreadCount > 0 ? (
            <button
              type="button"
              onClick={markAll}
              disabled={pending}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[0.6875rem] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <CheckCheck className="size-3.5" aria-hidden />
              Mark all as read
            </button>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="border-b border-border px-3 py-2 text-[0.6875rem] text-negative">
            {error}
          </p>
        ) : null}

        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-[0.8125rem] text-muted-foreground">
            {orgId === null
              ? "Join a workspace to start receiving alerts."
              : "Nothing has happened yet."}
          </p>
        ) : (
          /*
            `role="list"` is explicit for the same reason as on the page:
            Tailwind's reset strips the marker, and some screen readers drop list
            semantics with it.
          */
          <ul role="list" aria-label="Recent notifications">
            {items.map((item) => {
              const unread = isUnread(item);
              return (
                <li
                  key={item.id}
                  className="flex items-start gap-2.5 border-t border-border px-3 py-2 first:border-t-0"
                >
                  {/*
                    Brass for unread, muted for read — the same two marks the full
                    page uses, so the dot means one thing across the product.
                    Never the only cue: unread rows are also bolder and say so to
                    a screen reader.
                  */}
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      unread ? "bg-brand" : "bg-muted-foreground/40",
                    )}
                  />
                  <p
                    className={cn(
                      "min-w-0 flex-1 truncate text-[0.8125rem] leading-snug text-foreground",
                      unread ? "font-semibold" : "font-medium",
                    )}
                  >
                    {item.title}
                    {unread ? <span className="sr-only"> (unread)</span> : null}
                  </p>
                  <time
                    dateTime={item.createdAt}
                    className="mt-px shrink-0 font-mono text-[0.6875rem] whitespace-nowrap text-muted-foreground"
                  >
                    {formatRelativeTimeShort(item.createdAt, now)}
                  </time>
                </li>
              );
            })}
          </ul>
        )}

        <div className="border-t border-border p-1">
          <Link
            href="/dashboard/notifications"
            onClick={() => setOpen(false)}
            className="flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[0.8125rem] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            View all notifications
            <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

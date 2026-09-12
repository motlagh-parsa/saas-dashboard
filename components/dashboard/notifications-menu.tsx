"use client";

// The bell in the app header: a peek at the inbox, not a jump to it.
//
// A Popover rather than a DropdownMenu on purpose. The rows are information, not
// commands — the full page deliberately makes them non-interactive, and there is
// nowhere for a single notification to go. A `role="menu"` full of things that
// are not menu items is a lie to a screen reader; a popover containing a list
// and one link is what this actually is. Escape, outside click, and focus return
// to the bell all come from the primitive.
//
// Data is the shared demo feed in `lib/notification-demo-data.ts` — the same
// objects the notifications page renders, in the same order, so the two can never
// disagree. (The database-backed layer is `lib/notifications.ts`; this client
// island does not read it yet.)
import * as React from "react";
import Link from "next/link";
import { ArrowRight, Bell } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  compactTimeLabel,
  recentNotifications,
  unreadNotifications,
  TONE_DOT_CLASS,
  TYPE_META,
} from "@/lib/notification-demo-data";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/** How many inbox rows the panel shows before deferring to the full page. */
const PANEL_LIMIT = 5;

// Static demo data: resolved once at module scope rather than on every render.
const RECENT = recentNotifications(PANEL_LIMIT);
const UNREAD_COUNT = unreadNotifications().length;
const INBOX_LABEL =
  UNREAD_COUNT === 0 ? "Nothing unread" : `${UNREAD_COUNT} unread`;

export interface NotificationsMenuProps {
  /** Layout-owned visibility/spacing for the trigger. */
  className?: string;
}

export function NotificationsMenu({ className }: NotificationsMenuProps) {
  // Controlled only so the footer link can dismiss the panel: the header lives
  // in the layout, so it survives the navigation the link kicks off and would
  // otherwise stay open over the page it just sent you to.
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Notifications, ${UNREAD_COUNT} unread`}
        className={cn(
          "relative size-9 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent aria-expanded:text-foreground",
          className,
        )}
      >
        <Bell className="size-4" />
        {/* Unchanged from the link it replaced: a brass pip, counted in the label. */}
        <span
          aria-hidden
          className="absolute top-2 right-2 size-2 rounded-full bg-brand ring-2 ring-background"
        />
      </PopoverTrigger>

      {/* Radix gives the panel `role="dialog"`, so it needs a name of its own. */}
      <PopoverContent aria-label="Notifications" align="end" className="w-80 p-0">
        <div className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2.5">
          <p className="font-heading text-sm font-medium">Notifications</p>
          <p className="text-[0.6875rem] text-muted-foreground">{INBOX_LABEL}</p>
        </div>

        {/*
          `role="list"` is explicit for the same reason as on the page: Tailwind's
          reset strips the marker, and some screen readers drop list semantics
          with it.
        */}
        <ul role="list" aria-label="Recent notifications">
          {RECENT.map((item) => (
            <li
              key={item.id}
              className="flex items-start gap-2.5 border-t border-border px-3 py-2 first:border-t-0"
            >
              {/*
                Tone as a fill — positive/negative/neutral, the same ramp the page
                puts on the row icon. Never the only cue: the title says what
                happened in words.
              */}
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  TONE_DOT_CLASS[TYPE_META[item.type].tone],
                )}
              />
              <p
                className={cn(
                  "min-w-0 flex-1 truncate text-[0.8125rem] leading-snug text-foreground",
                  item.read ? "font-medium" : "font-semibold",
                )}
              >
                {item.title}
                {item.read ? null : <span className="sr-only"> (unread)</span>}
              </p>
              <span className="mt-px shrink-0 font-mono text-[0.6875rem] whitespace-nowrap text-muted-foreground">
                {compactTimeLabel(item.timeLabel)}
              </span>
            </li>
          ))}
        </ul>

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

"use client";

import type { ReactNode } from "react";
import Link, { useLinkStatus } from "next/link";

import { cn } from "@/lib/utils";

interface NavChipProps {
  href: string;
  children: ReactNode;
  /** Marks the chip that reflects the current URL state. */
  active?: boolean;
  /** Use when the visible label is too terse to stand alone. */
  label?: string;
  className?: string;
}

/**
 * A URL-state control: status filters and page turns.
 *
 * Plain links, not a client-side toggle. The state lives in the URL, so it is
 * shareable, back-button-correct, and works without JavaScript — the same choice
 * the period control makes.
 *
 * The one piece of client behaviour is the pending state. Navigating to a new
 * query param keeps the previous render on screen while the server answers, which
 * is right — flashing skeletons on a refetch is worse than waiting — but it also
 * means a click looks like nothing happened. `useLinkStatus` dims the chip that
 * was clicked for exactly as long as its own navigation is in flight. That is
 * motion marking a state change, which is the entire motion budget.
 */
export function NavChip({ href, children, active = false, label, className }: NavChipProps) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-label={label}
      aria-current={active ? "true" : undefined}
      className={cn(
        // 44px on touch, tightened to the data-density scale from md up.
        "inline-flex h-11 items-center rounded-md px-3 text-xs font-medium transition-colors md:h-8",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        className,
      )}
    >
      <ChipBody>{children}</ChipBody>
    </Link>
  );
}

function ChipBody({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 transition-opacity",
        pending && "opacity-50",
      )}
    >
      {children}
    </span>
  );
}

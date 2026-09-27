"use client";

// The two notification writes, plus the refresh that makes their effect visible.
//
// Shared by the full page and the header dropdown so both spell "mark, then
// resync" the same way — and so a fix to either half is a fix to both.
//
// How the numbers stay in sync
// ---------------------------------------------------------------------------
// Neither surface keeps its own copy of the feed. Both are rendered from props
// handed down by Server Components (`app/(dashboard)/layout.tsx` for the bell,
// the notifications page for the list). `router.refresh()` re-runs the Server
// Components for the current route — layout included — and streams fresh props
// into the already-mounted client islands without a reload or a remount. So one
// refresh updates the row, the page header, the bell badge, and the sidebar
// badge, because all four read from the same re-rendered server tree.
//
// `markAsRead` / `markAllAsRead` additionally call `revalidatePath("/dashboard",
// "layout")` server-side, which clears the router cache for the whole dashboard
// subtree — that is what keeps a later client-side navigation to another page
// from restoring a stale count from cache.
import * as React from "react";
import { useRouter } from "next/navigation";

import {
  archiveAllRead,
  archiveNotification,
  markAllAsRead,
  markAsRead,
} from "@/lib/notifications";

export interface NotificationActions {
  /** True while a write or its follow-up refresh is in flight. */
  readonly pending: boolean;
  /** Set when a write failed; null otherwise. Render it, do not swallow it. */
  readonly error: string | null;
  readonly markOne: (notificationId: string) => void;
  readonly markAll: () => void;
  readonly archiveOne: (notificationId: string) => void;
  /** Archives every READ notification still in the live feed. */
  readonly archiveRead: () => void;
}

const FAILURE_MESSAGE = "Couldn't update that just now. Try again in a moment.";

/**
 * @param orgId The tenant the caller is signed in to, resolved server-side and
 *   handed down. It is re-validated inside the Server Action against the
 *   session's memberships, so passing it through the client is not a trust
 *   decision — a forged id fails there rather than returning someone else's feed.
 *   `null` when the user is in no workspace at all, which disables both writes.
 */
export function useNotificationActions(orgId: string | null): NotificationActions {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const run = React.useCallback(
    (operation: () => Promise<number>) => {
      setError(null);
      startTransition(async () => {
        try {
          await operation();
        } catch {
          // The row stays visibly unread, which is the honest outcome: nothing
          // was optimistically flipped, so there is nothing to roll back.
          setError(FAILURE_MESSAGE);
          return;
        }
        // Inside the transition, so `pending` stays true until the server has
        // re-rendered and the new counts are actually on screen.
        router.refresh();
      });
    },
    [router],
  );

  const markOne = React.useCallback(
    (notificationId: string) => {
      if (orgId === null) return;
      run(() => markAsRead(notificationId, orgId));
    },
    [orgId, run],
  );

  const markAll = React.useCallback(() => {
    if (orgId === null) return;
    run(() => markAllAsRead(orgId));
  }, [orgId, run]);

  const archiveOne = React.useCallback(
    (notificationId: string) => {
      if (orgId === null) return;
      run(() => archiveNotification(notificationId, orgId));
    },
    [orgId, run],
  );

  const archiveRead = React.useCallback(() => {
    if (orgId === null) return;
    run(() => archiveAllRead(orgId));
  }, [orgId, run]);

  return { pending, error, markOne, markAll, archiveOne, archiveRead };
}

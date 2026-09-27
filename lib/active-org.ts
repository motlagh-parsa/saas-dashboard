import "server-only";

// The ONE place that decides which workspace a request is about.
//
// The user's choice lives in the `meridian_org` cookie, set by
// POST /api/workspace/switch. The cookie is a PREFERENCE, never an authorization:
// it is only honoured when the user still has a membership in that org, checked
// on every call. A stale cookie (the user left, or was removed) silently falls
// back to the default rule every page used before switching existed — the
// highest-role membership, the oldest org breaking ties.
//
// A signed-in user with no membership at all gets `null`. Each caller decides
// what that means: pages show their "not in a workspace yet" screen, the layout
// shows "No workspace", and API routes answer 403.
import { cache } from "react";
import { cookies } from "next/headers";

import { prisma } from "@/lib/prisma";

/** Cookie holding the user's selected organization id. */
export const ACTIVE_ORG_COOKIE = "meridian_org";

/** One year, in seconds — the cookie's `maxAge`. */
export const ACTIVE_ORG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The active organization id for `userId`, or null when they belong to none.
 *
 * Wrapped in React `cache()`: the dashboard layout and the page under it both
 * call this during one server render, and they share a single lookup instead of
 * each running its own. The memo lives for that one request only, so a switch or
 * a membership change is seen on the very next request. Route handlers are not
 * a React render, so there each call simply runs.
 */
export const getActiveOrgId = cache(
  async (userId: string): Promise<string | null> => {
    const cookieStore = await cookies();
    const preferred = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;

    if (preferred) {
      // Composite primary key — an index seek, and a miss for any org the user
      // does not (or no longer) belong to.
      const selected = await prisma.membership.findUnique({
        where: { userId_organizationId: { userId, organizationId: preferred } },
        select: { organizationId: true },
      });
      if (selected !== null) return selected.organizationId;
    }

    // Role enum order is OWNER, ADMIN, MEMBER, so ascending role puts the caller's
    // most privileged workspace first; oldest org breaks the tie deterministically.
    const fallback = await prisma.membership.findFirst({
      where: { userId },
      orderBy: [{ role: "asc" }, { organization: { createdAt: "asc" } }],
      select: { organizationId: true },
    });

    return fallback?.organizationId ?? null;
  },
);

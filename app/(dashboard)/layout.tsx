// Shell for the authenticated app. It stays a Server Component: it reads the
// session so the account menu can show who is signed in, resolves the caller's
// active workspace (lib/active-org.ts — the same resolver every page uses) plus
// the full list for the switcher, and reads the notification feed for the bell.
//
// Authorization is NOT done here — each protected page calls `requireSession()`.
// It degrades instead: no session means no org id, and the bell renders empty.
//
// One redirect IS done here: a signed-in user with no membership at all is sent
// to /onboarding to create a workspace, since every page below is scoped to one.
// Invited users already have a membership and never see it.
//
// It also reads what the ACTIVE workspace holds (lib/workspace-status.ts): the
// sample-data banner shows while it has SAMPLE rows, and the sidebar's metrics
// status reports how fresh its snapshots are.
//
// Why the bell's data is read HERE and not inside the bell: `router.refresh()`
// re-runs the Server Components of the current route, layouts included, and
// streams fresh props into already-mounted client islands. So a "mark as read"
// fired from the notifications page updates this count, and one fired from
// inside the bell updates the page behind it — one mechanism, both directions,
// no client-side fetching and no second copy of the feed.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";

import type { Notification } from "@prisma/client";

import { getActiveOrgId } from "@/lib/active-org";
import { authOptions } from "@/lib/auth";
import { currencyOptions } from "@/lib/currencies";
import { getWorkspaceDataState } from "@/lib/workspace-status";
import { prisma } from "@/lib/prisma";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import { getNotifications, getUnreadCount } from "@/lib/notifications";
import { toNotificationViews } from "@/lib/notification-view";
import { Separator } from "@/components/ui/separator";
import { BrandMark } from "@/components/dashboard/brand-mark";
import { CommandPaletteTrigger } from "@/components/dashboard/command-palette-trigger";
import { NotificationsMenu } from "@/components/dashboard/notifications-menu";
import { OrgSwitcher } from "@/components/dashboard/org-switcher";
import {
  SidebarDrawer,
  SidebarDrawerProvider,
  SidebarToggle,
} from "@/components/dashboard/sidebar-drawer";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { UserMenu } from "@/components/dashboard/user-menu";
import { MetricsStatus } from "@/components/workspace/metrics-status";
import { SampleDataBanner } from "@/components/workspace/sample-data-banner";

/** How many rows the bell shows before deferring to the full page. */
const BELL_LIMIT = 5;

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id ?? null;

  // Every workspace for the switcher, most privileged first (same sort as the
  // fallback in lib/active-org.ts), and the active one — the cookie choice when
  // it is still valid, else that fallback. Same resolver as every page, so the
  // header and the page below it always agree.
  //
  // The account menu's identity is read from the DATABASE, not the session: the
  // session is a JWT stamped at sign-in, so a rename on the Profile page would
  // not reach the header until the next sign-in.
  const [memberships, activeOrgId, account] = userId
    ? await Promise.all([
        prisma.membership.findMany({
          where: { userId },
          orderBy: [{ role: "asc" }, { organization: { createdAt: "asc" } }],
          select: { role: true, organization: { select: { id: true, name: true } } },
        }),
        getActiveOrgId(userId),
        prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true, image: true },
        }),
      ])
    : [[], null, null];

  // No workspace to show anything in: onboarding creates the first one.
  if (userId !== null && memberships.length === 0) redirect("/onboarding");

  const orgs = memberships.map(({ organization }) => ({
    id: organization.id,
    name: organization.name,
  }));

  // The caller's role in the ACTIVE workspace — decides which palette items are
  // offered. Presentation only: every page and action re-checks it.
  const activeRole =
    memberships.find(({ organization }) => organization.id === activeOrgId)?.role ?? null;

  // The same cookie the root layout turned into the <html> class — read again
  // here so the toggle's icon matches the theme on first paint.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);

  const [recent, unreadCount, dataState] = activeOrgId
    ? await Promise.all([
        getNotifications(activeOrgId, { limit: BELL_LIMIT }),
        getUnreadCount(activeOrgId),
        getWorkspaceDataState(activeOrgId),
      ])
    : ([[], 0, null] as [Notification[], number, null]);

  const currencies = currencyOptions();

  return (
    <SidebarDrawerProvider className="flex min-h-svh w-full">
      {/*
        The sidebar — ONE element. At md+ it is the sticky rail; below md the same
        element is an off-canvas drawer opened by the hamburger in the header
        (components/dashboard/sidebar-drawer.tsx). Its content renders here once.
      */}
      <SidebarDrawer>
        <div className="px-1">
          <BrandMark />
        </div>
        {/* On small screens the header has no room for the switcher, so it rides
            in the drawer; at md+ it stays in the header where it always was. */}
        <OrgSwitcher
          orgs={orgs}
          activeOrgId={activeOrgId ?? ""}
          currencies={currencies}
          className="w-full md:hidden"
        />
        <SidebarNav unreadCount={unreadCount} role={activeRole} />
        {dataState ? (
          <MetricsStatus latestSnapshot={dataState.latestSnapshot} hasSubscriptions={dataState.hasSubscriptions} />
        ) : null}
      </SidebarDrawer>

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background px-3 sm:px-4">
          <SidebarToggle />

          {/* Small screens show the mark; desktop shows the tenant switcher. */}
          <div className="md:hidden">
            <BrandMark showWordmark={false} />
          </div>

          <OrgSwitcher
            orgs={orgs}
            activeOrgId={activeOrgId ?? ""}
            currencies={currencies}
            className="hidden md:flex"
          />

          <div className="ml-auto flex items-center gap-1">
            {/* Command palette: the ⌘K listener, its buttons, and the dialog. */}
            <CommandPaletteTrigger role={activeRole} theme={theme} />

            {/* Bell: opens a peek at the inbox, anchored to the trigger. */}
            <NotificationsMenu
              orgId={activeOrgId}
              unreadCount={unreadCount}
              items={toNotificationViews(recent)}
              className="hidden md:inline-flex"
            />

            <ThemeToggle theme={theme} className="hidden md:inline-flex" />

            <Separator
              orientation="vertical"
              className="mx-1 hidden !h-5 self-center md:block"
            />

            <UserMenu
              name={account?.name ?? session?.user?.name ?? null}
              email={account?.email ?? session?.user?.email ?? null}
              image={account?.image ?? session?.user?.image ?? null}
              theme={theme}
            />
          </div>
        </header>

        {activeOrgId !== null && dataState?.hasSampleData ? (
          <SampleDataBanner organizationId={activeOrgId} canRemove={activeRole !== null && activeRole !== "MEMBER"} />
        ) : null}

        {children}
      </div>
    </SidebarDrawerProvider>
  );
}

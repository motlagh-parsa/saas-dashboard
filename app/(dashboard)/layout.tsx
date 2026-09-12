// Shell for the authenticated app. It stays a Server Component: the only data it
// reads is the session, purely so the account menu can show who is signed in.
// Authorization is NOT done here — each protected page calls `requireSession()`.
// Org name below is still a PLACEHOLDER; tenant wiring is a db-architect follow-up.
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { Separator } from "@/components/ui/separator";
import { BrandMark } from "@/components/dashboard/brand-mark";
import { CommandPalette } from "@/components/dashboard/command-palette";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { NotificationsMenu } from "@/components/dashboard/notifications-menu";
import { OrgSwitcher } from "@/components/dashboard/org-switcher";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { UserMenu } from "@/components/dashboard/user-menu";

// PLACEHOLDER — real tenant comes from the session/org context later.
const ORG_NAME = "Northwind Labs";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getServerSession(authOptions);

  return (
    <div className="flex min-h-svh w-full">
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col gap-6 border-r border-sidebar-border bg-sidebar px-3 py-4 md:flex">
        <div className="px-1">
          <BrandMark />
        </div>
        <SidebarNav />
        <div className="mt-auto flex items-center gap-2 rounded-md border border-sidebar-border/70 px-2.5 py-2">
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inline-flex size-full rounded-full bg-positive/70" />
            <span className="relative inline-flex size-2 rounded-full bg-positive" />
          </span>
          <span className="text-xs text-muted-foreground">Metrics up to date</span>
        </div>
      </aside>

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background px-3 sm:px-4">
          <MobileNav />

          {/* Small screens show the mark; desktop shows the tenant switcher. */}
          <div className="md:hidden">
            <BrandMark showWordmark={false} />
          </div>

          <OrgSwitcher name={ORG_NAME} className="hidden md:flex" />

          <div className="ml-auto flex items-center gap-1">
            {/* Command palette: trigger + ⌘K dialog. */}
            <CommandPalette />

            {/* Bell: opens a peek at the inbox, anchored to the trigger. */}
            <NotificationsMenu className="hidden md:inline-flex" />

            <ThemeToggle className="hidden md:inline-flex" />

            <Separator
              orientation="vertical"
              className="mx-1 hidden !h-5 self-center md:block"
            />

            <UserMenu
              name={session?.user?.name ?? null}
              email={session?.user?.email ?? null}
              image={session?.user?.image ?? null}
            />
          </div>
        </header>

        {children}
      </div>
    </div>
  );
}
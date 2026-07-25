// Presentational shell for the authenticated app. It renders no session and
// queries no data — each protected page gates itself. Org name and user identity
// below are PLACEHOLDERS; wiring real session/tenant data is a follow-up for
// nextjs-architect / db-architect.
import { Bell, Building2, ChevronsUpDown, Search } from "lucide-react";

import { Separator } from "@/components/ui/separator";
import { BrandMark } from "@/components/dashboard/brand-mark";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { UserMenu } from "@/components/dashboard/user-menu";

// PLACEHOLDER — real tenant comes from the session/org context later.
const ORG_NAME = "Northwind Labs";

export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
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

          <button
            type="button"
            aria-label={`Switch workspace — currently ${ORG_NAME}`}
            className="hidden h-9 items-center gap-2 rounded-md px-2 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring md:flex"
          >
            <Building2 className="size-4 text-muted-foreground" />
            <span className="max-w-40 truncate">{ORG_NAME}</span>
            <ChevronsUpDown className="size-3.5 text-muted-foreground" />
          </button>

          <div className="ml-auto flex items-center gap-1">
            {/* Command palette trigger — pending ⌘K wiring (follow-up). */}
            <button
              type="button"
              aria-label="Search"
              className="hidden h-9 w-64 items-center gap-2 rounded-md border border-input bg-muted/40 px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring lg:flex"
            >
              <Search className="size-4" />
              <span>Search customers, reports…</span>
              <kbd className="ml-auto inline-flex items-center gap-0.5 rounded border border-border bg-background px-1.5 font-mono text-[0.625rem] text-muted-foreground">
                ⌘K
              </kbd>
            </button>

            <button
              type="button"
              aria-label="Notifications, 3 unread"
              className="relative hidden size-9 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
            >
              <Bell className="size-4" />
              <span className="absolute top-2 right-2 size-2 rounded-full bg-brand ring-2 ring-background" />
            </button>

            <ThemeToggle className="hidden md:inline-flex" />

            <Separator
              orientation="vertical"
              className="mx-1 hidden !h-5 self-center md:block"
            />

            <UserMenu />
          </div>
        </header>

        {children}
      </div>
    </div>
  );
}
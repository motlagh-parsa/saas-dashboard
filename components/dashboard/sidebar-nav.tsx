"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { primaryNav, secondaryNav, type NavItem } from "./nav-items";

type SidebarNavProps = {
  /** Fired after a nav item is chosen — used to close the mobile drawer. */
  onNavigate?: () => void;
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        // Signature: an inset gold tick marks the active route.
        "group relative flex h-11 items-center gap-2.5 rounded-md pr-2 pl-3 text-sm font-medium transition-colors md:h-9",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar",
        "before:absolute before:top-1/2 before:left-0 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-brand before:transition-opacity",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground before:opacity-100"
          : "text-muted-foreground before:opacity-0 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0 transition-colors",
          active ? "text-brand" : "text-muted-foreground group-hover:text-sidebar-foreground",
        )}
      />
      <span className="truncate">{item.label}</span>
      {typeof item.count === "number" ? (
        <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand/15 px-1.5 font-mono text-[0.6875rem] font-medium text-brand tabular-nums">
          {item.count}
        </span>
      ) : null}
    </Link>
  );
}

export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const pathname = usePathname() ?? "/dashboard";

  return (
    <nav className="flex flex-1 flex-col gap-6" aria-label="Primary">
      <div className="flex flex-col gap-0.5">
        <p className="px-3 pb-1.5 text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground/70 uppercase">
          Metrics
        </p>
        {primaryNav.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(pathname, item.href)}
            onNavigate={onNavigate}
          />
        ))}
      </div>

      <div className="flex flex-col gap-0.5">
        <p className="px-3 pb-1.5 text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground/70 uppercase">
          Workspace
        </p>
        {secondaryNav.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(pathname, item.href)}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </nav>
  );
}
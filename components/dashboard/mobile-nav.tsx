"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/dashboard/brand-mark";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";

/**
 * The sidebar as a drawer on small screens. Opens from the left, closes on route
 * change, Escape, or backdrop press. Motion is entrance-only and is neutralized
 * by the global reduced-motion rule.
 */
export interface MobileNavProps {
  /** Unread notifications, forwarded to the nav so the drawer badge is live too. */
  unreadCount?: number;
}

export function MobileNav({ unreadCount }: MobileNavProps) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();

  // Close whenever the route changes.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape to close; lock body scroll while open.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Open navigation"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="size-11 md:hidden"
      >
        <Menu />
      </Button>

      {open ? (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/50 animate-in fade-in-0"
          />
          <div className="absolute inset-y-0 left-0 flex w-[17rem] max-w-[85%] flex-col gap-6 border-r border-sidebar-border bg-sidebar p-4 shadow-xl animate-in slide-in-from-left-4 fade-in-0">
            <div className="flex items-center justify-between">
              <BrandMark />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close navigation"
                onClick={() => setOpen(false)}
                className="size-11"
              >
                <X />
              </Button>
            </div>
            <SidebarNav onNavigate={() => setOpen(false)} unreadCount={unreadCount} />
          </div>
        </div>
      ) : null}
    </>
  );
}
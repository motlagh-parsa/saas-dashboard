"use client";

// Mounted once in the dashboard header. Owns the palette's `open` state, the
// global ⌘K / Ctrl+K shortcut, and the two buttons that open it — the labelled
// one on wide screens and an icon on narrow ones, where there is no keyboard
// shortcut to fall back on. Local state, no global store: nothing else needs to
// know whether the palette is open.
import * as React from "react";
import type { Role } from "@prisma/client";
import { Search } from "lucide-react";

import type { ThemePreference } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { CommandPalette } from "@/components/dashboard/command-palette";

interface CommandPaletteTriggerProps {
  /** The caller's role in the active workspace, resolved by the server layout. */
  role: Role | null;
  /** The `meridian_theme` preference, read by the server layout. */
  theme: ThemePreference;
}

export function CommandPaletteTrigger({ role, theme }: CommandPaletteTriggerProps) {
  const [open, setOpen] = React.useState(false);

  // Synchronizing with a browser-level event source — a legitimate effect.
  // ⌘K on macOS, Ctrl+K elsewhere; a second press closes it again.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k") return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setOpen((previous) => !previous);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        className="hidden h-9 w-64 items-center gap-2 rounded-md border border-input bg-muted/40 px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring lg:flex"
      >
        <Search className="size-4" aria-hidden />
        <span>Jump to…</span>
        <kbd className="ml-auto inline-flex items-center gap-0.5 rounded border border-border bg-background px-1.5 font-mono text-[0.625rem] text-muted-foreground">
          ⌘K
        </kbd>
      </button>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Open command palette"
        className="size-11 md:size-9 lg:hidden"
      >
        <Search aria-hidden />
      </Button>

      <CommandPalette open={open} onOpenChange={setOpen} role={role} theme={theme} />
    </>
  );
}

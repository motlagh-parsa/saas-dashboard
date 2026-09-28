"use client";

// The ⌘K palette: go to a page, run a quick action, or change the theme.
//
// Controlled — `open` lives in CommandPaletteTrigger, which also owns the global
// shortcut, so exactly one listener and one dialog exist per page.
//
// Scope: it lists the app's destinations and commands (lib/palette-items.ts). It
// does NOT search data — no customers, no invoices — so no copy on it may say
// "search". Widening it to data means a server-backed query, not a longer list.
//
// A11y: the dialog primitive handles focus trap, Escape, outside click and focus
// return. The field/list pair is a combobox + listbox, so arrow keys move the
// active option without moving DOM focus off the input. Group headings are
// `role="presentation"` separators inside the listbox, and each group's options
// are wrapped in `role="group"` with an accessible name.
import * as React from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import { CornerDownLeft, SearchX, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  PALETTE_GROUPS,
  filterPaletteItems,
  paletteItemsFor,
  type PaletteItem,
} from "@/lib/palette-items";
import type { ThemePreference } from "@/lib/theme";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useThemeCycle } from "@/components/dashboard/theme-toggle";

const LISTBOX_ID = "command-palette-results";

function optionId(item: PaletteItem): string {
  return `command-palette-option-${item.id}`;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The caller's role in the active workspace; null with no workspace. */
  role: Role | null;
  /** The `meridian_theme` preference, so the current mode can be marked. */
  theme: ThemePreference;
}

export function CommandPalette({ open, onOpenChange, role, theme }: CommandPaletteProps) {
  const router = useRouter();
  const themes = useThemeCycle(theme);
  const [query, setQuery] = React.useState("");
  // Highlight intent. Clamped against the current results during render, so the
  // list never needs an effect to stay in a valid state.
  const [highlight, setHighlight] = React.useState(0);

  const allowed = React.useMemo(() => paletteItemsFor(role), [role]);
  const results = React.useMemo(() => filterPaletteItems(allowed, query), [allowed, query]);

  // Grouped for rendering, in PALETTE_GROUPS order; empty groups drop out, so a
  // heading only appears when something sits under it. `results` keeps the same
  // order, so a flat index still addresses one option.
  const groups = React.useMemo(
    () =>
      PALETTE_GROUPS.map((group) => ({
        group,
        items: results.filter((item) => item.group === group),
      })).filter((entry) => entry.items.length > 0),
    [results],
  );
  const ordered = React.useMemo(() => groups.flatMap((entry) => entry.items), [groups]);

  const activeIndex = ordered.length === 0 ? -1 : Math.min(highlight, ordered.length - 1);
  const activeItem = activeIndex >= 0 ? ordered[activeIndex] : undefined;

  function handleOpenChange(next: boolean): void {
    onOpenChange(next);
    if (!next) {
      setQuery("");
      setHighlight(0);
    }
  }

  function run(item: PaletteItem): void {
    handleOpenChange(false);
    if (item.command.kind === "navigate") {
      router.push(item.command.href);
    } else {
      themes.select(item.command.theme);
    }
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    const count = ordered.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((previous) => (count === 0 ? 0 : (Math.min(previous, count - 1) + 1) % count));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((previous) =>
        count === 0 ? 0 : (Math.min(previous, count - 1) + count - 1) % count,
      );
      return;
    }
    if (event.key === "Home" && count > 0) {
      event.preventDefault();
      setHighlight(0);
      return;
    }
    if (event.key === "End" && count > 0) {
      event.preventDefault();
      setHighlight(count - 1);
      return;
    }
    if (event.key === "Enter" && activeItem) {
      event.preventDefault();
      run(activeItem);
    }
  }

  /** Right-hand hint: the path for a page, "Current" for the active theme. */
  function hintFor(item: PaletteItem): string | null {
    if (item.command.kind === "navigate") return item.command.href.split("?")[0];
    return item.command.theme === themes.theme ? "Current" : null;
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="top-[12%] max-w-[calc(100%-2rem)] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Go to a page or run a command. Type to filter, use the arrow keys to choose, Enter to
          run.
        </DialogDescription>

        <div className="flex items-center gap-2 border-b border-border px-3">
          <Sparkles className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            autoFocus
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={LISTBOX_ID}
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? optionId(activeItem) : undefined}
            aria-label="Command"
            placeholder="Type a page or command…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={handleInputKeyDown}
            className="h-12 rounded-none border-0 bg-transparent px-0 focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          />
          <kbd className="hidden shrink-0 rounded border border-border bg-muted px-1.5 font-mono text-[0.625rem] text-muted-foreground sm:inline-flex">
            Esc
          </kbd>
        </div>

        {ordered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <SearchX className="size-5 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground" role="status">
              No results for &lsquo;{query.trim()}&rsquo;
            </p>
          </div>
        ) : (
          <div
            id={LISTBOX_ID}
            role="listbox"
            aria-label="Commands"
            className="max-h-80 overflow-y-auto p-1.5"
          >
            {groups.map(({ group, items }) => (
              <div key={group} role="group" aria-label={group} className="pb-1 last:pb-0">
                <p
                  role="presentation"
                  className="px-2 pt-1.5 pb-1 font-mono text-[0.625rem] font-medium tracking-[0.14em] text-muted-foreground/80 uppercase"
                >
                  {group}
                </p>
                {items.map((item) => {
                  const Icon = item.icon;
                  const index = ordered.indexOf(item);
                  const active = index === activeIndex;
                  const hint = hintFor(item);
                  return (
                    <div
                      key={item.id}
                      id={optionId(item)}
                      role="option"
                      aria-selected={active}
                      onMouseMove={() => setHighlight(index)}
                      onClick={() => run(item)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors select-none",
                        active ? "bg-accent text-accent-foreground" : "text-foreground",
                      )}
                    >
                      <Icon
                        className={cn(
                          "size-4 shrink-0",
                          active ? "text-brand" : "text-muted-foreground",
                        )}
                      />
                      <span className="truncate">{item.label}</span>
                      {hint ? (
                        <span className="ml-auto truncate font-mono text-[0.6875rem] text-muted-foreground">
                          {hint}
                        </span>
                      ) : null}
                      {active ? (
                        <CornerDownLeft
                          className={cn("size-3.5 shrink-0 text-muted-foreground", !hint && "ml-auto")}
                          aria-hidden
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

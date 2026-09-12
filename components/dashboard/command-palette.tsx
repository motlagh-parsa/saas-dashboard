"use client";

// Global navigation palette. Owns its own open state and the ⌘K / Ctrl+K
// shortcut so the dashboard shell can stay a Server Component — only this
// subtree ships to the client.
//
// A11y: the dialog primitive handles focus trap, Escape, outside click, and
// focus return to the trigger. The field/list pair is a combobox + listbox, so
// arrow keys move the active option without moving DOM focus off the input.
import * as React from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { primaryNav, secondaryNav, type NavItem } from "./nav-items";

// One source of truth for "where can I go" — the same list the sidebar renders.
const destinations: NavItem[] = [...primaryNav, ...secondaryNav];

const LISTBOX_ID = "command-palette-results";

function optionId(href: string): string {
  return `command-palette-option-${href.replace(/\//g, "-")}`;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  // Highlight intent. Clamped against the current results during render, so the
  // list never needs an effect to stay in a valid state.
  const [highlight, setHighlight] = React.useState(0);

  // Synchronizing with a browser-level event source — a legitimate effect.
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

  const results = React.useMemo<NavItem[]>(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return destinations;
    return destinations.filter((item) =>
      `${item.label} ${item.href}`.toLowerCase().includes(needle),
    );
  }, [query]);

  const activeIndex = results.length === 0 ? -1 : Math.min(highlight, results.length - 1);
  const activeItem = activeIndex >= 0 ? results[activeIndex] : undefined;

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) {
      setQuery("");
      setHighlight(0);
    }
  }

  function go(href: string): void {
    handleOpenChange(false);
    router.push(href);
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((previous) =>
        results.length === 0 ? 0 : (Math.min(previous, results.length - 1) + 1) % results.length,
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((previous) =>
        results.length === 0
          ? 0
          : (Math.min(previous, results.length - 1) + results.length - 1) % results.length,
      );
      return;
    }
    if (event.key === "Enter" && activeItem) {
      event.preventDefault();
      go(activeItem.href);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        aria-label="Search"
        className="hidden h-9 w-64 items-center gap-2 rounded-md border border-input bg-muted/40 px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring lg:flex"
      >
        <Search className="size-4" />
        <span>Search customers, reports…</span>
        <kbd className="ml-auto inline-flex items-center gap-0.5 rounded border border-border bg-background px-1.5 font-mono text-[0.625rem] text-muted-foreground">
          ⌘K
        </kbd>
      </DialogTrigger>

      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="top-[12%] max-w-[calc(100%-2rem)] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Jump to a page. Type to filter, use the arrow keys to choose, Enter to go.
        </DialogDescription>

        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            autoFocus
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={LISTBOX_ID}
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? optionId(activeItem.href) : undefined}
            placeholder="Search customers, reports…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={handleInputKeyDown}
            className="h-12 rounded-none border-0 bg-transparent px-0 focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          />
        </div>

        {results.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No pages match “{query.trim()}”.
          </p>
        ) : (
          <ul
            id={LISTBOX_ID}
            role="listbox"
            aria-label="Pages"
            className="max-h-80 overflow-y-auto p-1.5"
          >
            {results.map((item, index) => {
              const Icon = item.icon;
              const active = index === activeIndex;
              return (
                <li key={item.href} role="none">
                  <button
                    type="button"
                    id={optionId(item.href)}
                    role="option"
                    aria-selected={active}
                    tabIndex={-1}
                    onMouseMove={() => setHighlight(index)}
                    onClick={() => go(item.href)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm outline-none transition-colors",
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
                    <span className="ml-auto truncate font-mono text-[0.6875rem] text-muted-foreground">
                      {item.href}
                    </span>
                    {active ? (
                      <CornerDownLeft
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

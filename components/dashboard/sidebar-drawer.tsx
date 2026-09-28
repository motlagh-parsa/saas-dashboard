"use client";

// The sidebar, repositioned as a drawer below `md`.
//
// There is ONE sidebar. The dashboard layout renders its content once, on the
// server, as children of <SidebarDrawer>; at md+ this is the sticky rail it
// always was, and below md the same element slides in from the left. Nothing
// is rendered twice.
//
// State is shared by two distant pieces of the header — the hamburger
// (<SidebarToggle>) and the drawer itself — so it lives in a small context
// (<SidebarDrawerProvider>) around the layout, not in a global store.
//
// Closed on small screens, the panel is `visibility: hidden` as well as
// off-canvas, so its links are out of the tab order and the accessibility tree
// without any JavaScript. On close `visibility` is transitioned alongside
// `translate`, which holds it visible for the length of the slide-out and flips
// it at the end; on open it flips immediately, because a still-hidden panel
// would refuse the initial focus. The global reduced-motion rule collapses the
// slide to an instant change.
//
// Deliberately NOT done: locking body scroll. The content column barely scrolls,
// and `overflow: hidden` on <body> shifts the layout by the scrollbar's width.
import * as React from "react";
import { Menu, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** Tailwind's `md` breakpoint — above it the drawer is the static rail. */
const DESKTOP_QUERY = "(min-width: 48rem)";

const SIDEBAR_ID = "app-sidebar";

/** Everything Tab can land on inside the panel, in DOM order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Radix menus and popovers inside the drawer (the workspace switcher) are
 * portaled to <body> and manage their own focus and Escape. While focus is in
 * one, the drawer's trap and Escape stand aside — otherwise one Escape would
 * close both, and Tab would yank focus out of an open menu.
 */
function isInFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-radix-popper-content-wrapper]") !== null;
}

function focusablesIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getClientRects().length > 0,
  );
}

interface SidebarDrawerState {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  /** The hamburger, so a dismissed drawer can hand focus back to it. */
  readonly toggleRef: React.RefObject<HTMLButtonElement | null>;
}

const SidebarDrawerContext = React.createContext<SidebarDrawerState | null>(null);

function useSidebarDrawer(): SidebarDrawerState {
  const state = React.useContext(SidebarDrawerContext);
  if (state === null) throw new Error("SidebarDrawer parts must be inside <SidebarDrawerProvider>.");
  return state;
}

/** The dashboard shell's root element, carrying the drawer's state to both halves of it. */
export function SidebarDrawerProvider({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = React.useState<boolean>(false);
  const toggleRef = React.useRef<HTMLButtonElement>(null);
  const value = React.useMemo<SidebarDrawerState>(() => ({ open, setOpen, toggleRef }), [open]);
  return (
    <SidebarDrawerContext.Provider value={value}>
      <div className={className}>{children}</div>
    </SidebarDrawerContext.Provider>
  );
}

/** The hamburger. Small screens only — at md+ the rail is always there. */
export function SidebarToggle() {
  const { open, setOpen, toggleRef } = useSidebarDrawer();
  return (
    <Button
      ref={toggleRef}
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Open navigation"
      aria-expanded={open}
      aria-controls={SIDEBAR_ID}
      onClick={() => setOpen(true)}
      className="size-11 md:hidden"
    >
      <Menu aria-hidden />
    </Button>
  );
}

/**
 * The sidebar element itself. `children` is its server-rendered content — the
 * brand, workspace switcher, nav and status — identical in both contexts.
 */
export function SidebarDrawer({ children }: { children: React.ReactNode }) {
  const { open, setOpen, toggleRef } = useSidebarDrawer();
  const panelRef = React.useRef<HTMLElement>(null);

  const close = React.useCallback(
    (restoreFocus: boolean) => {
      setOpen(false);
      // Back to the hamburger when dismissed in place (Escape, backdrop, ×);
      // not after a navigation or when the ⌘K palette is taking over focus.
      if (restoreFocus) toggleRef.current?.focus();
    },
    [setOpen, toggleRef],
  );

  // Synchronizing with the DOM while open: initial focus, the focus trap,
  // Escape, and the breakpoint. All of it is torn down the moment it closes.
  React.useEffect(() => {
    const panel = panelRef.current;
    if (!open || panel === null) return;

    // Focus goes to the dialog itself, not its first control. The shared Button
    // has `transition-all`, which includes the `visibility` it inherits from this
    // panel — so in the instant the drawer opens, every button inside is still
    // mid-transition from hidden and would refuse focus. The panel has no such
    // transition, it gets its label announced, and the next Tab lands on the
    // first control.
    panel.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (panel === null || isInFloatingLayer(event.target)) return;

      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
        return;
      }
      // ⌘K / Ctrl+K opens the command palette (CommandPaletteTrigger). Its dialog
      // brings its own focus trap, so this one steps out of the way.
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        close(false);
        return;
      }
      if (event.key !== "Tab") return;

      const items = focusablesIn(panel);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      // The panel itself (focused on open) sits "before" the first control.
      if (event.shiftKey && (!inside || active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    // Growing past md while open (rotation, a resized window) turns the drawer
    // back into the rail — it must not keep trapping focus there.
    const desktop = window.matchMedia(DESKTOP_QUERY);
    function onBreakpoint(event: MediaQueryListEvent): void {
      if (event.matches) close(false);
    }

    document.addEventListener("keydown", onKeyDown);
    desktop.addEventListener("change", onBreakpoint);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      desktop.removeEventListener("change", onBreakpoint);
    };
  }, [open, close]);

  /** A tapped nav link closes the drawer — delegated, so the server-rendered nav needs no callback. */
  function handleClick(event: React.MouseEvent<HTMLElement>): void {
    if (open && event.target instanceof Element && event.target.closest("a[href]") !== null) {
      close(false);
    }
  }

  return (
    <>
      {/* Backdrop. Presentational: the × button and Escape are the accessible ways out. */}
      <div
        aria-hidden="true"
        onClick={() => close(true)}
        className={cn(
          "fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        ref={panelRef}
        id={SIDEBAR_ID}
        onClick={handleClick}
        // A modal dialog only while it is one: below md, open. Closed, or as the
        // rail at md+, it stays a plain complementary landmark.
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-label="Navigation"
        // Focusable by script only (initial focus when the drawer opens), never by Tab.
        tabIndex={-1}
        data-open={open ? "true" : undefined}
        className={cn(
          // Shared: the rail's own look.
          "flex flex-col gap-6 border-r border-sidebar-border bg-sidebar px-3 py-4 outline-none",
          // Below md: an off-canvas drawer, hidden until opened. Closing transitions
          // `visibility` too, so it stays visible for the whole slide-out; opening
          // transitions only `translate`, so it is visible — and focusable — at once.
          "fixed inset-y-0 left-0 z-50 w-[17rem] max-w-[85%] shadow-xl transition-[translate,visibility] duration-200",
          "invisible -translate-x-full data-[open=true]:visible data-[open=true]:translate-x-0 data-[open=true]:transition-[translate]",
          // md+: exactly the rail it was — sticky, in flow, always shown, no motion.
          "md:visible md:sticky md:top-0 md:z-auto md:h-svh md:w-60 md:max-w-none md:shrink-0 md:translate-x-0 md:shadow-none md:transition-none",
        )}
      >
        {/* Drawer-only close control; the rail has nothing to close. */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close navigation"
          onClick={() => close(true)}
          className="absolute top-3 right-2 size-11 md:hidden"
        >
          <X aria-hidden />
        </Button>
        {children}
      </aside>
    </>
  );
}

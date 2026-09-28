"use client";

// Theme preference: light → dark → system → light.
//
// The SERVER owns the truth. The root layout reads the `meridian_theme` cookie
// and renders <html class="light|dark|"> before anything streams (lib/theme.ts),
// so there is no inline script and no flash. A change here does three things:
//   1. writes the cookie, so every later request renders the new class;
//   2. applies the class to <html> immediately — a click must not wait on a
//      server round trip to show its result;
//   3. calls `router.refresh()`, so the server re-renders with the new cookie and
//      React's own idea of <html>'s className matches the DOM again.
//
// `useOptimistic` shows the new mode's icon and label for the length of that
// refresh; once it lands, the `theme` prop from the server carries the same value.
import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Monitor, Moon, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  THEME_LABELS,
  nextTheme,
  themeClass,
  type ThemePreference,
} from "@/lib/theme";
import { Button } from "@/components/ui/button";

export const THEME_ICONS: Record<ThemePreference, LucideIcon> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

function persist(theme: ThemePreference): void {
  // Same attributes as `meridian_org` (app/api/workspace/switch/route.ts) except
  // httpOnly, which a cookie written from the browser cannot have — and does not
  // need, holding only a display preference. Secure wherever the page is https.
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

function applyToDocument(theme: ThemePreference): void {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  const next = themeClass(theme);
  if (next) root.classList.add(next);
}

export interface ThemeCycle {
  /** The mode on screen — the optimistic one while a change is in flight. */
  readonly theme: ThemePreference;
  /** The mode the next press selects. */
  readonly next: ThemePreference;
  readonly pending: boolean;
  /** Advances to `next` — the topbar button and the account menu. */
  readonly cycle: () => void;
  /** Jumps straight to one mode — the ⌘K palette's theme items. */
  readonly select: (target: ThemePreference) => void;
}

/**
 * Shared by the topbar button, the account menu's item (the only theme control
 * on small screens) and the ⌘K palette, so every one of them changes the same
 * preference the same way.
 *
 * @param theme The preference the server rendered with, from the cookie.
 */
export function useThemeCycle(theme: ThemePreference): ThemeCycle {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(theme);
  const next = nextTheme(shown);

  function select(target: ThemePreference): void {
    persist(target);
    applyToDocument(target);
    startTransition(() => {
      setShown(target);
      router.refresh();
    });
  }

  return { theme: shown, next, pending, cycle: () => select(next), select };
}

interface ThemeToggleProps {
  /** The preference the server rendered with, from the `meridian_theme` cookie. */
  theme: ThemePreference;
  className?: string;
}

export function ThemeToggle({ theme, className }: ThemeToggleProps) {
  const { theme: shown, next, cycle } = useThemeCycle(theme);
  const Icon = THEME_ICONS[shown];
  const label = `Theme: ${THEME_LABELS[shown]}. Switch to ${THEME_LABELS[next]}.`;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={label}
      title={label}
      className={className}
    >
      <Icon aria-hidden />
    </Button>
  );
}

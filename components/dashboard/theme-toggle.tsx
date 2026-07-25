"use client";

import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Flips the theme, persists the choice, and keeps native UI (scrollbars, form
 * controls) in sync via color-scheme. Reads state from the DOM so first paint
 * never mismatches the anti-FOUC script in the root layout.
 */
export function toggleTheme(): void {
  const root = document.documentElement;
  const next = !root.classList.contains("dark");
  root.classList.toggle("dark", next);
  root.style.colorScheme = next ? "dark" : "light";
  try {
    localStorage.setItem("theme", next ? "dark" : "light");
  } catch {
    // Ignore storage failures (private mode, etc.) — the class still applies.
  }
}

export function ThemeToggle({ className }: { className?: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label="Toggle light or dark theme"
      title="Toggle theme"
      className={className}
    >
      {/* Icons swap via the .dark class — no client state, no flash. */}
      <Sun className="hidden dark:block" />
      <Moon className="block dark:hidden" />
    </Button>
  );
}
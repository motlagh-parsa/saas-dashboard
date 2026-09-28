/**
 * The theme preference: its cookie, its three values, and what each one puts on
 * <html>.
 *
 * A plain module, imported by BOTH sides. The root layout reads the cookie and
 * renders the class, so the first byte of HTML already carries the right theme
 * (no inline script, no flash). The toggle writes the same cookie from the
 * browser. `meridian_org`'s constants live in lib/active-org.ts, but that module
 * is `server-only`; this one cannot be.
 *
 * The cookie is deliberately NOT httpOnly: it holds a display preference, not a
 * credential, and the toggle writes it directly. A hand-edited value is harmless
 * — `parseTheme` narrows anything unrecognised to "system".
 */

export const THEME_COOKIE = "meridian_theme";

/** One year, in seconds — the same lifetime as `meridian_org`. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const THEMES = ["light", "dark", "system"] as const;

export type ThemePreference = (typeof THEMES)[number];

/** No cookie yet means "follow the OS" — the least surprising first visit. */
export const DEFAULT_THEME: ThemePreference = "system";

export function parseTheme(raw: string | undefined): ThemePreference {
  return THEMES.find((theme) => theme === raw) ?? DEFAULT_THEME;
}

/**
 * The class for <html>. "system" gets NONE: globals.css then applies the dark
 * palette under `prefers-color-scheme: dark` — but only while <html> is not
 * `.light`, which is why an explicit light choice needs a class of its own.
 */
export function themeClass(theme: ThemePreference): "light" | "dark" | "" {
  return theme === "system" ? "" : theme;
}

/** The toggle's order: light → dark → system → light. */
export function nextTheme(theme: ThemePreference): ThemePreference {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}

export const THEME_LABELS: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

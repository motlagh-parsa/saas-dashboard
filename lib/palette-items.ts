/**
 * What the ⌘K palette can do: every destination, the quick actions, and the
 * theme choices — static data, rendered by components/dashboard/command-palette.tsx.
 *
 * Navigation is DERIVED from the sidebar's own list (nav-items.ts) so the two can
 * never disagree about where the app goes; only Profile is added, because it is a
 * settings tab rather than a sidebar entry.
 *
 * `roles` hides an item from anyone whose role in the active workspace is not
 * listed. That is presentation only — every destination and action re-checks the
 * role on the server.
 */
import type { Role } from "@prisma/client";
import type { ComponentType } from "react";
import { Mail, Monitor, Moon, Sun, UserPlus, UserRound } from "lucide-react";

import { primaryNav, secondaryNav } from "@/components/dashboard/nav-items";
import { THEME_LABELS, THEMES, type ThemePreference } from "@/lib/theme";

export type PaletteGroup = "Navigation" | "Actions" | "Theme";

/** Render order of the groups. */
export const PALETTE_GROUPS: readonly PaletteGroup[] = ["Navigation", "Actions", "Theme"];

export type PaletteCommand =
  | { readonly kind: "navigate"; readonly href: string }
  | { readonly kind: "theme"; readonly theme: ThemePreference };

export interface PaletteItem {
  /** Stable and unique — doubles as the DOM id suffix for aria-activedescendant. */
  readonly id: string;
  readonly group: PaletteGroup;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly command: PaletteCommand;
  /** Shown only to these roles in the active workspace. Absent = everyone. */
  readonly roles?: readonly Role[];
}

const MANAGERS: readonly Role[] = ["OWNER", "ADMIN"];

/** The audit log redirects members away, so the palette does not offer it to them. */
const MANAGER_ONLY_HREFS: ReadonlySet<string> = new Set(["/dashboard/audit"]);

/** Where "Add user" lands: the Users page opens its Add user dialog for this param. */
export const ADD_USER_HREF = "/dashboard/users?action=add";

const THEME_ICONS: Record<ThemePreference, ComponentType<{ className?: string }>> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

export const PALETTE_ITEMS: readonly PaletteItem[] = [
  ...[...primaryNav, ...secondaryNav].map(
    (item): PaletteItem => ({
      id: `nav${item.href.replace(/\//g, "-")}`,
      group: "Navigation",
      label: item.label,
      icon: item.icon,
      command: { kind: "navigate", href: item.href },
      roles: MANAGER_ONLY_HREFS.has(item.href) ? MANAGERS : undefined,
    }),
  ),
  {
    id: "nav-profile",
    group: "Navigation",
    label: "Profile",
    icon: UserRound,
    command: { kind: "navigate", href: "/dashboard/settings/profile" },
  },
  {
    id: "action-add-user",
    group: "Actions",
    label: "Add user",
    icon: UserPlus,
    command: { kind: "navigate", href: ADD_USER_HREF },
    roles: MANAGERS,
  },
  {
    // Same destination: adding a user IS inviting them — the dialog hands back
    // the invite link (lib/invite-token.ts).
    id: "action-invite-member",
    group: "Actions",
    label: "Invite member",
    icon: Mail,
    command: { kind: "navigate", href: ADD_USER_HREF },
    roles: MANAGERS,
  },
  ...THEMES.map(
    (theme): PaletteItem => ({
      id: `theme-${theme}`,
      group: "Theme",
      label: `Switch to ${THEME_LABELS[theme]}`,
      icon: THEME_ICONS[theme],
      command: { kind: "theme", theme },
    }),
  ),
];

/** The items this role may see. `null` (no workspace) sees only role-free items. */
export function paletteItemsFor(role: Role | null): readonly PaletteItem[] {
  return PALETTE_ITEMS.filter(
    (item) => item.roles === undefined || (role !== null && item.roles.includes(role)),
  );
}

/** Case-insensitive label match. An empty query matches everything. */
export function filterPaletteItems(
  items: readonly PaletteItem[],
  query: string,
): readonly PaletteItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => item.label.toLowerCase().includes(needle));
}

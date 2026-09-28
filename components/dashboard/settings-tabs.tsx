import { NavChip } from "@/components/dashboard/nav-chip";

/**
 * The Workspace | Profile switch shared by the two settings pages.
 *
 * Sub-navigation rather than a second sidebar entry: the sidebar marks Settings
 * active for everything under /dashboard/settings, so a separate "Profile" item
 * would light up alongside it. Same chips as the notifications tabs.
 */
export function SettingsTabs({ current }: { current: "workspace" | "profile" }) {
  return (
    <nav
      aria-label="Settings sections"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5"
    >
      <NavChip href="/dashboard/settings" active={current === "workspace"}>
        Workspace
      </NavChip>
      <NavChip href="/dashboard/settings/profile" active={current === "profile"}>
        Profile
      </NavChip>
    </nav>
  );
}

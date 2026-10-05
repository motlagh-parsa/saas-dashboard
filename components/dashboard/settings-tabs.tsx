import { NavChip } from "@/components/dashboard/nav-chip";

/**
 * The Workspace | Profile | API keys switch shared by the settings pages.
 *
 * Sub-navigation rather than a second sidebar entry: the sidebar marks Settings
 * active for everything under /dashboard/settings, so a separate "Profile" item
 * would light up alongside it. Same chips as the notifications tabs.
 *
 * API keys is for owners and admins only; members are not shown the tab (and
 * the page and its actions refuse them regardless).
 */
export function SettingsTabs({
  current,
  showApiKeys,
}: {
  current: "workspace" | "profile" | "api-keys";
  showApiKeys: boolean;
}) {
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
      {showApiKeys ? (
        <NavChip href="/dashboard/settings/api-keys" active={current === "api-keys"}>
          API keys
        </NavChip>
      ) : null}
    </nav>
  );
}

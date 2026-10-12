import { NavChip } from "@/components/dashboard/nav-chip";

/**
 * The Workspace | Profile | API keys | Integrations switch shared by the settings pages.
 *
 * Sub-navigation rather than a second sidebar entry: the sidebar marks Settings
 * active for everything under /dashboard/settings, so a separate "Profile" item
 * would light up alongside it. Same chips as the notifications tabs.
 *
 * API keys and Integrations are for owners and admins only; members are not
 * shown those tabs (and the pages and their actions refuse them regardless).
 */
export function SettingsTabs({
  current,
  showManagerTabs,
}: {
  current: "workspace" | "profile" | "api-keys" | "integrations";
  showManagerTabs: boolean;
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
      {showManagerTabs ? (
        <>
          <NavChip href="/dashboard/settings/api-keys" active={current === "api-keys"}>
            API keys
          </NavChip>
          <NavChip href="/dashboard/settings/integrations" active={current === "integrations"}>
            Integrations
          </NavChip>
        </>
      ) : null}
    </nav>
  );
}

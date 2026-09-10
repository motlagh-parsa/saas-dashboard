// Settings. Render mode: dynamic — it reads the session cookie, so it is never
// statically rendered.
//
// There is no data on this page yet, but `requireSession()` is still the
// authorization gate. Middleware is edge-only and is NOT authz; the security
// line is held server-side in every protected page, including the empty ones.
import type { Metadata } from "next";
import { Settings } from "lucide-react";

import { requireSession } from "@/lib/auth";
import { ComingSoon } from "@/components/dashboard/coming-soon";

export const metadata: Metadata = {
  title: "Settings",
  description: "Workspace details, members and roles, and billing configuration.",
};

export default async function SettingsPage() {
  await requireSession();

  return (
    <ComingSoon
      title="Settings"
      description="Workspace details, members and their roles, and the billing configuration behind these metrics."
      icon={Settings}
    />
  );
}

// Reports. Render mode: dynamic — it reads the session cookie, so it is never
// statically rendered.
//
// There is no data on this page yet, but `requireSession()` is still the
// authorization gate. Middleware is edge-only and is NOT authz; the security
// line is held server-side in every protected page, including the empty ones.
import type { Metadata } from "next";
import { FileText } from "lucide-react";

import { requireSession } from "@/lib/auth";
import { ComingSoon } from "@/components/dashboard/coming-soon";

export const metadata: Metadata = {
  title: "Reports",
  description: "Saved metric views and scheduled exports for your workspace.",
};

export default async function ReportsPage() {
  await requireSession();

  return (
    <ComingSoon
      title="Reports"
      description="Saved metric views and scheduled exports — the numbers from this dashboard, packaged for finance and the board."
      icon={FileText}
    />
  );
}

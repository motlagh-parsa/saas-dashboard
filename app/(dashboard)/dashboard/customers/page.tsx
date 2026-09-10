// Customers. Render mode: dynamic — it reads the session cookie, so it is never
// statically rendered.
//
// There is no data on this page yet, but `requireSession()` is still the
// authorization gate. Middleware is edge-only and is NOT authz; the security
// line is held server-side in every protected page, including the empty ones.
import type { Metadata } from "next";
import { Users } from "lucide-react";

import { requireSession } from "@/lib/auth";
import { ComingSoon } from "@/components/dashboard/coming-soon";

export const metadata: Metadata = {
  title: "Customers",
  description: "Account records, plan history, and lifetime value by customer.",
};

export default async function CustomersPage() {
  await requireSession();

  return (
    <ComingSoon
      title="Customers"
      description="Account records, plan history, and lifetime value — one row per customer, filterable by plan and status."
      icon={Users}
    />
  );
}

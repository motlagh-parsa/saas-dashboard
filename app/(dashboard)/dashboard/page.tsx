// Protected dashboard entry. Render mode: dynamic (session-dependent, uses
// cookies via getServerSession). This is a minimal placeholder that proves auth
// end-to-end — the real dashboard shell/widgets are owned by other agents.
//
// requireSession() is the authorization gate: middleware already blocks anonymous
// requests, but we re-check here server-side because middleware alone is NOT authz.
import type { Metadata } from "next";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireSession } from "@/lib/auth";
import { SignOutButton } from "@/components/auth/sign-out-button";

export const metadata: Metadata = {
  title: "Dashboard — SaaS Metrics Dashboard",
  description: "Your authenticated SaaS metrics overview.",
};

export default async function DashboardPage() {
  const session = await requireSession();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <SignOutButton />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>You are signed in</CardTitle>
          <CardDescription>
            This route is protected by middleware and re-verified server-side.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>User id: {session.user.id}</p>
          <p>Name: {session.user.name ?? "—"}</p>
          <p>Email: {session.user.email ?? "—"}</p>
        </CardContent>
      </Card>
    </main>
  );
}
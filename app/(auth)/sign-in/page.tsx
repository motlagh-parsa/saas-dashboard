// Sign-in page — Server Component. Render mode: dynamic (reads searchParams).
// It only decides which providers to show and hands serializable props to the
// client leaf that owns the interactive form.
import type { Metadata } from "next";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isGithubEnabled } from "@/lib/env";
import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata: Metadata = {
  title: "Sign in — SaaS Metrics Dashboard",
  description: "Sign in to access your SaaS metrics dashboard.",
};

type SignInPageProps = {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
};

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const { callbackUrl, error } = await searchParams;

  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Use the demo account, or continue with GitHub.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm
            callbackUrl={callbackUrl ?? "/dashboard"}
            githubEnabled={isGithubEnabled}
            initialError={error}
          />
        </CardContent>
      </Card>
    </main>
  );
}
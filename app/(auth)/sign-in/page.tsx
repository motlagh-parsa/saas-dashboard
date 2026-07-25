// Sign-in page — Server Component. Render mode: dynamic (reads searchParams).
// It only decides which providers to show and hands serializable props to the
// client leaf that owns the interactive form.
import type { Metadata } from "next";

import { isGithubEnabled } from "@/lib/env";
import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to access your SaaS metrics dashboard.",
};

type SignInPageProps = {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
};

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const { callbackUrl, error } = await searchParams;

  return (
    <div className="w-full max-w-sm">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Sign in
        </h1>
        <p className="text-sm text-muted-foreground">
          Welcome back. Use the demo account, or continue with GitHub.
        </p>
      </div>

      <div className="mt-6">
        <SignInForm
          callbackUrl={callbackUrl ?? "/dashboard"}
          githubEnabled={isGithubEnabled}
          initialError={error}
        />
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        By continuing you agree to the terms of service and privacy policy.
      </p>
    </div>
  );
}
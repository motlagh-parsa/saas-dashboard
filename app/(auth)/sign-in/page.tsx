// Sign-in page — Server Component. Render mode: dynamic (reads searchParams).
// It only decides which providers to show and hands serializable props to the
// client leaf that owns the interactive form.
import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck } from "lucide-react";

import { isGithubEnabled, isMailEnabled, isPublicDemo } from "@/lib/env";
import { DemoButton } from "@/components/auth/demo-button";
import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to access your SaaS metrics dashboard.",
};

type SignInPageProps = {
  searchParams: Promise<{
    callbackUrl?: string;
    error?: string;
    registered?: string;
    invited?: string;
    reset?: string;
  }>;
};

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const { callbackUrl, error, registered, invited, reset } = await searchParams;

  return (
    <div className="w-full max-w-sm">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Sign in
        </h1>
        <p className="text-sm text-muted-foreground">
          {isGithubEnabled
            ? "Welcome back. Use your email and password, or continue with GitHub."
            : "Welcome back. Sign in with your email and password."}
        </p>
      </div>

      {/* Set by `registerUser` on success. Only ever a confirmation — the flag
          carries no identity, so a hand-typed URL can do no more than show it. */}
      {registered === "1" ? (
        <p
          role="status"
          className="mt-6 flex items-start gap-2 rounded-md border border-positive/25 bg-positive/10 px-3 py-2.5 text-sm text-positive"
        >
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Account created. Sign in to set up your workspace.</span>
        </p>
      ) : null}

      {/* Set by `acceptInvite` on success — same contract as `registered`. */}
      {invited === "1" ? (
        <p
          role="status"
          className="mt-6 flex items-start gap-2 rounded-md border border-positive/25 bg-positive/10 px-3 py-2.5 text-sm text-positive"
        >
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Password set. You can now sign in.</span>
        </p>
      ) : null}

      {/* Set by `resetPassword` on success — same contract as `registered`. */}
      {reset === "1" ? (
        <p
          role="status"
          className="mt-6 flex items-start gap-2 rounded-md border border-positive/25 bg-positive/10 px-3 py-2.5 text-sm text-positive"
        >
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Password changed, and every other session signed out. Sign in with your new password.</span>
        </p>
      ) : null}

      <div className="mt-6">
        <SignInForm
          callbackUrl={callbackUrl ?? "/dashboard"}
          githubEnabled={isGithubEnabled}
          passwordResetEnabled={isMailEnabled}
          initialError={error}
        />
      </div>

      {isPublicDemo ? (
        <div className="mt-6 flex flex-col gap-2 border-t border-border pt-6">
          <p className="text-sm text-muted-foreground">Just looking? Explore a workspace full of sample data.</p>
          <DemoButton className="h-11 w-full" />
        </div>
      ) : null}

      <p className="mt-6 text-sm text-muted-foreground">
        New here?{" "}
        <Link
          href="/register"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Create an account
        </Link>
      </p>

      <p className="mt-4 text-xs text-muted-foreground">
        By continuing you agree to the terms of service and privacy policy.
      </p>
    </div>
  );
}
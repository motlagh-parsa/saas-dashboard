// Register page — Server Component, same shape as the sign-in page: it owns the
// copy and the links, and hands the interactive form to a client leaf.
import type { Metadata } from "next";
import Link from "next/link";

import { RegisterForm } from "@/components/auth/register-form";

export const metadata: Metadata = {
  title: "Create an account",
  description: "Create an account, then set up a workspace for your SaaS metrics.",
};

export default function RegisterPage() {
  return (
    <div className="w-full max-w-sm">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Create an account
        </h1>
        <p className="text-sm text-muted-foreground">
          Next, you&apos;ll name your workspace and bring in your data.
        </p>
      </div>

      <div className="mt-6">
        <RegisterForm />
      </div>

      <p className="mt-6 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          href="/sign-in"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>

      <p className="mt-4 text-xs text-muted-foreground">
        By continuing you agree to the terms of service and privacy policy.
      </p>
    </div>
  );
}

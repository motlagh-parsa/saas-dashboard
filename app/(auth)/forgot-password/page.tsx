// /forgot-password — public. Asks for an email address and sends a reset link
// to it if (and only if) it belongs to an account that signs in with a password.
import type { Metadata } from "next";
import Link from "next/link";

import { isMailEnabled } from "@/lib/env";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const metadata: Metadata = {
  title: "Reset your password",
  description: "Get a link to choose a new password.",
};

const LINK_CLASS = "font-medium text-foreground underline-offset-4 hover:underline";

export default function ForgotPasswordPage() {
  return (
    <div className="w-full max-w-sm">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Reset your password</h1>
        <p className="text-sm text-muted-foreground">
          Enter the email address you sign in with and we&apos;ll send you a link to choose a new password.
        </p>
      </div>

      <div className="mt-6">
        {isMailEnabled ? (
          <ForgotPasswordForm />
        ) : (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
            This deployment doesn&apos;t send email, so passwords can&apos;t be reset from here. Ask a workspace
            owner for help.
          </p>
        )}
      </div>

      <p className="mt-6 text-sm text-muted-foreground">
        Remembered it?{" "}
        <Link href="/sign-in" className={LINK_CLASS}>
          Sign in
        </Link>
      </p>
    </div>
  );
}

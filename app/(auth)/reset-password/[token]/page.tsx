// /reset-password/<token> — public. The token in the URL is the person's only
// credential here; lib/email-tokens.ts decides what it is worth, this page only
// words it. Opening the page changes nothing: the token is spent on submit.
import type { Metadata } from "next";
import Link from "next/link";

import { lookupEmailToken } from "@/lib/email-tokens";
import { SetPasswordForm } from "@/components/auth/set-password-form";
import { resetPassword } from "@/app/(auth)/reset-password/[token]/actions";

export const metadata: Metadata = {
  title: "Choose a new password",
  description: "Set a new password for your account.",
  // The token is in this URL: keep it out of Referer headers and search.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

type ResetPasswordPageProps = {
  params: Promise<{ token: string }>;
};

const LINK_CLASS = "font-medium text-foreground underline-offset-4 hover:underline";

export default async function ResetPasswordPage({ params }: ResetPasswordPageProps) {
  const { token } = await params;
  const owner = await lookupEmailToken(token, "RESET_PASSWORD");

  if (owner === null) {
    return (
      <div className="w-full max-w-sm">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Link unavailable</h1>
          <p className="text-sm text-muted-foreground">
            This reset link is invalid, has expired, or was already used. Only the newest link we sent works.
          </p>
        </div>
        <p className="mt-6 text-sm text-muted-foreground">
          <Link href="/forgot-password" className={LINK_CLASS}>
            Request a new link
          </Link>{" "}
          or{" "}
          <Link href="/sign-in" className={LINK_CLASS}>
            sign in
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Choose a new password</h1>
        <p className="text-sm text-muted-foreground">
          For <span className="font-medium text-foreground">{owner.email}</span>. Saving it signs you out on every
          device.
        </p>
      </div>

      <div className="mt-6">
        <SetPasswordForm
          action={resetPassword}
          token={token}
          email={owner.email}
          submitLabel="Save new password"
          pendingLabel="Saving…"
        />
      </div>
    </div>
  );
}

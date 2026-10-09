// Invite page — Server Component, same shape as the register page: it owns the
// copy and the links, and hands the interactive form to a client leaf.
// Render mode: dynamic (reads the route param and the database).
//
// Public on purpose (middleware only guards /dashboard): the person arriving
// here has no password yet, so the token in the URL is their only credential.
// lib/invite-token.ts decides what the link is worth; this page only words it.
import type { Metadata } from "next";
import Link from "next/link";

import { lookupInvite } from "@/lib/invite-token";
import { formatPersonName } from "@/lib/format";
import { acceptInvite } from "@/app/(auth)/invite/[token]/actions";
import { SetPasswordForm } from "@/components/auth/set-password-form";

export const metadata: Metadata = {
  title: "Set your password",
  description: "Finish setting up the account you were invited to.",
  // The token is in this URL. `no-referrer` keeps it out of the Referer header
  // of anything the page loads or links to; noindex keeps it out of search.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

type InvitePageProps = {
  params: Promise<{ token: string }>;
};

const LINK_CLASS = "font-medium text-foreground underline-offset-4 hover:underline";

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const invite = await lookupInvite(token);

  if (invite.kind === "invalid") {
    return (
      <div className="w-full max-w-sm">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Invite unavailable
          </h1>
          <p className="text-sm text-muted-foreground">
            This invite link is invalid or has expired.
          </p>
        </div>
        <p className="mt-6 text-sm text-muted-foreground">
          Ask whoever invited you for a new link, or{" "}
          <Link href="/sign-in" className={LINK_CLASS}>
            sign in
          </Link>{" "}
          if you already have a password.
        </p>
      </div>
    );
  }

  if (invite.kind === "already-set") {
    return (
      <div className="w-full max-w-sm">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            You&apos;re all set
          </h1>
          <p className="text-sm text-muted-foreground">
            You&apos;ve already set your password. Sign in instead.
          </p>
        </div>
        <p className="mt-6 text-sm text-muted-foreground">
          <Link href="/sign-in" className={LINK_CLASS}>
            Go to sign in
          </Link>
        </p>
      </div>
    );
  }

  const { user } = invite;

  return (
    <div className="w-full max-w-sm">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Set your password
        </h1>
        <p className="text-sm text-muted-foreground">
          Welcome, {formatPersonName(user.name, user.email)}. Choose a password for{" "}
          <span className="font-medium text-foreground">{user.email}</span> to finish
          setting up your account.
        </p>
      </div>

      <div className="mt-6">
        <SetPasswordForm
          action={acceptInvite}
          token={token}
          email={user.email}
          submitLabel="Set password"
          pendingLabel="Setting password…"
        />
      </div>

      <p className="mt-6 text-sm text-muted-foreground">
        Already set one?{" "}
        <Link href="/sign-in" className={LINK_CLASS}>
          Sign in
        </Link>
      </p>
    </div>
  );
}

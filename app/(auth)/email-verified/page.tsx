// Where a confirmation link lands (app/verify-email/[token]/route.ts redirects
// here). The status flag carries no identity, so a hand-typed URL can do no
// more than show one of these two messages.
import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck } from "lucide-react";

export const metadata: Metadata = {
  title: "Email confirmation",
  robots: { index: false, follow: false },
};

type EmailVerifiedPageProps = {
  searchParams: Promise<{ status?: string }>;
};

const LINK_CLASS = "font-medium text-foreground underline-offset-4 hover:underline";

export default async function EmailVerifiedPage({ searchParams }: EmailVerifiedPageProps) {
  const { status } = await searchParams;

  if (status === "verified") {
    return (
      <div className="w-full max-w-sm">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Email confirmed</h1>
          <p className="flex items-start gap-2 text-sm text-positive" data-testid="email-verified">
            <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>Thanks — your email address is confirmed.</span>
          </p>
        </div>
        <p className="mt-6 text-sm text-muted-foreground">
          <Link href="/dashboard" className={LINK_CLASS}>
            Continue to Meridian
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Link unavailable</h1>
        <p className="text-sm text-muted-foreground">
          This confirmation link is invalid, has expired, or was already used. Only the newest link we sent works.
        </p>
      </div>
      <p className="mt-6 text-sm text-muted-foreground">
        Sign in and use <span className="font-medium text-foreground">Resend email</span> in the banner at the top of
        the page to get a new one.{" "}
        <Link href="/dashboard" className={LINK_CLASS}>
          Go to Meridian
        </Link>
      </p>
    </div>
  );
}

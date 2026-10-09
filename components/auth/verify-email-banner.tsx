"use client";

// A slim strip above every dashboard page while the account's email address is
// unconfirmed. Inviting teammates and creating API keys wait for it
// (lib/account-email.ts → unverifiedEmailRefusal); everything else works.
import { useActionState } from "react";
import { MailWarning } from "lucide-react";

import { resendVerificationEmail } from "@/lib/verification-actions";
import { IDLE_RESEND_VERIFICATION } from "@/lib/verification-form";

interface VerifyEmailBannerProps {
  email: string;
}

export function VerifyEmailBanner({ email }: VerifyEmailBannerProps) {
  const [state, formAction, pending] = useActionState(resendVerificationEmail, IDLE_RESEND_VERIFICATION);

  return (
    <div
      role="status"
      data-testid="verify-email-banner"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/50 px-4 py-2 text-[0.8125rem] sm:px-6 lg:px-8"
    >
      <MailWarning aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-foreground">
        Confirm your email address — we sent a link to <span className="font-medium">{email}</span>.
      </span>
      {state.message ? (
        <span
          aria-live="polite"
          className={state.status === "error" ? "text-destructive" : "text-muted-foreground"}
        >
          {state.message}
        </span>
      ) : (
        <form action={formAction}>
          <button
            type="submit"
            disabled={pending}
            className="font-medium text-foreground underline underline-offset-4 hover:text-brand disabled:opacity-60"
          >
            {pending ? "Sending…" : "Resend email"}
          </button>
        </form>
      )}
    </div>
  );
}

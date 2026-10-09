"use server";

// Resending the confirmation email, from the banner every unconfirmed account
// sees. Signed-in only; it always acts on the caller's own account, never on an
// id from the form.
import { needsEmailVerification, sendVerificationEmail } from "@/lib/account-email";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { ResendVerificationState } from "@/lib/verification-form";

/** Used as a form action; it takes no input, so it declares no parameters. */
export async function resendVerificationEmail(): Promise<ResendVerificationState> {
  const session = await requireSession();
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, passwordHash: true, emailVerified: true },
  });
  if (user === null) return { status: "error", message: "Reload the page and try again." };
  if (!needsEmailVerification(user)) return { status: "sent", message: "Your email address is already confirmed." };

  const outcome = await sendVerificationEmail(user);
  switch (outcome.kind) {
    case "sent":
      return { status: "sent", message: `Sent — check ${user.email}.` };
    case "rate-limited": {
      const minutes = Math.ceil(outcome.retryAfterSeconds / 60);
      return {
        status: "error",
        message:
          outcome.retryAfterSeconds < 90
            ? `We just sent one. Try again in ${outcome.retryAfterSeconds} seconds.`
            : `Too many emails for now. Try again in ${minutes} minutes.`,
      };
    }
    case "unavailable":
    case "failed":
      return { status: "error", message: "We couldn't send the email. Try again in a few minutes." };
  }
}

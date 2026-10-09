import "server-only";

// The account emails, end to end: issue the token (lib/email-tokens.ts), build
// the link, render the template (lib/mail-templates.ts), send (lib/mail.ts).
// Callers decide WHEN; this module only knows HOW. None of these throw.
import { appUrl, isMailEnabled } from "@/lib/env";
import { INVITE_TTL_MS } from "@/lib/invite-token";
import { issueEmailToken, RESET_TTL_MINUTES, VERIFY_TTL_HOURS } from "@/lib/email-tokens";
import { sendMail } from "@/lib/mail";
import {
  inviteTemplate,
  passwordChangedTemplate,
  resetPasswordTemplate,
  verifyEmailTemplate,
} from "@/lib/mail-templates";
import { prisma } from "@/lib/prisma";

export type SendOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "rate-limited"; readonly retryAfterSeconds: number }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed" };

interface Recipient {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
}

/**
 * Whether an account still has to confirm its address. Only accounts that sign
 * in with a password do: GitHub vouches for its users' addresses, the demo
 * account has none to confirm, and invited accounts confirmed theirs by opening
 * the invite. Never true when this deployment cannot send email.
 */
export function needsEmailVerification(user: {
  readonly passwordHash: string | null;
  readonly emailVerified: Date | null;
}): boolean {
  return isMailEnabled && user.passwordHash !== null && user.emailVerified === null;
}

export async function sendVerificationEmail(user: Recipient): Promise<SendOutcome> {
  if (!isMailEnabled) return { kind: "unavailable" };
  const issued = await issueEmailToken(user.id, "VERIFY_EMAIL");
  if (issued.kind === "rate-limited") return issued;
  const url = `${appUrl()}/verify-email/${issued.token}`;
  const sent = await sendMail({
    to: user.email,
    ...verifyEmailTemplate({ name: user.name, url, hours: VERIFY_TTL_HOURS }),
  });
  return sent ? { kind: "sent" } : { kind: "failed" };
}

/**
 * The "forgot password" request. Whatever happens here, the caller tells the
 * person the same thing — "if an account exists, we've sent a link" — so this
 * cannot be used to learn which addresses have accounts. Sends only to accounts
 * that can sign in with a password and are not suspended.
 */
export async function sendPasswordResetEmail(email: string): Promise<SendOutcome> {
  if (!isMailEnabled) return { kind: "unavailable" };
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, passwordHash: true, suspendedAt: true },
  });
  if (user === null || user.passwordHash === null || user.suspendedAt !== null) {
    return { kind: "sent" };
  }
  const issued = await issueEmailToken(user.id, "RESET_PASSWORD");
  if (issued.kind === "rate-limited") return issued;
  const url = `${appUrl()}/reset-password/${issued.token}`;
  const sent = await sendMail({
    to: user.email,
    ...resetPasswordTemplate({ name: user.name, url, minutes: RESET_TTL_MINUTES }),
  });
  return sent ? { kind: "sent" } : { kind: "failed" };
}

/** A heads-up after any password change, with a way back if it wasn't them. */
export async function sendPasswordChangedEmail(user: Recipient): Promise<SendOutcome> {
  if (!isMailEnabled) return { kind: "unavailable" };
  const base = appUrl();
  const sent = await sendMail({
    to: user.email,
    ...passwordChangedTemplate({ name: user.name, signInUrl: `${base}/sign-in`, resetUrl: `${base}/forgot-password` }),
  });
  return sent ? { kind: "sent" } : { kind: "failed" };
}

/**
 * The invite email for an account an admin added. `token` is the raw invite
 * token the action just issued — it goes into the link and nowhere else.
 */
export async function sendInviteEmail(input: {
  readonly to: Recipient;
  readonly inviterName: string;
  readonly workspaceName: string;
  readonly token: string;
}): Promise<SendOutcome> {
  if (!isMailEnabled) return { kind: "unavailable" };
  const sent = await sendMail({
    to: input.to.email,
    ...inviteTemplate({
      name: input.to.name,
      inviterName: input.inviterName,
      workspaceName: input.workspaceName,
      url: `${appUrl()}/invite/${input.token}`,
      days: Math.round(INVITE_TTL_MS / (24 * 60 * 60 * 1000)),
    }),
  });
  return sent ? { kind: "sent" } : { kind: "failed" };
}

/**
 * Inviting people and creating API keys act on behalf of the workspace toward
 * the outside world, so an account that signs in with a password must confirm
 * its own address first. Returns the refusal message, or null when allowed.
 */
export async function unverifiedEmailRefusal(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, emailVerified: true },
  });
  if (user === null || !needsEmailVerification(user)) return null;
  return "Confirm your email address first — use the link we sent you, or resend it from the banner at the top of the page.";
}

/**
 * Sends the invite email for `userId` once the response is out: names the
 * inviter and the workspace, and carries the raw token in its link. Looked up
 * here rather than passed in, so callers only hand over ids and the token.
 */
export async function sendInviteEmailFor(input: {
  readonly userId: string;
  readonly inviterId: string;
  readonly organizationId: string;
  readonly token: string;
}): Promise<SendOutcome> {
  const [invitee, inviter, organization] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, name: true, email: true } }),
    prisma.user.findUnique({ where: { id: input.inviterId }, select: { name: true, email: true } }),
    prisma.organization.findUnique({ where: { id: input.organizationId }, select: { name: true } }),
  ]);
  if (invitee === null || organization === null) return { kind: "failed" };
  return sendInviteEmail({
    to: invitee,
    inviterName: inviter?.name ?? inviter?.email ?? "A teammate",
    workspaceName: organization.name,
    token: input.token,
  });
}

/**
 * The email half of `npm run verify:metrics`: the token rules, the account
 * emails and the session revocation behind a password reset, driven through the
 * same lib functions the pages and actions call.
 *
 *   1. Tokens — only the hash is stored; single use; expiry; wrong purpose and
 *      malformed tokens are just "invalid"; a new link expires the old one;
 *      the per-account sending limits (60 s gap, N per rolling hour).
 *   2. Verification — the email arrives in the local mailbox with a working
 *      link; consuming it confirms the address once.
 *   3. Password reset — no email (and the same outcome) for unknown, password-
 *      less and suspended accounts; the link sets the password, revokes earlier
 *      sessions, confirms the address and expires other reset links.
 *   4. Who must confirm, and what waits for it (invites, API keys).
 *   5. Templates escape user-provided values.
 *
 * It creates its own users (unique addresses per run) and deletes them by id.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  needsEmailVerification,
  sendPasswordResetEmail,
  sendVerificationEmail,
  unverifiedEmailRefusal,
} from "@/lib/account-email";
import {
  consumeResetToken,
  consumeVerifyToken,
  hashEmailToken,
  issueEmailToken,
  lookupEmailToken,
} from "@/lib/email-tokens";
import { localMailboxDir } from "@/lib/mail";
import { inviteTemplate } from "@/lib/mail-templates";
import { hashPassword, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { survivesRevocation } from "@/lib/session-revocation";

type Check = (label: string, actual: unknown, expected: unknown) => void;

interface StoredMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Every message the local driver wrote to `to`, oldest first. */
function mailTo(to: string): StoredMail[] {
  const dir = localMailboxDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return files
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as StoredMail)
    .filter((mail) => mail.to === to);
}

function tokenIn(mail: StoredMail | undefined, path: string): string | null {
  if (mail === undefined) return null;
  return new RegExp(`/${path}/([0-9a-f]{64})`).exec(mail.text)?.[1] ?? null;
}

const SECOND = 1000;

export async function verifyEmail(check: Check, stamp: string): Promise<string[]> {
  console.log("\n── email: tokens, verification, password reset ──");
  const userIds: string[] = [];
  const address = (label: string): string => `verify-${label}-${stamp}@example.test`;
  const makeUser = async (label: string, data: { passwordHash?: string | null; suspendedAt?: Date | null } = {}) => {
    const user = await prisma.user.create({
      data: { name: `Verify ${label}`, email: address(label), passwordHash: data.passwordHash ?? null, suspendedAt: data.suspendedAt ?? null },
      select: { id: true, name: true, email: true },
    });
    userIds.push(user.id);
    return user;
  };

  try {
    const oldHash = await hashPassword("old-password-1");

    // 1. Tokens -------------------------------------------------------------
    const tokenUser = await makeUser("tokens", { passwordHash: oldHash });
    const t0 = new Date();
    const first = await issueEmailToken(tokenUser.id, "VERIFY_EMAIL", t0);
    check("a token is issued", first.kind, "issued");
    const firstToken = first.kind === "issued" ? first.token : "";
    const stored = await prisma.emailToken.findMany({ where: { userId: tokenUser.id }, select: { tokenHash: true } });
    check("only the SHA-256 is stored", stored.map((row) => row.tokenHash), [hashEmailToken(firstToken)]);
    check("the stored value is not the token", stored[0]?.tokenHash === firstToken, false);

    const tooSoon = await issueEmailToken(tokenUser.id, "VERIFY_EMAIL", new Date(t0.getTime() + 10 * SECOND));
    check("a second link within 60 s is refused", tooSoon.kind, "rate-limited");
    check("… and says when to retry", tooSoon.kind === "rate-limited" ? tooSoon.retryAfterSeconds : null, 50);

    const t1 = new Date(t0.getTime() + 61 * SECOND);
    const second = await issueEmailToken(tokenUser.id, "VERIFY_EMAIL", t1);
    check("after 60 s a new link is issued", second.kind, "issued");
    check("the newer link expires the older one", await lookupEmailToken(firstToken, "VERIFY_EMAIL", t1), null);
    const secondToken = second.kind === "issued" ? second.token : "";
    check("the newer link is live", (await lookupEmailToken(secondToken, "VERIFY_EMAIL", t1))?.id, tokenUser.id);
    check("wrong purpose reads as invalid", await lookupEmailToken(secondToken, "RESET_PASSWORD", t1), null);
    check("a malformed token reads as invalid", await lookupEmailToken("not-a-token", "VERIFY_EMAIL", t1), null);
    check(
      "a verification link expires after 24 hours",
      await lookupEmailToken(secondToken, "VERIFY_EMAIL", new Date(t1.getTime() + 24 * 3600 * SECOND + SECOND)),
      null,
    );

    // Reset links: 3 per rolling hour.
    const limitUser = await makeUser("limits", { passwordHash: oldHash });
    const base = new Date();
    const results: string[] = [];
    for (let i = 0; i < 4; i++) {
      const issued = await issueEmailToken(limitUser.id, "RESET_PASSWORD", new Date(base.getTime() + i * 61 * SECOND));
      results.push(issued.kind);
    }
    check("reset links: three per hour, the fourth refused", results, ["issued", "issued", "issued", "rate-limited"]);
    const later = await issueEmailToken(limitUser.id, "RESET_PASSWORD", new Date(base.getTime() + 3601 * SECOND));
    check("… and allowed again once the hour has rolled", later.kind, "issued");

    // 2. Verification email -------------------------------------------------
    const newcomer = await makeUser("newcomer", { passwordHash: oldHash });
    check("a password account starts unconfirmed", needsEmailVerification({ passwordHash: oldHash, emailVerified: null }), true);
    const sent = await sendVerificationEmail(newcomer);
    check("the verification email is sent", sent.kind, "sent");
    const verifyMail = mailTo(newcomer.email).at(-1);
    check("it lands in the local mailbox", verifyMail?.subject, "Confirm your email for Meridian");
    const verifyToken = tokenIn(verifyMail, "verify-email");
    check("its link carries a 64-hex token", verifyToken?.length, 64);
    check("the HTML has the same link", verifyMail?.html.includes(`/verify-email/${verifyToken}`), true);
    const confirmed = await consumeVerifyToken(verifyToken ?? "");
    check("opening the link confirms the address", confirmed?.id, newcomer.id);
    const afterConfirm = await prisma.user.findUniqueOrThrow({ where: { id: newcomer.id }, select: { emailVerified: true } });
    check("emailVerified is stamped", afterConfirm.emailVerified instanceof Date, true);
    check("the link works once", await consumeVerifyToken(verifyToken ?? ""), null);
    check("a confirmed account needs nothing more", await unverifiedEmailRefusal(newcomer.id), null);

    // 3. Password reset -----------------------------------------------------
    const unknown = address("nobody");
    check("unknown address: the same answer", (await sendPasswordResetEmail(unknown)).kind, "sent");
    check("… and no email", mailTo(unknown).length, 0);

    const passwordless = await makeUser("github-only");
    check("password-less account: the same answer", (await sendPasswordResetEmail(passwordless.email)).kind, "sent");
    check("… and no email", mailTo(passwordless.email).length, 0);

    const suspended = await makeUser("suspended", { passwordHash: oldHash, suspendedAt: new Date() });
    check("suspended account: the same answer", (await sendPasswordResetEmail(suspended.email)).kind, "sent");
    check("… and no email", mailTo(suspended.email).length, 0);

    const resetter = await makeUser("resetter", { passwordHash: oldHash });
    check("a real account gets the email", (await sendPasswordResetEmail(resetter.email)).kind, "sent");
    const resetMail = mailTo(resetter.email).at(-1);
    check("the reset email arrives", resetMail?.subject, "Reset your Meridian password");
    const resetToken = tokenIn(resetMail, "reset-password");
    check("its link is live", (await lookupEmailToken(resetToken ?? "", "RESET_PASSWORD"))?.id, resetter.id);

    const signedInBefore = Date.now() - 5 * SECOND;
    const owner = await consumeResetToken(resetToken ?? "", await hashPassword("new-password-2"));
    check("the link sets the password", owner?.id, resetter.id);
    const afterReset = await prisma.user.findUniqueOrThrow({
      where: { id: resetter.id },
      select: { passwordHash: true, sessionsRevokedAt: true, emailVerified: true },
    });
    check("the new password works", await verifyPassword("new-password-2", afterReset.passwordHash ?? ""), true);
    check("the old one doesn't", await verifyPassword("old-password-1", afterReset.passwordHash ?? ""), false);
    check("the address counts as confirmed", afterReset.emailVerified instanceof Date, true);
    check("sessions from before the reset are cut off", survivesRevocation(signedInBefore, afterReset.sessionsRevokedAt), false);
    check("a session from before `authAt` existed is cut off too", survivesRevocation(0, afterReset.sessionsRevokedAt), false);
    check(
      "a session signed in afterwards survives",
      survivesRevocation((afterReset.sessionsRevokedAt?.getTime() ?? 0) + 1, afterReset.sessionsRevokedAt),
      true,
    );
    check("an account never revoked keeps every session", survivesRevocation(0, null), true);
    check("the reset link works once", await consumeResetToken(resetToken ?? "", await hashPassword("x-password-3")), null);

    // 4. Who must confirm ---------------------------------------------------
    check("a password-less account never has to confirm", needsEmailVerification({ passwordHash: null, emailVerified: null }), false);
    const unconfirmed = await makeUser("unconfirmed", { passwordHash: oldHash });
    check("an unconfirmed password account can't invite or create keys", typeof (await unverifiedEmailRefusal(unconfirmed.id)), "string");
    check("a password-less account can", await unverifiedEmailRefusal(passwordless.id), null);

    // 5. Templates ----------------------------------------------------------
    const invite = inviteTemplate({
      name: "Ada <b>",
      inviterName: "Eve & Co",
      workspaceName: "<script>alert(1)</script>",
      url: "https://example.test/invite/abc",
      days: 7,
    });
    check("user values are escaped in HTML", invite.html.includes("<script>"), false);
    check("… and shown escaped", invite.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), true);
    check("the plain-text part keeps them as typed", invite.text.includes("<script>alert(1)</script>"), true);
    check("the link is printed as text too", invite.text.includes("https://example.test/invite/abc"), true);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  return [];
}

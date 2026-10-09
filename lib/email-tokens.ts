import "server-only";

// One-time tokens for links sent by email: confirming an address, resetting a
// password. Same construction as invite tokens (lib/invite-token.ts): 32 random
// bytes, hex, living only in the emailed link; the database keeps the SHA-256,
// so a leaked backup or query log cannot be turned into a working link.
//
// Every consume is ONE conditional write on the token row (unused, unexpired,
// right purpose), so a link cannot be used twice — not even by two tabs at once.
import { createHash, randomBytes } from "node:crypto";
import type { EmailTokenPurpose } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export const VERIFY_TTL_HOURS = 24;
export const RESET_TTL_MINUTES = 60;

const TTL_MS: Record<EmailTokenPurpose, number> = {
  VERIFY_EMAIL: VERIFY_TTL_HOURS * 60 * 60 * 1000,
  RESET_PASSWORD: RESET_TTL_MINUTES * 60 * 1000,
};

/**
 * Sending limits per account and purpose: at most `perHour` links in a rolling
 * hour, and at least `gapSeconds` between two. They stop a resend button (or a
 * script posting someone else's address to /forgot-password) from turning the
 * app into a mail cannon.
 */
const LIMITS: Record<EmailTokenPurpose, { readonly perHour: number; readonly gapSeconds: number }> = {
  VERIFY_EMAIL: { perHour: 5, gapSeconds: 60 },
  RESET_PASSWORD: { perHour: 3, gapSeconds: 60 },
};

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function hashEmailToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type IssueResult =
  | { readonly kind: "issued"; readonly token: string; readonly expiresAt: Date }
  | { readonly kind: "rate-limited"; readonly retryAfterSeconds: number };

/**
 * Issues a fresh token for `userId`, unless the account hit its sending limit.
 * Older unused tokens of the same purpose are expired in the same transaction:
 * only the newest link works, so an old email lying in an inbox is harmless.
 */
export async function issueEmailToken(
  userId: string,
  purpose: EmailTokenPurpose,
  now: Date = new Date(),
): Promise<IssueResult> {
  const limit = LIMITS[purpose];
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  return prisma.$transaction(async (tx) => {
    const recent = await tx.emailToken.findMany({
      where: { userId, purpose, createdAt: { gt: hourAgo } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const latest = recent[0]?.createdAt;
    if (latest !== undefined) {
      const since = (now.getTime() - latest.getTime()) / 1000;
      if (since < limit.gapSeconds) {
        return { kind: "rate-limited", retryAfterSeconds: Math.ceil(limit.gapSeconds - since) };
      }
    }
    if (recent.length >= limit.perHour) {
      const oldest = recent[recent.length - 1].createdAt;
      return {
        kind: "rate-limited",
        retryAfterSeconds: Math.max(1, Math.ceil((oldest.getTime() + 60 * 60 * 1000 - now.getTime()) / 1000)),
      };
    }

    await tx.emailToken.updateMany({
      where: { userId, purpose, usedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(now.getTime() + TTL_MS[purpose]);
    await tx.emailToken.create({
      data: { userId, purpose, tokenHash: hashEmailToken(token), expiresAt, createdAt: now },
      select: { id: true },
    });
    return { kind: "issued", token, expiresAt };
  });
}

export interface TokenOwner {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
}

/**
 * Whose live token this is, or null. Malformed, unknown, used, expired and
 * wrong-purpose tokens are all just null — a page never says which.
 */
export async function lookupEmailToken(
  token: string,
  purpose: EmailTokenPurpose,
  now: Date = new Date(),
): Promise<TokenOwner | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = await prisma.emailToken.findUnique({
    where: { tokenHash: hashEmailToken(token) },
    select: {
      purpose: true,
      usedAt: true,
      expiresAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });
  if (row === null || row.purpose !== purpose || row.usedAt !== null || row.expiresAt <= now) {
    return null;
  }
  return row.user;
}

/**
 * Marks the address behind a verification link as confirmed. Returns the owner,
 * or null when the link was not (or is no longer) usable.
 */
export async function consumeVerifyToken(token: string, now: Date = new Date()): Promise<TokenOwner | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  return prisma.$transaction(async (tx) => {
    const tokenHash = hashEmailToken(token);
    const { count } = await tx.emailToken.updateMany({
      where: { tokenHash, purpose: "VERIFY_EMAIL", usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count !== 1) return null;
    const row = await tx.emailToken.findUniqueOrThrow({ where: { tokenHash }, select: { userId: true } });
    // Only the first confirmation stamps the time; a later one changes nothing.
    await tx.user.updateMany({ where: { id: row.userId, emailVerified: null }, data: { emailVerified: now } });
    return tx.user.findUniqueOrThrow({ where: { id: row.userId }, select: { id: true, name: true, email: true } });
  });
}

/**
 * Sets a new password through a reset link, in one transaction with consuming
 * the token. Also:
 *   - revokes every existing session (`sessionsRevokedAt`, read by lib/auth.ts)
 *     — whoever had the old password is signed out everywhere;
 *   - confirms the address, since the link proved the person reads that inbox;
 *   - expires any other outstanding reset links for the account.
 * Returns the owner, or null when the link was not (or is no longer) usable.
 */
export async function consumeResetToken(
  token: string,
  passwordHash: string,
  now: Date = new Date(),
): Promise<TokenOwner | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  return prisma.$transaction(async (tx) => {
    const tokenHash = hashEmailToken(token);
    const { count } = await tx.emailToken.updateMany({
      where: { tokenHash, purpose: "RESET_PASSWORD", usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count !== 1) return null;
    const row = await tx.emailToken.findUniqueOrThrow({ where: { tokenHash }, select: { userId: true } });

    await tx.emailToken.updateMany({
      where: { userId: row.userId, purpose: "RESET_PASSWORD", usedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
    const user = await tx.user.update({
      where: { id: row.userId },
      data: { passwordHash, sessionsRevokedAt: now },
      select: { id: true, name: true, email: true, emailVerified: true },
    });
    if (user.emailVerified === null) {
      await tx.user.update({ where: { id: user.id }, data: { emailVerified: now }, select: { id: true } });
    }
    return { id: user.id, name: user.name, email: user.email };
  });
}

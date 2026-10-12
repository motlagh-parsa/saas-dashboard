import "server-only";

// One-time invite tokens for accounts an admin adds from /dashboard/users.
//
// The token is 32 random bytes, hex-encoded, and it lives ONLY in the link the
// admin is shown. The database stores its SHA-256, so a leaked backup, replica
// or query log cannot be turned into a working link. SHA-256 rather than scrypt
// (lib/password.ts) on purpose: the input is 256 bits of randomness, not a
// human-chosen secret, so there is nothing to slow down a guesser on — and a
// fast, deterministic hash is what makes the unique-index lookup possible.
import { createHash, randomBytes } from "node:crypto";

import { prisma } from "@/lib/prisma";

/** How long an invite link works. The admin-facing copy says "7 days". */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 32 bytes as hex. Anything else is not a token this app issued. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export interface IssuedInvite {
  /** Goes in the link, once. Never stored. */
  readonly token: string;
  /** Goes in `User.inviteToken`. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueInvite(now: Date = new Date()): IssuedInvite {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashInviteToken(token),
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
  };
}

export type InviteLookup =
  | { readonly kind: "invalid" }
  | { readonly kind: "already-set" }
  | {
      readonly kind: "pending";
      readonly user: { readonly name: string | null; readonly email: string };
    };

/**
 * What an invite link is worth right now. Expired, malformed and unknown tokens
 * all read as "invalid" — the page never says which, so it cannot be used to
 * probe for tokens that almost exist.
 */
export async function lookupInvite(token: string, now: Date = new Date()): Promise<InviteLookup> {
  if (!TOKEN_PATTERN.test(token)) return { kind: "invalid" };

  const user = await prisma.user.findUnique({
    where: { inviteToken: hashInviteToken(token) },
    select: { name: true, email: true, inviteExpiresAt: true, passwordHash: true },
  });
  if (user === null || user.inviteExpiresAt === null || user.inviteExpiresAt <= now) {
    return { kind: "invalid" };
  }
  if (user.passwordHash !== null) return { kind: "already-set" };

  return { kind: "pending", user: { name: user.name, email: user.email } };
}

/**
 * Sets the password and consumes the token in ONE conditional write: the row is
 * only updated while the token still matches, is unexpired, and no password is
 * set. Two tabs submitting the same link cannot both win — the second matches
 * nothing. Returns false when the link was not (or is no longer) usable.
 */
export async function consumeInvite(
  token: string,
  passwordHash: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!TOKEN_PATTERN.test(token)) return false;

  const { count } = await prisma.user.updateMany({
    where: {
      inviteToken: hashInviteToken(token),
      inviteExpiresAt: { gt: now },
      passwordHash: null,
    },
    // Opening the emailed (or hand-delivered) link is the proof of address an
    // emailed verification link would give, so the address counts as confirmed.
    data: { passwordHash, inviteToken: null, inviteExpiresAt: null, emailVerified: now },
  });
  return count === 1;
}

import "server-only";

// REST API keys: generation, hashing, and authenticating a request by its key.
//
// A key is "mrd_" + 32 random bytes in base64url. Only its SHA-256 is stored —
// the key itself exists in exactly one response, the one that created it — and a
// request is authenticated by hashing what it presents and looking the hash up.
// The workspace a request acts on is the key's; nothing in the request can
// choose another.
import { createHash, randomBytes } from "node:crypto";
import type { ApiScope } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export const KEY_PREFIX = "mrd_";
/** Characters of the key shown in the UI: "mrd_" and 8 more. */
export const PREFIX_LENGTH = 12;
/** Active (unrevoked, unexpired) keys per workspace. */
export const MAX_ACTIVE_KEYS = 20;
/** `lastUsedAt` is written at most this often per key. */
const TOUCH_INTERVAL_MS = 60_000;

export interface GeneratedKey {
  readonly key: string;
  readonly prefix: string;
  readonly keyHash: string;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): GeneratedKey {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, PREFIX_LENGTH), keyHash: hashApiKey(key) };
}

/** Whether a key of scope `held` may call an endpoint needing `needed`: WRITE includes READ. */
export function scopeAllows(needed: ApiScope, held: ApiScope): boolean {
  return needed === "READ" || held === "WRITE";
}

export interface ApiKeyContext {
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly currency: string;
  readonly scope: ApiScope;
}

export type KeyCheck =
  | { readonly ok: true; readonly key: ApiKeyContext }
  | { readonly ok: false; readonly message: string };

/**
 * The key behind an `Authorization: Bearer mrd_…` header, or why there is none.
 * Unknown, revoked and expired keys all fail; the message says which, since the
 * caller already holds the key and the difference helps them fix it.
 */
export async function authenticateApiKey(header: string | null, now: Date = new Date()): Promise<KeyCheck> {
  if (header === null || !header.startsWith("Bearer ")) {
    return { ok: false, message: "Send your API key as `Authorization: Bearer mrd_…`." };
  }
  const presented = header.slice("Bearer ".length).trim();
  if (!presented.startsWith(KEY_PREFIX) || presented.length > 100) {
    return { ok: false, message: "That is not a Meridian API key. Keys start with `mrd_`." };
  }
  const key = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(presented) },
    select: {
      id: true,
      name: true,
      organizationId: true,
      scope: true,
      revokedAt: true,
      expiresAt: true,
      lastUsedAt: true,
      organization: { select: { currency: true } },
    },
  });
  if (key === null) return { ok: false, message: "Invalid API key." };
  if (key.revokedAt !== null) return { ok: false, message: "This API key was revoked." };
  if (key.expiresAt !== null && key.expiresAt <= now) return { ok: false, message: "This API key has expired." };

  // At most one write a minute per key, and conditional, so concurrent requests
  // do not all write it either.
  if (key.lastUsedAt === null || now.getTime() - key.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
    await prisma.apiKey.updateMany({
      where: {
        id: key.id,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - TOUCH_INTERVAL_MS) } }],
      },
      data: { lastUsedAt: now },
    });
  }
  return {
    ok: true,
    key: {
      id: key.id,
      name: key.name,
      organizationId: key.organizationId,
      currency: key.organization.currency,
      scope: key.scope,
    },
  };
}

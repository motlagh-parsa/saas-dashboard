import "server-only";

// Encryption at rest for third-party secrets the app must be able to read back
// (a Stripe restricted key, a webhook signing secret) — unlike passwords and
// tokens, which are hashed. AES-256-GCM: authenticated, so a tampered value
// fails to open rather than decrypting to garbage.
//
// The key is ENCRYPTION_KEY (32 bytes, base64), or, when that is not set, one
// derived from NEXTAUTH_SECRET with HKDF under a fixed label — so a deployment
// works without extra configuration, at the price that rotating NEXTAUTH_SECRET
// then makes stored secrets unreadable (they would have to be entered again).
//
// Format: "v1:" + base64(iv ‖ tag ‖ ciphertext).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import { env } from "@/lib/env";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = "v1:";

function key(): Buffer {
  if (env.ENCRYPTION_KEY !== undefined) return Buffer.from(env.ENCRYPTION_KEY, "base64");
  return Buffer.from(hkdfSync("sha256", env.NEXTAUTH_SECRET, "meridian", "secret-box:v1", 32));
}

export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

/** The plaintext, or null when the value is malformed, tampered with, or sealed under another key. */
export function open(sealed: string): string | null {
  if (!sealed.startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

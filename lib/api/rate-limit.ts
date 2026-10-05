import "server-only";

// 120 requests per minute per API key, counted in Postgres.
//
// In-memory counters would be per server instance — on serverless, per request,
// more or less — so the count lives in ApiRateLimit, one row per key per
// one-minute window, incremented with a single atomic upsert: two requests at
// the same instant each get their own count, never the same one. The first
// request of a new window prunes that key's old windows.
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export const RATE_LIMIT = 120;
export const RATE_WINDOW_MS = 60_000;

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** When the current window ends and the count starts over. */
  readonly resetAt: Date;
}

export async function consumeRateLimit(keyId: string, now: Date = new Date()): Promise<RateLimitResult> {
  const windowStart = new Date(Math.floor(now.getTime() / RATE_WINDOW_MS) * RATE_WINDOW_MS);
  const window = Prisma.sql`${windowStart.toISOString()}::timestamp`;
  const rows = await prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
    INSERT INTO "ApiRateLimit" ("keyId", "windowStart", "count")
    VALUES (${keyId}, ${window}, 1)
    ON CONFLICT ("keyId", "windowStart")
    DO UPDATE SET "count" = "ApiRateLimit"."count" + 1
    RETURNING "count"
  `);
  const count = Number(rows[0]?.count ?? 1);
  if (count === 1) {
    await prisma.apiRateLimit.deleteMany({ where: { keyId, windowStart: { lt: windowStart } } });
  }
  return {
    allowed: count <= RATE_LIMIT,
    limit: RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - count),
    resetAt: new Date(windowStart.getTime() + RATE_WINDOW_MS),
  };
}

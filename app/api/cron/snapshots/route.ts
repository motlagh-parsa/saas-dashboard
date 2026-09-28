// Daily MetricSnapshot job. Call once a day (any time after UTC midnight) with
// the `x-cron-secret` header; it writes the snapshot rows the MRR trend reads.
//
// Without this, nothing but the seed ever writes MetricSnapshot: the trend chart
// froze on the seed date while live MRR (computed from Subscription) kept moving.
//
// Security:
//   - Not a user endpoint. No session; the caller proves itself with a shared
//     secret, compared in constant time. No secret configured => every call is
//     refused. Middleware only matches /dashboard, so it does not intercept this.
//   - It reads and writes EVERY tenant — the one place that is correct — and
//     accepts no input that could select or shape any of that data.
//
// What it writes:
//   - One row per organization per UTC day, from the day after the latest stored
//     snapshot through YESTERDAY (the last complete day), capped at
//     MAX_CATCH_UP_DAYS. On a normal daily run that is exactly one day. A missed
//     run is filled on the next one instead of leaving a hole — the trend SUMS
//     new/churned subs across each month, so a missing day silently undercounts.
//   - Rewrites those days workspace by workspace through `recomputeSnapshots`
//     (lib/snapshots.ts): delete-then-insert in one transaction per workspace,
//     so a retry after a failure rewrites the same rows rather than duplicating
//     them. Values come from `lib/snapshot-formula.ts`, the formula the sample
//     data generator and every billing write also use, so all rows sit on one
//     series. It reads each workspace's full subscription history on every run —
//     fine at today's scale, and the first thing to revisit when it is not.
import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { DAY_MS, utcDayStart } from "@/lib/snapshot-formula";
import { recomputeSnapshots } from "@/lib/snapshots";

/** Upper bound on days written per call, so a long outage cannot become one huge transaction. */
const MAX_CATCH_UP_DAYS = 31;

interface SnapshotJobResult {
  /** Organizations processed (one row each per day written). */
  processed: number;
  /** The last day written — always yesterday, UTC. */
  date: string;
  /** The first day written. Equal to `date` on a normal daily run. */
  from: string;
  days: number;
}

/**
 * Constant-time secret check. Both sides are hashed first so the comparison is
 * over equal-length buffers — `timingSafeEqual` throws on a length mismatch, and
 * an early length check would leak the secret's length.
 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function isoDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export async function GET(request: Request): Promise<NextResponse> {
  const expected = env.CRON_SECRET;
  if (expected === undefined || !secretMatches(request.headers.get("x-cron-secret"), expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = utcDayStart(new Date());
  const yesterday = new Date(today.getTime() - DAY_MS);

  // Resume after the latest stored day; never before the cap; never after
  // yesterday (a second run on the same day just rewrites yesterday).
  const latest = await prisma.metricSnapshot.aggregate({ _max: { date: true } });
  const earliestAllowed = yesterday.getTime() - (MAX_CATCH_UP_DAYS - 1) * DAY_MS;
  const resumeFrom =
    latest._max.date === null ? yesterday.getTime() : latest._max.date.getTime() + DAY_MS;
  const firstDay = new Date(
    Math.min(yesterday.getTime(), Math.max(resumeFrom, earliestAllowed)),
  );

  const days = Math.round((yesterday.getTime() - firstDay.getTime()) / DAY_MS) + 1;

  // One workspace at a time through lib/snapshots.ts: the same function every
  // billing write calls, so a cron day and a recomputed day are the same rows.
  // Each is its own transaction under that workspace's advisory lock, and each
  // reads its workspace's FULL history ("new customer" means never active
  // before, which only the whole history can answer).
  const organizations = await prisma.organization.findMany({ select: { id: true } });
  for (const org of organizations) {
    await recomputeSnapshots(org.id, firstDay, { through: yesterday });
  }

  const result: SnapshotJobResult = {
    processed: organizations.length,
    date: isoDay(yesterday),
    from: isoDay(firstDay),
    days,
  };
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

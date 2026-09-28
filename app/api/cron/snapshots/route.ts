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
//   - Upserts on `@@unique([organizationId, date])`, all in one transaction, so a
//     retry after a failure rewrites the same rows rather than duplicating them.
//   - Values come from `lib/snapshot-formula.ts`, the same function the sample
//     data generator uses, so cron rows and generated rows sit on one series.
//     It reads each workspace's full subscription history on every run — fine at
//     today's scale, and the first thing to revisit when it is not.
import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import {
  DAY_MS,
  computeDaySnapshot,
  firstActiveAt,
  utcDayStart,
  type SnapshotSegment,
} from "@/lib/snapshot-formula";

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

  const days: Date[] = [];
  for (let ms = firstDay.getTime(); ms <= yesterday.getTime(); ms += DAY_MS) {
    days.push(new Date(ms));
  }

  // Each workspace's FULL subscription history: "new customer" means never
  // active before, which only the whole history can answer. Segments that start
  // after the last day written cannot affect it, so they are left out.
  const [organizations, segments] = await Promise.all([
    prisma.organization.findMany({ select: { id: true } }),
    prisma.subscription.findMany({
      where: { startedAt: { lt: today } },
      select: {
        id: true,
        organizationId: true,
        customerId: true,
        amountCents: true,
        quantity: true,
        interval: true,
        intervalCount: true,
        startedAt: true,
        endedAt: true,
        canceledAt: true,
      },
    }),
  ]);

  const segmentsByOrg = new Map<string, SnapshotSegment[]>();
  for (const segment of segments) {
    const list = segmentsByOrg.get(segment.organizationId);
    if (list === undefined) segmentsByOrg.set(segment.organizationId, [segment]);
    else list.push(segment);
  }

  await prisma.$transaction(
    organizations.flatMap((org) => {
      const orgSegments = segmentsByOrg.get(org.id) ?? [];
      const firstActive = firstActiveAt(orgSegments);
      return days.map((day) => {
        const metrics = computeDaySnapshot(orgSegments, day, firstActive);
        return prisma.metricSnapshot.upsert({
          where: { organizationId_date: { organizationId: org.id, date: day } },
          create: { organizationId: org.id, date: day, ...metrics },
          update: metrics,
        });
      });
    }),
  );

  const result: SnapshotJobResult = {
    processed: organizations.length,
    date: isoDay(yesterday),
    from: isoDay(firstDay),
    days: days.length,
  };
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

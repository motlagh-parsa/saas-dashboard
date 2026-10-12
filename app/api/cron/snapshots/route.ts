// Daily MetricSnapshot job. Scheduled by vercel.json at 00:10 UTC; any other
// scheduler works too — call it once a day with `Authorization: Bearer <secret>`.
//
// Security:
//   - Not a user endpoint. No session; the caller proves itself with the shared
//     secret CRON_SECRET, sent as a Bearer token — exactly what Vercel Cron sends
//     when the variable is set on the project — and compared in constant time.
//     No secret configured => every call is refused. Middleware only matches
//     /dashboard and /onboarding, so it does not intercept this.
//   - It reads and writes EVERY tenant — the one place that is correct — and
//     accepts no input that could select or shape any of that data.
//
// What it does, per workspace with billing data (at least one subscription),
// one workspace at a time:
//   1. Settles stored statuses that contradict dates: a segment whose `endedAt`
//      has passed but is not CANCELED (a cancellation or plan change scheduled
//      for a day that has now arrived) is marked CANCELED.
//   2. Writes the snapshot days it is missing: from the day after its latest
//      snapshot — or its earliest subscription start, if it has none — through
//      TODAY, with lib/snapshots.ts, the function every billing write also uses.
//      A missed run is filled on the next one instead of leaving a hole.
//   3. Raises any alerts the new numbers call for (lib/alerts.ts), and on
//      Mondays posts the weekly summary.
// Then, once for everyone, it emails the report schedules that are due
// (lib/report-schedules.ts).
// A failure in one workspace is logged and skipped; the others still run. The
// response is a JSON summary.
import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { evaluateAlerts, sendWeeklySummary } from "@/lib/alerts";
import { resetDemo } from "@/lib/demo";
import { env, isPublicDemo } from "@/lib/env";
import { runDueSchedules, type ScheduleRunResult } from "@/lib/report-schedules";
import { runStripeSync } from "@/lib/stripe/sync";
import { prisma } from "@/lib/prisma";
import { DAY_MS, utcDayStart } from "@/lib/snapshot-formula";
import { recomputeSnapshots, settleEndedSegments } from "@/lib/snapshots";

/**
 * Seconds this function may run. A normal day is one row per workspace; the
 * headroom is for catching up after an outage or a new workspace's first run.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

interface CronFailure {
  readonly organizationId: string;
  readonly error: string;
}

interface SnapshotJobResult {
  /** Workspaces with billing data, i.e. the ones the job looked at. */
  readonly workspaces: number;
  /** Of those, how many completed. */
  readonly processed: number;
  /** Snapshot rows written across all workspaces. */
  readonly rowsWritten: number;
  /** Subscription statuses corrected to CANCELED because their end had passed. */
  readonly statusesFixed: number;
  /** The last day written — today, UTC. */
  readonly through: string;
  /** Notifications raised by alerts and weekly summaries. */
  readonly alerts: number;
  readonly reports: ScheduleRunResult;
  /** Whether the public demo was rebuilt. */
  readonly demoReset: boolean;
  /** Stripe connections synced, and how many of those failed. */
  readonly stripe: { readonly synced: number; readonly failed: number };
  readonly failures: readonly CronFailure[];
}

/**
 * Constant-time secret check. Both sides are hashed first so the comparison is
 * over equal-length buffers — `timingSafeEqual` throws on a length mismatch, and
 * an early length check would leak the secret's length.
 */
function bearerMatches(header: string | null, expected: string): boolean {
  if (header === null || !header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length);
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function isoDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export async function GET(request: Request): Promise<NextResponse> {
  const expected = env.CRON_SECRET;
  if (expected === undefined || !bearerMatches(request.headers.get("authorization"), expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const today = utcDayStart(now);

  // A public demo starts every day as it was built — first, so the rest of the
  // job (snapshots, alerts) runs on the fresh data.
  let demoReset = false;
  if (isPublicDemo) {
    try {
      await resetDemo();
      demoReset = true;
    } catch (error: unknown) {
      console.error("[cron] demo reset failed", { error });
    }
  }

  // Only workspaces that have something to measure. Each one's latest snapshot
  // and earliest subscription decide where its catch-up starts.
  const workspaces = await prisma.organization.findMany({
    where: { subscriptions: { some: {} } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  let processed = 0;
  let rowsWritten = 0;
  let statusesFixed = 0;
  let alerts = 0;
  const failures: CronFailure[] = [];
  const isMonday = now.getUTCDay() === 1;

  for (const workspace of workspaces) {
    try {
      statusesFixed += await settleEndedSegments(prisma, workspace.id, now);

      const [latest, earliest] = await Promise.all([
        prisma.metricSnapshot.aggregate({ where: { organizationId: workspace.id }, _max: { date: true } }),
        prisma.subscription.findFirst({
          where: { organizationId: workspace.id },
          orderBy: { startedAt: "asc" },
          select: { startedAt: true },
        }),
      ]);
      const latestDay = latest._max.date;
      const from =
        latestDay !== null ? new Date(latestDay.getTime() + DAY_MS) : utcDayStart(earliest?.startedAt ?? today);

      // Already current (a billing write recomputed through today): nothing to write.
      const result = await recomputeSnapshots(workspace.id, from, { through: today });
      rowsWritten += result.days;
      processed += 1;

      alerts += (await evaluateAlerts(workspace.id, now)).raised.length;
      if (isMonday && (await sendWeeklySummary(workspace.id, now))) alerts += 1;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[cron:snapshots] workspace failed", { organizationId: workspace.id, error });
      failures.push({ organizationId: workspace.id, error: message.slice(0, 300) });
    }
  }

  const reports = await runDueSchedules(now);

  // The nightly Stripe safety net: picks up anything a webhook missed.
  const stripe = { synced: 0, failed: 0 };
  const connections = await prisma.stripeConnection.findMany({ select: { organizationId: true } });
  for (const connection of connections) {
    const outcome = await runStripeSync(connection.organizationId);
    if (outcome.kind === "done") stripe.synced += 1;
    else if (outcome.kind === "failed") stripe.failed += 1;
  }

  const result: SnapshotJobResult = {
    workspaces: workspaces.length,
    processed,
    rowsWritten,
    statusesFixed,
    through: isoDay(today),
    alerts,
    reports,
    demoReset,
    stripe,
    failures,
  };
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

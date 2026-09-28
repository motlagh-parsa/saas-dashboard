import "server-only";

// Rewrites one workspace's stored MetricSnapshot rows after its billing history
// changed — the ONE writer of snapshot rows besides the sample-data generator,
// and the function the daily cron calls per workspace.
//
// A snapshot row for day D is derived from the subscription history as it
// stands (lib/snapshot-formula.ts). So when a founder backdates a start, cancels
// in the past, or corrects a price, every stored day from the earliest affected
// date onward is stale. This deletes exactly those days and writes them again
// from the same formula the generator and the cron use, so a recomputed day is
// indistinguishable from one written by a full rebuild (scripts/verify-metrics.ts
// checks that).
//
// Scope and safety:
//   - ONE organization, one transaction. A Postgres advisory lock keyed on the
//     organization serializes two recomputes of the same workspace (two quick
//     edits whose `after()` callbacks overlap): without it, both would delete the
//     same days and the second insert would hit the (organizationId, date) unique
//     key. Different workspaces never wait on each other.
//   - The history is read INSIDE the lock, so the later of two recomputes always
//     sees the later write.
//
// Range: from the affected day through TODAY by default. The cron's convention
// stops at yesterday (the last day it treats as complete), but a row for day D
// holds the state at D's midnight and the flows up to it, so today's row is
// already final — and the sample data writes one. Leaving it out would leave that
// row stale after a change that takes effect today.
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  DAY_MS,
  computeDaySnapshot,
  firstActiveAt,
  utcDayStart,
  type SnapshotSegment,
} from "@/lib/snapshot-formula";

/** Days written per createMany batch — well inside Postgres's bind-parameter limit. */
const INSERT_BATCH = 2_000;

export interface RecomputeResult {
  /** Days rewritten; 0 when the affected date is after the last day stored. */
  readonly days: number;
  readonly from: Date | null;
  readonly through: Date | null;
}

/**
 * Marks every segment of the organization whose end has passed as CANCELED, so
 * a stored status never contradicts its dates. A plan change or cancellation
 * dated in the future leaves the segment ACTIVE (or TRIALING, PAST_DUE) until its
 * `endedAt` arrives; this settles it on the next write, recompute or cron run.
 * Metrics never read `status` for liveness — they use dates — so this only keeps
 * the displayed status honest.
 */
export async function settleEndedSegments(
  client: Prisma.TransactionClient | typeof prisma,
  organizationId: string,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await client.subscription.updateMany({
    where: { organizationId, endedAt: { lte: now }, status: { not: "CANCELED" } },
    data: { status: "CANCELED" },
  });
  return count;
}

export async function recomputeSnapshots(
  organizationId: string,
  fromDate: Date,
  options: { readonly through?: Date } = {},
): Promise<RecomputeResult> {
  const from = utcDayStart(fromDate);
  const through = utcDayStart(options.through ?? new Date());
  if (from.getTime() > through.getTime()) return { days: 0, from: null, through: null };

  return prisma.$transaction(
    async (tx) => {
      // Transaction-scoped: released at commit or rollback, never leaked.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`snapshots:${organizationId}`}))`;
      await settleEndedSegments(tx, organizationId);

      // The FULL history: "new customer" means never active before, which only
      // the whole history can answer. Segments starting after the last day
      // written cannot affect it.
      const history: SnapshotSegment[] = await tx.subscription.findMany({
        where: { organizationId, startedAt: { lte: through } },
        select: {
          id: true,
          customerId: true,
          amountCents: true,
          quantity: true,
          interval: true,
          intervalCount: true,
          startedAt: true,
          endedAt: true,
          canceledAt: true,
        },
      });
      const firstActive = firstActiveAt(history);

      const rows: Prisma.MetricSnapshotCreateManyInput[] = [];
      for (let ms = from.getTime(); ms <= through.getTime(); ms += DAY_MS) {
        const day = new Date(ms);
        rows.push({ organizationId, date: day, ...computeDaySnapshot(history, day, firstActive) });
      }

      await tx.metricSnapshot.deleteMany({
        where: { organizationId, date: { gte: from, lte: through } },
      });
      for (let index = 0; index < rows.length; index += INSERT_BATCH) {
        await tx.metricSnapshot.createMany({ data: rows.slice(index, index + INSERT_BATCH) });
      }

      return { days: rows.length, from, through };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

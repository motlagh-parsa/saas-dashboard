import "server-only";

// Subscriptions as the API sees them: CHAINS of segments.
//
// Meridian stores a subscription as segments linked by plan changes
// (prisma/schema.prisma). A caller knows it as one thing with one ID, so a chain
// is addressed by the caller's external_id, and each segment the API (or CSV
// import) writes carries `<external_id>:<YYYY-MM-DD start>`. A chain is found by
// any of its segments carrying that prefix, then completed through the links —
// so a segment added from the UI (no external id) still belongs to it.
import type { BillingInterval, Prisma, SubscriptionStatus } from "@prisma/client";

import { subscriptionChain } from "@/lib/billing-ops";
import { prisma } from "@/lib/prisma";
import { roundedMonthlyCents } from "@/lib/snapshot-formula";

import { wireDay, wireEnum, wireInterval } from "../schema";

export const SEGMENT_SELECT = {
  id: true,
  externalId: true,
  customerId: true,
  planId: true,
  status: true,
  amountCents: true,
  quantity: true,
  interval: true,
  intervalCount: true,
  startedAt: true,
  endedAt: true,
  canceledAt: true,
  previousSubscriptionId: true,
  source: true,
  createdAt: true,
  plan: { select: { externalId: true, name: true } },
  customer: { select: { externalId: true, name: true } },
} as const satisfies Prisma.SubscriptionSelect;

export type Segment = Prisma.SubscriptionGetPayload<{ select: typeof SEGMENT_SELECT }>;

/** `sub_42:2025-01-01` -> `sub_42`; null for a segment without the API/CSV scheme. */
export function chainIdOf(segmentExternalId: string | null): string | null {
  if (segmentExternalId === null) return null;
  const colon = segmentExternalId.lastIndexOf(":");
  return colon <= 0 ? null : segmentExternalId.slice(0, colon);
}

export function segmentExternalId(chainExternalId: string, startedAt: Date): string {
  return `${chainExternalId}:${wireDay(startedAt)}`;
}

/** Splits a customer's segments into chains, each oldest first. */
export function chainsOf(segments: readonly Segment[]): Segment[][] {
  const seen = new Set<string>();
  const chains: Segment[][] = [];
  for (const segment of [...segments].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())) {
    if (seen.has(segment.id)) continue;
    const chain = subscriptionChain(segments, segment.id);
    for (const member of chain) seen.add(member.id);
    chains.push(chain);
  }
  return chains;
}

/** The chain the caller calls `externalId`, or null. */
export async function findChain(organizationId: string, externalId: string): Promise<Segment[] | null> {
  // `startsWith` narrows in SQL; the exact prefix is checked here, since `_` is a
  // LIKE wildcard and `a:b:…` must not match `a`.
  const candidates = await prisma.subscription.findMany({
    where: { organizationId, externalId: { startsWith: `${externalId}:` } },
    select: { id: true, customerId: true, externalId: true },
  });
  const anchor = candidates.find((candidate) => chainIdOf(candidate.externalId) === externalId);
  if (anchor === undefined) return null;
  const segments = await prisma.subscription.findMany({
    where: { organizationId, customerId: anchor.customerId },
    select: SEGMENT_SELECT,
  });
  const chain = subscriptionChain(segments, anchor.id);
  return chain.length === 0 ? null : chain;
}

/** A chain's caller-facing external id: the one its segments carry. */
export function chainExternalId(chain: readonly Segment[]): string | null {
  for (const segment of chain) {
    const id = chainIdOf(segment.externalId);
    if (id !== null) return id;
  }
  return null;
}

function isLive(segment: Segment, at: Date): boolean {
  return segment.startedAt <= at && (segment.endedAt === null || segment.endedAt > at);
}

function mrrOf(segment: Segment, at: Date): number {
  return isLive(segment, at) ? roundedMonthlyCents([segment]) : 0;
}

export interface SegmentWire {
  readonly id: string;
  readonly external_id: string | null;
  readonly plan_external_id: string | null;
  readonly plan_name: string | null;
  readonly amount: number;
  readonly quantity: number;
  readonly interval: "month" | "year";
  readonly interval_count: number;
  readonly status: Lowercase<SubscriptionStatus>;
  readonly start_date: string;
  readonly end_date: string | null;
  readonly mrr: number;
}

export interface SubscriptionWire {
  readonly object: "subscription";
  readonly id: string;
  readonly external_id: string | null;
  readonly customer_id: string;
  readonly customer_external_id: string | null;
  readonly status: Lowercase<SubscriptionStatus>;
  readonly start_date: string;
  /** The day it ends or ended, when canceled (or scheduled to be); null while it runs on. */
  readonly end_date: string | null;
  readonly cancel_scheduled: boolean;
  readonly plan_external_id: string | null;
  readonly plan_name: string | null;
  readonly amount: number;
  readonly quantity: number;
  readonly interval: "month" | "year";
  readonly interval_count: number;
  readonly mrr: number;
  readonly currency: string;
  readonly segments: readonly SegmentWire[];
}

function segmentWire(segment: Segment, now: Date): SegmentWire {
  return {
    id: segment.id,
    external_id: segment.externalId,
    plan_external_id: segment.plan?.externalId ?? null,
    plan_name: segment.plan?.name ?? null,
    amount: segment.amountCents,
    quantity: segment.quantity,
    interval: wireInterval(segment.interval),
    interval_count: segment.intervalCount,
    status: wireEnum(segment.status),
    start_date: wireDay(segment.startedAt),
    end_date: wireDay(segment.endedAt),
    mrr: mrrOf(segment, now),
  };
}

export function subscriptionWire(chain: readonly Segment[], currency: string, now: Date): SubscriptionWire {
  const first = chain[0];
  const last = chain[chain.length - 1];
  if (first === undefined || last === undefined) throw new Error("empty subscription chain");
  const canceled = last.canceledAt !== null && last.endedAt !== null;
  return {
    object: "subscription",
    id: first.id,
    external_id: chainExternalId(chain),
    customer_id: first.customerId,
    customer_external_id: first.customer.externalId,
    status: wireEnum(last.status),
    start_date: wireDay(first.startedAt),
    end_date: canceled ? wireDay(last.endedAt) : null,
    cancel_scheduled: canceled && last.endedAt !== null && last.endedAt > now,
    plan_external_id: last.plan?.externalId ?? null,
    plan_name: last.plan?.name ?? null,
    amount: last.amountCents,
    quantity: last.quantity,
    interval: wireInterval(last.interval),
    interval_count: last.intervalCount,
    mrr: chain.reduce((sum, segment) => sum + mrrOf(segment, now), 0),
    currency,
    segments: chain.map((segment) => segmentWire(segment, now)),
  };
}

export interface TermsLike {
  readonly planId: string | null;
  readonly amountCents: number;
  readonly interval: BillingInterval;
  readonly intervalCount: number;
  readonly quantity: number;
}

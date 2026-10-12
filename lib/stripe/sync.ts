import "server-only";

// Stripe → Meridian. Reads a workspace's Stripe account and writes it through
// the SAME resource functions as the REST API (lib/api/resources/*), with
// source STRIPE — so a Stripe subscription follows exactly the rules of one
// entered by hand or pushed over the API: same plan-change segments, same
// cancellation rules, same refusals. Every write is an idempotent upsert keyed
// by the Stripe id, so syncing twice changes nothing the second time.
//
// Mapping:
//   - Price (recurring, monthly/yearly, in the workspace currency, with a flat
//     unit amount) → Plan, external_id = price id. Named after its product; a
//     product with several prices gets the billing period in the name.
//   - Customer → Customer, external_id = customer id.
//   - Subscription item → Subscription chain. external_id = the subscription
//     id, or "<subscription id>.<item id>" when a subscription has several
//     items. Status: active / trialing / past_due (unpaid counts as past due);
//     ended or scheduled-to-end subscriptions carry end_date. Incomplete ones
//     (never paid) are skipped.
//   - Invoice (non-zero, in the workspace currency) → Invoice, linked to its
//     subscription.
// Anything in another currency, on weekly/daily billing, or metered/tiered is
// counted as skipped, with the reason, rather than guessed at.
//
// A full sync reads up to 5,000 of each kind per run (50 pages of 100).
import type { Prisma } from "@prisma/client";

import { evaluateAlerts } from "@/lib/alerts";
import { ApiError } from "@/lib/api/errors";
import { writeContext, type ApiWriteContext } from "@/lib/api/context";
import { chainIdOf } from "@/lib/api/resources/chains";
import { putCustomer } from "@/lib/api/resources/customers";
import { putInvoice } from "@/lib/api/resources/invoices";
import { putPlan } from "@/lib/api/resources/plans";
import { putSubscription } from "@/lib/api/resources/subscriptions";
import { writeAudit } from "@/lib/audit-writer";
import { prisma } from "@/lib/prisma";
import { open } from "@/lib/secret-box";
import { recomputeSnapshots } from "@/lib/snapshots";
import { stripeClient, StripeError, type StripeClient } from "@/lib/stripe/client";

// ---------------------------------------------------------------------------
// Stripe shapes — only the fields read here.
// ---------------------------------------------------------------------------

export interface StripeProduct {
  readonly id: string;
  readonly name: string;
}

export interface StripePrice {
  readonly id: string;
  readonly currency: string;
  readonly unit_amount: number | null;
  readonly nickname: string | null;
  readonly type: "recurring" | "one_time";
  readonly recurring: { readonly interval: "day" | "week" | "month" | "year"; readonly interval_count: number } | null;
  readonly product: string | StripeProduct;
}

export interface StripeCustomer {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly deleted?: boolean;
}

export interface StripeSubscription {
  readonly id: string;
  readonly customer: string;
  readonly status: "active" | "trialing" | "past_due" | "unpaid" | "canceled" | "incomplete" | "incomplete_expired" | "paused";
  readonly currency: string;
  readonly start_date: number;
  readonly ended_at: number | null;
  readonly cancel_at: number | null;
  readonly items: { readonly data: readonly { readonly id: string; readonly quantity?: number; readonly price: StripePrice }[] };
}

export interface StripeInvoice {
  readonly id: string;
  readonly customer: string;
  readonly subscription: string | null;
  readonly currency: string;
  readonly total: number;
  readonly status: "draft" | "open" | "paid" | "void" | "uncollectible" | null;
  readonly created: number;
  readonly due_date: number | null;
  readonly status_transitions?: { readonly paid_at?: number | null; readonly finalized_at?: number | null };
}

// ---------------------------------------------------------------------------
// Counting what happened
// ---------------------------------------------------------------------------

export type SyncKind = "plans" | "customers" | "subscriptions" | "invoices";

export interface KindCounts {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export interface SyncSummary {
  readonly counts: Record<SyncKind, KindCounts>;
  /** Up to 20 examples of what was skipped or refused, and why. */
  readonly problems: { readonly kind: SyncKind; readonly id: string; readonly reason: string }[];
}

function emptySummary(): SyncSummary {
  const counts = (): KindCounts => ({ created: 0, updated: 0, unchanged: 0, skipped: 0 });
  return { counts: { plans: counts(), customers: counts(), subscriptions: counts(), invoices: counts() }, problems: [] };
}

function skip(summary: SyncSummary, kind: SyncKind, id: string, reason: string): void {
  summary.counts[kind].skipped += 1;
  if (summary.problems.length < 20) summary.problems.push({ kind, id, reason });
}

// ---------------------------------------------------------------------------
// Mapping one object — used by the full sync and by webhooks
// ---------------------------------------------------------------------------

const day = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10);

function intervalWords(interval: "month" | "year", count: number): string {
  if (count === 1) return interval === "month" ? "monthly" : "yearly";
  return `every ${count} ${interval}s`;
}

function productName(price: StripePrice): string {
  return typeof price.product === "string" ? price.product : price.product.name;
}

/** Why a price can't be a Meridian plan, or null when it can. */
function priceProblem(price: StripePrice, currency: string): string | null {
  if (price.type !== "recurring" || price.recurring === null) return "one-time price";
  if (price.currency.toUpperCase() !== currency) return `priced in ${price.currency.toUpperCase()}, workspace reports in ${currency}`;
  if (price.recurring.interval !== "month" && price.recurring.interval !== "year") return `billed per ${price.recurring.interval}`;
  if (price.unit_amount === null) return "metered or tiered price";
  return null;
}

export class StripeSync {
  readonly summary = emptySummary();
  private readonly planNames = new Map<string, string>();
  private readonly syncedPrices = new Set<string>();
  /** Stripe subscription id → the chain external_id its invoices link to. */
  private readonly subscriptionKeys = new Map<string, string>();

  constructor(
    readonly ctx: ApiWriteContext,
    readonly client: StripeClient,
  ) {}

  /** Names for a batch of prices: the product, plus the period when a product has several. */
  nameForPrices(prices: readonly StripePrice[]): void {
    const byProduct = new Map<string, StripePrice[]>();
    for (const price of prices) {
      const list = byProduct.get(productName(price)) ?? [];
      list.push(price);
      byProduct.set(productName(price), list);
    }
    const used = new Set<string>();
    for (const [product, list] of byProduct) {
      for (const price of list) {
        let name = list.length === 1 ? product : `${product} (${intervalWords(price.recurring!.interval as "month" | "year", price.recurring!.interval_count)})`;
        if (used.has(name.toLowerCase())) name = `${name} · ${price.nickname ?? price.id.slice(-6)}`;
        used.add(name.toLowerCase());
        this.planNames.set(price.id, name);
      }
    }
  }

  private count(kind: SyncKind, created: boolean, changed: boolean): void {
    const counts = this.summary.counts[kind];
    if (created) counts.created += 1;
    else if (changed) counts.updated += 1;
    else counts.unchanged += 1;
  }

  async syncPrice(price: StripePrice): Promise<boolean> {
    const problem = priceProblem(price, this.ctx.currency);
    if (problem !== null) {
      skip(this.summary, "plans", price.id, problem);
      return false;
    }
    const recurring = price.recurring!;
    const base = this.planNames.get(price.id) ?? productName(price);
    const body = {
      amount: price.unit_amount!,
      interval: recurring.interval,
      interval_count: recurring.interval_count,
    };
    // A plan of the same name may already exist (entered by hand): keep both,
    // the Stripe one marked as such.
    for (const name of [base, `${base} (Stripe)`, `${base} (Stripe ${price.id.slice(-6)})`]) {
      try {
        const result = await putPlan(this.ctx, price.id, { ...body, name });
        this.count("plans", result.created, result.changed);
        this.syncedPrices.add(price.id);
        return true;
      } catch (error: unknown) {
        if (error instanceof ApiError && error.type === "conflict" && error.param === "name") continue;
        skip(this.summary, "plans", price.id, error instanceof Error ? error.message : String(error));
        return false;
      }
    }
    skip(this.summary, "plans", price.id, "no free plan name");
    return false;
  }

  async syncCustomer(customer: StripeCustomer): Promise<void> {
    if (customer.deleted) return;
    try {
      const result = await putCustomer(this.ctx, customer.id, {
        name: (customer.name ?? "").trim() || customer.email || customer.id,
        email: customer.email ?? null,
      });
      this.count("customers", result.created, result.changed);
    } catch (error: unknown) {
      skip(this.summary, "customers", customer.id, error instanceof Error ? error.message : String(error));
    }
  }

  /** Makes sure the price an item bills exists as a plan (webhooks may see a new price first). */
  private async ensurePrice(price: StripePrice): Promise<boolean> {
    if (this.syncedPrices.has(price.id)) return true;
    const known = await prisma.plan.findUnique({
      where: { organizationId_externalId: { organizationId: this.ctx.organizationId, externalId: price.id } },
      select: { id: true },
    });
    if (known !== null) {
      this.syncedPrices.add(price.id);
      return true;
    }
    let full = price;
    if (typeof price.product === "string") {
      try {
        full = await this.client.get<StripePrice>(`/v1/prices/${price.id}`, { "expand[]": "product" });
      } catch {
        // Keep the product id as the name.
      }
    }
    this.nameForPrices([full]);
    return this.syncPrice(full);
  }

  /** Webhooks can arrive before the customer they refer to: fetch and write it first. */
  async ensureCustomer(customerId: string): Promise<void> {
    const known = await prisma.customer.findUnique({
      where: { organizationId_externalId: { organizationId: this.ctx.organizationId, externalId: customerId } },
      select: { id: true },
    });
    if (known !== null) return;
    try {
      await this.syncCustomer(await this.client.get<StripeCustomer>(`/v1/customers/${customerId}`));
    } catch {
      // The write that needs it reports the missing customer.
    }
  }

  async syncSubscription(subscription: StripeSubscription): Promise<void> {
    if (subscription.status === "incomplete" || subscription.status === "incomplete_expired") {
      skip(this.summary, "subscriptions", subscription.id, "never paid (incomplete)");
      return;
    }
    if (subscription.currency.toUpperCase() !== this.ctx.currency) {
      skip(this.summary, "subscriptions", subscription.id, `billed in ${subscription.currency.toUpperCase()}`);
      return;
    }
    const items = subscription.items.data;
    const start = day(subscription.start_date);
    const endUnix = subscription.ended_at ?? subscription.cancel_at;
    let end = endUnix !== null ? day(endUnix) : null;
    if (end !== null && end <= start) {
      skip(this.summary, "subscriptions", subscription.id, "ended the day it started");
      return;
    }
    const status =
      subscription.status === "trialing" ? "trialing" : subscription.status === "past_due" || subscription.status === "unpaid" ? "past_due" : "active";
    // A canceled subscription without a recorded end ended when it was canceled.
    if (subscription.status === "canceled" && end === null) end = day(Math.floor(Date.now() / 1000));

    for (const item of items) {
      const key = items.length === 1 ? subscription.id : `${subscription.id}.${item.id}`;
      if (!this.subscriptionKeys.has(subscription.id)) this.subscriptionKeys.set(subscription.id, key);
      const problem = priceProblem(item.price, this.ctx.currency);
      if (problem !== null) {
        skip(this.summary, "subscriptions", key, problem);
        continue;
      }
      if (!(await this.ensurePrice(item.price))) {
        skip(this.summary, "subscriptions", key, "its price couldn't become a plan");
        continue;
      }
      try {
        const result = await putSubscription(this.ctx, key, {
          customer_external_id: subscription.customer,
          plan_external_id: item.price.id,
          quantity: Math.max(1, item.quantity ?? 1),
          start_date: start,
          end_date: end,
          ...(end === null || end > day(Math.floor(Date.now() / 1000)) ? { status } : {}),
        });
        const unchanged = result.record.changes.length === 1 && result.record.changes[0] === "unchanged";
        this.count("subscriptions", result.created, !unchanged);
      } catch (error: unknown) {
        skip(this.summary, "subscriptions", key, error instanceof Error ? error.message : String(error));
      }
    }
  }

  async syncInvoice(invoice: StripeInvoice): Promise<void> {
    if (invoice.status === null || invoice.total <= 0) {
      skip(this.summary, "invoices", invoice.id, invoice.total <= 0 ? "zero total" : "no status");
      return;
    }
    if (invoice.currency.toUpperCase() !== this.ctx.currency) {
      skip(this.summary, "invoices", invoice.id, `billed in ${invoice.currency.toUpperCase()}`);
      return;
    }
    const paidAt = invoice.status_transitions?.paid_at ?? null;
    const issued = day(invoice.status_transitions?.finalized_at ?? invoice.created);
    let subscriptionKey: string | null = null;
    if (invoice.subscription !== null) {
      subscriptionKey = this.subscriptionKeys.get(invoice.subscription) ?? null;
      if (subscriptionKey === null) {
        // Seen in an earlier sync: its segments are "<key>:<start day>".
        const segment = await prisma.subscription.findFirst({
          where: {
            organizationId: this.ctx.organizationId,
            OR: [
              { externalId: { startsWith: `${invoice.subscription}:` } },
              { externalId: { startsWith: `${invoice.subscription}.` } },
            ],
          },
          select: { externalId: true },
        });
        subscriptionKey = chainIdOf(segment?.externalId ?? null);
      }
    }
    const body = {
      customer_external_id: invoice.customer,
      subscription_external_id: subscriptionKey,
      amount: invoice.total,
      status: invoice.status,
      issued_at: issued,
      due_at: invoice.due_date !== null ? day(invoice.due_date) : null,
      paid_at: invoice.status === "paid" ? day(paidAt ?? invoice.created) : null,
    };
    try {
      const result = await putInvoice(this.ctx, invoice.id, body);
      this.count("invoices", result.created, result.changed);
    } catch (error: unknown) {
      // An invoice for a subscription that was skipped still counts on its own.
      if (error instanceof ApiError && error.param === "subscription_external_id" && subscriptionKey !== null) {
        try {
          const result = await putInvoice(this.ctx, invoice.id, { ...body, subscription_external_id: null });
          this.count("invoices", result.created, result.changed);
          return;
        } catch {
          // Fall through to report the first error.
        }
      }
      skip(this.summary, "invoices", invoice.id, error instanceof Error ? error.message : String(error));
    }
  }

  /** Every price, customer, subscription and invoice, in dependency order. */
  async syncAll(): Promise<void> {
    const prices: StripePrice[] = [];
    for await (const price of this.client.list<StripePrice>("/v1/prices", { "expand[]": "data.product" })) prices.push(price);
    this.nameForPrices(prices.filter((price) => priceProblem(price, this.ctx.currency) === null));
    for (const price of prices) await this.syncPrice(price);
    for await (const customer of this.client.list<StripeCustomer>("/v1/customers")) await this.syncCustomer(customer);
    for await (const subscription of this.client.list<StripeSubscription>("/v1/subscriptions", { status: "all" })) {
      await this.syncSubscription(subscription);
    }
    for await (const invoice of this.client.list<StripeInvoice>("/v1/invoices")) await this.syncInvoice(invoice);
  }
}

// ---------------------------------------------------------------------------
// Running a sync for a workspace
// ---------------------------------------------------------------------------

/** A sync that started longer ago than this is presumed dead, and can be taken over. */
const STALE_RUN_MS = 15 * 60 * 1000;

export type SyncOutcome =
  | { readonly kind: "done"; readonly summary: SyncSummary }
  | { readonly kind: "busy" }
  | { readonly kind: "not-connected" }
  | { readonly kind: "failed"; readonly message: string };

export interface ConnectionContext {
  readonly organizationId: string;
  readonly currency: string;
  readonly client: StripeClient;
}

/** The workspace's decrypted connection, or null when there is none (or it can't be opened). */
export async function connectionContext(organizationId: string): Promise<ConnectionContext | null> {
  const connection = await prisma.stripeConnection.findUnique({
    where: { organizationId },
    select: { encryptedKey: true, organization: { select: { currency: true } } },
  });
  if (connection === null) return null;
  const key = open(connection.encryptedKey);
  if (key === null) return null;
  return { organizationId, currency: connection.organization.currency, client: stripeClient(key) };
}

/**
 * Writes what a sync (full or webhook) changed: snapshots from the earliest
 * affected day, then alerts. Synchronous, because a sync runs off the request
 * path already (after() or the daily job).
 */
export async function settle(ctx: ApiWriteContext): Promise<void> {
  if (ctx.effects.affectedFrom !== null) await recomputeSnapshots(ctx.organizationId, ctx.effects.affectedFrom);
  await evaluateAlerts(ctx.organizationId);
}

/** A full sync of one workspace. One at a time per workspace; never throws. */
export async function runStripeSync(
  organizationId: string,
  options: { readonly actorId?: string } = {},
): Promise<SyncOutcome> {
  const now = new Date();
  const claimed = await prisma.stripeConnection.updateMany({
    where: {
      organizationId,
      OR: [{ syncState: "idle" }, { syncStartedAt: { lt: new Date(now.getTime() - STALE_RUN_MS) } }],
    },
    data: { syncState: "running", syncStartedAt: now },
  });
  if (claimed.count === 0) {
    const exists = await prisma.stripeConnection.count({ where: { organizationId } });
    return exists === 0 ? { kind: "not-connected" } : { kind: "busy" };
  }

  let outcome: SyncOutcome;
  try {
    const connection = await connectionContext(organizationId);
    if (connection === null) throw new StripeError("The stored key can't be read. Disconnect Stripe and connect it again.", 0);
    const sync = new StripeSync(writeContext(organizationId, connection.currency, now, "STRIPE"), connection.client);
    await sync.syncAll();
    await settle(sync.ctx);
    await prisma.stripeConnection.update({
      where: { organizationId },
      data: {
        syncState: "idle",
        lastSyncAt: new Date(),
        lastSyncSummary: sync.summary as unknown as Prisma.InputJsonObject,
        lastSyncError: null,
      },
    });
    const counts = sync.summary.counts;
    await writeAudit({
      organizationId,
      actorId: options.actorId,
      action: "stripe.synced",
      targetType: "integration",
      targetId: organizationId,
      targetLabel: "Stripe",
      metadata: {
        created: counts.plans.created + counts.customers.created + counts.subscriptions.created + counts.invoices.created,
        updated: counts.plans.updated + counts.customers.updated + counts.subscriptions.updated + counts.invoices.updated,
        skipped: counts.plans.skipped + counts.customers.skipped + counts.subscriptions.skipped + counts.invoices.skipped,
      },
    });
    outcome = { kind: "done", summary: sync.summary };
  } catch (error: unknown) {
    const message = error instanceof StripeError ? error.message : "The sync stopped on an unexpected error. It will retry with the next one.";
    if (!(error instanceof StripeError)) console.error("[stripe] sync failed", { organizationId, error });
    await prisma.stripeConnection.updateMany({
      where: { organizationId },
      data: { syncState: "idle", lastSyncError: message, lastSyncAt: new Date() },
    });
    outcome = { kind: "failed", message };
  }
  return outcome;
}

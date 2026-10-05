/**
 * The REST API half of `npm run verify:metrics`.
 *
 *   1. Keys — generation, hashing, and authentication failures (unknown,
 *      revoked, expired), the at-most-once-a-minute lastUsedAt, and scopes.
 *   2. The Postgres rate limiter — 120 in a window, the 121st refused, the
 *      reset, and pruning of old windows.
 *   3. The resources (lib/api/resources/*) — the functions the route handlers
 *      call once a request is authenticated — driven directly: every
 *      subscription transition via PUT, invoice transitions, the 409s that
 *      mirror the UI's refusals, validation, isolation between workspaces.
 *   4. After the writes, the snapshots rebuilt from the effects' earliest date
 *      match a full rebuild, and metrics/summary equals the Overview's figures.
 *   5. Every route under app/api/v1 appears in the OpenAPI document.
 *
 * The route wrapper itself (headers, envelope, after()) needs a Next request
 * and is exercised over HTTP by scripts/e2e-api.mjs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { ApiError } from "@/lib/api/errors";
import { writeContext, type ApiWriteContext } from "@/lib/api/context";
import { authenticateApiKey, generateApiKey, hashApiKey, scopeAllows } from "@/lib/api/keys";
import { OPENAPI_DOCUMENT } from "@/lib/api/openapi";
import { RATE_LIMIT, consumeRateLimit } from "@/lib/api/rate-limit";
import { archiveCustomer, getCustomer, listCustomers, putCustomer } from "@/lib/api/resources/customers";
import { getInvoice, listInvoices, putInvoice } from "@/lib/api/resources/invoices";
import { getMrrSeries, getSummary } from "@/lib/api/resources/metrics";
import { listPlans, putPlan } from "@/lib/api/resources/plans";
import {
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  putSubscription,
} from "@/lib/api/resources/subscriptions";
import { getCustomerActivity, getCustomerList, getMetricsSummary, getNetRevenueRetention } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { diffAgainstRebuild, recomputeSnapshots } from "@/lib/snapshots";

type Check = (label: string, actual: unknown, expected: unknown) => void;

const DAY_MS = 86_400_000;
const isoDay = (value: Date): string => value.toISOString().slice(0, 10);
const todayDate = (): Date => new Date(`${isoDay(new Date())}T00:00:00.000Z`);
const offset = (days: number): string => isoDay(new Date(todayDate().getTime() + days * DAY_MS));

/** The ApiError a call throws, as {type, param} (and the message when asked). */
async function failure(run: () => Promise<unknown>): Promise<{ type: string; status: number; param: string | null; message: string; details: number }> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      return { type: error.type, status: error.status, param: error.param ?? null, message: error.message, details: error.details?.length ?? 0 };
    }
    throw error;
  }
  return { type: "none", status: 200, param: null, message: "", details: 0 };
}

const brief = (f: { type: string; param: string | null }) => [f.type, f.param];

/** A fresh context per request, as the route wrapper makes one. */
function fresh(ctx: ApiWriteContext): ApiWriteContext {
  return writeContext(ctx.organizationId, ctx.currency);
}

async function verifyKeys(check: Check, orgId: string, otherId: string): Promise<void> {
  console.log("\nlib/api/keys.ts — generation, hashing, authentication");
  const a = generateApiKey();
  const b = generateApiKey();
  check("format: mrd_ + 32 random bytes in base64url (43 chars)", /^mrd_[A-Za-z0-9_-]{43}$/.test(a.key), true);
  check("prefix is the first 12 characters", [a.prefix, a.prefix.length], [a.key.slice(0, 12), 12]);
  check("hash is SHA-256 hex, deterministic, and not the key", [/^[0-9a-f]{64}$/.test(a.keyHash), hashApiKey(a.key) === a.keyHash, a.keyHash.includes(a.key)], [true, true, false]);
  check("two keys differ", a.key === b.key || a.keyHash === b.keyHash, false);

  const now = new Date();
  const make = async (organizationId: string, extra: { revokedAt?: Date; expiresAt?: Date; scope?: "READ" | "WRITE" } = {}) => {
    const generated = generateApiKey();
    const row = await prisma.apiKey.create({
      data: {
        organizationId,
        name: "verify",
        prefix: generated.prefix,
        keyHash: generated.keyHash,
        scope: extra.scope ?? "WRITE",
        revokedAt: extra.revokedAt ?? null,
        expiresAt: extra.expiresAt ?? null,
      },
      select: { id: true },
    });
    return { ...generated, id: row.id };
  };
  const valid = await make(orgId);
  const revoked = await make(orgId, { revokedAt: now });
  const expired = await make(orgId, { expiresAt: new Date(now.getTime() - 1000) });
  const future = await make(orgId, { expiresAt: new Date(now.getTime() + DAY_MS) });
  const foreign = await make(otherId, { scope: "READ" });

  const ok = await authenticateApiKey(`Bearer ${valid.key}`, now);
  check("a valid key authenticates to ITS workspace", ok.ok ? [ok.key.organizationId, ok.key.scope, ok.key.currency] : null, [orgId, "WRITE", "USD"]);
  const other = await authenticateApiKey(`Bearer ${foreign.key}`, now);
  check("another workspace's key authenticates to that workspace, not this one", other.ok ? other.key.organizationId : null, otherId);
  check("unknown key -> refused", (await authenticateApiKey(`Bearer ${generateApiKey().key}`, now)).ok, false);
  check("revoked key -> refused", await authenticateApiKey(`Bearer ${revoked.key}`, now), { ok: false, message: "This API key was revoked." });
  check("expired key -> refused", await authenticateApiKey(`Bearer ${expired.key}`, now), { ok: false, message: "This API key has expired." });
  check("a key expiring tomorrow still works", (await authenticateApiKey(`Bearer ${future.key}`, now)).ok, true);
  check("no header / not Bearer / not mrd_ -> refused", [
    (await authenticateApiKey(null, now)).ok,
    (await authenticateApiKey(`Basic ${valid.key}`, now)).ok,
    (await authenticateApiKey("Bearer sk_live_nope", now)).ok,
  ], [false, false, false]);

  const touched = await prisma.apiKey.findUniqueOrThrow({ where: { id: valid.id }, select: { lastUsedAt: true } });
  check("lastUsedAt set on first use", touched.lastUsedAt?.getTime(), now.getTime());
  await authenticateApiKey(`Bearer ${valid.key}`, new Date(now.getTime() + 30_000));
  const within = await prisma.apiKey.findUniqueOrThrow({ where: { id: valid.id }, select: { lastUsedAt: true } });
  check("lastUsedAt not rewritten within a minute", within.lastUsedAt?.getTime(), now.getTime());
  await authenticateApiKey(`Bearer ${valid.key}`, new Date(now.getTime() + 61_000));
  const after = await prisma.apiKey.findUniqueOrThrow({ where: { id: valid.id }, select: { lastUsedAt: true } });
  check("lastUsedAt rewritten after a minute", after.lastUsedAt?.getTime(), now.getTime() + 61_000);

  check("scopes: READ endpoint takes both; WRITE endpoint refuses a READ key", [
    scopeAllows("READ", "READ"),
    scopeAllows("READ", "WRITE"),
    scopeAllows("WRITE", "WRITE"),
    scopeAllows("WRITE", "READ"),
  ], [true, true, true, false]);

  console.log("\nlib/api/rate-limit.ts — 120 a minute per key, in Postgres");
  const t0 = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 5_000);
  const results = [];
  for (let i = 0; i < RATE_LIMIT + 1; i += 1) results.push(await consumeRateLimit(valid.id, new Date(t0.getTime() + i * 100)));
  const last = results[RATE_LIMIT - 1];
  const over = results[RATE_LIMIT];
  check("request 120 allowed with 0 remaining", [last?.allowed, last?.remaining], [true, 0]);
  check("request 121 refused", over?.allowed, false);
  check("reset is the end of the one-minute window", over?.resetAt.getTime(), t0.getTime() - 5_000 + 60_000);
  check("another key has its own count", (await consumeRateLimit(future.id, t0)).remaining, RATE_LIMIT - 1);
  const next = await consumeRateLimit(valid.id, new Date(t0.getTime() + 60_000));
  check("the next window starts over", [next.allowed, next.remaining], [true, RATE_LIMIT - 1]);
  check("the old window is pruned on the new window's first request", await prisma.apiRateLimit.count({ where: { keyId: valid.id } }), 1);
  // 30 parallel increments: each gets its own count.
  const burst = await Promise.all(Array.from({ length: 30 }, () => consumeRateLimit(foreign.id, t0)));
  check("parallel requests each count once (atomic upsert)", new Set(burst.map((r) => r.remaining)).size, 30);
}

async function verifyResources(check: Check, orgId: string, otherId: string): Promise<void> {
  console.log("\nlib/api/resources — PUT upserts through the UI's billing operations");
  const base = writeContext(orgId, "USD");
  const c = () => fresh(base);
  const START = "2025-01-01";

  // --- plans and customers --------------------------------------------------
  const basic = await putPlan(c(), "basic", { name: "Basic", amount: 10_000, interval: "month" });
  check("plan created (201), source api", [basic.created, basic.record.amount, basic.record.source], [true, 10_000, "api"]);
  const again = c();
  const same = await putPlan(again, "basic", { name: "Basic", amount: 10_000, interval: "month" });
  check("plan unchanged: no write, no audit", [same.created, same.changed, again.effects.audits.length], [false, false, 0]);
  await putPlan(c(), "pro", { name: "Pro", amount: 30_000, interval: "month" });
  await putPlan(c(), "team", { name: "Team", amount: 120_000, interval: "year" });
  check("plan validation lists every invalid field", await failure(() => putPlan(c(), "bad", { name: "", amount: 1.5, interval: "week", extra: 1 })).then((f) => [f.type, f.details]), ["invalid_request", 4]);
  check("plan name clash -> 409 with the UI's message", brief(await failure(() => putPlan(c(), "basic2", { name: "basic", amount: 1, interval: "month" }))), ["conflict", "name"]);

  const cus = await putCustomer(c(), "cus_1", { name: "One Co", email: "One@Example.com" });
  check("customer created, email normalized", [cus.created, cus.record.email, cus.record.status], [true, "one@example.com", "none"]);
  const cusCtx = c();
  check("customer unchanged: no audit", [(await putCustomer(cusCtx, "cus_1", { name: "One Co" })).changed, cusCtx.effects.audits.length], [false, 0]);
  const renameCtx = c();
  await putCustomer(renameCtx, "cus_1", { name: "One Company", email: null });
  check("customer update -> customer.updated, email cleared", [renameCtx.effects.audits.map((a) => a.action), (await getCustomer(c(), "cus_1")).email], [["customer.updated"], null]);
  await putCustomer(c(), "cus_2", { name: "Two Co" });
  await putCustomer(c(), "cus_3", { name: "Three Co" });
  await putCustomer(c(), "cus_r", { name: "Returning Co" });

  // --- subscriptions: every transition -------------------------------------
  const sub = { customer_external_id: "cus_1", plan_external_id: "basic", start_date: START };
  const created = await putSubscription(c(), "sub_1", sub);
  check("create -> [created], one segment, MRR 100.00", [created.created, created.record.changes, created.record.segments.length, created.record.mrr, created.record.segments[0]?.external_id], [true, ["created"], 1, 10_000, "sub_1:2025-01-01"]);
  const noop = c();
  check("same state again -> [unchanged], no write", [(await putSubscription(noop, "sub_1", sub)).record.changes, noop.effects.audits.length, noop.effects.affectedFrom], [["unchanged"], 0, null]);

  const qty = await putSubscription(c(), "sub_1", { ...sub, quantity: 2, effective_date: "2025-02-01" });
  check("backdated quantity change -> [quantity_changed] from 2025-02-01", [qty.record.changes, qty.record.segments.length, qty.record.segments[1]?.start_date, qty.record.mrr], [["quantity_changed"], 2, "2025-02-01", 20_000]);
  const upgradeCtx = c();
  const upgrade = await putSubscription(upgradeCtx, "sub_1", { ...sub, plan_external_id: "pro", quantity: 2, effective_date: "2025-03-01" });
  check("backdated plan change -> [plan_changed], affects from its date", [upgrade.record.changes, upgrade.record.plan_external_id, upgrade.record.mrr, upgradeCtx.effects.affectedFrom?.toISOString().slice(0, 10)], [["plan_changed"], "pro", 60_000, "2025-03-01"]);
  // A repriced plan must not move a running subscription.
  await putPlan(c(), "pro", { name: "Pro", amount: 35_000, interval: "month" });
  const repriced = c();
  check("plan repriced: an unchanged PUT stays unchanged, price kept", [(await putSubscription(repriced, "sub_1", { ...sub, plan_external_id: "pro", quantity: 2 })).record.changes, (await getSubscription(c(), "sub_1")).amount], [["unchanged"], 30_000]);
  const today = await putSubscription(c(), "sub_1", { ...sub, plan_external_id: "team", quantity: 2 });
  check("plan change today -> [plan_changed], starts today, yearly", [today.record.changes, today.record.segments.at(-1)?.start_date, today.record.interval, today.record.mrr], [["plan_changed"], offset(0), "year", 20_000]);
  const early = await failure(() => putSubscription(c(), "sub_1", { ...sub, plan_external_id: "basic", quantity: 2, effective_date: "2025-04-01" }));
  check("change dated before the current terms -> 409 on effective_date, UI's words", [early.type, early.param, early.message.startsWith("Pick a date after")], ["conflict", "effective_date", true]);
  const both = await putSubscription(c(), "sub_1", { ...sub, plan_external_id: "basic", quantity: 3, effective_date: offset(2) });
  check("plan and quantity at once -> both listed; a future change is the latest terms", [both.record.changes, both.record.quantity], [["plan_changed", "quantity_changed"], 3]);

  const later = { ...sub, plan_external_id: "basic", quantity: 3 };
  const scheduled = await putSubscription(c(), "sub_1", { ...later, end_date: offset(40) });
  check("future end_date -> [cancel_scheduled], still active", [scheduled.record.changes, scheduled.record.status, scheduled.record.cancel_scheduled, scheduled.record.end_date], [["cancel_scheduled"], "active", true, offset(40)]);
  check("same end_date again -> [unchanged]", (await putSubscription(c(), "sub_1", { ...later, end_date: offset(40) })).record.changes, ["unchanged"]);
  const moved = await putSubscription(c(), "sub_1", { ...later, end_date: offset(50) });
  check("a moved end_date -> undo, then schedule again", [moved.record.changes, moved.record.end_date], [["cancel_undone", "cancel_scheduled"], offset(50)]);
  const undone = await putSubscription(c(), "sub_1", later);
  check("end_date removed while scheduled -> [cancel_undone]", [undone.record.changes, undone.record.cancel_scheduled, undone.record.end_date], [["cancel_undone"], false, null]);
  const status = await putSubscription(c(), "sub_1", { ...later, status: "past_due" });
  check("a live status change -> [status_changed] (Correct)", [status.record.changes, status.record.status], [["status_changed"], "past_due"]);
  const early2 = await failure(() => putSubscription(c(), "sub_1", { ...later, end_date: offset(1) }));
  check("end_date before the latest terms begin -> 409 on end_date, nothing written", [early2.type, early2.param, (await getSubscription(c(), "sub_1")).end_date], ["conflict", "end_date", null]);

  const second = { customer_external_id: "cus_2", plan_external_id: "basic", start_date: START };
  await putSubscription(c(), "sub_2", second);
  const past = await putSubscription(c(), "sub_2", { ...second, end_date: "2025-06-01" });
  check("past end_date -> [canceled], MRR 0", [past.record.changes, past.record.status, past.record.mrr, past.record.end_date], [["canceled"], "canceled", 0, "2025-06-01"]);
  const revive = await failure(() => putSubscription(c(), "sub_2", second));
  check("removing an end_date already in effect -> 409 (UI can't undo it either)", [revive.type, revive.message.startsWith("This subscription ended on")], ["conflict", true]);
  const changeEnded = await failure(() => putSubscription(c(), "sub_2", { ...second, plan_external_id: "pro", end_date: "2025-06-01" }));
  check("changing an ended subscription -> 409 with the UI's message", [changeEnded.type, changeEnded.message.startsWith("This subscription ended on")], ["conflict", true]);

  const oneShot = await putSubscription(c(), "sub_3", { customer_external_id: "cus_3", amount: 5_000, interval: "month", start_date: START, end_date: "2025-03-01" });
  check("create with a past end_date -> [created, canceled], custom price", [oneShot.record.changes, oneShot.record.plan_external_id, oneShot.record.amount], [["created", "canceled"], null, 5_000]);

  check("unknown customer -> 404 on customer_external_id", brief(await failure(() => putSubscription(c(), "sub_x", { ...sub, customer_external_id: "nope" }))), ["not_found", "customer_external_id"]);
  check("unknown plan -> 404 on plan_external_id", brief(await failure(() => putSubscription(c(), "sub_x", { ...sub, plan_external_id: "nope" }))), ["not_found", "plan_external_id"]);
  check("a subscription can't move customers -> 409", brief(await failure(() => putSubscription(c(), "sub_1", { ...later, customer_external_id: "cus_2" }))), ["conflict", "customer_external_id"]);
  check("start_date can't change -> 409", brief(await failure(() => putSubscription(c(), "sub_1", { ...later, start_date: "2025-01-02" }))), ["conflict", "start_date"]);
  const invalid = await failure(() => putSubscription(c(), "sub_x", { customer_external_id: "cus_1", quantity: 0, start_date: "2025-02-30", status: "canceled" }));
  check("validation lists every invalid field, cross-field ones too", [invalid.type, invalid.details], ["invalid_request", 5]);
  check("plan and interval together -> 400", brief(await failure(() => putSubscription(c(), "sub_x", { ...sub, interval: "month" }))), ["invalid_request", "interval"]);

  // Churn and return inside the metrics window, for reactivated_customers.
  await putSubscription(c(), "sub_r1", { customer_external_id: "cus_r", plan_external_id: "basic", start_date: START, end_date: offset(-10) });
  await putSubscription(c(), "sub_r2", { customer_external_id: "cus_r", plan_external_id: "pro", start_date: offset(-5) });

  // --- invoices ---------------------------------------------------------------
  console.log("\nInvoices — transitions follow the UI's rules");
  const inv = { customer_external_id: "cus_1", subscription_external_id: "sub_1", amount: 10_000, issued_at: "2025-01-01" };
  const open = await putInvoice(c(), "in_1", { ...inv, status: "open", due_at: "2025-01-15" });
  check("invoice recorded open, linked to the segment of its issue date", [open.created, open.record.status, open.record.subscription_external_id], [true, "open", "sub_1"]);
  const paidCtx = c();
  const paid = await putInvoice(paidCtx, "in_1", { ...inv, status: "paid", paid_at: "2025-01-03" });
  check("open -> paid via the UI's Mark paid", [paid.record.status, paid.record.paid_at, paidCtx.effects.audits.map((a) => a.action)], ["paid", "2025-01-03", ["invoice.paid"]]);
  check("paid again, same paid_at -> unchanged", (await putInvoice(c(), "in_1", { ...inv, status: "paid", paid_at: "2025-01-03" })).changed, false);
  check("paid -> open refused with the UI's wording", await failure(() => putInvoice(c(), "in_1", { ...inv, status: "open" })).then((f) => [f.type, f.message]), ["conflict", "A paid invoice can't be marked open."]);
  check("paid -> void refused (a refund is not modelled)", (await failure(() => putInvoice(c(), "in_1", { ...inv, status: "void" }))).type, "conflict");
  check("amount can't change once recorded", brief(await failure(() => putInvoice(c(), "in_1", { ...inv, amount: 1, status: "paid", paid_at: "2025-01-03" }))), ["conflict", "amount"]);
  check("paid without paid_at -> 400", brief(await failure(() => putInvoice(c(), "in_2", { ...inv, status: "paid" }))), ["invalid_request", "paid_at"]);
  const voidCtx = c();
  const voided = await putInvoice(voidCtx, "in_2", { ...inv, status: "void" });
  check("a new void invoice: recorded open, then voided (two UI operations)", [voided.record.status, voidCtx.effects.audits.map((a) => a.action)], ["void", ["invoice.created", "invoice.voided"]]);
  await putInvoice(c(), "in_3", { ...inv, status: "draft" });
  check("draft -> uncollectible refused (only open can be)", (await failure(() => putInvoice(c(), "in_3", { ...inv, status: "uncollectible" }))).type, "conflict");
  await putInvoice(c(), "in_4", { ...inv, status: "open" });
  await putInvoice(c(), "in_4", { ...inv, status: "uncollectible" });
  check("open -> uncollectible -> paid (recovered)", (await putInvoice(c(), "in_4", { ...inv, status: "paid", paid_at: offset(0) })).record.status, "paid");
  check("invoice for an unknown subscription -> 404", brief(await failure(() => putInvoice(c(), "in_5", { ...inv, subscription_external_id: "nope", status: "open" }))), ["not_found", "subscription_external_id"]);
  const filtered = await listInvoices(c(), new URLSearchParams("status=paid&customer_external_id=cus_1"));
  check("invoice list filters", filtered.data.map((row) => row.external_id).sort(), ["in_1", "in_4"]);
  check("issued_after is exclusive", (await listInvoices(c(), new URLSearchParams("issued_after=2025-01-01"))).data.length, 0);

  // --- lists, archive, delete -------------------------------------------------
  const page1 = await listCustomers(c(), new URLSearchParams("limit=2"));
  const page2 = await listCustomers(c(), new URLSearchParams(`limit=2&starting_after=${page1.next_cursor ?? ""}`));
  check("cursor pagination: 2 + 2, no overlap, has_more flips", [page1.data.length, page1.has_more, page2.data.length, page2.has_more, page1.data.some((row) => page2.data.some((other) => other.id === row.id))], [2, true, 2, false, false]);
  check("status=churned lists cus_2 and cus_3", (await listCustomers(c(), new URLSearchParams("status=churned"))).data.map((row) => row.external_id).sort(), ["cus_2", "cus_3"]);
  check("limit over 100 -> 400", brief(await failure(() => listCustomers(c(), new URLSearchParams("limit=101")))), ["invalid_request", "limit"]);
  check("plans list", (await listPlans(c(), new URLSearchParams())).data.length, 3);
  check("subscription list by customer", (await listSubscriptions(c(), new URLSearchParams("customer_external_id=cus_r"))).data.map((row) => row.external_id).sort(), ["sub_r1", "sub_r2"]);
  const archived = await archiveCustomer(c(), "cus_3");
  check("DELETE customer archives and returns it; again is a no-op", [archived.archived, (await archiveCustomer(c(), "cus_3")).archived], [true, true]);
  check("PUT brings an archived customer back", (await putCustomer(c(), "cus_3", { name: "Three Co" })).record.archived, false);

  // --- isolation --------------------------------------------------------------
  console.log("\nIsolation — a key's workspace is the only one it sees");
  const otherCtx = writeContext(otherId, "USD");
  check("other workspace: customer 404", brief(await failure(() => getCustomer(otherCtx, "cus_1"))), ["not_found", "external_id"]);
  check("other workspace: can't subscribe to this one's customer", brief(await failure(() => putSubscription(writeContext(otherId, "USD"), "sub_1", sub))), ["not_found", "customer_external_id"]);
  check("other workspace: empty lists", [(await listCustomers(otherCtx, new URLSearchParams())).data.length, (await listInvoices(otherCtx, new URLSearchParams())).data.length], [0, 0]);
  check("other workspace: invoice 404", (await failure(() => getInvoice(otherCtx, "in_1"))).type, "not_found");
  await putCustomer(writeContext(otherId, "USD"), "cus_1", { name: "Same ID elsewhere" });
  check("the same external_id in two workspaces are two customers", [(await getCustomer(c(), "cus_1")).name, (await getCustomer(otherCtx, "cus_1")).name], ["One Company", "Same ID elsewhere"]);

  // --- delete -----------------------------------------------------------------
  await putCustomer(c(), "cus_d", { name: "Doomed Co" });
  await putSubscription(c(), "sub_d", { customer_external_id: "cus_d", plan_external_id: "basic", start_date: START });
  await putSubscription(c(), "sub_d", { customer_external_id: "cus_d", plan_external_id: "pro", start_date: START, effective_date: "2025-05-01" });
  const deleted = await deleteSubscription(c(), "sub_d");
  check("DELETE subscription removes the whole chain", [deleted.segments, (await failure(() => getSubscription(c(), "sub_d"))).type], [2, "not_found"]);

  // --- snapshots and metrics --------------------------------------------------
  console.log("\nSnapshots and metrics — the Overview's numbers");
  await recomputeSnapshots(orgId, new Date("2024-12-01T00:00:00.000Z"));
  check("stored snapshots equal a full rebuild", (await diffAgainstRebuild(orgId, new Date("2024-12-01T00:00:00.000Z"))).length, 0);
  // A later write's effects say where to recompute from; that alone keeps them right.
  const late = c();
  await putSubscription(late, "sub_2", { ...second, end_date: "2025-06-01" });
  await putSubscription(late, "sub_3", { customer_external_id: "cus_3", amount: 5_000, interval: "month", start_date: START, end_date: "2025-03-01" });
  const backdate = c();
  await putSubscription(backdate, "sub_1", { ...later, status: "past_due", quantity: 4, effective_date: offset(3) });
  if (backdate.effects.affectedFrom) await recomputeSnapshots(orgId, backdate.effects.affectedFrom);
  check("recompute from effects.affectedFrom keeps snapshots exact", (await diffAgainstRebuild(orgId, new Date("2024-12-01T00:00:00.000Z"))).length, 0);

  const ctx = c();
  const summary = await getSummary(ctx, new URLSearchParams());
  const overviewPeriod = { kind: "preset" as const, preset: "last_30_days" as const, asOf: ctx.now };
  const [kpis, nrr, activity, customers] = await Promise.all([
    getMetricsSummary(orgId, overviewPeriod),
    getNetRevenueRetention(orgId, overviewPeriod),
    getCustomerActivity(orgId, overviewPeriod),
    getCustomerList(orgId, ctx.now),
  ]);
  check("summary equals the Overview for today", [
    summary.mrr, summary.arr, summary.active_customers, summary.new_customers, summary.churned_customers,
    summary.customer_churn_rate, summary.revenue_churn_rate, summary.nrr, summary.arpa,
  ], [
    kpis.mrrCents.current, kpis.arrCents.current, kpis.activeCustomers.current, activity.newCustomers.current, activity.churnedCustomers.current,
    kpis.customerChurnRate.current, kpis.revenueChurnRate.current, nrr.nrr, customers.averageMRRCents,
  ]);
  check("hand-checked: MRR = sub_1 (Team yearly ×2 = 200.00) + cus_r (Pro 350.00)", summary.mrr, 55_000);
  check("reactivated_customers: cus_r churned 10 days ago and came back 5 days ago", [summary.reactivated_customers, summary.churned_customers], [1, 1]);
  check("grr = (start − contraction − churn) / start", summary.grr, nrr.startingMRRCents === 0 ? null : (nrr.startingMRRCents - nrr.contractionMRRCents - nrr.churnedMRRCents) / nrr.startingMRRCents);
  const pastDay = await getSummary(c(), new URLSearchParams("date=2025-02-15"));
  check("a past date: state at that day's end (sub_1 Basic ×2, sub_2, sub_3 custom, sub_r1)", [pastDay.date, pastDay.mrr], ["2025-02-15", 20_000 + 10_000 + 5_000 + 10_000]);
  check("a future date -> 400", brief(await failure(() => getSummary(c(), new URLSearchParams(`date=${offset(1)}`)))), ["invalid_request", "date"]);
  const series = await getMrrSeries(c(), new URLSearchParams(`from=${offset(-2)}&to=${offset(0)}`));
  check("mrr series: one point per day, today's is the summary MRR", [series.data.length, series.data.at(-1)?.mrr], [3, summary.mrr]);
  check("mrr series over 730 days -> 400", (await failure(() => getMrrSeries(c(), new URLSearchParams("from=2020-01-01&to=2025-01-01")))).type, "invalid_request");
}

function verifyOpenApi(check: Check): void {
  console.log("\nOpenAPI — every route in app/api/v1 is documented");
  const root = path.join(process.cwd(), "app", "api", "v1");
  const routes: { path: string; methods: string[] }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "route.ts") {
        const relative = path.relative(root, dir).split(path.sep).join("/");
        if (relative.startsWith("[...") || relative === "openapi.json") continue;
        const source = readFileSync(full, "utf8");
        const methods = [...source.matchAll(/export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1] ?? "");
        routes.push({ path: `/${relative.replace(/\[([^\]]+)\]/g, "{$1}")}`, methods });
      }
    }
  };
  walk(root);
  const paths = OPENAPI_DOCUMENT.paths as Record<string, Record<string, unknown>>;
  const missing = routes.flatMap((route) =>
    route.methods.filter((method) => paths[route.path]?.[method.toLowerCase()] === undefined).map((method) => `${method} ${route.path}`),
  );
  check(`all ${routes.reduce((n, r) => n + r.methods.length, 0)} route methods are in openapi.json`, missing, []);
  const documented = Object.entries(paths).flatMap(([p, ops]) =>
    Object.keys(ops).filter((k) => ["get", "put", "post", "patch", "delete"].includes(k)).map((m) => `${m.toUpperCase()} ${p}`),
  );
  const implemented = new Set(routes.flatMap((route) => route.methods.map((method) => `${method} ${route.path}`)));
  check("and nothing documented is missing a route", documented.filter((op) => !implemented.has(op)), []);
  check("OpenAPI version", OPENAPI_DOCUMENT.openapi, "3.1.0");
}

export async function verifyApi(check: Check, stamp: string): Promise<string[]> {
  const org = await prisma.organization.create({
    data: { name: "verify-api", slug: `verify-api-${stamp}`, currency: "USD" },
    select: { id: true },
  });
  const other = await prisma.organization.create({
    data: { name: "verify-api other", slug: `verify-api-other-${stamp}`, currency: "USD" },
    select: { id: true },
  });
  const ids = [org.id, other.id];
  try {
    await verifyKeys(check, org.id, other.id);
    await verifyResources(check, org.id, other.id);
    verifyOpenApi(check);
  } catch (error: unknown) {
    await prisma.organization.deleteMany({ where: { id: { in: ids } } });
    throw error;
  }
  return ids;
}

/**
 * The Stripe half of `npm run verify:metrics`, against the in-process fake
 * Stripe (scripts/fake-stripe.mjs, 2 objects per page so every list pages):
 *
 *   1. Secrets at rest (lib/secret-box.ts) and webhook signatures.
 *   2. The client's errors: a rejected key, a key without invoice access.
 *   3. A full sync of the default fixture account into a fresh USD workspace:
 *      what becomes a plan / customer / subscription / invoice, what is skipped
 *      and why, source STRIPE, scheduled and past cancellations, live MRR.
 *   4. Syncing again changes nothing.
 *   5. A plan change made in Stripe arrives as a plan change in Meridian.
 *   6. Webhook events: a cancellation, and an invoice for a customer Meridian
 *      has never seen (fetched first).
 */
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { writeContext } from "@/lib/api/context";
import { getCustomerList } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { open, seal } from "@/lib/secret-box";
import { stripeClient, StripeError } from "@/lib/stripe/client";
import { settle, StripeSync, type StripeSubscription } from "@/lib/stripe/sync";
import { applyStripeEvent, verifyStripeSignature } from "@/lib/stripe/webhook";

type Check = (label: string, actual: unknown, expected: unknown) => void;

interface FakeStripe {
  readonly url: string;
  setState(state: unknown): void;
  getState(): {
    customers: { id: string; name: string | null; email: string | null }[];
    subscriptions: StripeSubscription[];
    invoices: Record<string, unknown>[];
    prices: { id: string }[];
  };
  close(): Promise<void>;
}

const DAY = 86_400;

async function mrr(organizationId: string): Promise<number> {
  const list = await getCustomerList(organizationId);
  return list.customers.reduce((sum, row) => sum + row.mrrCents, 0);
}

export async function verifyStripe(check: Check, stamp: string): Promise<string[]> {
  console.log("\n── stripe: secrets, signatures, sync, webhooks ──");
  // An ES module, loaded from this script that ts-node compiles to CommonJS —
  // where a plain `import()` would be rewritten to `require()`, which can't
  // load it. A real dynamic import keeps it a native one.
  const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  const fakeModule = (await nativeImport(pathToFileURL(join(__dirname, "fake-stripe.mjs")).href)) as {
    startFakeStripe(options?: { port?: number }): Promise<FakeStripe>;
    FAKE_KEY: string;
    FAKE_KEY_NO_INVOICES: string;
  };
  const fake = await fakeModule.startFakeStripe();
  const orgIds: string[] = [];

  try {
    // 1. Secrets and signatures ----------------------------------------------
    const sealed = seal("rk_test_secret_value");
    check("secret box: opens what it sealed", open(sealed), "rk_test_secret_value");
    check("secret box: never stores the plaintext", sealed.includes("rk_test_secret_value"), false);
    check("secret box: a fresh IV every time", seal("x") === seal("x"), false);
    const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    check("secret box: a tampered value doesn't open", open(tampered), null);

    const secret = "whsec_testsecret0123456789";
    const payload = JSON.stringify({ id: "evt_1", type: "customer.updated" });
    const t = Math.floor(Date.now() / 1000);
    const sign = (time: number, body: string, key = secret) => createHmac("sha256", key).update(`${time}.${body}`).digest("hex");
    check("signature: valid", verifyStripeSignature(payload, `t=${t},v1=${sign(t, payload)}`, secret), true);
    check("signature: any of several v1 values", verifyStripeSignature(payload, `t=${t},v1=deadbeef,v1=${sign(t, payload)}`, secret), true);
    check("signature: wrong secret", verifyStripeSignature(payload, `t=${t},v1=${sign(t, payload, "whsec_other")}`, secret), false);
    check("signature: body changed", verifyStripeSignature(payload + " ", `t=${t},v1=${sign(t, payload)}`, secret), false);
    check("signature: older than five minutes", verifyStripeSignature(payload, `t=${t - 301},v1=${sign(t - 301, payload)}`, secret), false);
    check("signature: missing header", verifyStripeSignature(payload, null, secret), false);

    // 2. Client errors ----------------------------------------------------------
    const failure = async (key: string, path: string): Promise<string> => {
      try {
        await stripeClient(key, fake.url).get(path);
        return "no error";
      } catch (error: unknown) {
        return error instanceof StripeError ? `${error.status}: ${error.message}` : String(error);
      }
    };
    check("client: a rejected key", (await failure("rk_test_wrong", "/v1/prices")).startsWith("401: Stripe didn't accept this key"), true);
    check(
      "client: names the missing permission",
      await failure(fakeModule.FAKE_KEY_NO_INVOICES, "/v1/invoices"),
      "403: This key can't read invoices. Give it Read access to invoices in Stripe.",
    );

    // 3. Full sync --------------------------------------------------------------
    const org = await prisma.organization.create({
      data: { name: `Stripe ${stamp}`, slug: `stripe-${stamp}`, currency: "USD" },
      select: { id: true },
    });
    orgIds.push(org.id);
    const client = stripeClient(fakeModule.FAKE_KEY, fake.url);
    const fullSync = async (): Promise<StripeSync> => {
      const sync = new StripeSync(writeContext(org.id, "USD", new Date(), "STRIPE"), client);
      await sync.syncAll();
      await settle(sync.ctx);
      return sync;
    };
    const first = await fullSync();
    const { counts } = first.summary;
    check("sync: plans — 3 created, 4 skipped", [counts.plans.created, counts.plans.skipped], [3, 4]);
    check("sync: customers — 4 created", counts.customers.created, 4);
    check("sync: subscriptions — 4 created, 2 skipped", [counts.subscriptions.created, counts.subscriptions.skipped], [4, 2]);
    check("sync: invoices — 3 created, the zero one skipped", [counts.invoices.created, counts.invoices.skipped], [3, 1]);
    const reasons = first.summary.problems.map((problem) => `${problem.id}: ${problem.reason}`);
    check("sync: says why — another currency", reasons.includes("price_pro_eur: priced in EUR, workspace reports in USD"), true);
    check("sync: says why — weekly billing", reasons.includes("price_basic_w: billed per week"), true);
    check("sync: says why — incomplete", reasons.includes("sub_e: never paid (incomplete)"), true);

    const plans = await prisma.plan.findMany({ where: { organizationId: org.id }, orderBy: { name: "asc" }, select: { name: true, externalId: true, source: true } });
    check(
      "plans: named after the product, with the period when a product has several",
      plans.map((plan) => plan.name),
      ["Basic", "Pro (monthly)", "Pro (yearly)"],
    );
    check("plans: source STRIPE, external_id = price id", plans.every((plan) => plan.source === "STRIPE" && plan.externalId?.startsWith("price_")), true);
    const delta = await prisma.customer.findUnique({ where: { organizationId_externalId: { organizationId: org.id, externalId: "cus_d" } }, select: { name: true } });
    check("customers: a nameless one is named by its email", delta?.name, "delta@delta.test");

    const segment = (key: string) =>
      prisma.subscription.findFirst({
        where: { organizationId: org.id, externalId: { startsWith: `${key}:` } },
        orderBy: { startedAt: "desc" },
        select: { endedAt: true, canceledAt: true, status: true, quantity: true, source: true },
      });
    const today = Math.floor(Date.now() / 1000);
    const T = today - (today % DAY);
    const dayOf = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
    const a = await segment("sub_a");
    check("subscriptions: quantity carried over", a?.quantity, 2);
    check("subscriptions: source STRIPE", a?.source, "STRIPE");
    const b = await segment("sub_b");
    check("subscriptions: a canceled one ended when Stripe says", b?.endedAt?.toISOString().slice(0, 10), dayOf(T - 30 * DAY));
    const d = await segment("sub_d");
    check("subscriptions: cancel_at becomes a scheduled cancellation", d?.endedAt?.toISOString().slice(0, 10), dayOf(T + 20 * DAY));
    check("subscriptions: … still active today", d?.status, "ACTIVE");
    const c = await segment("sub_c");
    check("subscriptions: trialing stays trialing", c?.status, "TRIALING");

    check("MRR: 2 × Pro monthly + Pro yearly ÷ 12 + Basic", await mrr(org.id), 9_800 + Math.round(49_000 / 12) + 1_500);
    const overdue = await prisma.invoice.findUnique({
      where: { organizationId_externalId: { organizationId: org.id, externalId: "in_d1" } },
      select: { status: true, subscriptionId: true },
    });
    check("invoices: linked to their subscription", overdue?.subscriptionId !== null, true);
    check("alerts: the overdue Stripe invoice raised one", await prisma.notification.count({ where: { organizationId: org.id, type: "INVOICE_OVERDUE" } }), 1);

    // 4. Idempotent -------------------------------------------------------------
    const second = await fullSync();
    const created = Object.values(second.summary.counts).reduce((sum, kind) => sum + kind.created + kind.updated, 0);
    check("sync again: nothing created or updated", created, 0);
    check("sync again: the subscriptions are unchanged", second.summary.counts.subscriptions.unchanged, 4);

    // 5. A plan change in Stripe ------------------------------------------------
    const state = fake.getState();
    const basic = state.prices.find((price) => price.id === "price_basic_m");
    const subA = state.subscriptions.find((sub) => sub.id === "sub_a")!;
    fake.setState({
      ...state,
      subscriptions: state.subscriptions.map((sub) =>
        sub.id === "sub_a" ? { ...subA, items: { data: [{ ...subA.items.data[0], price: basic }] } } : sub,
      ),
    });
    const third = await fullSync();
    check("plan change: one subscription updated", third.summary.counts.subscriptions.updated, 1);
    const chain = await prisma.subscription.findMany({
      where: { organizationId: org.id, externalId: { startsWith: "sub_a:" } },
      orderBy: { startedAt: "asc" },
      select: { endedAt: true, amountCents: true, previousSubscriptionId: true },
    });
    check("plan change: a new segment linked to the old one", [chain.length, chain[1]?.previousSubscriptionId !== null], [2, true]);
    check("plan change: MRR follows", await mrr(org.id), 3_000 + Math.round(49_000 / 12) + 1_500);

    // 6. Webhook events ---------------------------------------------------------
    const connection = { organizationId: org.id, currency: "USD", client };
    const subC = fake.getState().subscriptions.find((sub) => sub.id === "sub_c")!;
    const handled = await applyStripeEvent(connection, {
      id: "evt_cancel",
      type: "customer.subscription.deleted",
      data: { object: { ...subC, status: "canceled", ended_at: T - DAY } },
    });
    check("webhook: a cancellation is handled", handled, true);
    check("webhook: … and ends the subscription", (await segment("sub_c"))?.endedAt?.toISOString().slice(0, 10), dayOf(T - DAY));

    const current = fake.getState();
    fake.setState({ ...current, customers: [...current.customers, { id: "cus_new", object: "customer", name: "Newco", email: null }] });
    await applyStripeEvent(connection, {
      id: "evt_invoice",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_new",
          customer: "cus_new",
          subscription: null,
          currency: "usd",
          total: 2500,
          status: "paid",
          created: T - DAY,
          due_date: null,
          status_transitions: { paid_at: T - DAY, finalized_at: T - DAY },
        },
      },
    });
    const newInvoice = await prisma.invoice.findUnique({
      where: { organizationId_externalId: { organizationId: org.id, externalId: "in_new" } },
      select: { amountCents: true, customer: { select: { name: true } } },
    });
    check("webhook: an invoice for an unseen customer fetches the customer first", newInvoice?.customer.name, "Newco");
    check("webhook: ignores events it doesn't handle", await applyStripeEvent(connection, { id: "evt_x", type: "charge.refunded", data: { object: {} } }), false);
  } finally {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await fake.close();
  }
  return [];
}

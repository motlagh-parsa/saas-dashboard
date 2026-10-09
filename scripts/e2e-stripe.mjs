// End-to-end check of the Stripe integration, against the fake Stripe
// (scripts/fake-stripe.mjs) — the app must run with
// STRIPE_API_BASE=http://127.0.0.1:12111 and the fake must be listening there:
//
//   node scripts/fake-stripe.mjs &      # then start the app, then:
//   npm run e2e:stripe
//
//   1. Connecting refuses a secret key, a rejected key, and a key that can't
//      read invoices — each with its own message; a good key connects, and the
//      first sync fills the workspace (summary table, customers, MRR).
//   2. Live updates: save the signing secret; a correctly signed event changes
//      a customer within seconds; a badly signed one is refused (400).
//   3. Sync now; the daily job also syncs connected workspaces.
//   4. A member is refused the page.
//   5. Disconnect: the key is gone, the synced data stays.
// Runs in a fresh workspace it creates for the demo user, and deletes it.
import { createHmac } from "node:crypto";

import { APP, connectDb, createChecks, launchBrowser, mintSession, money, signInDemo, sleep } from "./e2e-lib.mjs";
import { FAKE_KEY, FAKE_KEY_NO_INVOICES } from "./fake-stripe.mjs";

const FAKE = process.env.STRIPE_API_BASE ?? "http://127.0.0.1:12111";
const { check, fail, finish } = createChecks();
const { one, db, close: closeDb } = await connectDb();
const browser = await launchBrowser({ port: 9339 });
const { evaluate, waitFor, load, click, setSession, whenInteractive } = browser;

const stamp = Date.now().toString(36);
const demo = await one(`SELECT id FROM "User" WHERE email = $1`, [process.env.DEMO_EMAIL]);
const bob = await one(`SELECT id FROM "User" WHERE email = 'bob@acme-demo.dev'`);
const orgId = `e2estripe${stamp}`.padEnd(25, "0"); // cuid-shaped: actions check id format

async function submitKey(value) {
  await load("/dashboard/settings/integrations");
  await whenInteractive("#stripe-key");
  await evaluate(`(() => { window.__e2e.set(document.getElementById("stripe-key"), ${JSON.stringify(value)}); return true; })()`);
  await click("Connect Stripe", `document.querySelector('[data-testid="stripe-key-form"] button[type="submit"]')`);
}

async function keyError() {
  return waitFor("key error", `document.getElementById("stripe-key-error")?.textContent || null`, 30_000);
}

async function waitForSync(label) {
  for (let i = 0; i < 150; i++) {
    const row = await one(`SELECT "syncState", "lastSyncAt", "lastSyncError" FROM "StripeConnection" WHERE "organizationId" = $1`, [orgId]);
    if (row && row.syncState === "idle" && row.lastSyncAt) return row;
    await sleep(200);
  }
  throw new Error(`${label}: the sync never finished`);
}

try {
  await fetch(`${FAKE}/__control/reset`, { method: "POST" });
  await db.query(
    `INSERT INTO "Organization" (id, name, slug, currency, "createdAt", "updatedAt") VALUES ($1, $2, $3, 'USD', now(), now())`,
    [orgId, `E2E Stripe ${stamp}`, `e2e-stripe-${stamp}`],
  );
  await db.query(`INSERT INTO "Membership" ("userId", "organizationId", role, "createdAt") VALUES ($1, $2, 'OWNER', now())`, [demo.id, orgId]);
  await db.query(`INSERT INTO "Membership" ("userId", "organizationId", role, "createdAt") VALUES ($1, $2, 'MEMBER', now())`, [bob.id, orgId]);
  const session = await signInDemo();
  await setSession(session, orgId);

  // 1. Connect --------------------------------------------------------------------------------
  await submitKey("sk_test_abcdefghijklmnop");
  check("1. a secret key is refused", (await keyError()).includes("secret key"));
  await submitKey("rk_test_notavalidkey00000000");
  check("1. a rejected key says so", (await keyError()).includes("didn't accept this key"));
  await submitKey(FAKE_KEY_NO_INVOICES);
  check("1. a key that can't read invoices says which permission", (await keyError()).includes("can't read invoices"));
  check("1. nothing stored for refused keys", (await one(`SELECT count(*)::int AS n FROM "StripeConnection" WHERE "organizationId" = $1`, [orgId])).n === 0);

  await submitKey(FAKE_KEY);
  // On success the page re-renders as connected: the form gives way to the status.
  await waitFor("connected", `!!document.querySelector('[data-testid="stripe-sync-status"]')`, 30_000);
  const stored = await one(`SELECT "encryptedKey", "keyHint", livemode FROM "StripeConnection" WHERE "organizationId" = $1`, [orgId]);
  check("1. the key is stored encrypted, with only its last four shown", stored.encryptedKey.startsWith("v1:") && !stored.encryptedKey.includes(FAKE_KEY) && stored.keyHint === FAKE_KEY.slice(-4) && stored.livemode === false);
  const firstSync = await waitForSync("first sync");
  check("1. the first sync runs on its own and succeeds", firstSync.lastSyncError === null, firstSync.lastSyncError ?? "");
  await load("/dashboard/settings/integrations");
  const summary = await evaluate(`window.__e2e.text('[data-testid="stripe-sync-summary"]')`);
  check("1. the page shows what it synced", summary?.includes("Customers") && summary.includes("Subscriptions"), summary ?? "none");
  const customers = (await one(`SELECT count(*)::int AS n FROM "Customer" WHERE "organizationId" = $1 AND source = 'STRIPE'`, [orgId])).n;
  check("1. four customers from Stripe", customers === 4, String(customers));
  await load("/dashboard");
  const mrr = money(await waitFor("overview MRR", `window.__e2e.text('[data-testid="overview-mrr"] .sr-only')`));
  check("1. Overview MRR: $153.83 (shown rounded)", Math.abs(mrr - 153.83) < 0.5, String(mrr));

  // 2. Webhook --------------------------------------------------------------------------------
  const secret = `whsec_e2e${stamp}0123456789abcdef`;
  await load("/dashboard/settings/integrations");
  await whenInteractive("#stripe-webhook-secret");
  await evaluate(`(() => { window.__e2e.set(document.getElementById("stripe-webhook-secret"), ${JSON.stringify(secret)}); return true; })()`);
  await click("Save secret", `document.querySelector('[data-testid="stripe-webhook-secret-form"] button[type="submit"]')`);
  await waitFor("secret saved", `document.querySelector('[data-testid="stripe-webhook-secret-form"] [role="status"]')?.textContent.includes("saved")`, 30_000);
  const url = await evaluate(`window.__e2e.text('[data-testid="stripe-webhook-url"]')`);
  const path = new URL(url).pathname;
  check("2. the page shows this workspace's endpoint", path.startsWith("/api/stripe/webhook/"), path);

  const event = JSON.stringify({
    id: `evt_${stamp}`,
    type: "customer.updated",
    data: { object: { id: "cus_a", object: "customer", name: "Acme Corporation", email: "billing@acme.test" } },
  });
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${t}.${event}`).digest("hex");
  const bad = await fetch(`${APP}${path}`, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${"0".repeat(64)}` }, body: event });
  check("2. a badly signed event is refused", bad.status === 400);
  const good = await fetch(`${APP}${path}`, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${signature}` }, body: event });
  check("2. a signed event is accepted", good.status === 200);
  let renamed = null;
  for (let i = 0; i < 50 && renamed !== "Acme Corporation"; i++) {
    renamed = (await one(`SELECT name FROM "Customer" WHERE "organizationId" = $1 AND "externalId" = 'cus_a'`, [orgId]))?.name;
    await sleep(200);
  }
  check("2. … and changes the customer within seconds", renamed === "Acme Corporation", renamed ?? "");

  // 3. Sync now, and the daily job ---------------------------------------------------------------
  await db.query(`UPDATE "StripeConnection" SET "lastSyncAt" = NULL WHERE "organizationId" = $1`, [orgId]);
  await load("/dashboard/settings/integrations");
  await click("Sync now", `window.__e2e.byText('[data-testid="stripe-card"] button', "Sync now")`);
  const manual = await waitForSync("sync now");
  check("3. Sync now runs a sync", manual.lastSyncError === null);
  const cron = await fetch(`${APP}/api/cron/snapshots`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  const job = await cron.json();
  check("3. the daily job syncs connected workspaces", cron.status === 200 && job.stripe?.synced >= 1, JSON.stringify(job.stripe));

  // 4. Members ------------------------------------------------------------------------------------
  await setSession(await mintSession({ id: bob.id, name: "Bob", email: "bob@acme-demo.dev" }), orgId);
  await load("/dashboard/settings/integrations");
  check("4. a member is refused the page", (await evaluate("document.body.innerText")).includes("Only owners and admins manage integrations"));
  await setSession(session, orgId);

  // 5. Disconnect -----------------------------------------------------------------------------------
  await load("/dashboard/settings/integrations");
  await click("Disconnect Stripe", `window.__e2e.byText("button", "Disconnect Stripe")`);
  await click("Disconnect", `window.__e2e.dialog()?.querySelector('button[type="submit"]')`);
  await waitFor("disconnected", `!!document.getElementById("stripe-key")`, 30_000);
  check("5. the connection and its key are gone", (await one(`SELECT count(*)::int AS n FROM "StripeConnection" WHERE "organizationId" = $1`, [orgId])).n === 0);
  check("5. the synced data stays", (await one(`SELECT count(*)::int AS n FROM "Customer" WHERE "organizationId" = $1`, [orgId])).n === 4);
  check("5. audited", (await one(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "organizationId" = $1 AND action IN ('stripe.connected', 'stripe.disconnected', 'stripe.synced')`, [orgId])).n >= 4);
} catch (error) {
  fail(error);
} finally {
  try {
    await db.query(`DELETE FROM "Organization" WHERE id = $1`, [orgId]);
  } catch (cleanupError) {
    console.error("cleanup failed:", cleanupError);
  }
  browser.close();
  await closeDb();
}

finish();

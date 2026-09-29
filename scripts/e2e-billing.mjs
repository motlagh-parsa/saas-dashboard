// End-to-end check of hand-entered billing data, driven through headless Chrome
// over the DevTools protocol — Node 22 built-ins only (fetch, WebSocket), no
// test framework, the same approach as the drawer e2e from the mobile-nav work.
//
//   node scripts/e2e-billing.mjs            (dev server on http://localhost:3000)
//
// As the demo user (an OWNER), in the first seeded workspace, through the real UI:
//   1. create a customer;
//   2. add a subscription backdated 60 days, with its past invoices;
//   3. change its plan from 30 days ago;
//   4. cancel it today;
//   5. record an invoice and mark it paid;
// checking the customer page and the Overview's headline MRR after each step
// (and the stored snapshot the change rewrote), then deletes the customer so
// the run leaves the workspace as it found it.
//
// Then as Bob, a MEMBER of the same workspace: every billing page shows no write
// control, and calling a billing Server Action directly is refused on the
// server. Bob's session cookie is minted with NEXTAUTH_SECRET — the seeded
// teammates have no password to sign in with — which is exactly the token a
// signed-in Bob would carry.
//
// Exits non-zero if any check fails.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
process.loadEnvFile(".env");
const { Client } = require("pg");
const { encode } = require("next-auth/jwt");

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP = process.env.APP_URL ?? "http://localhost:3000";
const PORT = 9334;
const DAY_MS = 86_400_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(label, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

const todayMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
const dayString = (offset) => new Date(todayMs + offset * DAY_MS).toISOString().slice(0, 10);
function addMonthsUTC(ms, months) {
  const d = new Date(ms);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months + 1, 0)).getUTCDate();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, Math.min(d.getUTCDate(), lastDay));
}

// ---------------------------------------------------------------------------
// Database and sessions
// ---------------------------------------------------------------------------

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

const workspace = await one(
  `SELECT o.id, o.name, o.currency FROM "Organization" o
   JOIN "Membership" m ON m."organizationId" = o.id
   JOIN "User" u ON u.id = m."userId"
   WHERE u.email = $1 AND m.role = 'OWNER' AND o.slug = 'northwind-analytics'`,
  [process.env.DEMO_EMAIL],
);
const bob = await one(
  `SELECT u.id, u.name, u.email, m.role FROM "User" u
   JOIN "Membership" m ON m."userId" = u.id AND m."organizationId" = $1
   WHERE u.email = 'bob@acme-demo.dev'`,
  [workspace.id],
);
if (!workspace || !bob) throw new Error("run the seed first: the demo workspace or Bob is missing");

async function signInDemo() {
  const csrfResponse = await fetch(`${APP}/api/auth/csrf`);
  const { csrfToken } = await csrfResponse.json();
  const csrfCookie = csrfResponse.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const response = await fetch(`${APP}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: csrfCookie },
    body: new URLSearchParams({
      csrfToken,
      email: process.env.DEMO_EMAIL,
      password: process.env.DEMO_PASSWORD,
      callbackUrl: `${APP}/dashboard`,
      json: "true",
    }),
  });
  const session = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("next-auth.session-token="));
  if (!session) throw new Error("demo sign-in failed");
  return session.split(";")[0].slice("next-auth.session-token=".length);
}

async function mintSession(user) {
  return encode({
    token: { sub: user.id, id: user.id, name: user.name, email: user.email },
    secret: process.env.NEXTAUTH_SECRET,
  });
}

// ---------------------------------------------------------------------------
// Chrome over CDP
// ---------------------------------------------------------------------------

const profile = mkdtempSync(join(tmpdir(), "billing-e2e-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1440,1000",
  "about:blank",
]);

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await sleep(200);
  }
  throw new Error("chrome did not start");
}

const ws = new WebSocket(await connect());
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

/** In-page helpers, installed on every load. */
const HELPERS = `(() => {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  window.__e2e = {
    all(selector, root = document) { return [...root.querySelectorAll(selector)].filter(visible); },
    byText(selector, text, root = document) {
      return window.__e2e.all(selector, root).find((el) => el.textContent.replace(/\\s+/g, " ").trim().startsWith(text));
    },
    dialog() { return [...document.querySelectorAll('[role="dialog"]')].find(visible) ?? null; },
    set(el, value) {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    selectOption(select, prefix) {
      const option = [...select.options].find((o) => o.textContent.trim().startsWith(prefix));
      if (!option) throw new Error("no option starting " + prefix);
      window.__e2e.set(select, option.value);
      return option.value;
    },
    text(selector) { const el = document.querySelector(selector); return el ? el.textContent.replace(/\\s+/g, " ").trim() : null; },
  };
})()`;

async function evaluate(expression) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression: `${HELPERS}; (${expression})`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "evaluate failed");
  return result.value;
}

async function waitFor(label, expression, timeoutMs = 20_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await evaluate(expression);
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

async function load(path) {
  await send("Page.navigate", { url: `${APP}${path}` });
  await waitFor(`${path} to load`, `document.readyState === "complete" && location.pathname === ${JSON.stringify(path.split("?")[0])}`, 60_000);
  // Hydration: interactive islands attach listeners after the document loads.
  await sleep(1200);
}

/** A real mouse click at the element's centre — what Radix triggers listen for. */
async function click(label, elementExpression) {
  const box = await waitFor(
    label,
    `(() => { const el = ${elementExpression}; if (!el) return null; el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`,
  );
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  await sleep(250);
}

async function setCookies(sessionToken) {
  await send("Network.clearBrowserCookies");
  await send("Network.setCookie", { name: "next-auth.session-token", value: sessionToken, domain: "localhost", path: "/", httpOnly: true });
  await send("Network.setCookie", { name: "meridian_org", value: workspace.id, domain: "localhost", path: "/" });
}

/** Submits the open dialog and waits for it to close (success) — or reports its error. */
async function submitDialog(label) {
  await click(`${label}: submit`, `window.__e2e.dialog()?.querySelector('button[type="submit"]')`);
  await waitFor(
    `${label}: dialog to close`,
    `(() => { const d = window.__e2e.dialog(); if (!d) return true;
      const alert = d.querySelector('[role="alert"], .text-destructive'); if (alert && alert.textContent.trim()) throw new Error(alert.textContent.trim()); return false; })()`,
  );
}

const money = (text) => Number(String(text).replace(/[^0-9.-]/g, ""));

async function overviewMRR() {
  await load("/dashboard");
  const text = await waitFor("overview MRR", `window.__e2e.text('[data-testid="overview-mrr"] .sr-only')`);
  return money(text);
}

async function snapshotMRR(offsetDays) {
  const row = await one(`SELECT "mrrCents" FROM "MetricSnapshot" WHERE "organizationId" = $1 AND date = $2::date`, [
    workspace.id,
    dayString(offsetDays),
  ]);
  return row ? row.mrrCents : null;
}

/** after() recomputes snapshots once the response is sent; give it a moment. */
async function waitForSnapshot(offsetDays, expected) {
  for (let i = 0; i < 50; i++) {
    if ((await snapshotMRR(offsetDays)) === expected) return true;
    await sleep(200);
  }
  return false;
}

async function customerFigures() {
  return evaluate(`({
    mrr: window.__e2e.text('[data-testid="customer-mrr"]'),
    status: window.__e2e.text('[data-testid="customer-status"]'),
  })`);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const stamp = Date.now().toString(36);
const customerName = `E2E Hand Entry ${stamp}`;
let customerId = null;

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await setCookies(await signInDemo());
  console.log(`── as the demo OWNER, in ${workspace.name} (${workspace.currency}) ──`);

  const growth = await one(`SELECT "amountCents" FROM "Plan" WHERE "organizationId" = $1 AND name = 'Growth'`, [workspace.id]);
  const pro = await one(`SELECT "amountCents" FROM "Plan" WHERE "organizationId" = $1 AND name = 'Pro'`, [workspace.id]);
  const growthMajor = growth.amountCents / 100;
  const proMajor = pro.amountCents / 100;

  const mrr0 = await overviewMRR();
  const snapshot45Before = await snapshotMRR(-45);
  check("overview MRR read", mrr0 > 0, `$${mrr0}`);

  // 1. Create a customer ----------------------------------------------------------
  await load("/dashboard/customers");
  await click("Add customer", `window.__e2e.byText("header button", "Add customer")`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.set(d.querySelector('input[name="name"]'), ${JSON.stringify(customerName)});
    window.__e2e.set(d.querySelector('input[name="email"]'), "billing@e2e-${stamp}.example"); return true; })()`);
  await submitDialog("add customer");
  const created = await one(`SELECT id FROM "Customer" WHERE "organizationId" = $1 AND name = $2`, [workspace.id, customerName]);
  customerId = created?.id ?? null;
  check("1. customer created (source MANUAL)", customerId !== null);

  await load(`/dashboard/customers?q=${encodeURIComponent(stamp)}`);
  const href = await waitFor("customer link", `window.__e2e.byText("table a", ${JSON.stringify(customerName)})?.getAttribute("href")`);
  await load(href);
  let figures = await customerFigures();
  check("1. new customer page: $0.00, No subscription", figures.mrr === "$0.00" && figures.status === "No subscription", JSON.stringify(figures));

  // 2. Backdated subscription with past invoices ---------------------------------
  await click("Add subscription", `window.__e2e.byText("button", "Add subscription")`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.selectOption(d.querySelector('select[name="planId"]'), "Growth —");
    window.__e2e.set(d.querySelector('input[name="startDate"]'), ${JSON.stringify(dayString(-60))}); return true; })()`);
  await click("record past invoices", `window.__e2e.dialog()?.querySelector('input[name="recordPastInvoices"]')`);
  await submitDialog("add subscription");
  await waitFor("customer MRR after subscription", `window.__e2e.text('[data-testid="customer-mrr"]') === "$${growthMajor.toFixed(2)}"`);
  figures = await customerFigures();
  let expectedInvoices = 0;
  while (addMonthsUTC(todayMs - 60 * DAY_MS, expectedInvoices) <= todayMs) expectedInvoices += 1;
  const invoiceRows = await evaluate(`window.__e2e.all('main table tbody tr').filter((tr) => tr.textContent.includes("Paid")).length`);
  check(`2. backdated subscription: customer MRR $${growthMajor.toFixed(2)}, Active`, figures.status === "Active", JSON.stringify(figures));
  check(`2. past invoices recorded: ${expectedInvoices} paid`, invoiceRows === expectedInvoices, `rows ${invoiceRows}`);
  let mrr = await overviewMRR();
  check(`2. overview MRR +$${growthMajor}`, mrr === mrr0 + growthMajor, `$${mrr0} → $${mrr}`);
  check(
    "2. snapshot 45 days ago rewritten to include it",
    await waitForSnapshot(-45, snapshot45Before + growth.amountCents),
    `${snapshot45Before} → ${await snapshotMRR(-45)}`,
  );

  // 3. Plan change from 30 days ago ------------------------------------------------
  await load(href);
  await click("Change plan", `window.__e2e.byText("button", "Change plan")`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.selectOption(d.querySelector('select[name="planId"]'), "Pro —");
    window.__e2e.set(d.querySelector('input[name="effectiveDate"]'), ${JSON.stringify(dayString(-30))}); return true; })()`);
  await submitDialog("change plan");
  await waitFor("customer MRR after plan change", `window.__e2e.text('[data-testid="customer-mrr"]') === "$${proMajor.toFixed(2)}"`);
  const timeline = await evaluate(`window.__e2e.text('[data-subscription]')`);
  check("3. timeline shows the old terms ended by a plan change", /Plan change/.test(timeline ?? ""), timeline?.slice(0, 120));
  mrr = await overviewMRR();
  check(`3. overview MRR +$${proMajor} (was +$${growthMajor})`, mrr === mrr0 + proMajor, `$${mrr}`);

  // 4. Cancel today ------------------------------------------------------------------
  await load(href);
  await click("Cancel subscription", `window.__e2e.byText("button", "Cancel subscription")`);
  await submitDialog("cancel");
  await waitFor("customer MRR after cancel", `window.__e2e.text('[data-testid="customer-mrr"]') === "$0.00"`);
  figures = await customerFigures();
  check("4. canceled today: $0.00, Churned", figures.status === "Churned", JSON.stringify(figures));
  mrr = await overviewMRR();
  check("4. overview MRR back to where it started", mrr === mrr0, `$${mrr}`);

  // 5. Record an invoice and mark it paid ----------------------------------------------
  await load(href);
  const lifetimeBefore = money(await evaluate(`window.__e2e.byText("[data-slot='card']", "Lifetime revenue")?.textContent.match(/\\$[0-9,.]+/)?.[0]`));
  await click("Record invoice", `window.__e2e.byText("button", "Record invoice")`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.set(d.querySelector('input[name="amount"]'), "50.00"); return true; })()`);
  await submitDialog("record invoice");
  const openRow = `window.__e2e.all('main table tbody tr').find((tr) => tr.textContent.includes("$50.00"))`;
  await waitFor("the open invoice row", `(${openRow})?.textContent.includes("Open")`);
  check("5. invoice recorded as Open", true);
  await click("invoice actions", `(${openRow})?.querySelector('button[aria-label^="Actions for invoice"]')`);
  await click("Mark paid…", `window.__e2e.byText('[role="menuitem"]', "Mark paid")`);
  await submitDialog("mark paid");
  await waitFor("the invoice row to read Paid", `(${openRow})?.textContent.includes("Paid")`);
  const lifetimeAfter = money(await evaluate(`window.__e2e.byText("[data-slot='card']", "Lifetime revenue")?.textContent.match(/\\$[0-9,.]+/)?.[0]`));
  check("5. marked paid: lifetime revenue +$50.00", Math.abs(lifetimeAfter - lifetimeBefore - 50) < 0.001, `$${lifetimeBefore} → $${lifetimeAfter}`);
  // Audit entries are written in after(), once each response is on its way:
  // reload until the last one has landed.
  const steps = ["Added customer", "Added subscription", "Changed plan", "Canceled subscription", "Recorded invoice", "Marked invoice paid"];
  let activity = "";
  for (let attempt = 0; attempt < 10 && !steps.every((label) => activity.includes(label)); attempt++) {
    await load(href);
    activity = (await evaluate(`window.__e2e.text('[aria-labelledby="activity-heading"]')`)) ?? "";
  }
  const missing = steps.filter((label) => !activity.includes(label));
  check("5. activity lists every step", missing.length === 0, missing.length ? `missing: ${missing.join(", ")} | ${activity.slice(0, 200)}` : "");

  // Cleanup: delete the customer through the UI -----------------------------------------
  await click("Delete customer", `window.__e2e.byText("main > header button", "Delete")`);
  await evaluate(`(() => { window.__e2e.set(window.__e2e.dialog().querySelector('input[name="confirmName"]'), ${JSON.stringify(customerName)}); return true; })()`);
  await submitDialog("delete customer");
  await waitFor("redirect to the customer list", `location.pathname === "/dashboard/customers"`);
  const gone = await one(`SELECT count(*)::int AS n FROM "Customer" WHERE id = $1`, [customerId]);
  check("cleanup: customer and their history deleted", gone.n === 0);
  if (gone.n === 0) customerId = null;
  check("cleanup: snapshot 45 days ago back to its original value", await waitForSnapshot(-45, snapshot45Before));

  // ---------------------------------------------------------------------------------------
  console.log(`── as Bob, a ${bob.role} of ${workspace.name} ──`);
  await setCookies(await mintSession(bob));
  const sample = await one(`SELECT id FROM "Customer" WHERE "organizationId" = $1 AND "archivedAt" IS NULL ORDER BY name LIMIT 1`, [workspace.id]);
  const WRITE_CONTROLS = [
    "Add customer",
    "Add subscription",
    "Change plan",
    "Change quantity",
    "Cancel subscription",
    "Correct",
    "Record invoice",
    "Create plan",
    "Archive",
    "Unarchive",
    "Export",
    "Delete",
    "Edit",
  ];
  for (const path of ["/dashboard/customers", `/dashboard/customers/${sample.id}`, "/dashboard/plans", "/dashboard/invoices", "/dashboard/revenue"]) {
    await load(path);
    const found = await evaluate(`(() => {
      const labels = ${JSON.stringify(WRITE_CONTROLS)};
      const hits = window.__e2e.all("button, a").map((el) => el.textContent.replace(/\\s+/g, " ").trim()).filter((t) => labels.some((l) => t === l || t.startsWith(l + " ")));
      const extras = window.__e2e.all('input[type="checkbox"], button[aria-label^="Actions for invoice"]').length;
      return { hits, extras };
    })()`);
    check(`member sees no write controls on ${path.replace(sample.id, ":id")}`, found.hits.length === 0 && found.extras === 0, JSON.stringify(found));
  }

  // Call a billing action directly, bypassing the hidden UI.
  const chunkDir = ".next/dev/static/chunks";
  // Dev builds list each action's id beside its export name in the client chunks.
  const actionIdOf = (name) => {
    const pattern = new RegExp(`"([0-9a-f]{40,})":\\{"name":"${name}"\\}`);
    for (const file of readdirSync(chunkDir)) {
      if (!file.endsWith(".js")) continue;
      const match = readFileSync(join(chunkDir, file), "utf8").match(pattern);
      if (match) return match[1];
    }
    return null;
  };
  const actionId = actionIdOf("archiveCustomer");
  const exportId = actionIdOf("exportCustomersCSV");
  check("found the actions' ids in the dev build", actionId !== null && exportId !== null);
  await load("/dashboard/customers");
  const reply = await evaluate(`(async () => {
    // React's encodeReply format for (prevState, formData): the FormData's
    // fields as "_1_<name>", then the root "0" LAST — the server parses the
    // multipart body as a stream and resolves "$K1" when "0" arrives.
    const body = new FormData();
    body.set("_1_organizationId", ${JSON.stringify(workspace.id)});
    body.set("_1_customerId", ${JSON.stringify(sample.id)});
    body.set("0", JSON.stringify([{ status: "idle", message: null, fieldErrors: {} }, "$K1"]));
    const response = await fetch("/dashboard/customers", {
      method: "POST",
      headers: { Accept: "text/x-component", "Next-Action": ${JSON.stringify(actionId)} },
      body,
    });
    return { status: response.status, text: await response.text() };
  })()`);
  check(
    "member calling archiveCustomer directly is refused by the server",
    reply.text.includes("Only owners and admins can change billing data."),
    `HTTP ${reply.status}`,
  );
  // A plain-arguments action too: the export would hand a member every customer's email.
  const exportReply = await evaluate(`(async () => {
    const response = await fetch("/dashboard/customers", {
      method: "POST",
      headers: { Accept: "text/x-component", "Next-Action": ${JSON.stringify(exportId)} },
      body: JSON.stringify([${JSON.stringify(workspace.id)}, "", "", "", ""]),
    });
    return response.text();
  })()`);
  check(
    "member calling exportCustomersCSV directly gets a refusal, not the file",
    exportReply.includes("Only owners and admins can change billing data.") && !exportReply.includes("External ID"),
  );
  const stillActive = await one(`SELECT "archivedAt" FROM "Customer" WHERE id = $1`, [sample.id]);
  check("… and the customer was not archived", stillActive.archivedAt === null);
} catch (error) {
  console.log("ERROR", error.message);
  results.push(false);
} finally {
  if (customerId !== null) {
    // A failed run must not leave its customer behind.
    await db.query(`DELETE FROM "Customer" WHERE id = $1 AND "organizationId" = $2`, [customerId, workspace.id]);
    // Deleted outside the app, so the snapshots it moved must be rewritten here.
    spawnSync("npm", ["run", "snapshots:recompute", "--", workspace.id, dayString(-120)], { stdio: "ignore", shell: true });
    console.log("cleanup: removed the e2e customer directly and recomputed snapshots (the UI delete did not run)");
  }
  ws.close();
  chrome.kill();
  await db.end();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

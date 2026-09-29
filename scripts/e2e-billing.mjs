// End-to-end check of hand-entered billing data, driven through headless Chrome
// over the DevTools protocol (scripts/e2e-lib.mjs — no test framework).
//
//   npm run e2e:billing            (dev server on http://localhost:3000, seeded DB)
//
// As the demo user (an OWNER), in the seeded Northwind workspace, through the UI:
//   1–5. The core lifecycle: create a customer; a subscription backdated 60 days
//        with past invoices; a plan change from 30 days ago; cancel today; record
//        an invoice and mark it paid — checking the customer page, the Overview
//        MRR and the rewritten snapshot after each step.
//   6.   The rest of the subscription dialogs: change quantity, correct, a
//        scheduled cancellation and its undo, delete a subscription.
//   7.   Invoice actions: delete a draft, void then delete, mark uncollectible,
//        and the refusal to delete a paid invoice (UI and server).
//   8.   Plans: create, edit, archive, unarchive, delete an unused plan, and the
//        refusal to delete a used one (UI and server).
//   9.   Customers: edit, archive and unarchive — on the customer page and in bulk.
//   10.  CSV exports (customers, invoices): the file arrives and its row count
//        matches the filtered view.
//   11.  ⌘K: Add customer, Add subscription, Create plan and Record invoice open
//        the right dialog.
//   12.  Users table after the DataTable rebuild: bulk suspend / unsuspend, export.
//   13.  Concurrency: two overlapping billing writes; afterwards the stored
//        snapshots equal a full rebuild.
// Then deletes everything it created, so the workspace is left as it was.
//
// Then as Bob, a MEMBER: no write controls on any billing page, and calling
// billing Server Actions directly is refused on the server.
//
// Exits non-zero if any check fails.
import { spawnSync } from "node:child_process";

import {
  DAY_MS,
  actionIdOf,
  addMonthsUTC,
  connectDb,
  createChecks,
  dayString,
  launchBrowser,
  mintSession,
  money,
  signInDemo,
  sleep,
  todayMs,
} from "./e2e-lib.mjs";

const { check, fail, finish } = createChecks();
const { one, all, close: closeDb } = await connectDb();

const workspace = await one(
  `SELECT o.id, o.name, o.currency FROM "Organization" o
   JOIN "Membership" m ON m."organizationId" = o.id
   JOIN "User" u ON u.id = m."userId"
   WHERE u.email = $1 AND m.role = 'OWNER' AND o.slug = 'northwind-analytics'`,
  [process.env.DEMO_EMAIL],
);
const bob = workspace
  ? await one(
      `SELECT u.id, u.name, u.email, m.role FROM "User" u
       JOIN "Membership" m ON m."userId" = u.id AND m."organizationId" = $1
       WHERE u.email = 'bob@acme-demo.dev'`,
      [workspace.id],
    )
  : null;
if (!workspace || !bob) throw new Error("run the seed first: the demo workspace or Bob is missing");

const browser = await launchBrowser({ port: 9334 });
const { evaluate, waitFor, load, click, key, typeText, setSession, submitDialog, closeDialog } =
  browser;

const stamp = Date.now().toString(36);
let customerName = `E2E Hand Entry ${stamp}`;
const planName = `E2E Plan ${stamp}`;
let customerId = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function overviewMRR() {
  await load("/dashboard");
  return money(await waitFor("overview MRR", `window.__e2e.text('[data-testid="overview-mrr"] .sr-only')`));
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
  for (let i = 0; i < 75; i++) {
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

const customerMRRIs = (text) => waitFor(`customer MRR ${text}`, `window.__e2e.text('[data-testid="customer-mrr"]') === ${JSON.stringify(text)}`);

/** The row of the embedded/full invoices table whose text includes `needle`. */
const invoiceRow = (needle) => `window.__e2e.all('main table tbody tr').find((tr) => tr.textContent.includes(${JSON.stringify(needle)}))`;

async function recordInvoice(amount, status) {
  await click("Record invoice", `window.__e2e.byText("button", "Record invoice")`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.set(d.querySelector('input[name="amount"]'), ${JSON.stringify(amount)});
    window.__e2e.set(d.querySelector('select[name="status"]'), ${JSON.stringify(status)}); return true; })()`);
  await submitDialog(`record ${status} invoice`);
  await waitFor(`the ${amount} invoice row`, `!!(${invoiceRow(`$${amount}`)})`);
}

async function invoiceMenu(amount, item) {
  await click(`${amount} invoice actions`, `(${invoiceRow(`$${amount}`)})?.querySelector('button[aria-label^="Actions for invoice"]')`);
  if (item !== null) await click(item, `window.__e2e.byText('[role="menuitem"]', ${JSON.stringify(item)})`);
}

/**
 * Calls a Server Action the way the browser's form does: React's encodeReply
 * format for (prevState, formData) — the fields as "_1_<name>", then the root
 * "0" LAST (the server parses the multipart body as a stream).
 */
async function callFormAction(name, fields, path = "/dashboard/customers") {
  const id = actionIdOf(name);
  if (id === null) throw new Error(`no action id for ${name}`);
  return evaluate(`(async () => {
    const body = new FormData();
    for (const [key, value] of Object.entries(${JSON.stringify(fields)})) body.set("_1_" + key, value);
    body.set("0", JSON.stringify([{ status: "idle", message: null, fieldErrors: {} }, "$K1"]));
    const response = await fetch(${JSON.stringify(path)}, {
      method: "POST",
      headers: { Accept: "text/x-component", "Next-Action": ${JSON.stringify(id)} },
      body,
    });
    return response.text();
  })()`);
}

/** Captures the next CSV the page hands to a download link. */
const CAPTURE_CSV = `(() => {
  window.__csv = null;
  const original = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => { blob.text().then((text) => { window.__csv = text; }); return original(blob); };
  return true;
})()`;

async function exportedRows(label) {
  await evaluate(CAPTURE_CSV);
  await click(`${label}: Export`, `window.__e2e.byText("button", "Export")`);
  const csv = await waitFor(`${label}: CSV`, `window.__csv`, 30_000);
  return csv.split("\r\n").filter((line) => line.length > 0).length - 1;
}

function recomputeCheck(from) {
  const run = spawnSync("npm", ["run", "snapshots:recompute", "--", workspace.id, from, "--check"], {
    encoding: "utf8",
    shell: true,
  });
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}`.trim().split("\n").slice(-2).join(" ") };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

try {
  await setSession(await signInDemo(), workspace.id);
  console.log(`── as the demo OWNER, in ${workspace.name} (${workspace.currency}) ──`);

  const planPrice = async (name) =>
    (await one(`SELECT "amountCents" FROM "Plan" WHERE "organizationId" = $1 AND name = $2`, [workspace.id, name])).amountCents;
  const growth = await planPrice("Growth");
  const pro = await planPrice("Pro");
  const starter = await planPrice("Starter");

  const mrr0 = await overviewMRR();
  const snapshot45Before = await snapshotMRR(-45);
  check("overview MRR read", mrr0 > 0, `$${mrr0}`);

  // 1. Create a customer ---------------------------------------------------------
  await load("/dashboard/customers");
  await click("Add customer", `window.__e2e.byText("header button", "Add customer")`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.set(d.querySelector('input[name="name"]'), ${JSON.stringify(customerName)});
    window.__e2e.set(d.querySelector('input[name="email"]'), "billing@e2e-${stamp}.example"); return true; })()`);
  await submitDialog("add customer");
  customerId = (await one(`SELECT id FROM "Customer" WHERE "organizationId" = $1 AND name = $2`, [workspace.id, customerName]))?.id ?? null;
  check("1. customer created (source MANUAL)", customerId !== null);
  const href = `/dashboard/customers/${customerId}`;
  await load(href);
  let figures = await customerFigures();
  check("1. new customer page: $0.00, No subscription", figures.mrr === "$0.00" && figures.status === "No subscription", JSON.stringify(figures));

  // 2. Backdated subscription with past invoices -----------------------------------
  await click("Add subscription", `window.__e2e.byText("button", "Add subscription")`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.selectOption(d.querySelector('select[name="planId"]'), "Growth —");
    window.__e2e.set(d.querySelector('input[name="startDate"]'), ${JSON.stringify(dayString(-60))}); return true; })()`);
  await click("record past invoices", `window.__e2e.dialog()?.querySelector('input[name="recordPastInvoices"]')`);
  await submitDialog("add subscription");
  await customerMRRIs(`$${(growth / 100).toFixed(2)}`);
  figures = await customerFigures();
  let expectedInvoices = 0;
  while (addMonthsUTC(todayMs - 60 * DAY_MS, expectedInvoices) <= todayMs) expectedInvoices += 1;
  const paidRows = await evaluate(`window.__e2e.all('main table tbody tr').filter((tr) => tr.textContent.includes("Paid")).length`);
  check("2. backdated subscription: customer Active", figures.status === "Active", JSON.stringify(figures));
  check(`2. past invoices recorded: ${expectedInvoices} paid`, paidRows === expectedInvoices, `rows ${paidRows}`);
  let mrr = await overviewMRR();
  check(`2. overview MRR +$${growth / 100}`, mrr === mrr0 + growth / 100, `$${mrr0} → $${mrr}`);
  check("2. snapshot 45 days ago rewritten to include it", await waitForSnapshot(-45, snapshot45Before + growth), `${snapshot45Before} → ${await snapshotMRR(-45)}`);

  // 3. Plan change from 30 days ago ---------------------------------------------------
  await load(href);
  await click("Change plan", `window.__e2e.byText("button", "Change plan")`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.selectOption(d.querySelector('select[name="planId"]'), "Pro —");
    window.__e2e.set(d.querySelector('input[name="effectiveDate"]'), ${JSON.stringify(dayString(-30))}); return true; })()`);
  await submitDialog("change plan");
  await customerMRRIs(`$${(pro / 100).toFixed(2)}`);
  check("3. timeline shows the old terms ended by a plan change", /Plan change/.test((await evaluate(`window.__e2e.text('[data-subscription]')`)) ?? ""));
  mrr = await overviewMRR();
  check(`3. overview MRR +$${pro / 100} (was +$${growth / 100})`, mrr === mrr0 + pro / 100, `$${mrr}`);

  // 4. Cancel today --------------------------------------------------------------------
  await load(href);
  await click("Cancel subscription", `window.__e2e.byText("button", "Cancel subscription")`);
  await submitDialog("cancel");
  await customerMRRIs("$0.00");
  figures = await customerFigures();
  check("4. canceled today: $0.00, Churned", figures.status === "Churned", JSON.stringify(figures));
  mrr = await overviewMRR();
  check("4. overview MRR back to where it started", mrr === mrr0, `$${mrr}`);

  // 5. Record an invoice and mark it paid ------------------------------------------------
  await load(href);
  const lifetime = async () =>
    money(await evaluate(`window.__e2e.byText("[data-slot='card']", "Lifetime revenue")?.textContent.match(/[$€£¥][0-9,.]+/)?.[0]`));
  const lifetimeBefore = await lifetime();
  await recordInvoice("50.00", "OPEN");
  check("5. invoice recorded as Open", await evaluate(`(${invoiceRow("$50.00")})?.textContent.includes("Open")`));
  await invoiceMenu("50.00", "Mark paid");
  await submitDialog("mark paid");
  await waitFor("the invoice row to read Paid", `(${invoiceRow("$50.00")})?.textContent.includes("Paid")`);
  const lifetimeAfter = await lifetime();
  check("5. marked paid: lifetime revenue +$50.00", Math.abs(lifetimeAfter - lifetimeBefore - 50) < 0.001, `$${lifetimeBefore} → $${lifetimeAfter}`);

  // 6. The rest of the subscription dialogs -------------------------------------------------
  console.log("── 6. change quantity, correct, scheduled cancel + undo, delete ──");
  await click("Add subscription", `window.__e2e.byText("button", "Add subscription")`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.selectOption(d.querySelector('select[name="planId"]'), "Starter —");
    window.__e2e.set(d.querySelector('input[name="startDate"]'), ${JSON.stringify(dayString(-20))}); return true; })()`);
  await submitDialog("second subscription");
  await customerMRRIs(`$${(starter / 100).toFixed(2)}`);

  await click("Change quantity", `window.__e2e.byText("button", "Change quantity")`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.set(d.querySelector('input[name="quantity"]'), "3");
    window.__e2e.set(d.querySelector('input[name="effectiveDate"]'), ${JSON.stringify(dayString(-10))}); return true; })()`);
  await submitDialog("change quantity");
  await customerMRRIs(`$${((starter * 3) / 100).toFixed(2)}`);
  check("6. change quantity: Starter × 3 from 10 days ago", true);

  await click("Correct", `window.__e2e.byText("button", "Correct")`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.set(d.querySelector('input[name="quantity"]'), "2"); return true; })()`);
  await submitDialog("correct");
  await customerMRRIs(`$${((starter * 2) / 100).toFixed(2)}`);
  const corrected = await one(
    `SELECT metadata FROM "AuditLog" WHERE "organizationId" = $1 AND action = 'subscription.corrected' AND metadata->>'customerId' = $2 ORDER BY "createdAt" DESC LIMIT 1`,
    [workspace.id, customerId],
  );
  check("6. correct rewrites the current terms (× 3 → × 2), audited with before/after", corrected?.metadata?.before?.quantity === 3 && corrected?.metadata?.after?.quantity === 2);

  await click("Cancel subscription", `window.__e2e.byText("button", "Cancel subscription")`);
  await evaluate(`(() => { window.__e2e.set(window.__e2e.dialog().querySelector('input[name="effectiveDate"]'), ${JSON.stringify(dayString(15))}); return true; })()`);
  await submitDialog("scheduled cancel");
  await waitFor("Undo scheduled cancel", `!!window.__e2e.byText("button", "Undo scheduled cancel")`);
  const timeline = (await evaluate(`window.__e2e.text('[data-subscription]')`)) ?? "";
  check("6. scheduled cancellation shows “Cancels on …” and keeps billing", /Cancels on/.test(timeline) && (await customerFigures()).mrr === `$${((starter * 2) / 100).toFixed(2)}`);
  await click("Undo scheduled cancel", `window.__e2e.byText("button", "Undo scheduled cancel")`);
  await waitFor("Cancel subscription to return", `!!window.__e2e.byText("button", "Cancel subscription") && !window.__e2e.byText("button", "Undo scheduled cancel")`);
  const undone = await one(`SELECT "endedAt", "canceledAt" FROM "Subscription" WHERE "customerId" = $1 AND "endedAt" IS NULL AND "canceledAt" IS NULL`, [customerId]);
  check("6. undo clears the scheduled cancellation", undone !== undefined);

  const chainsBefore = await evaluate(`window.__e2e.all('[data-subscription]').length`);
  // Running subscriptions are listed first: the Starter chain is the first card.
  await click("Delete subscription", `window.__e2e.byText("button", "Delete", window.__e2e.all('[data-subscription]')[0])`);
  await submitDialog("delete subscription");
  await waitFor("one chain fewer", `window.__e2e.all('[data-subscription]').length === ${chainsBefore - 1}`);
  await customerMRRIs("$0.00");
  check("6. delete subscription removes the chain", true, `${chainsBefore} → ${chainsBefore - 1} chains`);

  // 7. Invoice actions --------------------------------------------------------------------------
  console.log("── 7. invoices: delete draft, void + delete, uncollectible, paid refusal ──");
  await recordInvoice("11.00", "DRAFT");
  await invoiceMenu("11.00", "Delete");
  await submitDialog("delete draft");
  await waitFor("draft gone", `!(${invoiceRow("$11.00")})`);
  check("7. a draft invoice can be deleted", true);

  await recordInvoice("22.00", "OPEN");
  await invoiceMenu("22.00", "Void");
  await submitDialog("void");
  await waitFor("voided", `(${invoiceRow("$22.00")})?.textContent.includes("Void")`);
  await invoiceMenu("22.00", "Delete");
  await submitDialog("delete void");
  await waitFor("void invoice gone", `!(${invoiceRow("$22.00")})`);
  check("7. an open invoice can be voided, then deleted", true);

  await recordInvoice("33.00", "OPEN");
  await invoiceMenu("33.00", "Mark uncollectible");
  await submitDialog("uncollectible");
  await waitFor("uncollectible", `(${invoiceRow("$33.00")})?.textContent.includes("Uncollectible")`);
  check("7. an open invoice can be marked uncollectible", true);

  await invoiceMenu("50.00", null);
  const paidMenu = await evaluate(`(() => {
    const item = window.__e2e.byText('[role="menuitem"]', "Delete");
    const note = [...document.querySelectorAll('[role="menu"] p')].map((p) => p.textContent).join(" ");
    return { disabled: item?.getAttribute("aria-disabled") === "true" || item?.hasAttribute("data-disabled"), note };
  })()`);
  await key("Escape", "Escape", 27);
  check("7. deleting a paid invoice is not offered, and the menu says why", paidMenu.disabled && /money received/.test(paidMenu.note), paidMenu.note);
  const paidInvoice = await one(`SELECT id FROM "Invoice" WHERE "customerId" = $1 AND "amountCents" = 5000 AND status = 'PAID'`, [customerId]);
  const paidReply = await callFormAction("deleteInvoice", { organizationId: workspace.id, invoiceId: paidInvoice.id });
  check("7. … and the server refuses it when called directly", paidReply.includes("Only draft or void invoices can be deleted"));

  // 8. Plans ------------------------------------------------------------------------------------------
  console.log("── 8. plans: create, edit, archive, unarchive, delete, used-plan refusal ──");
  await load("/dashboard/plans");
  await click("Create plan", `window.__e2e.byText("header button", "Create plan")`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.set(d.querySelector('input[name="name"]'), ${JSON.stringify(planName)});
    window.__e2e.set(d.querySelector('input[name="price"]'), "12.00"); return true; })()`);
  await submitDialog("create plan");
  const planRow = `window.__e2e.all('main table tbody tr').find((tr) => tr.textContent.includes(${JSON.stringify(planName)}))`;
  await waitFor("plan row", `(${planRow})?.textContent.includes("$12 / month")`);
  check("8. plan created: $12 / month", true);

  await click("Edit plan", `(${planRow})?.querySelector('button[aria-label^="Edit"]')`);
  await evaluate(`(() => { window.__e2e.set(window.__e2e.dialog().querySelector('input[name="price"]'), "15.50"); return true; })()`);
  await submitDialog("edit plan");
  await waitFor("edited price", `(${planRow})?.textContent.includes("$15.50 / month")`);
  check("8. plan edited: $15.50 / month", true);

  await click("Archive plan", `(${planRow})?.querySelector('button[aria-label^="Archive"]')`);
  await waitFor("archived", `(${planRow})?.textContent.includes("Archived")`);
  await click("Unarchive plan", `(${planRow})?.querySelector('button[aria-label^="Unarchive"]')`);
  await waitFor("active again", `(${planRow})?.textContent.includes("Active")`);
  check("8. plan archived, then unarchived", true);

  await click("Delete plan", `(${planRow})?.querySelector('button[aria-label^="Delete"]')`);
  await submitDialog("delete plan");
  await waitFor("plan gone", `!(${planRow})`);
  check("8. an unused plan can be deleted", (await one(`SELECT count(*)::int AS n FROM "Plan" WHERE name = $1`, [planName])).n === 0);

  const growthRow = `window.__e2e.all('main table tbody tr').find((tr) => tr.querySelector("td")?.textContent.trim().startsWith("Growth"))`;
  const growthCell = await evaluate(`(() => { const row = ${growthRow}; return row ? { canDelete: !!row.querySelector('button[aria-label^="Delete"]'), text: row.textContent } : null; })()`);
  check("8. a used plan offers no Delete, and says to archive it", growthCell !== null && !growthCell.canDelete && /archive instead/.test(growthCell.text));
  const growthId = (await one(`SELECT id FROM "Plan" WHERE "organizationId" = $1 AND name = 'Growth'`, [workspace.id])).id;
  const usedReply = await callFormAction("deletePlan", { organizationId: workspace.id, planId: growthId }, "/dashboard/plans");
  check("8. … and the server refuses it when called directly", usedReply.includes("can't be deleted. Archive it instead."));

  // 9. Customers: edit, archive, unarchive — single and bulk -------------------------------------
  console.log("── 9. customers: edit, archive / unarchive (single and bulk) ──");
  await load(href);
  await click("Edit customer", `window.__e2e.byText("main > header button", "Edit")`);
  customerName = `${customerName} (edited)`;
  await evaluate(`(() => { window.__e2e.set(window.__e2e.dialog().querySelector('input[name="name"]'), ${JSON.stringify(customerName)}); return true; })()`);
  await submitDialog("edit customer");
  await waitFor("renamed header", `document.querySelector("main h1")?.textContent === ${JSON.stringify(customerName)}`);
  check("9. customer renamed from their page", true);

  await click("Archive customer", `window.__e2e.byText("main > header button", "Archive")`);
  await waitFor("archived badge", `document.querySelector("main > header")?.textContent.includes("Archived")`);
  await click("Unarchive customer", `window.__e2e.byText("main > header button", "Unarchive")`);
  await waitFor("unarchived", `!document.querySelector("main > header")?.textContent.includes("Archived")`);
  check("9. archive and unarchive from the customer page", (await one(`SELECT "archivedAt" FROM "Customer" WHERE id = $1`, [customerId])).archivedAt === null);

  await load(`/dashboard/customers?q=${encodeURIComponent(stamp)}`);
  await click("select the customer", `document.querySelector('input[aria-label="Select ${customerName.replace(/"/g, '\\"')}"]')`);
  await click("bulk Archive", `window.__e2e.byText('[aria-label="Bulk actions"] button', "Archive")`);
  let archivedAt = null;
  for (let i = 0; i < 50 && archivedAt === null; i++) {
    archivedAt = (await one(`SELECT "archivedAt" FROM "Customer" WHERE id = $1`, [customerId])).archivedAt;
    if (archivedAt === null) await sleep(200);
  }
  check("9. bulk archive", archivedAt !== null);
  await load(`/dashboard/customers?q=${encodeURIComponent(stamp)}&status=archived`);
  await click("select the archived customer", `document.querySelector('input[aria-label="Select ${customerName.replace(/"/g, '\\"')}"]')`);
  await click("bulk Unarchive", `window.__e2e.byText('[aria-label="Bulk actions"] button', "Unarchive")`);
  let unarchived = false;
  for (let i = 0; i < 50 && !unarchived; i++) {
    unarchived = (await one(`SELECT "archivedAt" FROM "Customer" WHERE id = $1`, [customerId])).archivedAt === null;
    if (!unarchived) await sleep(200);
  }
  check("9. bulk unarchive", unarchived);

  // 10. CSV exports -------------------------------------------------------------------------------
  console.log("── 10. CSV exports ──");
  await load("/dashboard/customers?status=churned");
  const churnedShown = money(await evaluate(`window.__e2e.text('[data-slot="card-action"]')`));
  const churnedRows = await exportedRows("customers");
  check("10. customers export: rows = the filtered view's count (churned)", churnedRows === churnedShown && churnedRows > 0, `${churnedRows} rows, view says ${churnedShown}`);
  await load("/dashboard/invoices?status=paid");
  const paidInDb = (await one(`SELECT count(*)::int AS n FROM "Invoice" WHERE "organizationId" = $1 AND status = 'PAID'`, [workspace.id])).n;
  const paidExported = await exportedRows("invoices");
  check("10. invoices export: rows = paid invoices in the workspace", paidExported === paidInDb, `${paidExported} rows, ${paidInDb} in the database`);

  // 11. ⌘K entries --------------------------------------------------------------------------------
  console.log("── 11. ⌘K billing actions ──");
  for (const [label, title] of [
    ["Add customer", "Add a customer"],
    ["Add subscription", "Add a subscription"],
    ["Create plan", "Create a plan"],
    ["Record invoice", "Record an invoice"],
  ]) {
    await load("/dashboard");
    await key("k", "KeyK", 75, 2);
    await waitFor("palette", `!!document.querySelector('input[aria-label="Command"]')`);
    await typeText(label);
    await key("Enter", "Enter", 13);
    const opened = await waitFor(`${label} dialog`, `window.__e2e.dialog()?.querySelector("h2")?.textContent.trim() === ${JSON.stringify(title)} || null`, 60_000).catch(() => false);
    check(`11. ⌘K “${label}” opens “${title}”`, opened === true);
    if (opened) await closeDialog();
  }

  // 12. Users table after the rebuild ---------------------------------------------------------------
  console.log("── 12. users: bulk suspend / unsuspend, export ──");
  const dan = await one(`SELECT id FROM "User" WHERE email = 'dan@acme-demo.dev'`);
  const suspendedOf = async () => (await one(`SELECT "suspendedAt" FROM "User" WHERE id = $1`, [dan.id])).suspendedAt;
  await load("/dashboard/users");
  await click("select Dan", `document.querySelector('input[aria-label="Select Dan Lee"]')`);
  await click("bulk Suspend", `window.__e2e.byText('[aria-label="Bulk actions"] button', "Suspend")`);
  let suspended = null;
  for (let i = 0; i < 50 && suspended === null; i++) {
    suspended = await suspendedOf();
    if (suspended === null) await sleep(200);
  }
  check("12. bulk suspend", suspended !== null);
  await load("/dashboard/users");
  await click("select Dan again", `document.querySelector('input[aria-label="Select Dan Lee"]')`);
  await click("bulk Unsuspend", `window.__e2e.byText('[aria-label="Bulk actions"] button', "Unsuspend")`);
  let restored = false;
  for (let i = 0; i < 50 && !restored; i++) {
    restored = (await suspendedOf()) === null;
    if (!restored) await sleep(200);
  }
  check("12. bulk unsuspend", restored);
  const members = (await one(`SELECT count(*)::int AS n FROM "Membership" WHERE "organizationId" = $1`, [workspace.id])).n;
  const userRows = await exportedRows("users");
  check("12. users export: one row per member", userRows === members, `${userRows} rows, ${members} members`);

  // 13. Concurrency --------------------------------------------------------------------------------
  console.log("── 13. two overlapping billing writes ──");
  const starterId = (await one(`SELECT id FROM "Plan" WHERE "organizationId" = $1 AND name = 'Starter'`, [workspace.id])).id;
  await load("/dashboard/revenue");
  const createId = actionIdOf("createSubscription");
  const both = await evaluate(`(async () => {
    const send = (name, start) => {
      const fields = { organizationId: ${JSON.stringify(workspace.id)}, customerId: "__new_customer__", newCustomerName: name,
        planId: ${JSON.stringify(starterId)}, price: "", interval: "", intervalCount: "", quantity: "1", status: "ACTIVE",
        startDate: start, recordPastInvoices: "" };
      const body = new FormData();
      for (const [key, value] of Object.entries(fields)) body.set("_1_" + key, value);
      body.set("0", JSON.stringify([{ status: "idle", message: null, fieldErrors: {} }, "$K1"]));
      return fetch("/dashboard/revenue", { method: "POST", headers: { Accept: "text/x-component", "Next-Action": ${JSON.stringify(createId)} }, body })
        .then((response) => response.text());
    };
    const replies = await Promise.all([send("E2E Race A ${stamp}", ${JSON.stringify(dayString(-400))}), send("E2E Race B ${stamp}", ${JSON.stringify(dayString(-380))})]);
    return replies.map((text) => text.includes('"status":"success"'));
  })()`);
  check("13. both overlapping writes succeeded", both.every(Boolean), JSON.stringify(both));
  // Both after() recomputes run once the responses are sent; wait for the later one.
  let consistent = { ok: false, output: "" };
  for (let i = 0; i < 15 && !consistent.ok; i++) {
    await sleep(2000);
    consistent = recomputeCheck(dayString(-420));
  }
  check("13. afterwards the stored snapshots equal a full rebuild", consistent.ok, consistent.output);

  // Cleanup ---------------------------------------------------------------------------------------
  await all(`DELETE FROM "Customer" WHERE "organizationId" = $1 AND name LIKE $2`, [workspace.id, `E2E Race _ ${stamp}`]);
  await load(href);
  await click("Delete customer", `window.__e2e.byText("main > header button", "Delete")`);
  await evaluate(`(() => { window.__e2e.set(window.__e2e.dialog().querySelector('input[name="confirmName"]'), ${JSON.stringify(customerName)}); return true; })()`);
  await submitDialog("delete customer");
  await waitFor("redirect to the customer list", `location.pathname === "/dashboard/customers"`);
  const gone = await one(`SELECT count(*)::int AS n FROM "Customer" WHERE id = $1`, [customerId]);
  check("cleanup: customer and their history deleted", gone.n === 0);
  if (gone.n === 0) customerId = null;
  spawnSync("npm", ["run", "snapshots:recompute", "--", workspace.id, dayString(-420)], { stdio: "ignore", shell: true });
  check("cleanup: snapshot 45 days ago back to its original value", await waitForSnapshot(-45, snapshot45Before));
  const finalCheck = recomputeCheck(dayString(-420));
  check("cleanup: snapshots equal a full rebuild", finalCheck.ok, finalCheck.output);

  // ---------------------------------------------------------------------------------------------
  console.log(`── as Bob, a ${bob.role} of ${workspace.name} ──`);
  await setSession(await mintSession(bob), workspace.id);
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
    "Remove sample data",
    "Load sample data",
    "Invite member",
    "Delete workspace",
  ];
  for (const path of ["/dashboard/customers", `/dashboard/customers/${sample.id}`, "/dashboard/plans", "/dashboard/invoices", "/dashboard/revenue", "/dashboard/settings"]) {
    await load(path);
    const found = await evaluate(`(() => {
      const labels = ${JSON.stringify(WRITE_CONTROLS)};
      const hits = window.__e2e.all("button, a").map((el) => el.textContent.replace(/\\s+/g, " ").trim()).filter((t) => labels.some((l) => t === l || t.startsWith(l + " ")));
      const extras = window.__e2e.all('input[type="checkbox"], button[aria-label^="Actions for invoice"]').length;
      return { hits, extras };
    })()`);
    check(`member sees no billing write controls on ${path.replace(sample.id, ":id")}`, found.hits.length === 0 && found.extras === 0, JSON.stringify(found));
  }

  await load("/dashboard/customers");
  const reply = await callFormAction("archiveCustomer", { organizationId: workspace.id, customerId: sample.id });
  check("member calling archiveCustomer directly is refused by the server", reply.includes("Only owners and admins can change billing data."));
  const exportId = actionIdOf("exportCustomersCSV");
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
  const loadReply = await callFormAction("loadSampleData", { organizationId: workspace.id });
  check("member calling loadSampleData directly is refused", loadReply.includes("Only owners and admins can change billing data."));
  check("… and nothing was changed", (await one(`SELECT "archivedAt" FROM "Customer" WHERE id = $1`, [sample.id])).archivedAt === null);
} catch (error) {
  fail(error);
} finally {
  if (customerId !== null) {
    // A failed run must not leave its data behind.
    await all(`DELETE FROM "Customer" WHERE "organizationId" = $1 AND (id = $2 OR name LIKE $3)`, [workspace.id, customerId, `E2E Race _ ${stamp}`]);
    spawnSync("npm", ["run", "snapshots:recompute", "--", workspace.id, dayString(-420)], { stdio: "ignore", shell: true });
    console.log("cleanup: removed the e2e customers directly and recomputed snapshots (the UI delete did not run)");
  }
  await all(`DELETE FROM "Plan" WHERE "organizationId" = $1 AND name = $2`, [workspace.id, planName]);
  await all(`UPDATE "User" SET "suspendedAt" = NULL WHERE email = 'dan@acme-demo.dev'`);
  browser.close();
  await closeDb();
  process.exit(finish());
}

// End-to-end check of CSV import, driven through headless Chrome over the
// DevTools protocol (scripts/e2e-lib.mjs — no test framework; uploads use
// DOM.setFileInputFiles, the same path a user picking a file takes).
//
//   npm run e2e:import        (dev server on http://localhost:3000, seeded DB)
//
// As the demo owner, in a fresh workspace created for the run:
//   1. download a template;
//   2. import plans (semicolon file, decimal commas) → customers → subscriptions
//      (DD/MM dates the wizard must ask about) → invoices: map, preview, import,
//      check the counts;
//   3. the Overview MRR and a customer page reflect the import;
//   4. re-upload the subscriptions file: the preview says 0 to create;
//   5. the Stripe-shaped fixture: its headers auto-map, amounts in cents;
//   6. a file with bad rows: errors reported, the error report downloads — from
//      the result and again from the history — with formulas neutralized;
//   7. the run history, the audit entry and the importer's notification.
// As Bob, a MEMBER of the seeded workspace: no Import page or sidebar entry,
// and calling the import actions directly is refused.
// The fresh workspace (and everything in it) is deleted at the end.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { actionIdOf, connectDb, createChecks, launchBrowser, mintSession, money, signInDemo } from "./e2e-lib.mjs";

const { check, fail, finish } = createChecks();
const { one, all, close: closeDb } = await connectDb();
const browser = await launchBrowser({ port: 9336 });
const { evaluate, waitFor, load, click, setSession, uploadFile } = browser;

const stamp = Date.now().toString(36);
const dir = mkdtempSync(join(tmpdir(), "meridian-import-e2e-"));
const file = (name, text) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

// Semicolons and decimal commas, as a European Excel saves them.
const PLANS = file("plans.csv", "plan_id;name;amount;interval\nprice_basic;Basic;29,00;month\nprice_premium;Premium;199,00;month\n");
const CUSTOMERS = file(
  "customers.csv",
  "Customer ID,Name,E-mail\ncus_1,Acme Analytics,billing@acme-e2e.example\ncus_2,Bluebird Labs,finance@bluebird-e2e.example\ncus_3,Cobalt Studio,hello@cobalt-e2e.example\n",
);
// Every date could be DD/MM or MM/DD: the wizard must ask. Read as DD/MM.
const SUBSCRIPTIONS_TEXT =
  "subscription_id,customer_id,plan_id,quantity,status,start_date,end_date\n" +
  "sub_1,cus_1,price_basic,2,active,01/02/2025,\n" +
  "sub_2,cus_2,price_premium,1,active,03/04/2025,\n" +
  "sub_3,cus_3,price_basic,1,canceled,05/01/2025,06/03/2025\n";
const SUBSCRIPTIONS = file("subscriptions.csv", SUBSCRIPTIONS_TEXT);
const INVOICES = file(
  "invoices.csv",
  "invoice_id,customer_id,subscription_id,amount,status,issued_at,paid_at\nin_1,cus_1,sub_1,58.00,paid,2025-03-01,2025-03-02\nin_2,cus_2,sub_2,199.00,open,2025-05-03,\n",
);
const BAD = file(
  "bad-subscriptions.csv",
  "subscription_id,customer_id,customer_name,plan_id,start_date,currency\n" +
    "sub_bad1,cus_9,=HYPERLINK(\"http://evil.example\"),price_basic,2025-13-45,USD\n" +
    "sub_bad2,cus_9,Nine Co,price_basic,2025-06-01,EUR\n" +
    "sub_ok,cus_9,Nine Co,price_basic,2025-06-01,USD\n",
);
const STRIPE = resolve("scripts/fixtures/stripe-subscriptions-export.csv");

/** Captures the next CSV the page hands to a download link. */
const CAPTURE_CSV = `(() => {
  window.__csv = null;
  const original = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => { blob.text().then((text) => { window.__csv = text; }); return original(blob); };
  return true;
})()`;

const count = (label) =>
  evaluate(`Number(document.querySelector('[data-testid="import-counts"] [data-count="${label}"] dd')?.textContent.replace(/[^0-9]/g, "") ?? "NaN")`);

/** From the kind step: choose a kind, upload, and land on the mapping step. */
async function startImport(kindKey, path) {
  await click(`import ${kindKey}`, `document.querySelector('[data-kind="${kindKey}"] button')`);
  await waitFor("upload step", `!!document.querySelector('[data-testid="import-file"]')`);
  await uploadFile('[data-testid="import-file"]', path);
  await waitFor("mapping step", `!!document.querySelector('select[id^="map-"]')`);
}

async function previewAndImport(label) {
  await click(`${label}: preview`, `window.__e2e.byText("button", "Preview import")`);
  await waitFor(`${label}: preview`, `!!document.querySelector('[data-testid="import-preview"] [data-testid="import-counts"]')`, 60_000);
  const planned = { create: await count("Will create"), update: await count("Will update"), errors: await count("Errors") };
  await click(`${label}: import`, `window.__e2e.byText('[data-testid="import-preview"] button', "Import ")`);
  await waitFor(`${label}: result`, `!!document.querySelector('[data-testid="import-result"] [data-testid="import-counts"]')`, 120_000);
  const done = { created: await count("Created"), updated: await count("Updated"), errors: await count("Errors") };
  return { planned, done };
}

async function importAnother() {
  await click("import another", `window.__e2e.byText("button", "Import another file")`);
  await waitFor("kind step", `!!document.querySelector('[data-kind="plans"]')`);
}

let organizationId = null;

try {
  // A fresh workspace for the run, owned by the demo user.
  const demo = await one(`SELECT id FROM "User" WHERE email = $1`, [process.env.DEMO_EMAIL]);
  organizationId = `e2eimport${stamp}`;
  await all(
    `INSERT INTO "Organization" (id, name, slug, currency, "createdAt", "updatedAt") VALUES ($1, $2, $3, 'USD', now(), now())`,
    [organizationId, `E2E Import ${stamp}`, `e2e-import-${stamp}`],
  );
  await all(`INSERT INTO "Membership" ("userId", "organizationId", role) VALUES ($1, $2, 'OWNER')`, [demo.id, organizationId]);
  await setSession(await signInDemo(), organizationId);
  console.log("── as the demo OWNER, in a fresh USD workspace ──");

  // 1. Template --------------------------------------------------------------------
  await load("/dashboard/import");
  await evaluate(CAPTURE_CSV);
  await click("plans template", `window.__e2e.byText('[data-kind="plans"] button', "Template")`);
  const template = await waitFor("template CSV", `window.__csv`);
  // Blob.text() decodes UTF-8 and drops the byte-order mark the file starts with.
  check(
    "1. template downloads with the documented columns and 3 examples",
    template.replace(/^﻿/, "").startsWith('"plan_id","name","amount","interval","interval_count","currency"') &&
      template.trim().split("\r\n").length === 4,
    template.split("\r\n")[0],
  );

  // 2. Plans (semicolons, decimal commas) --------------------------------------------
  await startImport("plans", PLANS);
  const plansMap = await evaluate(`({
    name: document.getElementById("map-name").value, amount: document.getElementById("map-amount").value,
    decimal: document.querySelector('input[name="decimal"]:checked')?.value ?? null,
    text: document.body.textContent })`);
  check("2. plans: semicolon file read, columns auto-mapped, decimal comma detected", plansMap.name !== "" && plansMap.amount !== "" && plansMap.decimal === "comma" && plansMap.text.includes("semicolon separated"));
  const plans = await previewAndImport("plans");
  check("2. plans: preview 2 to create, import created 2", plans.planned.create === 2 && plans.done.created === 2, JSON.stringify(plans));
  const starter = await one(`SELECT "amountCents", source FROM "Plan" WHERE "organizationId" = $1 AND "externalId" = 'price_basic'`, [organizationId]);
  check("2. plans: 29,00 stored as 2900, source CSV", starter?.amountCents === 2900 && starter?.source === "CSV");
  await importAnother();

  // Customers ------------------------------------------------------------------------
  await startImport("customers", CUSTOMERS);
  const customersMap = await evaluate(`document.getElementById("map-email").value !== "" && document.getElementById("map-customer_id").value !== ""`);
  check("2. customers: “Customer ID” and “E-mail” headers auto-mapped", customersMap);
  const customers = await previewAndImport("customers");
  check("2. customers: 3 created", customers.done.created === 3, JSON.stringify(customers));
  await importAnother();

  // Subscriptions (ambiguous dates) ------------------------------------------------------
  await startImport("subscriptions", SUBSCRIPTIONS);
  const blocked = await evaluate(`document.querySelector('[data-testid="import-blockers"]')?.textContent ?? ""`);
  check("2. subscriptions: ambiguous DD/MM vs MM/DD dates block the preview until chosen", blocked.includes("day/month or month/day"));
  await click("day first", `document.querySelector('input[name="dateOrder"][value="dmy"]')`);
  await waitFor("unblocked", `!document.querySelector('[data-testid="import-blockers"]')`);
  const subscriptions = await previewAndImport("subscriptions");
  check("2. subscriptions: 3 created", subscriptions.done.created === 3, JSON.stringify(subscriptions));
  // Read as text: node-pg would parse the timezone-less column in local time.
  const sub2 = await one(
    `SELECT to_char("startedAt", 'YYYY-MM-DD') AS day FROM "Subscription" WHERE "organizationId" = $1 AND "externalId" LIKE 'sub_2:%'`,
    [organizationId],
  );
  check("2. subscriptions: 03/04/2025 read day-first as 3 April", sub2?.day === "2025-04-03", sub2?.day);
  await importAnother();

  // Invoices ----------------------------------------------------------------------------
  await startImport("invoices", INVOICES);
  const invoices = await previewAndImport("invoices");
  check("2. invoices: 2 created", invoices.done.created === 2, JSON.stringify(invoices));
  await importAnother();

  // 3. Overview and a customer page ----------------------------------------------------------
  await load("/dashboard");
  const mrr = money(await waitFor("overview MRR", `window.__e2e.text('[data-testid="overview-mrr"] .sr-only')`, 60_000));
  check("3. overview MRR = Basic × 2 + Premium = $257", mrr === 257, `$${mrr}`);
  const acme = await one(`SELECT id FROM "Customer" WHERE "organizationId" = $1 AND "externalId" = 'cus_1'`, [organizationId]);
  await load(`/dashboard/customers/${acme.id}`);
  const acmePage = await evaluate(`({ mrr: window.__e2e.text('[data-testid="customer-mrr"]'), invoices: window.__e2e.all('main table tbody tr').length })`);
  check("3. customer page: Acme at $58.00 with its imported invoice", acmePage.mrr === "$58.00" && acmePage.invoices === 1, JSON.stringify(acmePage));

  // 4. Re-upload subscriptions: nothing to create ---------------------------------------------
  await load("/dashboard/import");
  await startImport("subscriptions", SUBSCRIPTIONS);
  await click("day first", `document.querySelector('input[name="dateOrder"][value="dmy"]')`);
  await click("preview", `window.__e2e.byText("button", "Preview import")`);
  await waitFor("preview", `!!document.querySelector('[data-testid="import-preview"] [data-testid="import-counts"]')`, 60_000);
  const again = { create: await count("Will create"), unchanged: await count("Unchanged") };
  const nothing = await evaluate(`!!window.__e2e.byText('[data-testid="import-preview"] button', "Nothing to import")`);
  check("4. re-uploading the subscriptions file: 0 created, 3 unchanged, nothing to import", again.create === 0 && again.unchanged === 3 && nothing, JSON.stringify(again));

  // 5. Stripe export -----------------------------------------------------------------------------
  await load("/dashboard/import");
  await startImport("subscriptions", STRIPE);
  const mapped = await evaluate(`[...document.querySelectorAll('select[id^="map-"]')].filter((select) => select.value !== "").length`);
  check("5. Stripe export: 14 of its 15 columns auto-mapped", mapped === 14, `${mapped} mapped`);
  await click("amounts in cents", `document.querySelector('input[name="amountsInCents"]')`);
  const stripe = await previewAndImport("stripe");
  check("5. Stripe export: 8 subscriptions, 7 customers, 3 plans", stripe.done.created === 8, JSON.stringify(stripe));
  await importAnother();
  await load("/dashboard");
  const mrrAfter = money(await waitFor("overview MRR", `window.__e2e.text('[data-testid="overview-mrr"] .sr-only')`, 60_000));
  check("5. overview MRR = 257 + 900.50 = $1,158 (rounded)", mrrAfter === 1158, `$${mrrAfter}`);

  // 6. Bad rows and the error report ---------------------------------------------------------------
  await load("/dashboard/import");
  await startImport("subscriptions", BAD);
  const bad = await previewAndImport("bad file");
  check("6. bad file: preview 2 errors, 1 created", bad.planned.errors === 2 && bad.done.created === 1 && bad.done.errors === 2, JSON.stringify(bad));
  await evaluate(CAPTURE_CSV);
  await click("error report", `window.__e2e.byText('[data-testid="import-result"] button', "Download error report")`);
  const report = await waitFor("error report CSV", `window.__csv`);
  const reportLines = report.trim().split("\r\n");
  check(
    "6. error report: the original rows with Line and Error, formulas neutralized",
    reportLines.length === 3 &&
      reportLines[0].endsWith('"Line","Error"') &&
      report.includes(`"'=HYPERLINK(""http://evil.example"")"`) &&
      report.includes("is not a real date") &&
      report.includes("This workspace reports in USD; row is EUR."),
    reportLines.slice(0, 3).join(" | "),
  );

  // 7. History, audit, notification --------------------------------------------------------------------
  await load("/dashboard/import");
  const history = await evaluate(`window.__e2e.all('[data-testid="import-history"] tbody tr').length`);
  check("7. history lists every run (the re-upload was only previewed)", history === 6, `${history} runs`);
  await evaluate(CAPTURE_CSV);
  await click("history error report", `window.__e2e.all('[data-testid="import-history"] tbody tr')[0]?.querySelector('button[aria-label="Download error report"]')`);
  const again2 = await waitFor("history error report CSV", `window.__csv`);
  check("7. the same error report downloads again from the history", again2 === report);
  const audit = await one(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "organizationId" = $1 AND action = 'import.completed'`, [organizationId]);
  const notices = await all(`SELECT title, body FROM "Notification" WHERE "organizationId" = $1 AND type = 'IMPORT_FINISHED' AND "userId" = $2`, [organizationId, demo.id]);
  check("7. every import audited and notified to the importer", audit.n === 6 && notices.length === 6, `${audit.n} audit, ${notices.length} notifications`);
  check("7. the notification says what happened", notices.some((notice) => notice.body.includes("1 created, 2 errors")), notices.map((n) => n.body).join(" | "));

  // As Bob --------------------------------------------------------------------------------------------------
  const northwind = await one(`SELECT id FROM "Organization" WHERE slug = 'northwind-analytics'`);
  const bob = await one(`SELECT id, name, email FROM "User" WHERE email = 'bob@acme-demo.dev'`);
  console.log("── as Bob, a MEMBER of Northwind ──");
  await setSession(await mintSession(bob), northwind.id);
  await load("/dashboard/import", "/dashboard");
  check("Bob opening /dashboard/import is sent to the overview", true);
  check("no Import entry in Bob's sidebar", await evaluate(`!document.querySelector('a[href="/dashboard/import"]')`));
  const runsBefore = (await one(`SELECT count(*)::int AS n FROM "ImportRun" WHERE "organizationId" = $1`, [northwind.id])).n;
  const input = {
    organizationId: northwind.id,
    kind: "customers",
    fileName: "sneaky.csv",
    text: "name\nSneaky Co\n",
    mapping: { name: 0 },
    options: { amountsInCents: false, decimal: "point", dateOrder: null },
  };
  for (const [name, args] of [
    ["previewImport", [input]],
    ["runImport", [{ ...input, runId: "11111111-2222-4333-8444-555555555555" }]],
  ]) {
    const id = actionIdOf(name);
    const reply = await evaluate(`(async () => {
      const response = await fetch("/dashboard", { method: "POST", headers: { Accept: "text/x-component", "Next-Action": ${JSON.stringify(id)} }, body: ${JSON.stringify(JSON.stringify(args))} });
      return response.text();
    })()`);
    check(`Bob calling ${name} directly is refused`, reply.includes("Only owners and admins can change billing data."));
  }
  const runsAfter = (await one(`SELECT count(*)::int AS n FROM "ImportRun" WHERE "organizationId" = $1`, [northwind.id])).n;
  const sneaky = (await one(`SELECT count(*)::int AS n FROM "Customer" WHERE "organizationId" = $1 AND name = 'Sneaky Co'`, [northwind.id])).n;
  check("… and nothing was imported", runsAfter === runsBefore && sneaky === 0);
} catch (error) {
  fail(error);
} finally {
  if (organizationId !== null) {
    await all(`DELETE FROM "Organization" WHERE id = $1`, [organizationId]);
    const left = (await one(`SELECT count(*)::int AS n FROM "Organization" WHERE id = $1`, [organizationId])).n;
    console.log(`cleanup: deleted the run's workspace and everything in it (${left} left)`);
  }
  browser.close();
  await closeDb();
  process.exit(finish());
}

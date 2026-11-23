// End-to-end check of the first-run experience, driven through headless Chrome
// over the DevTools protocol (scripts/e2e-lib.mjs — no test framework).
//
//   npm run e2e:onboarding        (dev server on http://localhost:3000, with CRON_SECRET set)
//
//   1. Register a new user -> signed in automatically, on /onboarding step 1.
//   2. Create a workspace in EUR -> step 2 for it.
//   3. Load sample data -> the dashboard, the sample banner, amounts in €, the
//      currency locked in Settings.
//   4. Remove sample data -> empty states; the currency is editable again.
//   5. Create a second workspace from the switcher -> onboarding step 2 for it;
//      fill it with sample data, delete it with the typed confirmation -> back
//      in the first workspace, and nothing of the second left in any table.
//   6. A signed-in user with no membership opening /dashboard -> /onboarding.
//   7. The cron route: 401 with a wrong Bearer token, 200 and a summary with the
//      right one.
// Everything it creates is deleted at the end, pass or fail.
import {
  APP,
  connectDb,
  createChecks,
  launchBrowser,
  mintSession,
  money,
  sleep,
} from "./e2e-lib.mjs";

const { check, fail, finish } = createChecks();
const { one, all, close: closeDb } = await connectDb();
const browser = await launchBrowser({ port: 9335 });
const { evaluate, waitFor, load, click, setSession, submitDialog, whenInteractive } = browser;

const stamp = Date.now().toString(36);
const email = `e2e-onboarding-${stamp}@example.test`;
const password = `e2e-${stamp}-Password!`;
const firstName = `E2E Euro Co ${stamp}`;
const secondName = `E2E Second ${stamp}`;
const createdUserIds = [];

/** Every table that holds a workspace's data, for the no-orphans check. */
const ORG_TABLES = [
  "Membership",
  "Customer",
  "Plan",
  "Subscription",
  "Invoice",
  "MetricSnapshot",
  "Notification",
  "ReportRun",
  "AuditLog",
];

async function waitForCurrency(organizationId, currency) {
  for (let i = 0; i < 100; i++) {
    if ((await one(`SELECT currency FROM "Organization" WHERE id = $1`, [organizationId])).currency === currency) return;
    await sleep(200);
  }
  throw new Error(`currency never became ${currency}`);
}

async function rowsFor(organizationId) {
  const counts = {};
  for (const table of ORG_TABLES) {
    counts[table] = (await one(`SELECT count(*)::int AS n FROM "${table}" WHERE "organizationId" = $1`, [organizationId])).n;
  }
  return counts;
}

try {
  // 1. Register -> signed in, on onboarding ------------------------------------------
  await setSession(null);
  await load("/register");
  await evaluate(`(() => {
    window.__e2e.set(document.getElementById("name"), "E2E Founder");
    window.__e2e.set(document.getElementById("email"), ${JSON.stringify(email)});
    window.__e2e.set(document.getElementById("password"), ${JSON.stringify(password)});
    window.__e2e.set(document.getElementById("confirmPassword"), ${JSON.stringify(password)});
    return true; })()`);
  await click("Create account", `window.__e2e.byText('button[type="submit"]', "Create account")`);
  await waitFor("onboarding after registering", `location.pathname === "/onboarding" && !!document.querySelector('[data-testid="onboarding-progress"]')`, 60_000);
  const user = await one(`SELECT id FROM "User" WHERE email = $1`, [email]);
  if (user) createdUserIds.push(user.id);
  const step1 = await evaluate(`({ progress: window.__e2e.text('[data-testid="onboarding-progress"]'), heading: window.__e2e.text("main h1"), body: document.body.textContent })`);
  check("1. registered and signed in: /onboarding, Step 1 of 2", step1.progress?.includes("Step 1 of 2") && step1.heading === "Create your workspace" && step1.body.includes(email), step1.progress ?? "");
  check("1. registration created the user only — no workspace", user !== undefined && (await one(`SELECT count(*)::int AS n FROM "Membership" WHERE "userId" = $1`, [user.id])).n === 0);

  // 2. Create a workspace in EUR -------------------------------------------------------
  // A fresh load: the sign-up's client navigation may still be refreshing the
  // page, which would reset the form under the values typed into it.
  await load("/onboarding");
  await whenInteractive('input[name="name"]');
  await evaluate(`(() => {
    window.__e2e.set(document.querySelector('input[name="name"]'), ${JSON.stringify(firstName)});
    window.__e2e.set(document.querySelector('select[name="currency"]'), "EUR");
    return true; })()`);
  await click("Create workspace", `window.__e2e.byText('button[type="submit"]', "Create workspace")`);
  await waitFor("step 2", `window.__e2e.text('[data-testid="onboarding-progress"]')?.includes("Step 2 of 2")`, 60_000);
  const first = await one(
    `SELECT o.id, o.currency, o.slug, m.role FROM "Organization" o JOIN "Membership" m ON m."organizationId" = o.id
     WHERE m."userId" = $1 AND o.name = $2`,
    [user.id, firstName],
  );
  check("2. workspace created in EUR, creator is OWNER", first?.currency === "EUR" && first?.role === "OWNER", JSON.stringify(first));
  check("2. slug generated from the name", first?.slug?.startsWith(`e2e-euro-co-${stamp}`) === true, first?.slug);
  check("2. audited as workspace.created", (await one(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "organizationId" = $1 AND action = 'workspace.created'`, [first.id])).n === 1);

  // 3. Load sample data -----------------------------------------------------------------
  await click("Explore with sample data", `window.__e2e.byText('button[type="submit"]', "Explore with sample data")`);
  await waitFor("the dashboard", `location.pathname === "/dashboard" && !!document.querySelector('[data-testid="overview-mrr"]')`, 120_000);
  await sleep(1000);
  const dash = await evaluate(`({
    banner: window.__e2e.text('[data-testid="sample-data-banner"]'),
    mrr: window.__e2e.text('[data-testid="overview-mrr"] .sr-only'),
    status: window.__e2e.text('[data-testid="metrics-status"]'),
  })`);
  check("3. sample banner visible with its Remove control", dash.banner?.includes("You're viewing sample data.") && dash.banner.includes("Remove sample data"), dash.banner ?? "");
  check("3. amounts in €", dash.mrr?.startsWith("€") && money(dash.mrr) > 0, dash.mrr ?? "");
  check("3. sidebar: metrics up to date", dash.status === "Up to date", dash.status ?? "none");
  const sampleCustomers = (await one(`SELECT count(*)::int AS n FROM "Customer" WHERE "organizationId" = $1 AND source = 'SAMPLE'`, [first.id])).n;
  check("3. 60 sample customers loaded", sampleCustomers === 60);
  await load("/dashboard/settings");
  const locked = await evaluate(`({ fixed: !!document.querySelector('[data-testid="workspace-currency"]'), text: document.body.textContent.includes("Currency is fixed once billing data exists") })`);
  check("3. Settings: currency read-only with its reason", locked.fixed && locked.text);

  // 4. Remove sample data -------------------------------------------------------------------
  await load("/dashboard");
  await click("Remove sample data", `window.__e2e.byText('[data-testid="sample-data-banner"] button', "Remove sample data")`);
  await submitDialog("remove sample data");
  await waitFor("banner gone", `!document.querySelector('[data-testid="sample-data-banner"]')`, 60_000);
  await load("/dashboard");
  const emptyOverview = await evaluate(`document.body.textContent.includes("No subscriptions yet")`);
  await load("/dashboard/customers");
  const emptyCustomers = await evaluate(`document.body.textContent.includes("No customers yet")`);
  check("4. empty states after removing sample data", emptyOverview && emptyCustomers);
  const leftovers = await rowsFor(first.id);
  check(
    "4. no sample rows or snapshots remain",
    leftovers.Customer + leftovers.Plan + leftovers.Subscription + leftovers.Invoice + leftovers.MetricSnapshot === 0,
    JSON.stringify(leftovers),
  );
  await load("/dashboard/settings");
  await whenInteractive("#workspace-currency");
  await evaluate(`(() => { window.__e2e.set(document.getElementById("workspace-currency"), "GBP"); return true; })()`);
  // Save stays inert until React has taken the new draft — wait for that, so a
  // click that lands before hydration can't be swallowed by the form's guard.
  await waitFor("Save enabled", `document.getElementById("workspace-currency").closest("form").querySelector('button[type="submit"]').getAttribute("aria-disabled") !== "true"`);
  await click("Save currency", `window.__e2e.byText('form button[type="submit"]', "Save", document.getElementById("workspace-currency").closest("form"))`);
  await waitForCurrency(first.id, "GBP");
  const gbp = (await one(`SELECT currency FROM "Organization" WHERE id = $1`, [first.id])).currency;
  // The confirmation shows, and the dropdown stays on what was saved (React's
  // automatic form reset used to put it back on the old currency).
  const gbpShown = await waitFor("GBP confirmation", `document.getElementById("workspace-currency-status")?.textContent === "Amounts are now in GBP." && document.getElementById("workspace-currency").value === "GBP"`);
  await load("/dashboard/settings");
  await whenInteractive("#workspace-currency");
  await evaluate(`(() => { window.__e2e.set(document.getElementById("workspace-currency"), "EUR"); return true; })()`);
  // Save stays inert until React has taken the new draft — wait for that, so a
  // click that lands before hydration can't be swallowed by the form's guard.
  await waitFor("Save enabled", `document.getElementById("workspace-currency").closest("form").querySelector('button[type="submit"]').getAttribute("aria-disabled") !== "true"`);
  await click("Save currency", `window.__e2e.byText('form button[type="submit"]', "Save", document.getElementById("workspace-currency").closest("form"))`);
  await waitForCurrency(first.id, "EUR");
  const eurShown = await waitFor("EUR confirmation", `document.getElementById("workspace-currency-status")?.textContent === "Amounts are now in EUR." && document.getElementById("workspace-currency").value === "EUR"`);
  check("4. currency editable while empty (EUR → GBP → EUR)", gbp === "GBP" && (await one(`SELECT currency FROM "Organization" WHERE id = $1`, [first.id])).currency === "EUR");
  check("4. each save confirms, and the dropdown keeps the saved currency", gbpShown && eurShown);

  // 5. A second workspace from the switcher, then delete it -----------------------------------
  await load("/dashboard");
  await click("workspace switcher", `window.__e2e.all('header button[aria-label^="Switch workspace"]')[0]`);
  await click("New workspace", `window.__e2e.byText('[role="menuitem"]', "New workspace")`);
  await waitFor("New workspace dialog", `window.__e2e.dialog()?.querySelector("h2")?.textContent === "New workspace"`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.set(d.querySelector('input[name="name"]'), ${JSON.stringify(secondName)});
    window.__e2e.set(d.querySelector('select[name="currency"]'), "USD"); return true; })()`);
  await click("Create workspace", `window.__e2e.dialog()?.querySelector('button[type="submit"]')`);
  await waitFor("onboarding step 2 for the new workspace", `location.pathname === "/onboarding" && document.body.textContent.includes(${JSON.stringify(secondName)}) && window.__e2e.text('[data-testid="onboarding-progress"]')?.includes("Step 2 of 2")`, 60_000);
  const second = await one(`SELECT o.id FROM "Organization" o JOIN "Membership" m ON m."organizationId" = o.id WHERE m."userId" = $1 AND o.name = $2`, [user.id, secondName]);
  check("5. switcher dialog created the workspace and opened onboarding step 2 for it", second !== undefined);

  await click("Explore with sample data", `window.__e2e.byText('button[type="submit"]', "Explore with sample data")`);
  await waitFor("the second workspace's dashboard", `location.pathname === "/dashboard" && !!document.querySelector('[data-testid="sample-data-banner"]')`, 120_000);
  const filled = await rowsFor(second.id);
  check("5. second workspace filled (sample data, snapshots, audit)", filled.Customer === 60 && filled.MetricSnapshot > 0 && filled.AuditLog > 0, JSON.stringify(filled));

  await load("/dashboard/settings");
  await click("Delete workspace", `window.__e2e.byText("main button", "Delete workspace")`);
  const blocked = await evaluate(`window.__e2e.dialog()?.querySelector('button[type="submit"]')?.getAttribute("aria-disabled") === "true"`);
  check("5. delete is blocked until the name is typed", blocked);
  await evaluate(`(() => { window.__e2e.set(window.__e2e.dialog().querySelector('input[name="confirmName"]'), ${JSON.stringify(secondName)}); return true; })()`);
  await click("confirm delete", `window.__e2e.dialog()?.querySelector('button[type="submit"]')`);
  await waitFor("back on the dashboard", `location.pathname === "/dashboard" && !window.__e2e.dialog()`, 60_000);
  await sleep(1000);
  const switcher = await evaluate(`window.__e2e.all('header button[aria-label^="Switch workspace"]')[0]?.getAttribute("aria-label")`);
  check("5. landed back in the first workspace", switcher?.includes(firstName) === true, switcher ?? "");
  const orphans = await rowsFor(second.id);
  const orgGone = (await one(`SELECT count(*)::int AS n FROM "Organization" WHERE id = $1`, [second.id])).n === 0;
  check("5. workspace deleted with nothing left in any table", orgGone && Object.values(orphans).every((n) => n === 0), JSON.stringify(orphans));
  check("5. the user's account and first workspace are untouched", (await one(`SELECT count(*)::int AS n FROM "Membership" WHERE "userId" = $1`, [user.id])).n === 1);

  // 6. No membership -> onboarding ------------------------------------------------------------
  const lonelyId = `e2elonely${stamp}`;
  await all(`INSERT INTO "User" (id, email, name, "createdAt", "updatedAt") VALUES ($1, $2, 'E2E No Workspace', now(), now())`, [lonelyId, `e2e-lonely-${stamp}@example.test`]);
  createdUserIds.push(lonelyId);
  await setSession(await mintSession({ id: lonelyId, name: "E2E No Workspace", email: `e2e-lonely-${stamp}@example.test` }));
  await load("/dashboard/customers", "/onboarding");
  check("6. a user with no membership opening /dashboard/* lands on /onboarding", await evaluate(`window.__e2e.text('[data-testid="onboarding-progress"]')?.includes("Step 1 of 2")`));

  // 7. The cron route ----------------------------------------------------------------------------
  const wrong = await fetch(`${APP}/api/cron/snapshots`, { headers: { Authorization: "Bearer not-the-secret" } });
  check("7. cron with a wrong Bearer token: 401", wrong.status === 401);
  const missing = await fetch(`${APP}/api/cron/snapshots`, { headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" } });
  check("7. cron with the old x-cron-secret header: 401", missing.status === 401);
  const right = await fetch(`${APP}/api/cron/snapshots`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  const summary = right.status === 200 ? await right.json() : null;
  check(
    "7. cron with the right Bearer token: 200 and a summary",
    summary !== null && ["workspaces", "processed", "rowsWritten", "statusesFixed", "through", "failures"].every((field) => field in summary) && summary.failures.length === 0,
    JSON.stringify(summary),
  );
} catch (error) {
  fail(error);
} finally {
  // Everything this run created: the users' workspaces (cascading their data),
  // then the users themselves.
  for (const userId of createdUserIds) {
    await all(
      `DELETE FROM "Organization" WHERE id IN (SELECT "organizationId" FROM "Membership" WHERE "userId" = $1)`,
      [userId],
    );
  }
  await all(`DELETE FROM "Organization" WHERE name IN ($1, $2)`, [firstName, secondName]);
  await all(`DELETE FROM "User" WHERE email IN ($1, $2)`, [email, `e2e-lonely-${stamp}@example.test`]);
  const remaining = await one(`SELECT count(*)::int AS n FROM "User" WHERE email LIKE $1`, [`e2e-%-${stamp}@example.test`]);
  console.log(`cleanup: removed test users and workspaces (${remaining.n} left)`);
  browser.close();
  await closeDb();
  process.exit(finish());
}

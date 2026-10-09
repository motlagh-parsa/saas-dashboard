// End-to-end check of notifications, scheduled reports, and the public pages,
// driven through headless Chrome (scripts/e2e-lib.mjs).
//
//   npm run e2e:notifications     (app on http://localhost:3000, seeded DB, CRON_SECRET set)
//
//   1. Public pages: `/` is the real landing page, signed out and signed in;
//      the sign-in panel shows no invented figures.
//   2. No placeholder copy ("coming soon", "Soon", "not yet active") on any
//      dashboard page.
//   3. The seeded alerts are in the demo feed; a teammate's personal
//      notification is not.
//   4. Preferences: turning "Overdue invoices" off in the app hides them from
//      the feed; turning it back on restores them.
//   5. Scheduled reports: schedule one in the dialog, it is listed; when due,
//      the daily job emails the CSV; Stop removes it.
// Everything it creates is removed at the end, and preferences are restored.
import {
  APP,
  connectDb,
  createChecks,
  launchBrowser,
  mintSession,
  signInDemo,
  sleep,
  waitForMail,
} from "./e2e-lib.mjs";

const { check, fail, finish } = createChecks();
const { one, db, close: closeDb } = await connectDb();
const browser = await launchBrowser({ port: 9338 });
const { evaluate, waitFor, load, click, setSession, whenInteractive } = browser;

const PLACEHOLDER = /coming soon|not yet active|lorem ipsum|\bSoon\b/i;
const PAGES = [
  "/dashboard",
  "/dashboard/revenue",
  "/dashboard/retention",
  "/dashboard/customers",
  "/dashboard/plans",
  "/dashboard/invoices",
  "/dashboard/import",
  "/dashboard/reports",
  "/dashboard/users",
  "/dashboard/audit",
  "/dashboard/notifications",
  "/dashboard/settings",
  "/dashboard/settings/profile",
  "/dashboard/settings/api-keys",
  "/dashboard/settings/integrations",
];

const demo = await one(`SELECT id, email FROM "User" WHERE email = $1`, [process.env.DEMO_EMAIL]);
const workspace = await one(
  `SELECT o.id, o.name FROM "Organization" o JOIN "Membership" m ON m."organizationId" = o.id
   WHERE m."userId" = $1 AND o.slug = 'northwind-analytics'`,
  [demo.id],
);
const bob = await one(`SELECT id FROM "User" WHERE email = 'bob@acme-demo.dev'`);
const stamp = Date.now().toString(36);
let personalId = null;
let schedulerId = null;

try {
  // 1. Public pages ----------------------------------------------------------------------------
  await setSession(null);
  await load("/");
  const landing = await evaluate(`({ h1: window.__e2e.text("h1"), body: document.body.innerText })`);
  check("1. / is the landing page", landing.h1 === "Know why your MRR moved.", landing.h1);
  check("1. … with sign-up and the API docs", landing.body.includes("Create a workspace") && landing.body.includes("Read the API docs"));
  check("1. … and no starter-template text", !landing.body.includes("To get started"));
  check("1. the example bridge says it's an example and adds up", landing.body.includes("An example month") && landing.body.includes("$42,250"));
  await load("/sign-in");
  const signIn = await evaluate("document.body.innerText");
  check("1. the sign-in panel has no invented figures", !signIn.includes("284,610") && !signIn.includes("2,400+"));

  const session = await signInDemo();
  await setSession(session, workspace.id);
  await load("/");
  check("1. signed in, / offers the dashboard", (await evaluate("document.body.innerText")).includes("Open dashboard"));

  // 2. No placeholder copy -----------------------------------------------------------------------
  const offenders = [];
  for (const path of PAGES) {
    await load(path);
    await sleep(500);
    const text = await evaluate("document.body.innerText");
    const match = PLACEHOLDER.exec(text);
    if (match) offenders.push(`${path}: "${match[0]}"`);
  }
  check("2. no placeholder copy on any dashboard page", offenders.length === 0, offenders.join(" | "));

  // 3. Feed ---------------------------------------------------------------------------------------
  const created = await one(
    `INSERT INTO "Notification" (id, "organizationId", "userId", type, title, body, "createdAt")
     VALUES ($1, $2, $3, 'REPORT_READY', $4, 'Personal to Bob.', now()) RETURNING id`,
    [`e2e${stamp}personal`, workspace.id, bob.id, `E2E personal for Bob ${stamp}`],
  );
  personalId = created.id;
  await load("/dashboard/notifications");
  const feed = await evaluate("document.querySelector('main').innerText");
  check("3. the seeded alerts are in the feed", /invoices? need attention|overdue/i.test(feed) && /MRR passed/.test(feed));
  check("3. a teammate's personal notification is not", !feed.includes(`E2E personal for Bob ${stamp}`));
  await setSession(await mintSession({ id: bob.id, name: "Bob", email: "bob@acme-demo.dev" }), workspace.id);
  await load("/dashboard/notifications");
  check("3. … but Bob sees his own", (await evaluate("document.querySelector('main').innerText")).includes(`E2E personal for Bob ${stamp}`));
  await setSession(session, workspace.id);

  // 4. Preferences ----------------------------------------------------------------------------------
  await load("/dashboard/settings/profile");
  await whenInteractive('[data-testid="notification-preferences"] input[name="INVOICE_OVERDUE:inApp"]');
  await click("Overdue in app", `document.querySelector('input[name="INVOICE_OVERDUE:inApp"]')`);
  await click("Save preferences", `window.__e2e.byText('[data-testid="notification-preferences"] button[type="submit"]', "Save")`);
  await waitFor("saved", `window.__e2e.text('[data-testid="notification-preferences"] [role="status"]')?.includes("saved")`);
  const pref = await one(`SELECT "inApp" FROM "NotificationPreference" WHERE "userId" = $1 AND type = 'INVOICE_OVERDUE'`, [demo.id]);
  check("4. the choice is saved", pref?.inApp === false);
  await load("/dashboard/notifications");
  const mutedFeed = await evaluate("document.querySelector('main').innerText");
  check("4. muted: overdue alerts leave the feed", !/invoices? need attention/i.test(mutedFeed));
  await db.query(`DELETE FROM "NotificationPreference" WHERE "userId" = $1`, [demo.id]);
  await load("/dashboard/notifications");
  check("4. restored: back in the feed", /invoices? need attention/i.test(await evaluate("document.querySelector('main').innerText")));

  // 5. Scheduled reports ------------------------------------------------------------------------------
  // As a real owner: the demo account can't schedule emails (lib/demo.ts), and
  // its address isn't an inbox.
  const schedulerEmail = `e2e-scheduler-${stamp}@example.test`;
  const scheduler = await one(
    `INSERT INTO "User" (id, email, name, "createdAt", "updatedAt") VALUES ($1, $2, 'E2E Scheduler', now(), now()) RETURNING id, email, name`,
    [`e2esched${stamp}`.padEnd(25, "0"), schedulerEmail],
  );
  schedulerId = scheduler.id;
  await db.query(`INSERT INTO "Membership" ("userId", "organizationId", role, "createdAt") VALUES ($1, $2, 'ADMIN', now())`, [scheduler.id, workspace.id]);
  await setSession(await mintSession(scheduler), workspace.id);
  await load("/dashboard/reports");
  await click("Schedule report", `window.__e2e.byText("header button", "Schedule report")`);
  await waitFor("dialog", `!!window.__e2e.dialog()?.querySelector('select[name="reportId"]')`);
  await whenInteractive('[role="dialog"] select[name="reportId"]');
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.set(d.querySelector('select[name="reportId"]'), "revenue-bridge");
    window.__e2e.set(d.querySelector('select[name="frequency"]'), "WEEKLY");
    return true; })()`);
  check("5. the dialog says where it goes", (await evaluate("window.__e2e.dialog().innerText")).includes(schedulerEmail));
  await click("Save schedule", `window.__e2e.dialog()?.querySelector('button[type="submit"]')`);
  await waitFor("dialog closed", `!window.__e2e.dialog()`, 30_000);
  await waitFor("listed", `window.__e2e.text('[data-testid="report-schedules"]')?.includes("Revenue Bridge")`);
  // Timestamps are stored as UTC wall time without a zone; read and write them
  // in SQL as UTC, whatever the database session's time zone is.
  const schedule = await one(
    `SELECT id, frequency, EXTRACT(ISODOW FROM "nextRunAt")::int AS weekday, to_char("nextRunAt", 'HH24:MI') AS time
     FROM "ReportSchedule" WHERE "userId" = $1 AND "organizationId" = $2 AND "reportId" = 'revenue-bridge'`,
    [scheduler.id, workspace.id],
  );
  check("5. saved as weekly, next run on a Monday at 00:00 UTC", schedule?.frequency === "WEEKLY" && schedule.weekday === 1 && schedule.time === "00:00", JSON.stringify(schedule));

  await db.query(`UPDATE "ReportSchedule" SET "nextRunAt" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, [schedule.id]);
  const before = Date.now();
  const cron = await fetch(`${APP}/api/cron/snapshots`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  const summary = await cron.json();
  check("5. the daily job sends due reports", cron.status === 200 && summary.reports?.sent >= 1, JSON.stringify(summary.reports));
  const mail = await waitForMail(schedulerEmail, "Revenue Bridge", { after: before });
  check("5. the email has the CSV attached", mail.attachments?.[0]?.filename?.startsWith("revenue-bridge-") === true, mail.subject);

  await load("/dashboard/reports");
  await click("Stop", `document.querySelector('[data-testid="report-schedules"] button[aria-label^="Stop Revenue Bridge"]')`);
  await waitFor("removed", `!document.querySelector('[data-testid="report-schedules"]')?.innerText.includes("Revenue Bridge")`, 30_000);
  check("5. Stop removes it", (await one(`SELECT count(*)::int AS n FROM "ReportSchedule" WHERE id = $1`, [schedule.id])).n === 0);
} catch (error) {
  fail(error);
} finally {
  try {
    if (personalId) await db.query(`DELETE FROM "Notification" WHERE id = $1`, [personalId]);
    await db.query(`DELETE FROM "NotificationPreference" WHERE "userId" = $1`, [demo.id]);
    await db.query(`DELETE FROM "ReportSchedule" WHERE "userId" = $1`, [demo.id]);
    if (schedulerId) {
      await db.query(`DELETE FROM "Notification" WHERE "userId" = $1`, [schedulerId]);
      await db.query(`DELETE FROM "User" WHERE id = $1`, [schedulerId]);
    }
    await db.query(`DELETE FROM "Notification" WHERE "organizationId" = $1 AND type = 'REPORT_READY' AND "userId" = $2`, [workspace.id, demo.id]);
  } catch (cleanupError) {
    console.error("cleanup failed:", cleanupError);
  }
  browser.close();
  await closeDb();
}

finish();

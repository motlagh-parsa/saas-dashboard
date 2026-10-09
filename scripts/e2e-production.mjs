// End-to-end checks of production hardening, against `next start`:
//
//   npm run e2e:production
//
//   1. Security headers on pages and APIs; no X-Powered-By.
//   2. /api/health answers 200 with the database up.
//   3. An unknown URL renders the branded 404, with status 404.
//   4. /api/vitals takes a valid web-vital (204) and refuses junk (400).
//   5. The demo account is fenced in, through the UI: inviting, connecting
//      Stripe and editing its profile are refused with the demo message.
import { APP, connectDb, createChecks, launchBrowser, signInDemo } from "./e2e-lib.mjs";

const { check, fail, finish } = createChecks();
const { one, close: closeDb } = await connectDb();
const browser = await launchBrowser({ port: 9340 });
const { evaluate, waitFor, load, click, setSession, whenInteractive } = browser;
const DEMO_MESSAGE = "The demo account can't do this";

try {
  // 1. Headers ----------------------------------------------------------------------
  for (const path of ["/", "/sign-in", "/api/health"]) {
    const response = await fetch(`${APP}${path}`);
    const h = response.headers;
    check(
      `1. ${path}: CSP, frame, sniffing and referrer headers`,
      (h.get("content-security-policy") ?? "").includes("frame-ancestors 'none'") &&
        h.get("x-frame-options") === "DENY" &&
        h.get("x-content-type-options") === "nosniff" &&
        h.get("referrer-policy") === "strict-origin-when-cross-origin",
      [...h.keys()].join(","),
    );
    check(`1. ${path}: no X-Powered-By`, h.get("x-powered-by") === null);
  }
  const csp = (await fetch(`${APP}/`)).headers.get("content-security-policy") ?? "";
  check("1. CSP: no third-party scripts or connections", /script-src 'self' 'unsafe-inline'(;|$)/.test(csp) && /connect-src 'self'(;|$)/.test(csp), csp);

  // 2. Health -------------------------------------------------------------------------
  const health = await fetch(`${APP}/api/health`);
  check("2. /api/health is 200 ok", health.status === 200 && (await health.json()).status === "ok");

  // 3. 404 ----------------------------------------------------------------------------
  const missing = await fetch(`${APP}/no-such-page-${Date.now()}`);
  check("3. an unknown URL is a 404", missing.status === 404);
  await load(`/no-such-page-${Date.now()}`);
  check("3. … with the branded page", (await evaluate(`window.__e2e.text("h1")`)) === "Page not found");

  // 4. Vitals -------------------------------------------------------------------------
  const vital = await fetch(`${APP}/api/vitals`, {
    method: "POST",
    body: JSON.stringify({ name: "LCP", value: 1234, rating: "good", path: "/dashboard" }),
  });
  check("4. a web vital is accepted", vital.status === 204);
  const junk = await fetch(`${APP}/api/vitals`, { method: "POST", body: JSON.stringify({ name: "EVIL", value: -1, path: "<script>" }) });
  check("4. junk is refused", junk.status === 400);

  // 5. The demo account ---------------------------------------------------------------
  const demo = await one(`SELECT id FROM "User" WHERE email = $1`, [process.env.DEMO_EMAIL]);
  const northwind = await one(`SELECT id FROM "Organization" WHERE slug = 'northwind-analytics'`);
  await setSession(await signInDemo(), northwind.id);

  await load("/dashboard/users?action=add", "/dashboard/users");
  await waitFor("add user dialog", `!!window.__e2e.dialog()?.querySelector('input[name="email"]')`);
  await whenInteractive('[role="dialog"] input[name="email"]');
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.set(d.querySelector('input[name="name"]'), "Should Not Exist");
    window.__e2e.set(d.querySelector('input[name="email"]'), "should-not-exist@example.test");
    return true; })()`);
  await click("Add user", `window.__e2e.dialog()?.querySelector('button[type="submit"]')`);
  const invite = await waitFor("refusal", `window.__e2e.dialog()?.querySelector('[role="alert"]')?.textContent || null`);
  check("5. the demo can't invite people", invite.includes(DEMO_MESSAGE), invite);
  check("5. … and no account was made", (await one(`SELECT count(*)::int AS n FROM "User" WHERE email = 'should-not-exist@example.test'`)).n === 0);

  await load("/dashboard/settings/integrations");
  await whenInteractive("#stripe-key");
  await evaluate(`(() => { window.__e2e.set(document.getElementById("stripe-key"), "rk_test_somebodysrealkey0000"); return true; })()`);
  await click("Connect Stripe", `document.querySelector('[data-testid="stripe-key-form"] button[type="submit"]')`);
  const stripe = await waitFor("refusal", `document.querySelector('[data-testid="stripe-key-form"] [role="alert"]')?.textContent || null`);
  check("5. the demo can't connect Stripe", stripe.includes(DEMO_MESSAGE), stripe);

  await load("/dashboard/settings/profile");
  await whenInteractive('input[name="name"]');
  await evaluate(`(() => { window.__e2e.set(document.querySelector('input[name="name"]'), "Renamed Demo"); return true; })()`);
  await click("Save profile", `document.querySelector('input[name="name"]').closest("form").querySelector('button[type="submit"]')`);
  await waitFor("profile refusal", `document.body.innerText.includes(${JSON.stringify(DEMO_MESSAGE)})`);
  check("5. the demo can't rename itself", (await one(`SELECT name FROM "User" WHERE id = $1`, [demo.id])).name === "Demo Operator");
} catch (error) {
  fail(error);
} finally {
  browser.close();
  await closeDb();
}

finish();

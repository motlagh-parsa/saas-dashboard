// End-to-end check of the REST API: keys made in the UI, then plain fetch
// against /api/v1, and the browser to compare what the dashboard shows
// (scripts/e2e-lib.mjs — Chrome over the DevTools protocol, no framework).
//
//   npm run e2e:api        (dev server on http://localhost:3000, seeded DB)
//
// As the demo owner, in a fresh workspace created for the run:
//   1. onboarding's Connect via API card links to the keys and the docs;
//   2. create a WRITE and a READ key in Settings → API keys, copying the key the
//      dialog shows once; only its hash is stored;
//   3. push plans, customers, subscriptions and invoices; change a plan; cancel;
//      responses carry X-Request-Id and the rate-limit headers, no CORS;
//   4. the Overview's MRR in the browser equals GET /v1/metrics/summary;
//   5. errors: validation lists every field, 409 carries the UI's message,
//      unknown key 401, READ key write 403;
//   6. 121 requests in one minute: the 121st is 429 with Retry-After;
//   7. revoke the WRITE key in the UI: it gets 401 from then on;
//   8. the audit page and the customer's Activity show "API · <key name>";
//   9. the docs are in the command palette; /docs/api and openapi.json load
//      signed out.
// As Bob, a MEMBER of the seeded workspace: no API keys tab, the page refuses,
// and calling createApiKey directly is refused.
// The fresh workspace (keys, data, audit) is deleted at the end.
import { createHash } from "node:crypto";

import { APP, actionIdOf, connectDb, createChecks, dayString, launchBrowser, mintSession, money, signInDemo, sleep } from "./e2e-lib.mjs";

const { check, fail, finish } = createChecks();
const { one, all, close: closeDb } = await connectDb();
const browser = await launchBrowser({ port: 9337 });
const { evaluate, waitFor, load, click, key, typeText, setSession, submitDialog } = browser;

const stamp = Date.now().toString(36);
const WRITE_NAME = `Backend ${stamp}`;
const READ_NAME = `Reporting ${stamp}`;

/** A JSON request to /api/v1 with a key, returning status, headers and body. */
async function api(method, path, apiKey, body) {
  const response = await fetch(`${APP}/api/v1${path}`, {
    method,
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON — reported through `json: null`.
  }
  return { status: response.status, headers: response.headers, json };
}

/** Creates a key in the open API keys page and returns what the dialog shows. */
async function createKeyInUi(name, scope) {
  await click("Create key", `window.__e2e.byText("main button", "Create key")`);
  await waitFor("create dialog", `!!window.__e2e.dialog()?.querySelector('input[name="name"]')`);
  await evaluate(`window.__e2e.set(window.__e2e.dialog().querySelector('input[name="name"]'), ${JSON.stringify(name)})`);
  await click(`${scope} scope`, `window.__e2e.dialog().querySelector('input[name="scope"][value="${scope}"]')`);
  await click("submit", `window.__e2e.dialog()?.querySelector('button[type="submit"]')`);
  const shown = await waitFor("the new key", `document.querySelector('[data-testid="new-api-key"]')?.value || null`, 30_000);
  const warning = await evaluate(`window.__e2e.dialog()?.textContent.includes("only time the key is shown") ?? false`);
  await click("Copy", `window.__e2e.byText('[role="dialog"] button', "Copy")`);
  const copied = await waitFor(
    "copy result",
    `(() => { const t = window.__e2e.dialog()?.textContent ?? ""; return t.includes("Copied") ? "copied" : t.includes("Couldn't copy") ? "fallback" : null; })()`,
  );
  await click("Done", `window.__e2e.byText('[role="dialog"] button', "Done")`);
  await waitFor("dialog to close", `!window.__e2e.dialog()`);
  return { key: shown, warning, copied };
}

let organizationId = null;

try {
  const demo = await one(`SELECT id FROM "User" WHERE email = $1`, [process.env.DEMO_EMAIL]);
  organizationId = `e2eapi${stamp}`;
  await all(
    `INSERT INTO "Organization" (id, name, slug, currency, "createdAt", "updatedAt") VALUES ($1, $2, $3, 'USD', now(), now())`,
    [organizationId, `E2E API ${stamp}`, `e2e-api-${stamp}`],
  );
  await all(`INSERT INTO "Membership" ("userId", "organizationId", role) VALUES ($1, $2, 'OWNER')`, [demo.id, organizationId]);
  await setSession(await signInDemo(), organizationId);
  console.log("── as the demo OWNER, in a fresh USD workspace ──");

  // 1. Onboarding card ----------------------------------------------------------------------------------
  await load("/onboarding");
  const card = await evaluate(`(() => {
    const heading = [...document.querySelectorAll("span")].find((el) => el.textContent.trim() === "Connect via API");
    const box = heading?.closest("div");
    return box ? [...box.querySelectorAll("a")].map((a) => a.getAttribute("href")) : null;
  })()`);
  check("1. onboarding: Connect via API links to Settings → API keys and the docs", JSON.stringify(card) === JSON.stringify(["/dashboard/settings/api-keys", "/docs/api"]), JSON.stringify(card));

  // 2. Keys in the UI ----------------------------------------------------------------------------------
  await load("/dashboard/settings");
  check("2. the settings tabs show API keys to an owner", await evaluate(`!!document.querySelector('nav[aria-label="Settings sections"] a[href="/dashboard/settings/api-keys"]')`));
  await load("/dashboard/settings/api-keys");
  check("2. the keys tab links the docs", await evaluate(`!!document.querySelector('main a[href="/docs/api"]')`));
  const write = await createKeyInUi(WRITE_NAME, "WRITE");
  check("2. WRITE key shown once: mrd_ + 43 chars, with the warning", /^mrd_[A-Za-z0-9_-]{43}$/.test(write.key) && write.warning, write.key.slice(0, 12));
  check("2. Copy works, or says to copy by hand", write.copied === "copied" || write.copied === "fallback", write.copied);
  const read = await createKeyInUi(READ_NAME, "READ");
  check("2. READ key created", /^mrd_/.test(read.key) && read.key !== write.key);
  const stored = await all(`SELECT name, prefix, "keyHash", scope FROM "ApiKey" WHERE "organizationId" = $1 ORDER BY name`, [organizationId]);
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  check(
    "2. only the SHA-256 and the 12-char prefix are stored",
    stored.length === 2 &&
      stored.some((row) => row.keyHash === sha(write.key) && row.prefix === write.key.slice(0, 12) && row.scope === "WRITE") &&
      stored.some((row) => row.keyHash === sha(read.key) && row.scope === "READ") &&
      !JSON.stringify(stored).includes(write.key),
    JSON.stringify(stored.map((row) => [row.name, row.prefix, row.scope])),
  );
  await load("/dashboard/settings/api-keys");
  const rows = await evaluate(`window.__e2e.all('[data-testid="api-key-row"]').map((row) => row.textContent.replace(/\\s+/g, " "))`);
  check("2. the list shows both keys by name, prefix…, access and status", rows.length === 2 && rows.some((r) => r.includes(WRITE_NAME) && r.includes(`${write.key.slice(0, 12)}…`) && r.includes("Read and write") && r.includes("active")), JSON.stringify(rows));

  // 3. Push ---------------------------------------------------------------------------------------------
  const W = write.key;
  const plan = await api("PUT", "/plans/basic", W, { name: "Basic", amount: 4900, interval: "month" });
  check("3. PUT plan -> 201", plan.status === 201 && plan.json?.amount === 4900 && plan.json?.currency === "USD", `${plan.status}`);
  check("3. headers: X-Request-Id and X-RateLimit-*, no CORS", !!plan.headers.get("x-request-id") && plan.headers.get("x-ratelimit-limit") === "120" && plan.headers.get("x-ratelimit-remaining") !== null && plan.headers.get("x-ratelimit-reset") !== null && plan.headers.get("access-control-allow-origin") === null);
  check("3. PUT plan again -> 200", (await api("PUT", "/plans/basic", W, { name: "Basic", amount: 4900, interval: "month" })).status === 200);
  await api("PUT", "/plans/pro", W, { name: "Pro", amount: 9900, interval: "month" });
  for (const [id, name] of [["c1", "Api One"], ["c2", "Api Two"], ["c3", "Api Three"]]) {
    const customer = await api("PUT", `/customers/${id}`, W, { name, email: `${id}@api-e2e.example` });
    check(`3. PUT customer ${id} -> 201`, customer.status === 201, `${customer.status}`);
  }
  const s1 = await api("PUT", "/subscriptions/s1", W, { customer_external_id: "c1", plan_external_id: "basic", start_date: "2025-01-01" });
  check("3. PUT subscription -> 201 [created]", s1.status === 201 && JSON.stringify(s1.json?.changes) === '["created"]', `${s1.status} ${JSON.stringify(s1.json?.changes)}`);
  await api("PUT", "/subscriptions/s2", W, { customer_external_id: "c2", plan_external_id: "pro", quantity: 2, start_date: "2025-03-01" });
  await api("PUT", "/subscriptions/s3", W, { customer_external_id: "c3", plan_external_id: "basic", start_date: "2025-02-01" });
  const inv = await api("PUT", "/invoices/in_1", W, { customer_external_id: "c1", subscription_external_id: "s1", amount: 4900, status: "open", issued_at: "2025-01-01" });
  const paid = await api("PUT", "/invoices/in_1", W, { customer_external_id: "c1", subscription_external_id: "s1", amount: 4900, status: "paid", issued_at: "2025-01-01", paid_at: "2025-01-02" });
  check("3. invoice recorded open, then paid", inv.status === 201 && paid.status === 200 && paid.json?.status === "paid", `${inv.status}/${paid.status}`);
  const upgrade = await api("PUT", "/subscriptions/s1", W, { customer_external_id: "c1", plan_external_id: "pro", start_date: "2025-01-01" });
  check("3. plan change -> [plan_changed], two segments", upgrade.status === 200 && JSON.stringify(upgrade.json?.changes) === '["plan_changed"]' && upgrade.json?.segments.length === 2, JSON.stringify(upgrade.json?.changes));
  const cancel = await api("PUT", "/subscriptions/s3", W, { customer_external_id: "c3", plan_external_id: "basic", start_date: "2025-02-01", end_date: dayString(-1) });
  check("3. end_date yesterday -> [canceled]", cancel.status === 200 && cancel.json?.status === "canceled" && JSON.stringify(cancel.json?.changes) === '["canceled"]', JSON.stringify(cancel.json?.changes));
  const unchanged = await api("PUT", "/subscriptions/s2", W, { customer_external_id: "c2", plan_external_id: "pro", quantity: 2, start_date: "2025-03-01" });
  check("3. same state -> 200 [unchanged]", unchanged.status === 200 && JSON.stringify(unchanged.json?.changes) === '["unchanged"]');
  const sources = await one(`SELECT count(*) FILTER (WHERE source = 'API')::int AS api, count(*)::int AS n FROM "Subscription" WHERE "organizationId" = $1`, [organizationId]);
  check("3. every written segment has source API", sources.api === sources.n && sources.n === 4, JSON.stringify(sources));

  // 4. Overview = summary -------------------------------------------------------------------------------
  const summary = await api("GET", "/metrics/summary", read.key);
  check("4. summary: MRR = Pro + Pro × 2 = $297", summary.status === 200 && summary.json?.mrr === 29_700, JSON.stringify(summary.json?.mrr));
  await load("/dashboard");
  const overview = money(await waitFor("overview MRR", `window.__e2e.text('[data-testid="overview-mrr"] .sr-only')`, 60_000));
  check("4. the Overview's MRR in the browser equals GET /v1/metrics/summary", overview * 100 === summary.json?.mrr, `$${overview} vs ${summary.json?.mrr}`);
  const customer = await api("GET", "/customers/c1", read.key);
  check("4. GET customer: current MRR, status, subscriptions", customer.json?.mrr === 9900 && customer.json?.status === "active" && customer.json?.subscriptions.length === 1);
  const series = await api("GET", `/metrics/mrr?from=${dayString(-2)}&to=${dayString(0)}`, read.key);
  check("4. GET metrics/mrr: daily points", series.status === 200 && Array.isArray(series.json?.data), `${series.status}`);

  // 5. Errors -------------------------------------------------------------------------------------------
  const invalid = await api("PUT", "/subscriptions/s9", W, { customer_external_id: "c1", quantity: 0, start_date: "nope" });
  check("5. 400 lists every invalid field", invalid.status === 400 && invalid.json?.error.type === "invalid_request" && invalid.json?.error.details.length >= 3, JSON.stringify(invalid.json));
  const conflict = await api("PUT", "/subscriptions/s3", W, { customer_external_id: "c3", plan_external_id: "pro", start_date: "2025-02-01", end_date: dayString(-1) });
  check("5. 409 with the UI's message (changing an ended subscription)", conflict.status === 409 && /^This subscription ended on/.test(conflict.json?.error.message ?? ""), JSON.stringify(conflict.json));
  const missing = await api("PUT", "/subscriptions/s9", W, { customer_external_id: "nobody", plan_external_id: "pro", start_date: "2025-01-01" });
  check("5. 404 names the param", missing.status === 404 && missing.json?.error.param === "customer_external_id");
  const unknown = await api("GET", "/customers", "mrd_this-key-does-not-exist-anywhere-at-all-000000");
  check("5. unknown key -> 401", unknown.status === 401 && unknown.json?.error.type === "authentication");
  const readWrite = await api("PUT", "/customers/c9", read.key, { name: "Nope" });
  check("5. READ key on a write -> 403", readWrite.status === 403 && readWrite.json?.error.type === "permission", `${readWrite.status}`);
  const noStack = JSON.stringify([invalid.json, conflict.json, missing.json, unknown.json, readWrite.json]);
  check("5. no stack traces or internals in errors", !/at \w+ \(|\.ts:\d+|prisma/i.test(noStack));
  const notJson = await fetch(`${APP}/api/v1/customers/c9`, { method: "PUT", headers: { Authorization: `Bearer ${W}`, "Content-Type": "text/plain" }, body: "name=x" });
  check("5. a non-JSON body -> 400", notJson.status === 400);
  const huge = await api("PUT", "/customers/c9", W, { name: "x", pad: "y".repeat(1_100_000) });
  check("5. a body over 1 MB -> 400", huge.status === 400 && /1 MB/.test(huge.json?.error.message ?? ""), `${huge.status}`);

  // 6. Rate limit ---------------------------------------------------------------------------------------
  // Start at the top of a fresh minute so all 121 land in one window.
  const wait = 60_000 - (Date.now() % 60_000) + 300;
  console.log(`   (waiting ${Math.round(wait / 1000)}s for a fresh rate-limit window)`);
  await sleep(wait);
  const burst = [];
  for (let batch = 0; batch < 121; batch += 20) {
    const size = Math.min(20, 121 - batch);
    burst.push(...(await Promise.all(Array.from({ length: size }, () => api("GET", "/plans?limit=1", read.key)))));
  }
  const limited = burst.filter((response) => response.status === 429);
  check("6. 121 requests in a minute: 120 pass, 1 is 429", burst.filter((r) => r.status === 200).length === 120 && limited.length === 1, `${limited.length} × 429`);
  const retryAfter = Number(limited[0]?.headers.get("retry-after"));
  check("6. the 429 has Retry-After and Remaining 0", retryAfter >= 1 && retryAfter <= 60 && limited[0]?.headers.get("x-ratelimit-remaining") === "0" && limited[0]?.json?.error.type === "rate_limited", `${retryAfter}`);

  // 7. Revoke -------------------------------------------------------------------------------------------
  await load("/dashboard/settings/api-keys");
  await click("Revoke", `window.__e2e.all('[data-testid="api-key-row"]').find((row) => row.textContent.includes(${JSON.stringify(WRITE_NAME)}))?.querySelector("button")`);
  await waitFor("revoke dialog", `window.__e2e.dialog()?.textContent.includes("Revoke ${WRITE_NAME}?")`);
  await submitDialog("revoke");
  const afterRevoke = await api("PUT", "/customers/c9", W, { name: "Too late" });
  check("7. revoked key -> 401", afterRevoke.status === 401 && afterRevoke.json?.error.message === "This API key was revoked.", `${afterRevoke.status}`);
  await load("/dashboard/settings/api-keys");
  check("7. the list shows it revoked", await evaluate(`window.__e2e.all('[data-testid="api-key-row"]').some((row) => row.textContent.includes(${JSON.stringify(WRITE_NAME)}) && row.textContent.includes("revoked"))`));

  // 8. Audit --------------------------------------------------------------------------------------------
  const logged = await all(`SELECT action, "actorId", "apiKeyId" FROM "AuditLog" WHERE "organizationId" = $1`, [organizationId]);
  const apiEntries = logged.filter((row) => row.apiKeyId !== null);
  check("8. API writes audited with the key and no actor", apiEntries.length >= 10 && apiEntries.every((row) => row.actorId === null), `${apiEntries.length} entries`);
  check("8. api_key.created ×2 and api_key.revoked by the owner", logged.filter((r) => r.action === "api_key.created" && r.actorId === demo.id).length === 2 && logged.some((r) => r.action === "api_key.revoked" && r.actorId === demo.id));
  await load("/dashboard/audit");
  check("8. the audit page shows “API · <key name>”", await evaluate(`document.querySelector("main").textContent.includes(${JSON.stringify(`API · ${WRITE_NAME}`)})`));
  const c1 = await one(`SELECT id FROM "Customer" WHERE "organizationId" = $1 AND "externalId" = 'c1'`, [organizationId]);
  await load(`/dashboard/customers/${c1.id}`);
  check("8. the customer's Activity shows “API · <key name>”", await evaluate(`document.querySelector("main").textContent.includes(${JSON.stringify(`API · ${WRITE_NAME}`)})`));

  // 9. Palette and public docs --------------------------------------------------------------------------
  await load("/dashboard");
  await key("k", "KeyK", 75, 2);
  await waitFor("palette", `!!document.querySelector('input[aria-label="Command"]')`);
  await typeText("API documentation");
  await key("Enter", "Enter", 13);
  await waitFor("docs page", `location.pathname === "/docs/api" && document.readyState === "complete"`, 60_000);
  check("9. ⌘K “API documentation” opens /docs/api", true);
  await browser.send("Network.clearBrowserCookies");
  const docs = await fetch(`${APP}/docs/api`, { redirect: "manual" });
  const docsHtml = await docs.text();
  check("9. /docs/api loads signed out", docs.status === 200 && docsHtml.includes("Syncing from your billing system"), `${docs.status}`);
  const spec = await fetch(`${APP}/api/v1/openapi.json`);
  check("9. /api/v1/openapi.json loads signed out (OpenAPI 3.1)", spec.status === 200 && (await spec.json()).openapi === "3.1.0");

  // As Bob ----------------------------------------------------------------------------------------------
  const northwind = await one(`SELECT id FROM "Organization" WHERE slug = 'northwind-analytics'`);
  const bob = await one(`SELECT id, name, email FROM "User" WHERE email = 'bob@acme-demo.dev'`);
  console.log("── as Bob, a MEMBER of Northwind ──");
  await setSession(await mintSession(bob), northwind.id);
  await load("/dashboard/settings");
  check("Bob sees no API keys tab", await evaluate(`!document.querySelector('a[href="/dashboard/settings/api-keys"]')`));
  await load("/dashboard/settings/api-keys");
  check("Bob opening the page is refused", await evaluate(`document.querySelector("main").textContent.includes("Only owners and admins manage API keys")`));
  const before = (await one(`SELECT count(*)::int AS n FROM "ApiKey" WHERE "organizationId" = $1`, [northwind.id])).n;
  const id = actionIdOf("createApiKey");
  const reply = await evaluate(`(async () => {
    const body = new FormData();
    for (const [k, v] of Object.entries(${JSON.stringify({ organizationId: northwind.id, name: "Sneaky", scope: "WRITE", expiry: "never" })})) body.set("_1_" + k, v);
    body.set("0", JSON.stringify([{ status: "idle", message: null, fieldErrors: {}, key: null }, "$K1"]));
    const response = await fetch("/dashboard/settings", { method: "POST", headers: { Accept: "text/x-component", "Next-Action": ${JSON.stringify(id)} }, body });
    return response.text();
  })()`);
  const after = (await one(`SELECT count(*)::int AS n FROM "ApiKey" WHERE "organizationId" = $1`, [northwind.id])).n;
  check("Bob calling createApiKey directly is refused, no key made", reply.includes("Only owners and admins can manage API keys.") && after === before, reply.slice(0, 160));
} catch (error) {
  fail(error);
} finally {
  if (organizationId !== null) {
    await all(`DELETE FROM "Organization" WHERE id = $1`, [organizationId]);
    const left = (await one(`SELECT count(*)::int AS n FROM "ApiKey" WHERE "organizationId" = $1`, [organizationId])).n;
    console.log(`cleanup: deleted the run's workspace, its keys and data (${left} keys left)`);
  }
  browser.close();
  await closeDb();
  process.exit(finish());
}

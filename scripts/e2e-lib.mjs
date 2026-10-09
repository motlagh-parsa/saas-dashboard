// Shared harness for the browser e2e scripts (e2e-billing.mjs, e2e-onboarding.mjs):
// headless Chrome over the DevTools protocol, a Postgres client, session helpers
// and a tiny check/report — Node 22 built-ins plus packages the app already has
// (pg, next-auth). No test framework.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
try {
  process.loadEnvFile(".env");
} catch {
  // Variables may come from the environment instead.
}
const { Client } = require("pg");
const { encode } = require("next-auth/jwt");

export const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
export const APP = process.env.APP_URL ?? "http://localhost:3000";
export const DAY_MS = 86_400_000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const todayMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
/** `YYYY-MM-DD`, `offset` days from today (UTC). */
export const dayString = (offset) => new Date(todayMs + offset * DAY_MS).toISOString().slice(0, 10);

export function addMonthsUTC(ms, months) {
  const d = new Date(ms);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months + 1, 0)).getUTCDate();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, Math.min(d.getUTCDate(), lastDay));
}

export const money = (text) => Number(String(text).replace(/[^0-9.-]/g, ""));

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export function createChecks() {
  const results = [];
  return {
    check(label, ok, detail = "") {
      results.push(ok);
      console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
    },
    fail(error) {
      console.log("ERROR", error instanceof Error ? error.message : String(error));
      results.push(false);
    },
    /** Prints the tally and returns the process exit code. */
    finish() {
      const failed = results.filter((ok) => !ok).length;
      console.log(`\n${results.length - failed}/${results.length} checks passed`);
      return failed === 0 ? 0 : 1;
    },
  };
}

// ---------------------------------------------------------------------------
// Mail — the app's local mail driver (lib/mail.ts) writes one JSON file per
// message here; the server and these scripts run on the same machine.
// ---------------------------------------------------------------------------

export function mailboxDir() {
  return process.env.MAIL_DEV_DIR || join(tmpdir(), "meridian-mail");
}

/** Every message sent to `to`, oldest first: { to, subject, text, html, sentAt }. */
export function readMailbox(to) {
  let files;
  try {
    files = readdirSync(mailboxDir()).filter((file) => file.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return files
    .map((file) => JSON.parse(readFileSync(join(mailboxDir(), file), "utf8")))
    .filter((mail) => mail.to === to);
}

/** Waits for the newest message to `to` matching `subject`, and returns it. */
export async function waitForMail(to, subject, { after = 0, timeoutMs = 20_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const mail = readMailbox(to)
      .filter((m) => m.subject.includes(subject) && Date.parse(m.sentAt) >= after)
      .at(-1);
    if (mail) return mail;
    await sleep(200);
  }
  throw new Error(`no "${subject}" email to ${to}`);
}

/** The path (with token) of the first link in a message to `/${prefix}/…`. */
export function linkPath(mail, prefix) {
  const match = new RegExp(`https?://[^/\\s]+(/${prefix}/[0-9a-f]{64})`).exec(mail.text);
  if (!match) throw new Error(`no /${prefix}/ link in "${mail.subject}"`);
  return match[1];
}

// ---------------------------------------------------------------------------
// Database and sessions
// ---------------------------------------------------------------------------

export async function connectDb() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  return {
    db,
    one: async (sql, params = []) => (await db.query(sql, params)).rows[0],
    all: async (sql, params = []) => (await db.query(sql, params)).rows,
    close: () => db.end(),
  };
}

/** Signs in through NextAuth's credentials endpoint and returns the session token. */
export async function signIn(email, password) {
  const csrfResponse = await fetch(`${APP}/api/auth/csrf`);
  const { csrfToken } = await csrfResponse.json();
  const csrfCookie = csrfResponse.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const response = await fetch(`${APP}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${APP}/dashboard`, json: "true" }),
  });
  const session = response.headers.getSetCookie().find((c) => c.startsWith("next-auth.session-token="));
  if (!session) throw new Error(`sign-in failed for ${email}`);
  return session.split(";")[0].slice("next-auth.session-token=".length);
}

export const signInDemo = () => signIn(process.env.DEMO_EMAIL, process.env.DEMO_PASSWORD);

/**
 * A session token for `user`, minted with NEXTAUTH_SECRET — for accounts that
 * have no password to sign in with (seeded teammates, test users). It is the
 * token a signed-in user of that id would carry.
 */
export function mintSession(user) {
  return encode({
    token: { sub: user.id, id: user.id, name: user.name, email: user.email },
    secret: process.env.NEXTAUTH_SECRET,
  });
}

/**
 * A Server Action's id from its export name. Against `next dev` (the default)
 * the ids sit beside their names in the dev client chunks. Against `next start`
 * set E2E_BUILD=production (CI does): they come from the build's server
 * reference manifest instead.
 */
export function actionIdOf(name) {
  const manifestPath = ".next/server/server-reference-manifest.json";
  if (process.env.E2E_BUILD === "production") {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const [id, entry] of Object.entries(manifest.node ?? {})) {
      if (entry.exportedName === name) return id;
    }
  }
  const chunkDir = ".next/dev/static/chunks";
  if (!existsSync(chunkDir)) return null;
  const pattern = new RegExp(`"([0-9a-f]{40,})":\\{"name":"${name}"\\}`);
  for (const file of readdirSync(chunkDir)) {
    if (!file.endsWith(".js")) continue;
    const match = readFileSync(join(chunkDir, file), "utf8").match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chrome over CDP
// ---------------------------------------------------------------------------

/** In-page helpers, installed before every evaluation. */
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

export async function launchBrowser({ port }) {
  const profile = mkdtempSync(join(tmpdir(), "meridian-e2e-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,1000",
    // Chrome refuses to start as root without this — the case in CI containers.
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    "about:blank",
  ]);

  let url = null;
  for (let i = 0; i < 50 && url === null; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      url = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    } catch {
      // Chrome is still starting.
    }
    if (url === null) await sleep(200);
  }
  if (url === null) throw new Error("chrome did not start");

  const ws = new WebSocket(url);
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

  /** Navigates and waits for the document; `expectPath` defaults to the path itself. */
  async function load(path, expectPath = path.split("?")[0]) {
    await send("Page.navigate", { url: `${APP}${path}` });
    await waitFor(`${path} to load`, `document.readyState === "complete" && location.pathname === ${JSON.stringify(expectPath)}`, 60_000);
    // Hydration: interactive islands attach listeners after the document loads.
    await sleep(1200);
  }

  /** A real mouse click at the element's centre — what Radix triggers listen for. */
  async function click(label, elementExpression) {
    const box = await waitFor(
      label,
      // Waits until nothing covers the element's centre (a toast from the
      // previous step, a closing dialog), so the click lands on it.
      `(() => { const el = ${elementExpression}; if (!el) return null; el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect(); if (r.width === 0) return null;
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const top = document.elementFromPoint(x, y);
        return top && (el === top || el.contains(top)) ? { x, y } : null; })()`,
    );
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await sleep(250);
  }

  async function key(keyName, code, keyCode, modifiers = 0) {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
    await sleep(150);
  }

  async function typeText(text) {
    await send("Input.insertText", { text });
    await sleep(150);
  }

  async function setSession(sessionToken, organizationId = null) {
    await send("Network.clearBrowserCookies");
    if (sessionToken !== null) {
      await send("Network.setCookie", { name: "next-auth.session-token", value: sessionToken, domain: "localhost", path: "/", httpOnly: true });
    }
    if (organizationId !== null) {
      await send("Network.setCookie", { name: "meridian_org", value: organizationId, domain: "localhost", path: "/" });
    }
  }

  /**
   * Waits until React has attached to the element matching `selector` (its
   * props key is on the node). Values set or clicks made before that are lost
   * on hydration, or swallowed by a form's guard — a source of flaky runs.
   */
  async function whenInteractive(selector, timeoutMs = 30_000) {
    await waitFor(
      `${selector} to be interactive`,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps")); })()`,
      timeoutMs,
    );
  }

  /** Submits the open dialog and waits for it to close (success) — or reports its error. */
  async function submitDialog(label) {
    await click(`${label}: submit`, `window.__e2e.dialog()?.querySelector('button[type="submit"]')`);
    await waitFor(
      `${label}: dialog to close`,
      `(() => { const d = window.__e2e.dialog(); if (!d) return true;
        const alert = d.querySelector('[role="alert"], p.text-destructive'); if (alert && alert.textContent.trim()) throw new Error(alert.textContent.trim()); return false; })()`,
      30_000,
    );
  }

  /** Sets a file input's file the way a user picking it would (DOM.setFileInputFiles). */
  async function uploadFile(selector, path) {
    const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`no file input matching ${selector}`);
    await send("DOM.setFileInputFiles", { nodeId, files: [path] });
    await sleep(300);
  }

  async function closeDialog() {
    await key("Escape", "Escape", 27);
    await waitFor("dialog to close", `!window.__e2e.dialog()`);
  }

  await send("DOM.enable");
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");

  return {
    send,
    evaluate,
    waitFor,
    load,
    click,
    key,
    typeText,
    setSession,
    submitDialog,
    uploadFile,
    whenInteractive,
    closeDialog,
    close() {
      ws.close();
      chrome.kill();
    },
  };
}

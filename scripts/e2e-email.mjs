// End-to-end check of everything that goes through email, driven through
// headless Chrome over the DevTools protocol (scripts/e2e-lib.mjs). Messages
// are read from the app's local mail driver (lib/mail.ts).
//
//   npm run e2e:email        (app on http://localhost:3000; no RESEND_API_KEY)
//
//   1. Register -> a confirmation email arrives; the dashboard shows the
//      confirmation banner; inviting someone is refused until confirmed;
//      "Resend email" right away is rate-limited.
//   2. Open the emailed link -> "Email confirmed"; the banner is gone.
//   3. Add a user -> the dialog says the invite was emailed; the invite email
//      names the inviter and workspace; its link sets the invitee's password
//      and confirms their address.
//   4. Forgot password -> the same answer for an unknown address (and no
//      email); the reset email's link sets a new password; the session signed
//      in before the reset is cut off; the old password stops working and the
//      new one works; a "password changed" email follows; the link is single use.
// Everything it creates is deleted at the end, pass or fail.
import {
  APP,
  connectDb,
  createChecks,
  launchBrowser,
  linkPath,
  readMailbox,
  signIn,
  sleep,
  waitForMail,
} from "./e2e-lib.mjs";

const { check, fail, finish } = createChecks();
const { one, close: closeDb } = await connectDb();
const browser = await launchBrowser({ port: 9337 });
const { evaluate, waitFor, load, click, setSession, whenInteractive } = browser;

const stamp = Date.now().toString(36);
const founderEmail = `e2e-email-${stamp}@example.test`;
const inviteeEmail = `e2e-invitee-${stamp}@example.test`;
const password = `e2e-${stamp}-Password!`;
const newPassword = `e2e-${stamp}-Changed!`;
const inviteePassword = `e2e-${stamp}-Invitee!`;
const workspaceName = `E2E Mail Co ${stamp}`;
const createdUserEmails = [founderEmail, inviteeEmail];
const createdOrgNames = [workspaceName];

/** Whether a request carrying `token` still gets into the dashboard. */
async function sessionWorks(token) {
  const response = await fetch(`${APP}/dashboard/settings/profile`, {
    redirect: "manual",
    headers: { cookie: `next-auth.session-token=${token}` },
  });
  const location = response.headers.get("location") ?? "";
  if (response.status >= 300 && response.status < 400) {
    if (location.includes("/sign-in")) return false;
    throw new Error(`unexpected ${response.status} → ${location}`);
  }
  // Once a loading skeleton has started streaming, requireSession()'s redirect
  // can only arrive inside the 200 body, as Next's page-redirect meta tag.
  const body = await response.text();
  if (/__next-page-redirect[^>]*\/sign-in/.test(body) || /NEXT_REDIRECT;[^"]*\/sign-in/.test(body)) return false;
  if (response.status !== 200) throw new Error(`unexpected ${response.status}`);
  return true;
}

async function canSignIn(email, pass) {
  try {
    await signIn(email, pass);
    return true;
  } catch {
    return false;
  }
}

try {
  // 1. Register ---------------------------------------------------------------------------
  const registeredAt = Date.now();
  await setSession(null);
  await load("/register");
  await evaluate(`(() => {
    window.__e2e.set(document.getElementById("name"), "E2E Mail Founder");
    window.__e2e.set(document.getElementById("email"), ${JSON.stringify(founderEmail)});
    window.__e2e.set(document.getElementById("password"), ${JSON.stringify(password)});
    window.__e2e.set(document.getElementById("confirmPassword"), ${JSON.stringify(password)});
    return true; })()`);
  await click("Create account", `window.__e2e.byText('button[type="submit"]', "Create account")`);
  await waitFor("onboarding", `location.pathname === "/onboarding" && !!document.querySelector('[data-testid="onboarding-progress"]')`, 60_000);

  const confirmMail = await waitForMail(founderEmail, "Confirm your email", { after: registeredAt });
  check("1. registering sends a confirmation email", true, confirmMail.subject);
  check("1. it is addressed to the founder by name", confirmMail.text.includes("Hi E2E Mail Founder,"));

  await whenInteractive('input[name="name"]');
  await evaluate(`(() => {
    window.__e2e.set(document.querySelector('input[name="name"]'), ${JSON.stringify(workspaceName)});
    window.__e2e.set(document.querySelector('select[name="currency"]'), "USD");
    return true; })()`);
  await click("Create workspace", `window.__e2e.byText('button[type="submit"]', "Create workspace")`);
  await waitFor("step 2", `window.__e2e.text('[data-testid="onboarding-progress"]')?.includes("Step 2 of 2")`, 60_000);

  await load("/dashboard");
  const banner = await waitFor("confirmation banner", `window.__e2e.text('[data-testid="verify-email-banner"]')`);
  check("1. the dashboard shows the confirmation banner", banner.includes(founderEmail), banner);

  await click("Resend email", `window.__e2e.byText('[data-testid="verify-email-banner"] button', "Resend email")`);
  const resendReply = await waitFor(
    "resend reply",
    `(() => { const t = window.__e2e.text('[data-testid="verify-email-banner"]'); return t && /Try again|Sent/.test(t) ? t : null; })()`,
  );
  check("1. resending right away is rate-limited", /We just sent one\. Try again in \d+ seconds\./.test(resendReply), resendReply);

  await load("/dashboard/users?action=add", "/dashboard/users");
  await waitFor("add user dialog", `!!window.__e2e.dialog()?.querySelector('input[name="email"]')`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.set(d.querySelector('input[name="name"]'), "E2E Invitee");
    window.__e2e.set(d.querySelector('input[name="email"]'), ${JSON.stringify(inviteeEmail)});
    return true; })()`);
  await click("Add user: submit", `window.__e2e.dialog()?.querySelector('button[type="submit"]')`);
  const refusal = await waitFor("refusal", `window.__e2e.dialog()?.querySelector('[role="alert"]')?.textContent`);
  check("1. inviting is refused until the address is confirmed", refusal.includes("Confirm your email address first"), refusal);
  check("1. … and no account was created", (await one(`SELECT count(*)::int AS n FROM "User" WHERE email = $1`, [inviteeEmail])).n === 0);

  // 2. Confirm ------------------------------------------------------------------------------
  await load(linkPath(confirmMail, "verify-email"), "/email-verified");
  const confirmed = await waitFor("confirmed page", `window.__e2e.text('[data-testid="email-verified"]')`);
  check("2. the emailed link confirms the address", confirmed.includes("your email address is confirmed"), confirmed);
  check("2. … and leaves no token in the URL", !(await evaluate("location.href")).includes("verify-email/"));
  const founder = await one(`SELECT id, "emailVerified" FROM "User" WHERE email = $1`, [founderEmail]);
  check("2. emailVerified is set", founder?.emailVerified !== null);
  await load("/dashboard");
  check("2. the banner is gone", !(await evaluate(`!!document.querySelector('[data-testid="verify-email-banner"]')`)));
  await load(linkPath(confirmMail, "verify-email"), "/email-verified");
  check("2. the link works only once", (await evaluate("document.body.textContent")).includes("Link unavailable"));

  // 3. Invite by email ----------------------------------------------------------------------
  const invitedAt = Date.now();
  await load("/dashboard/users?action=add", "/dashboard/users");
  await waitFor("add user dialog", `!!window.__e2e.dialog()?.querySelector('input[name="email"]')`);
  await evaluate(`(() => { const d = window.__e2e.dialog();
    window.__e2e.set(d.querySelector('input[name="name"]'), "E2E Invitee");
    window.__e2e.set(d.querySelector('input[name="email"]'), ${JSON.stringify(inviteeEmail)});
    return true; })()`);
  await click("Add user: submit", `window.__e2e.dialog()?.querySelector('button[type="submit"]')`);
  const added = await waitFor("invite panel", `window.__e2e.dialog()?.textContent.includes("was added") ? window.__e2e.dialog().textContent : null`);
  check("3. the dialog says the invite was emailed", added.includes(`We've emailed an invite to ${inviteeEmail}`), added);

  const inviteMail = await waitForMail(inviteeEmail, "invited you to", { after: invitedAt });
  check("3. the invite email names the inviter and the workspace", inviteMail.subject === `E2E Mail Founder invited you to ${workspaceName} on Meridian`, inviteMail.subject);

  await setSession(null);
  await load(linkPath(inviteMail, "invite"));
  await waitFor("set password form", `!!document.getElementById("confirmPassword")`);
  await evaluate(`(() => {
    window.__e2e.set(document.getElementById("password"), ${JSON.stringify(inviteePassword)});
    window.__e2e.set(document.getElementById("confirmPassword"), ${JSON.stringify(inviteePassword)});
    return true; })()`);
  await click("Set password", `window.__e2e.byText('button[type="submit"]', "Set password")`);
  await waitFor("sign-in after invite", `location.pathname === "/sign-in" && location.search.includes("invited=1")`, 30_000);
  const invitee = await one(`SELECT "emailVerified", "passwordHash" IS NOT NULL AS "hasPassword" FROM "User" WHERE email = $1`, [inviteeEmail]);
  check("3. the invite link set the password", invitee?.hasPassword === true);
  check("3. … and counts as a confirmed address", invitee?.emailVerified !== null);
  check("3. the invitee can sign in", await canSignIn(inviteeEmail, inviteePassword));

  // 4. Password reset -------------------------------------------------------------------------
  const oldSession = await signIn(founderEmail, password);
  check("4. a session from before the reset works", await sessionWorks(oldSession));

  const unknownEmail = `e2e-nobody-${stamp}@example.test`;
  await load("/forgot-password");
  await evaluate(`(() => { window.__e2e.set(document.getElementById("email"), ${JSON.stringify(unknownEmail)}); return true; })()`);
  await click("Send reset link", `window.__e2e.byText('button[type="submit"]', "Send reset link")`);
  const unknownReply = await waitFor("reset requested", `window.__e2e.text('[data-testid="reset-requested"]')`);

  const requestedAt = Date.now();
  await load("/forgot-password");
  await evaluate(`(() => { window.__e2e.set(document.getElementById("email"), ${JSON.stringify(founderEmail.toUpperCase())}); return true; })()`);
  await click("Send reset link", `window.__e2e.byText('button[type="submit"]', "Send reset link")`);
  const knownReply = await waitFor("reset requested", `window.__e2e.text('[data-testid="reset-requested"]')`);
  check(
    "4. the same answer for an unknown and a known address",
    unknownReply.replace(unknownEmail, "<email>") === knownReply.replace(founderEmail, "<email>"),
    `${unknownReply} | ${knownReply}`,
  );
  await sleep(1500);
  check("4. no email for the unknown address", readMailbox(unknownEmail).length === 0);

  const resetMail = await waitForMail(founderEmail, "Reset your Meridian password", { after: requestedAt });
  check("4. the reset email arrives (the address matched case-insensitively)", true, resetMail.subject);
  const resetPath = linkPath(resetMail, "reset-password");
  await load(resetPath);
  await waitFor("new password form", `!!document.getElementById("confirmPassword")`);
  await evaluate(`(() => {
    window.__e2e.set(document.getElementById("password"), ${JSON.stringify(newPassword)});
    window.__e2e.set(document.getElementById("confirmPassword"), ${JSON.stringify(newPassword)});
    return true; })()`);
  await click("Save new password", `window.__e2e.byText('button[type="submit"]', "Save new password")`);
  await waitFor("sign-in after reset", `location.pathname === "/sign-in" && location.search.includes("reset=1")`, 30_000);
  check("4. the sign-in page confirms the change", (await evaluate("document.body.textContent")).includes("Password changed, and every other session signed out."));

  check("4. the session from before the reset is cut off", !(await sessionWorks(oldSession)));
  check("4. the old password no longer works", !(await canSignIn(founderEmail, password)));
  const fresh = await signIn(founderEmail, newPassword);
  check("4. the new password works, and its session gets in", await sessionWorks(fresh));
  const changedMail = await waitForMail(founderEmail, "password was changed", { after: requestedAt });
  check("4. a 'password changed' email follows", changedMail.text.includes("/forgot-password"), changedMail.subject);

  await load(resetPath);
  check("4. the reset link works only once", (await evaluate("document.body.textContent")).includes("Link unavailable"));
} catch (error) {
  fail(error);
} finally {
  // Workspaces first (their memberships cascade), then the users.
  try {
    const { db } = await connectDb();
    await db.query(`DELETE FROM "Organization" WHERE name = ANY($1)`, [createdOrgNames]);
    await db.query(`DELETE FROM "User" WHERE email = ANY($1)`, [createdUserEmails]);
    await db.end();
  } catch (cleanupError) {
    console.error("cleanup failed:", cleanupError);
  }
  browser.close();
  await closeDb();
}

finish();

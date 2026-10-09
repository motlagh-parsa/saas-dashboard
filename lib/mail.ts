import "server-only";

// Outgoing email, behind one function. Which driver runs is decided once, in
// lib/env.ts (`mailDriver`):
//
//   resend — RESEND_API_KEY is set. One POST to Resend's HTTP API with `fetch`;
//            no SDK, so nothing extra to install.
//   local  — no provider, but a mailbox directory: MAIL_DEV_DIR, or a temp
//            folder in development. Each message becomes one JSON file there,
//            and a one-line summary is logged. Development reads mail this way,
//            and so do the e2e scripts (scripts/e2e-lib.mjs → readMailbox).
//   none   — a production deployment with neither. `sendMail` reports false
//            and the callers already hid the features that need email.
//
// `sendMail` never throws. Email is a side effect of an action that has already
// succeeded (an account created, a token issued); a provider outage must not
// turn that into an error page. Failures are logged and reported as `false`.
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { env, mailDriver } from "@/lib/env";

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  /** Plain-text body — always sent, for clients that do not render HTML. */
  readonly text: string;
  readonly html: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;

/** The local driver's folder. Shared with scripts/e2e-lib.mjs, which reads it. */
export function localMailboxDir(): string {
  return env.MAIL_DEV_DIR ?? join(tmpdir(), "meridian-mail");
}

async function sendWithResend(message: MailMessage, apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      // The body names the problem (unverified domain, bad key) and holds no
      // secret; the recipient is left out of the log.
      console.error(`[mail] Resend refused "${message.subject}": ${response.status} ${await response.text()}`);
      return false;
    }
    return true;
  } catch (error: unknown) {
    console.error(`[mail] Resend request failed for "${message.subject}":`, error);
    return false;
  }
}

async function sendLocally(message: MailMessage): Promise<boolean> {
  try {
    const dir = localMailboxDir();
    await mkdir(dir, { recursive: true });
    const sentAt = new Date();
    // Time first so a directory listing sorts oldest → newest.
    const file = join(dir, `${sentAt.getTime()}-${randomBytes(4).toString("hex")}.json`);
    await writeFile(file, JSON.stringify({ ...message, from: env.MAIL_FROM, sentAt: sentAt.toISOString() }, null, 2));
    console.info(`[mail] (local) "${message.subject}" → ${message.to}  ${file}`);
    return true;
  } catch (error: unknown) {
    console.error(`[mail] could not write to the local mailbox:`, error);
    return false;
  }
}

/** Sends one message. Returns whether it was handed off; never throws. */
export async function sendMail(message: MailMessage): Promise<boolean> {
  switch (mailDriver) {
    case "resend":
      return sendWithResend(message, env.RESEND_API_KEY as string);
    case "local":
      return sendLocally(message);
    case "none":
      return false;
  }
}

import "server-only";

// Every email Meridian sends, as { subject, text, html }.
//
// One layout, plain and readable in any client: a single column, system fonts,
// inline styles only (most clients drop <style> blocks), one button whose URL is
// ALSO printed as text so it works where buttons don't. Every value that came
// from a user (names, workspace names) is HTML-escaped. No tracking pixels, no
// remote images.
import type { MailMessage } from "@/lib/mail";

type Template = Omit<MailMessage, "to">;

const BRAND = "Meridian";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface LayoutInput {
  readonly heading: string;
  /** Paragraphs, already written as plain text; escaped here. */
  readonly paragraphs: readonly string[];
  readonly action?: { readonly label: string; readonly url: string };
  /** Small print under the button (why you got this, what to do if it wasn't you). */
  readonly footnote: string;
}

function layout({ heading, paragraphs, action, footnote }: LayoutInput): { text: string; html: string } {
  const text = [
    heading,
    "",
    ...paragraphs.flatMap((p) => [p, ""]),
    ...(action ? [`${action.label}: ${action.url}`, ""] : []),
    footnote,
    "",
    `— ${BRAND}`,
  ].join("\n");

  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f6f5f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f2;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e7e4dc;border-radius:12px;">
<tr><td style="padding:32px 32px 8px;font-family:${font};">
<p style="margin:0 0 24px;font-size:13px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#8a6d2b;">${BRAND}</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#1c1b19;">${escapeHtml(heading)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3d3b36;">${escapeHtml(p)}</p>`).join("\n")}
${
  action
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#1c1b19;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:8px;">${escapeHtml(action.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#6b6860;">Or paste this link into your browser:<br><span style="word-break:break-all;color:#3d3b36;">${escapeHtml(action.url)}</span></p>`
    : ""
}
</td></tr>
<tr><td style="padding:8px 32px 32px;font-family:${font};">
<p style="margin:0;border-top:1px solid #eeebe4;padding-top:16px;font-size:12px;line-height:1.5;color:#8b887f;">${escapeHtml(footnote)}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { text, html };
}

function greeting(name: string | null): string {
  return name ? `Hi ${name},` : "Hi,";
}

export function verifyEmailTemplate(input: { name: string | null; url: string; hours: number }): Template {
  return {
    subject: `Confirm your email for ${BRAND}`,
    ...layout({
      heading: "Confirm your email address",
      paragraphs: [
        greeting(input.name),
        `Confirm that this is your email address to finish setting up your ${BRAND} account. The link works for ${input.hours} hours.`,
      ],
      action: { label: "Confirm email", url: input.url },
      footnote: `You're receiving this because this address was used to create a ${BRAND} account. If that wasn't you, ignore this email and nothing will happen.`,
    }),
  };
}

export function resetPasswordTemplate(input: { name: string | null; url: string; minutes: number }): Template {
  return {
    subject: `Reset your ${BRAND} password`,
    ...layout({
      heading: "Reset your password",
      paragraphs: [
        greeting(input.name),
        `Someone asked to reset the password for this ${BRAND} account. Use the link below to choose a new one. It works once, for ${input.minutes} minutes.`,
        "Resetting your password signs you out on every device.",
      ],
      action: { label: "Choose a new password", url: input.url },
      footnote: "If you didn't ask for this, ignore this email — your password stays as it is.",
    }),
  };
}

export function passwordChangedTemplate(input: { name: string | null; signInUrl: string; resetUrl: string }): Template {
  return {
    subject: `Your ${BRAND} password was changed`,
    ...layout({
      heading: "Your password was changed",
      paragraphs: [
        greeting(input.name),
        `The password for your ${BRAND} account was just changed.`,
        `If this wasn't you, reset your password now: ${input.resetUrl}`,
      ],
      action: { label: "Sign in", url: input.signInUrl },
      footnote: "We send this every time a password changes, so you always know.",
    }),
  };
}

export function inviteTemplate(input: {
  name: string | null;
  inviterName: string;
  workspaceName: string;
  url: string;
  days: number;
}): Template {
  return {
    subject: `${input.inviterName} invited you to ${input.workspaceName} on ${BRAND}`,
    ...layout({
      heading: `Join ${input.workspaceName} on ${BRAND}`,
      paragraphs: [
        greeting(input.name),
        `${input.inviterName} added you to the ${input.workspaceName} workspace on ${BRAND}, where your team tracks revenue, churn and retention.`,
        `Set a password to finish setting up your account. The link works once, for ${input.days} days.`,
      ],
      action: { label: "Set your password", url: input.url },
      footnote: "If you weren't expecting this, you can ignore it — the account stays inactive until a password is set.",
    }),
  };
}

/** Any in-app notification that is also emailed (lib/notification-writer.ts). */
export function notificationTemplate(input: {
  workspaceName: string;
  title: string;
  body: string;
  url: string;
  manageUrl: string;
}): Template {
  return {
    subject: `${input.title} · ${input.workspaceName}`,
    ...layout({
      heading: input.title,
      paragraphs: [input.body, `Workspace: ${input.workspaceName}`],
      action: { label: "Open in Meridian", url: input.url },
      footnote: `Choose which notifications reach your inbox in your profile settings: ${input.manageUrl}`,
    }),
  };
}

/** A scheduled report, with its CSV attached (lib/report-schedules.ts). */
export function scheduledReportTemplate(input: {
  name: string | null;
  workspaceName: string;
  reportName: string;
  frequencyWord: string;
  url: string;
  manageUrl: string;
}): Template {
  return {
    subject: `${input.reportName} — ${input.workspaceName}`,
    ...layout({
      heading: input.reportName,
      paragraphs: [
        greeting(input.name),
        `Your ${input.frequencyWord} ${input.reportName} report for ${input.workspaceName} is attached as a CSV file.`,
      ],
      action: { label: "Open Reports", url: input.url },
      footnote: `You scheduled this report yourself. Stop or change it on the Reports page: ${input.manageUrl}`,
    }),
  };
}

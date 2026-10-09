/**
 * The notifications half of `npm run verify:metrics`: the alert engine, the
 * weekly summary, who gets what by email, and scheduled reports — through the
 * lib functions the daily job and the billing writes call.
 *
 * Fixture (dates relative to today, T): plan Pro 1,000.00/month, plan Lite
 * 50.00/month. Big Co on Pro and Small Co on Lite since T−40 → MRR 1,050.00.
 *   1. First evaluation: the $1,000 milestone, once.
 *   2. Big Co cancels at T−1 → churn alert (Big Co, 1,000.00) and a revenue dip
 *      (1,050 → 50, −95%), each once.
 *   3. An OPEN invoice due T−3 and an UNCOLLECTIBLE one → one "2 invoices need
 *      attention", once.
 *   4. The weekly summary, once per week.
 *   5. Email: the owner gets the default types; the member gets none; a member
 *      who opted in gets it; an owner who opted out doesn't. A workspace with
 *      sample data gets alerts in the app only.
 *   6. Scheduled reports: next-run dates, a due schedule emails its creator the
 *      CSV, advances, records a run and a personal notification; a schedule of
 *      someone who left the workspace is removed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { evaluateAlerts, sendWeeklySummary } from "@/lib/alerts";
import { localMailboxDir } from "@/lib/mail";
import { mutedInAppTypes } from "@/lib/notification-preferences";
import { prisma } from "@/lib/prisma";
import { nextRunAfter, runDueSchedules } from "@/lib/report-schedules";
import { generateSampleData } from "@/lib/sample-data";
import { DAY_MS, utcDayStart } from "@/lib/snapshot-formula";
import { recomputeSnapshots } from "@/lib/snapshots";

type Check = (label: string, actual: unknown, expected: unknown) => void;

interface StoredMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly attachments?: readonly { filename: string; content: string }[];
}

function mailTo(to: string): StoredMail[] {
  try {
    const dir = localMailboxDir();
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as StoredMail)
      .filter((mail) => mail.to === to);
  } catch {
    return [];
  }
}

const T = utcDayStart(new Date());
const at = (days: number): Date => new Date(T.getTime() + days * DAY_MS);

export async function verifyNotifications(check: Check, stamp: string): Promise<string[]> {
  console.log("\n── notifications: alerts, weekly summary, email, scheduled reports ──");
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const email = (label: string): string => `notify-${label}-${stamp}@example.test`;

  try {
    const org = await prisma.organization.create({
      data: { name: `Notify ${stamp}`, slug: `notify-${stamp}`, currency: "USD" },
      select: { id: true },
    });
    orgIds.push(org.id);
    const makeMember = async (label: string, role: "OWNER" | "ADMIN" | "MEMBER", organizationId = org.id) => {
      const user = await prisma.user.create({ data: { name: `Notify ${label}`, email: email(label) }, select: { id: true, email: true } });
      userIds.push(user.id);
      await prisma.membership.create({ data: { userId: user.id, organizationId, role } });
      return user;
    };
    const owner = await makeMember("owner", "OWNER");
    const member = await makeMember("member", "MEMBER");
    const keenMember = await makeMember("keen-member", "MEMBER");
    const quietAdmin = await makeMember("quiet-admin", "ADMIN");
    await prisma.notificationPreference.createMany({
      data: [
        { userId: keenMember.id, type: "CHURN_ALERT", inApp: true, email: true },
        { userId: quietAdmin.id, type: "CHURN_ALERT", inApp: false, email: false },
      ],
    });

    const [pro, lite] = await Promise.all([
      prisma.plan.create({ data: { organizationId: org.id, name: "Pro", amountCents: 100_000, interval: "MONTH" }, select: { id: true } }),
      prisma.plan.create({ data: { organizationId: org.id, name: "Lite", amountCents: 5_000, interval: "MONTH" }, select: { id: true } }),
    ]);
    const [big, small] = await Promise.all([
      prisma.customer.create({ data: { organizationId: org.id, name: "Big Co" }, select: { id: true } }),
      prisma.customer.create({ data: { organizationId: org.id, name: "Small Co" }, select: { id: true } }),
    ]);
    const bigSub = await prisma.subscription.create({
      data: { organizationId: org.id, customerId: big.id, planId: pro.id, amountCents: 100_000, interval: "MONTH", startedAt: at(-40) },
      select: { id: true },
    });
    await prisma.subscription.create({
      data: { organizationId: org.id, customerId: small.id, planId: lite.id, amountCents: 5_000, interval: "MONTH", startedAt: at(-40) },
    });
    await recomputeSnapshots(org.id, at(-40));

    const titles = async (): Promise<string[]> =>
      (await prisma.notification.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: "asc" }, select: { title: true } })).map(
        (row) => row.title,
      );

    // 1. Milestone --------------------------------------------------------------
    const first = await evaluateAlerts(org.id);
    check("milestone: raised on first evaluation", first.raised, ["MRR_MILESTONE"]);
    check("milestone: the highest round number reached", (await titles()).at(-1), "MRR passed $1,000");
    check("milestone: not repeated", (await evaluateAlerts(org.id)).raised, []);

    // 2. Churn and dip ----------------------------------------------------------
    await prisma.subscription.update({ where: { id: bigSub.id }, data: { endedAt: at(-1), canceledAt: at(-1), status: "CANCELED" } });
    await recomputeSnapshots(org.id, at(-1));
    const second = await evaluateAlerts(org.id);
    check("churn + dip: both raised", [...second.raised].sort(), ["CHURN_ALERT", "REVENUE_DIP"]);
    const afterChurn = await titles();
    check("churn: names the customer", afterChurn.includes("Big Co churned"), true);
    check("dip: states the fall", afterChurn.some((title) => title.startsWith("MRR down 95")), true);
    check("churn + dip: not repeated", (await evaluateAlerts(org.id)).raised, []);

    // 3. Invoices ---------------------------------------------------------------
    await prisma.invoice.createMany({
      data: [
        { organizationId: org.id, customerId: small.id, amountCents: 5_000, status: "OPEN", issuedAt: at(-10), dueAt: at(-3) },
        { organizationId: org.id, customerId: big.id, amountCents: 100_000, status: "UNCOLLECTIBLE", issuedAt: at(-20) },
        { organizationId: org.id, customerId: small.id, amountCents: 5_000, status: "OPEN", issuedAt: at(-1), dueAt: at(5) },
      ],
    });
    check("invoices: one notification for both", (await evaluateAlerts(org.id)).raised, ["INVOICE_OVERDUE"]);
    check("invoices: counts and the largest", (await titles()).at(-1), "2 invoices need attention");
    check("invoices: not repeated", (await evaluateAlerts(org.id)).raised, []);

    // 4. Weekly summary ---------------------------------------------------------
    check("weekly summary: sent", await sendWeeklySummary(org.id), true);
    check("weekly summary: once a week", await sendWeeklySummary(org.id), false);
    const summary = await prisma.notification.findFirst({ where: { organizationId: org.id, type: "WEEKLY_SUMMARY" }, select: { title: true, body: true } });
    check("weekly summary: today's MRR", summary?.title, "Your week: MRR $50");
    check("weekly summary: one churned customer this week", summary?.body.includes("1 churned"), true);

    // 5. Email ------------------------------------------------------------------
    const churnMail = (address: string) => mailTo(address).filter((mail) => mail.subject.startsWith("Big Co churned"));
    check("email: the owner gets churn alerts by default", churnMail(owner.email).length, 1);
    check("email: a member gets none by default", churnMail(member.email).length, 0);
    check("email: a member who opted in gets it", churnMail(keenMember.email).length, 1);
    check("email: an admin who opted out doesn't", churnMail(quietAdmin.email).length, 0);
    check("email: the subject names the workspace", churnMail(owner.email)[0]?.subject, `Big Co churned · Notify ${stamp}`);
    check("in-app mute: the opted-out admin's muted types", await mutedInAppTypes(quietAdmin.id), ["CHURN_ALERT"]);

    const sampleOrg = await prisma.organization.create({
      data: { name: `Notify sample ${stamp}`, slug: `notify-sample-${stamp}`, currency: "USD" },
      select: { id: true },
    });
    orgIds.push(sampleOrg.id);
    const sampleOwner = await makeMember("sample-owner", "OWNER", sampleOrg.id);
    await generateSampleData(sampleOrg.id);
    const sampleRun = await evaluateAlerts(sampleOrg.id);
    check("sample data: alerts are raised in the app", sampleRun.raised.length > 0, true);
    check("sample data: but never emailed", mailTo(sampleOwner.email).length, 0);

    // 6. Scheduled reports ------------------------------------------------------
    const wednesday = new Date(Date.UTC(2026, 9, 7, 15)); // 2026-10-07 is a Wednesday
    check("weekly: next Monday", nextRunAfter("WEEKLY", wednesday).toISOString(), "2026-10-12T00:00:00.000Z");
    check("weekly: from a Monday, the following one", nextRunAfter("WEEKLY", new Date(Date.UTC(2026, 9, 12, 0, 10))).toISOString(), "2026-10-19T00:00:00.000Z");
    check("monthly: the 1st of next month", nextRunAfter("MONTHLY", wednesday).toISOString(), "2026-11-01T00:00:00.000Z");
    check("quarterly: the next quarter", nextRunAfter("QUARTERLY", new Date(Date.UTC(2026, 1, 20))).toISOString(), "2026-04-01T00:00:00.000Z");
    check("quarterly: across the year", nextRunAfter("QUARTERLY", new Date(Date.UTC(2026, 11, 5))).toISOString(), "2027-01-01T00:00:00.000Z");

    const due = await prisma.reportSchedule.create({
      data: { organizationId: org.id, userId: owner.id, reportId: "mrr-summary", frequency: "MONTHLY", nextRunAt: new Date(Date.now() - 60_000) },
      select: { id: true },
    });
    const leaver = await makeMember("leaver", "MEMBER");
    const orphan = await prisma.reportSchedule.create({
      data: { organizationId: org.id, userId: leaver.id, reportId: "churn-analysis", frequency: "WEEKLY", nextRunAt: new Date(Date.now() - 60_000) },
      select: { id: true },
    });
    await prisma.membership.delete({ where: { userId_organizationId: { userId: leaver.id, organizationId: org.id } } });

    const result = await runDueSchedules();
    check("schedules: the due one is sent", result.sent >= 1, true);
    check("schedules: a leaver's schedule is removed", await prisma.reportSchedule.findUnique({ where: { id: orphan.id } }), null);
    const reportMail = mailTo(owner.email).filter((mail) => mail.subject.startsWith("MRR Summary")).at(-1);
    check("schedules: the email names the report and workspace", reportMail?.subject, `MRR Summary — Notify ${stamp}`);
    check("schedules: the CSV is attached", reportMail?.attachments?.[0]?.filename.startsWith("mrr-summary-"), true);
    check("schedules: … with the report's header row", reportMail?.attachments?.[0]?.content.split("\r\n")[0].includes("(USD)"), true);
    const advanced = await prisma.reportSchedule.findUniqueOrThrow({ where: { id: due.id }, select: { nextRunAt: true, lastSentAt: true } });
    check("schedules: moved to the 1st of next month", advanced.nextRunAt.getUTCDate() === 1 && advanced.nextRunAt > new Date(), true);
    check("schedules: lastSentAt stamped", advanced.lastSentAt instanceof Date, true);
    check("schedules: a report run is recorded", await prisma.reportRun.count({ where: { organizationId: org.id, reportId: "mrr-summary" } }), 1);
    const personal = await prisma.notification.findFirst({ where: { organizationId: org.id, type: "REPORT_READY" }, select: { userId: true } });
    check("schedules: a personal notification for its owner", personal?.userId, owner.id);
    check("schedules: not sent twice", (await runDueSchedules()).sent, 0);
  } finally {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  return [];
}

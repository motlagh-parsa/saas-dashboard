import "server-only";

// Reports emailed on a schedule, to the person who scheduled them. Sent by the
// daily job (app/api/cron/snapshots/route.ts → runDueSchedules).
//
// Recipients are deliberately not free text: a schedule always mails its own
// creator, at their account address, and only while they still belong to the
// workspace. A report is the workspace's revenue; it does not leave for an
// address nobody verified.
import type { ReportFrequency } from "@prisma/client";

import { appUrl, isMailEnabled } from "@/lib/env";
import { sendMail } from "@/lib/mail";
import { scheduledReportTemplate } from "@/lib/mail-templates";
import { createNotification } from "@/lib/notification-writer";
import { prisma } from "@/lib/prisma";
import { SCHEDULE_FREQUENCIES } from "@/lib/report-schedule-form";
import { buildReport, isReportId } from "@/lib/reports";
import { REPORTS } from "@/components/dashboard/report-catalogue";

/**
 * The next send after `from`, at 00:00 UTC — the daily job runs at 00:10 UTC,
 * so a schedule is sent on its day. Weekly: next Monday. Monthly: the 1st of
 * next month. Quarterly: the 1st of the next quarter.
 */
export function nextRunAfter(frequency: ReportFrequency, from: Date): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();
  switch (frequency) {
    case "WEEKLY": {
      const weekday = from.getUTCDay(); // 0 Sunday … 6 Saturday
      const days = ((8 - weekday) % 7) || 7;
      return new Date(Date.UTC(y, m, d + days));
    }
    case "MONTHLY":
      return new Date(Date.UTC(y, m + 1, 1));
    case "QUARTERLY":
      return new Date(Date.UTC(y, Math.floor(m / 3) * 3 + 3, 1));
  }
}

export interface ScheduleRunResult {
  readonly due: number;
  readonly sent: number;
  readonly removed: number;
  readonly failed: number;
}

/** Sends every schedule whose time has come, and moves each to its next date. */
export async function runDueSchedules(now: Date = new Date()): Promise<ScheduleRunResult> {
  const due = await prisma.reportSchedule.findMany({
    where: { nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: 500,
    select: {
      id: true,
      organizationId: true,
      reportId: true,
      frequency: true,
      user: { select: { id: true, name: true, email: true, suspendedAt: true } },
      organization: { select: { name: true } },
    },
  });

  let sent = 0;
  let removed = 0;
  let failed = 0;
  for (const schedule of due) {
    try {
      const member = await prisma.membership.findUnique({
        where: { userId_organizationId: { userId: schedule.user.id, organizationId: schedule.organizationId } },
        select: { role: true },
      });
      // Left the workspace, unknown report: the schedule no longer means anything.
      if (member === null || !isReportId(schedule.reportId)) {
        await prisma.reportSchedule.delete({ where: { id: schedule.id } });
        removed += 1;
        continue;
      }
      // Advance first: a crash after sending must not send twice tomorrow.
      await prisma.reportSchedule.update({
        where: { id: schedule.id },
        data: { nextRunAt: nextRunAfter(schedule.frequency, now), lastSentAt: now },
      });
      if (schedule.user.suspendedAt !== null || !isMailEnabled) continue;

      const report = await buildReport(schedule.organizationId, schedule.reportId, now);
      const definition = REPORTS.find((entry) => entry.id === schedule.reportId);
      const reportName = definition?.name ?? schedule.reportId;
      const frequencyWord = SCHEDULE_FREQUENCIES.find((entry) => entry.value === schedule.frequency)?.word ?? "";
      const base = appUrl();
      const ok = await sendMail({
        to: schedule.user.email,
        ...scheduledReportTemplate({
          name: schedule.user.name,
          workspaceName: schedule.organization.name,
          reportName,
          frequencyWord,
          url: `${base}/dashboard/reports`,
          manageUrl: `${base}/dashboard/reports`,
        }),
        attachments: [{ filename: report.filename, content: report.csv }],
      });
      if (!ok) {
        failed += 1;
        continue;
      }
      sent += 1;
      await prisma.reportRun.create({
        data: { organizationId: schedule.organizationId, reportId: schedule.reportId, generatedAt: now },
      });
      await createNotification(
        {
          organizationId: schedule.organizationId,
          userId: schedule.user.id,
          type: "REPORT_READY",
          title: `${reportName} sent`,
          body: `Your ${frequencyWord} ${reportName} report was emailed to ${schedule.user.email}.`,
        },
        // The email IS the report; a second "your report is ready" email would be noise.
        { email: false },
      );
    } catch (error: unknown) {
      failed += 1;
      console.error("[reports] scheduled send failed", { scheduleId: schedule.id, error });
    }
  }
  return { due: due.length, sent, removed, failed };
}

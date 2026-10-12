"use server";

// Scheduling a report, and stopping one. Any member can schedule — every member
// can already download every report — and each schedule mails only its creator
// (lib/report-schedules.ts). People manage their own schedules, nobody else's.
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { requireSession } from "@/lib/auth";
import { isMailEnabled } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { demoRefusal } from "@/lib/demo";
import { scheduleSchema, type ScheduleState } from "@/lib/report-schedule-form";
import { nextRunAfter } from "@/lib/report-schedules";

const STALE_PAGE = "This page is out of date. Reload it and try again.";
const REPORTS_PATH = "/dashboard/reports";
const ID_PATTERN = /^[a-z0-9]{20,40}$/i;

function failure(message: string | null, fieldErrors: ScheduleState["fieldErrors"] = {}): ScheduleState {
  return { status: "error", message, fieldErrors };
}

export async function createReportSchedule(_previous: ScheduleState, formData: FormData): Promise<ScheduleState> {
  const session = await requireSession();
  if (!isMailEnabled) return failure("This deployment doesn't send email, so reports can't be scheduled.");
  const demo = await demoRefusal(session.user.id);
  if (demo !== null) return failure(demo);

  const organizationId = formData.get("organizationId");
  if (typeof organizationId !== "string" || !ID_PATTERN.test(organizationId)) return failure(STALE_PAGE);
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: session.user.id, organizationId } },
    select: { role: true },
  });
  if (membership === null) return failure(STALE_PAGE);

  const parsed = scheduleSchema.safeParse({ reportId: formData.get("reportId"), frequency: formData.get("frequency") });
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
    return failure(null, { reportId: fieldErrors.reportId?.[0], frequency: fieldErrors.frequency?.[0] });
  }
  const { reportId, frequency } = parsed.data;
  const nextRunAt = nextRunAfter(frequency, new Date());

  try {
    await prisma.reportSchedule.upsert({
      where: { organizationId_userId_reportId: { organizationId, userId: session.user.id, reportId } },
      create: { organizationId, userId: session.user.id, reportId, frequency, nextRunAt },
      update: { frequency, nextRunAt },
    });
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return failure("You just scheduled this report in another tab. Reload to see it.");
    }
    throw error;
  }

  revalidatePath(REPORTS_PATH);
  return { status: "success", message: null, fieldErrors: {} };
}

export async function deleteReportSchedule(_previous: ScheduleState, formData: FormData): Promise<ScheduleState> {
  const session = await requireSession();
  const scheduleId = formData.get("scheduleId");
  if (typeof scheduleId !== "string" || !ID_PATTERN.test(scheduleId)) return failure(STALE_PAGE);
  // Scoped to the caller in the DELETE itself: someone else's id matches nothing.
  const { count } = await prisma.reportSchedule.deleteMany({ where: { id: scheduleId, userId: session.user.id } });
  if (count === 0) return failure("That schedule no longer exists.");
  revalidatePath(REPORTS_PATH);
  return { status: "success", message: "Schedule stopped.", fieldErrors: {} };
}

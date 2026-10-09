"use client";

// The signed-in person's own report schedules on the Reports page, each with a
// Stop button. Rendered only when they have at least one.
import { useActionState } from "react";
import { Loader2 } from "lucide-react";

import { deleteReportSchedule } from "@/lib/report-schedule-actions";
import { IDLE_SCHEDULE } from "@/lib/report-schedule-form";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/dashboard/use-toast";

export interface ScheduleRow {
  readonly id: string;
  readonly reportName: string;
  readonly frequencyLabel: string;
  /** Pre-formatted on the server, so the text hydrates as rendered. */
  readonly nextSend: string;
}

export function ReportSchedulesList({ schedules, email }: { schedules: readonly ScheduleRow[]; email: string }) {
  return (
    <ul className="divide-y divide-border" data-testid="report-schedules">
      {schedules.map((schedule) => (
        <li key={schedule.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{schedule.reportName}</p>
            <p className="text-xs text-muted-foreground">
              {schedule.frequencyLabel} to {email} · next {schedule.nextSend}
            </p>
          </div>
          <StopButton scheduleId={schedule.id} label={schedule.reportName} />
        </li>
      ))}
    </ul>
  );
}

function StopButton({ scheduleId, label }: { scheduleId: string; label: string }) {
  const [, formAction, pending] = useActionState(
    async (...args: Parameters<typeof deleteReportSchedule>) => {
      const result = await deleteReportSchedule(...args);
      if (result.status === "success") toast.success("Schedule stopped", { description: label });
      else if (result.status === "error") toast.error("Couldn't stop the schedule", { description: result.message ?? undefined });
      return result;
    },
    IDLE_SCHEDULE,
  );
  return (
    <form action={formAction}>
      <input type="hidden" name="scheduleId" value={scheduleId} />
      <Button type="submit" variant="outline" aria-label={`Stop ${label} schedule`} className="h-11 px-3 sm:h-8">
        {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
        Stop
      </Button>
    </form>
  );
}

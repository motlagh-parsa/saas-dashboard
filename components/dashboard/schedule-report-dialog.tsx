"use client";

// "Schedule report" — the page's primary action, and its dialog. Saves a real
// ReportSchedule (lib/report-schedule-actions.ts); the daily job emails the CSV
// to the person who scheduled it (lib/report-schedules.ts). Recipients are not
// free text on purpose: a schedule only ever mails its creator's own address.
//
// Validation: one Zod schema (lib/report-schedule-form.ts), here for instant
// feedback and again in the action, which is the check that counts.
import { useActionState, useId, useState } from "react";
import type { FormEvent } from "react";
import { CalendarClock } from "lucide-react";
import { z } from "zod";

import { cn } from "@/lib/utils";
import { createReportSchedule } from "@/lib/report-schedule-actions";
import {
  IDLE_SCHEDULE,
  SCHEDULE_FREQUENCIES,
  scheduleSchema,
  type ScheduleField,
  type ScheduleState,
} from "@/lib/report-schedule-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { REPORTS } from "@/components/dashboard/report-catalogue";
import { toast } from "@/components/dashboard/use-toast";

const SELECT_CLASS =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 sm:h-8 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

const ERROR_CLASS = "text-xs text-destructive";

interface ScheduleReportDialogProps {
  organizationId: string;
  /** Where the report will be sent: the signed-in user's own address. */
  email: string;
}

type Draft = Record<ScheduleField, string>;

export function ScheduleReportDialog({ organizationId, email }: ScheduleReportDialogProps) {
  const [open, setOpen] = useState<boolean>(false);
  const [attempt, setAttempt] = useState<number>(0);

  function handleOpenChange(next: boolean): void {
    if (next) setAttempt((previous) => previous + 1);
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9">
          <CalendarClock aria-hidden />
          Schedule report
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule a report</DialogTitle>
          <DialogDescription>
            We&apos;ll email it to <span className="font-medium text-foreground">{email}</span> as a CSV file, on the
            schedule you choose.
          </DialogDescription>
        </DialogHeader>
        {/* Keyed by attempt: every open starts from a clean form. */}
        <ScheduleForm key={attempt} organizationId={organizationId} onSaved={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ScheduleForm({ organizationId, onSaved }: { organizationId: string; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>({ reportId: "", frequency: "MONTHLY" });
  const [clientErrors, setClientErrors] = useState<ScheduleState["fieldErrors"]>({});
  const baseId = useId();
  const fieldId = (field: ScheduleField): string => `${baseId}-${field}`;
  const errorId = (field: ScheduleField): string => `${baseId}-${field}-error`;

  const [state, formAction, pending] = useActionState(
    async (previous: ScheduleState, formData: FormData): Promise<ScheduleState> => {
      const result = await createReportSchedule(previous, formData);
      if (result.status === "success") {
        const report = REPORTS.find((entry) => entry.id === draft.reportId)?.name ?? "Report";
        const frequency = SCHEDULE_FREQUENCIES.find((entry) => entry.value === draft.frequency);
        toast.success("Report scheduled", { description: `${report}, ${frequency?.hint ?? ""}.` });
        onSaved();
      }
      return result;
    },
    IDLE_SCHEDULE,
  );

  const errors = { ...clientErrors, ...state.fieldErrors };

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (pending) {
      event.preventDefault();
      return;
    }
    const result = scheduleSchema.safeParse(draft);
    if (result.success) {
      setClientErrors({});
      return;
    }
    event.preventDefault();
    const { fieldErrors } = z.flattenError(result.error);
    setClientErrors({ reportId: fieldErrors.reportId?.[0], frequency: fieldErrors.frequency?.[0] });
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="grid gap-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      {state.message ? (
        <p role="alert" className={ERROR_CLASS}>
          {state.message}
        </p>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor={fieldId("reportId")}>Report</Label>
        <select
          id={fieldId("reportId")}
          name="reportId"
          value={draft.reportId}
          onChange={(event) => {
            setDraft((previous) => ({ ...previous, reportId: event.target.value }));
            setClientErrors((previous) => ({ ...previous, reportId: undefined }));
          }}
          aria-invalid={errors.reportId ? true : undefined}
          aria-describedby={errors.reportId ? errorId("reportId") : undefined}
          className={cn(SELECT_CLASS, draft.reportId === "" && "text-muted-foreground")}
        >
          <option value="" disabled>
            Select a report
          </option>
          {REPORTS.map((report) => (
            <option key={report.id} value={report.id} className="text-foreground">
              {report.name}
            </option>
          ))}
        </select>
        {errors.reportId ? (
          <p id={errorId("reportId")} className={ERROR_CLASS}>
            {errors.reportId}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor={fieldId("frequency")}>Frequency</Label>
        <select
          id={fieldId("frequency")}
          name="frequency"
          value={draft.frequency}
          onChange={(event) => setDraft((previous) => ({ ...previous, frequency: event.target.value }))}
          aria-describedby={`${fieldId("frequency")}-hint`}
          className={SELECT_CLASS}
        >
          {SCHEDULE_FREQUENCIES.map((frequency) => (
            <option key={frequency.value} value={frequency.value}>
              {frequency.label}
            </option>
          ))}
        </select>
        <p id={`${fieldId("frequency")}-hint`} className="text-xs text-muted-foreground">
          Sent {SCHEDULE_FREQUENCIES.find((entry) => entry.value === draft.frequency)?.hint}. Scheduling the same report
          again changes its frequency.
        </p>
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" className="h-11 sm:h-8">
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="submit"
          aria-disabled={pending ? "true" : undefined}
          className="h-11 bg-brand text-brand-foreground hover:bg-brand/90 sm:h-8"
        >
          {pending ? "Saving…" : "Save schedule"}
        </Button>
      </DialogFooter>
    </form>
  );
}

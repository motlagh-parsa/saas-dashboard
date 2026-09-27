"use client";

// "Schedule report" — the page's primary action, and its dialog. Client, because
// it owns the open state and the form draft. The page passes in the signed-in
// user's email; the report list comes from the same catalogue the cards render.
//
// NOT LIVE. There is no schedule table and no job runner, so "Save schedule" is
// `aria-disabled` and says why, and submitting does nothing — it neither closes
// the dialog nor confirms a save that did not happen. The form and its validation
// stay so the feature is one flag and one write away.
//
// Validation: the Zod schema below is the single source of truth for both the
// rules and the submitted type. The form is `noValidate` so the browser does not
// run a second, differently-worded pass over the same fields.
import { useId, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { CalendarClock } from "lucide-react";
import { z } from "zod";

import { cn } from "@/lib/utils";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { REPORTS } from "@/components/dashboard/report-catalogue";

/** Flip once a schedule model and a job runner exist to save and send one. */
const SCHEDULING_ACTIVE = false;

const SCHEDULING_INACTIVE_NOTE = "Scheduling is not yet active — coming soon.";

const FREQUENCIES = ["Weekly", "Monthly", "Quarterly"] as const;

const scheduleSchema = z.object({
  reportId: z.enum(
    REPORTS.map((report) => report.id),
    { error: "Choose a report." },
  ),
  frequency: z.enum(FREQUENCIES, { error: "Choose a frequency." }),
  email: z.email({ error: "Enter a valid email address." }),
});

type ScheduleInput = z.infer<typeof scheduleSchema>;
type ScheduleField = keyof ScheduleInput;

/** The raw form state: every field is a string until the schema says otherwise. */
type ScheduleDraft = Record<ScheduleField, string>;
type ScheduleErrors = Partial<Record<ScheduleField, string>>;

/** Order in which fields appear, so the first invalid one can take focus. */
const FIELD_ORDER: readonly ScheduleField[] = ["reportId", "frequency", "email"];

/**
 * Native `<select>` dressed as the app's `Input`. Stand-in for the shadcn Select,
 * which could not be added in this pass (see hand-off notes). Native keeps the
 * label association, keyboard behavior and screen-reader semantics for free.
 */
const SELECT_CLASS =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 sm:h-8 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

const ERROR_CLASS = "text-xs text-destructive";

interface ScheduleReportDialogProps {
  /** Pre-fills the recipient field. */
  defaultEmail: string;
}

export function ScheduleReportDialog({ defaultEmail }: ScheduleReportDialogProps) {
  const initialDraft: ScheduleDraft = {
    reportId: "",
    frequency: "Monthly",
    email: defaultEmail,
  };

  const [open, setOpen] = useState<boolean>(false);
  const [draft, setDraft] = useState<ScheduleDraft>(initialDraft);
  const [errors, setErrors] = useState<ScheduleErrors>({});

  const baseId = useId();
  const fieldId = (field: ScheduleField): string => `${baseId}-${field}`;
  const errorId = (field: ScheduleField): string => `${baseId}-${field}-error`;
  const inactiveNoteId = `${baseId}-inactive-note`;

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    // Every open starts from a clean form; reset on close, in the event handler,
    // rather than deriving it in an effect.
    if (!next) {
      setDraft(initialDraft);
      setErrors({});
    }
  }

  function updateField(field: ScheduleField) {
    return (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>): void => {
      const { value } = event.target;
      setDraft((previous) => ({ ...previous, [field]: value }));
      if (errors[field]) {
        setErrors((previous) => ({ ...previous, [field]: undefined }));
      }
    };
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // `aria-disabled` keeps the button focusable (so its reason can be read), which
    // means a press — or Enter inside a field — still submits. Nothing to save to,
    // so nothing happens: no validation errors for a form that cannot be saved.
    if (!SCHEDULING_ACTIVE) return;

    const result = scheduleSchema.safeParse(draft);

    if (!result.success) {
      const { fieldErrors } = z.flattenError(result.error);
      const nextErrors: ScheduleErrors = {
        reportId: fieldErrors.reportId?.[0],
        frequency: fieldErrors.frequency?.[0],
        email: fieldErrors.email?.[0],
      };
      setErrors(nextErrors);

      const firstInvalid = FIELD_ORDER.find((field) => nextErrors[field]);
      if (firstInvalid) {
        const control = event.currentTarget.elements.namedItem(firstInvalid);
        if (control instanceof HTMLElement) control.focus();
      }
      return;
    }

    // Validated, and this is where the write goes once `SCHEDULING_ACTIVE` is
    // true. Confirm with a toast only AFTER that write succeeds.
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/*
        The page's one primary action, and the only brass on the screen — same
        treatment Settings gives "Invite member". Scheduling is the durable action;
        generating is something you do once.
      */}
      <DialogTrigger asChild>
        <Button
          type="button"
          className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9"
        >
          <CalendarClock aria-hidden />
          Schedule report
          {/* Said before the dialog opens, not only inside it. Mono caps in a
              pill, the same quiet marker every unbuilt surface uses, but tinted
              from the button's own foreground: the muted token would vanish on
              brass. Visible text is terse; the accessible name reads it in full. */}
          {SCHEDULING_ACTIVE ? null : (
            <>
              <span
                aria-hidden
                className="rounded-full bg-brand-foreground/15 px-1.5 py-px font-mono text-[0.625rem] font-medium tracking-[0.12em] text-brand-foreground uppercase"
              >
                Soon
              </span>
              <span className="sr-only">(coming soon)</span>
            </>
          )}
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule a report</DialogTitle>
          <DialogDescription>
            Choose a report and how often it should be sent.
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={fieldId("reportId")}>Report</Label>
            <select
              id={fieldId("reportId")}
              name="reportId"
              value={draft.reportId}
              onChange={updateField("reportId")}
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
              onChange={updateField("frequency")}
              aria-invalid={errors.frequency ? true : undefined}
              aria-describedby={errors.frequency ? errorId("frequency") : undefined}
              className={SELECT_CLASS}
            >
              {FREQUENCIES.map((frequency) => (
                <option key={frequency} value={frequency}>
                  {frequency}
                </option>
              ))}
            </select>
            {errors.frequency ? (
              <p id={errorId("frequency")} className={ERROR_CLASS}>
                {errors.frequency}
              </p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label htmlFor={fieldId("email")}>Send to</Label>
            <Input
              id={fieldId("email")}
              name="email"
              type="email"
              autoComplete="email"
              value={draft.email}
              onChange={updateField("email")}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? errorId("email") : undefined}
              className="h-11 sm:h-8"
            />
            {errors.email ? (
              <p id={errorId("email")} className={ERROR_CLASS}>
                {errors.email}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" className="h-11 sm:h-8">
                Cancel
              </Button>
            </DialogClose>
            {/* `aria-disabled`, not `disabled`: a natively disabled button leaves
                the tab order, and a keyboard user would never reach the note that
                explains it. The dimmed look is restated here because the shared
                Button only styles the native `disabled` state. */}
            <Button
              type="submit"
              aria-disabled={SCHEDULING_ACTIVE ? undefined : "true"}
              aria-describedby={SCHEDULING_ACTIVE ? undefined : inactiveNoteId}
              className={cn(
                "h-11 bg-brand text-brand-foreground sm:h-8",
                SCHEDULING_ACTIVE
                  ? "hover:bg-brand/90"
                  : "cursor-not-allowed opacity-50",
              )}
            >
              Save schedule
            </Button>
          </DialogFooter>

          {SCHEDULING_ACTIVE ? null : (
            <p
              id={inactiveNoteId}
              className="-mt-2 text-xs text-muted-foreground sm:text-right"
            >
              {SCHEDULING_INACTIVE_NOTE}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

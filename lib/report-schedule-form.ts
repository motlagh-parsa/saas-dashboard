// The schedule-report form's rules and result shape, shared by the dialog and
// the Server Action. A plain module: the dialog is a client island.
import { z } from "zod";

export const SCHEDULE_FREQUENCIES = [
  { value: "WEEKLY", label: "Weekly", word: "weekly", hint: "every Monday" },
  { value: "MONTHLY", label: "Monthly", word: "monthly", hint: "on the 1st of each month" },
  { value: "QUARTERLY", label: "Quarterly", word: "quarterly", hint: "on the 1st of January, April, July and October" },
] as const;

export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number]["value"];

export const REPORT_IDS = ["mrr-summary", "churn-analysis", "revenue-bridge", "retention-cohorts"] as const;

export const scheduleSchema = z.object({
  reportId: z.enum(REPORT_IDS, { error: "Choose a report." }),
  frequency: z.enum(["WEEKLY", "MONTHLY", "QUARTERLY"], { error: "Choose a frequency." }),
});

export type ScheduleField = keyof z.infer<typeof scheduleSchema>;

export interface ScheduleState {
  readonly status: "idle" | "success" | "error";
  readonly message: string | null;
  readonly fieldErrors: Partial<Record<ScheduleField, string>>;
}

export const IDLE_SCHEDULE: ScheduleState = { status: "idle", message: null, fieldErrors: {} };

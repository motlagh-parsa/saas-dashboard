// The notification types a person can choose about, with their wording and
// defaults. A plain module: the preferences form (client) and the server
// (lib/notification-preferences.ts) read the same list.
//
// INVOICE_PAID and SYSTEM are not here: nothing generates them for people to
// choose about.
import type { NotificationType, Role } from "@prisma/client";

export interface NotificationKind {
  readonly type: NotificationType;
  readonly label: string;
  readonly description: string;
  /** Personal: only ever sent to the one person it concerns (their import, their report). */
  readonly personal: boolean;
}

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  {
    type: "CHURN_ALERT",
    label: "Customer churn",
    description: "A customer worth at least 2% of MRR cancels.",
    personal: false,
  },
  {
    type: "REVENUE_DIP",
    label: "Revenue dips",
    description: "MRR falls more than 5% over seven days.",
    personal: false,
  },
  {
    type: "INVOICE_OVERDUE",
    label: "Overdue invoices",
    description: "An open invoice passes its due date, or one is marked uncollectible.",
    personal: false,
  },
  {
    type: "MRR_MILESTONE",
    label: "MRR milestones",
    description: "MRR reaches a new round number: $1k, $5k, $10k, $25k …",
    personal: false,
  },
  {
    type: "WEEKLY_SUMMARY",
    label: "Weekly summary",
    description: "Every Monday: MRR, new and churned customers for the past week.",
    personal: false,
  },
  {
    type: "MEMBER_JOINED",
    label: "New teammates",
    description: "Someone you invited sets their password and joins.",
    personal: false,
  },
  {
    type: "IMPORT_FINISHED",
    label: "Your imports",
    description: "A CSV import you started has finished.",
    personal: true,
  },
  {
    type: "REPORT_READY",
    label: "Your reports",
    description: "A report you generated or scheduled is ready.",
    personal: true,
  },
];

/** Types emailed by default to owners and admins; members get no email by default. */
const EMAIL_BY_DEFAULT: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "CHURN_ALERT",
  "REVENUE_DIP",
  "INVOICE_OVERDUE",
  "MRR_MILESTONE",
  "WEEKLY_SUMMARY",
  "REPORT_READY",
]);

export interface Channels {
  readonly inApp: boolean;
  readonly email: boolean;
}

/** The channels a person gets for `type` when they have not chosen. */
export function defaultChannels(type: NotificationType, role: Role): Channels {
  if (type === "REPORT_READY") return { inApp: true, email: true };
  return { inApp: true, email: role !== "MEMBER" && EMAIL_BY_DEFAULT.has(type) };
}

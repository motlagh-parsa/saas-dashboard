// Presentation lookups for a notification type: which icon, which tone.
//
// Keyed by the PERSISTED vocabulary — Prisma's `NotificationType` — so there is
// exactly one alphabet in the app now. (The previous kebab-case display union
// from the demo feed is gone along with the demo feed.) `Record<NotificationType,
// …>` means a new enum member is a compile error here, not a blank cell in the UI.
//
// No "use client" of its own: this is a plain module of constants that both the
// list and the dropdown import, and both of those are client islands. The type
// import is erased at compile time, so nothing drags Prisma into the bundle.
import type { ComponentType } from "react";
import {
  CalendarRange,
  Clock,
  Database,
  FileText,
  FileUp,
  Receipt,
  TrendingDown,
  TrendingUp,
  UserMinus,
  UserPlus,
} from "lucide-react";

import type { NotificationType } from "@prisma/client";

/**
 * Direction, not category.
 *
 * `positive` is money in, `negative` is money at risk, `neutral` is everything
 * operational — the same `--positive` / `--negative` pair the metric deltas use,
 * so a row's tone means the same thing here as it does on the overview.
 *
 * Colour is never the only cue: every toned row also says what it is in words
 * ("Churn alert", "Revenue dip detected"), so the ramp is redundant by design.
 */
export type NotificationTone = "positive" | "negative" | "neutral";

export interface NotificationTypeMeta {
  readonly icon: ComponentType<{ className?: string }>;
  readonly tone: NotificationTone;
}

/**
 * Icons are reused from elsewhere in the product wherever a precedent exists —
 * `TrendingUp` from the Revenue nav item, `Receipt` from the invoice table,
 * `UserMinus` from the churn tile, `UserPlus` from Settings' invite button,
 * `FileText` from the Reports nav item.
 */
export const TYPE_META: Record<NotificationType, NotificationTypeMeta> = {
  MRR_MILESTONE: { icon: TrendingUp, tone: "positive" },
  INVOICE_PAID: { icon: Receipt, tone: "positive" },
  INVOICE_OVERDUE: { icon: Clock, tone: "negative" },
  CHURN_ALERT: { icon: UserMinus, tone: "negative" },
  MEMBER_JOINED: { icon: UserPlus, tone: "neutral" },
  REVENUE_DIP: { icon: TrendingDown, tone: "negative" },
  REPORT_READY: { icon: FileText, tone: "neutral" },
  IMPORT_FINISHED: { icon: FileUp, tone: "neutral" },
  SYSTEM: { icon: Database, tone: "neutral" },
  WEEKLY_SUMMARY: { icon: CalendarRange, tone: "neutral" },
};

/**
 * Bare icons on the card surface rather than the `bg-x/12 text-x` chip used for
 * status badges: `--positive` and `--negative` sit near 3.5:1 against a white
 * card, which is fine for a graphical mark but would drop under the floor on a
 * 12% wash of themselves. Bare is also denser, which is what a list of ten rows
 * wants.
 */
export const TONE_CLASS: Record<NotificationTone, string> = {
  positive: "text-positive",
  negative: "text-negative",
  neutral: "text-muted-foreground",
};

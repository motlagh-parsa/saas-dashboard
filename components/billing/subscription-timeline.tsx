// A customer's subscriptions as timelines: one card per CHAIN (the segments
// linked by plan changes), newest segment first. Each segment shows its terms,
// its span, and what ended it — a plan change, a cancellation, or nothing yet.
//
// The lifecycle actions sit on the chain's CURRENT segment only, and only while
// it is still running: history is changed by adding a segment (Change), ending
// it (Cancel), or — for mistakes — Correct and Delete. A server component; the
// dialogs are client islands.
import type { PlanOption } from "@/lib/billing-form";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ActionButton } from "@/components/billing/action-button";
import {
  CancelSubscriptionDialog,
  ChangeSubscriptionDialog,
  CorrectSubscriptionDialog,
  DeleteSubscriptionDialog,
  type SegmentView,
} from "@/components/billing/subscription-dialogs";
import { undoScheduledCancel } from "@/lib/subscription-actions";
import { TAG_CLASS } from "@/components/data-table/styles";

export type SegmentTone = "live" | "scheduled" | "upcoming" | "ended";

export interface TimelineSegment {
  readonly id: string;
  /** "Pro · $199 × 2 / month" */
  readonly terms: string;
  /** "01 Mar 2026 → 15 Jun 2026" or "01 Mar 2026 → now". */
  readonly span: string;
  /** "Plan change", "Canceled", "Cancels on 01 Jan 2027", "Active", "Starts 01 Jan 2027". */
  readonly endedBy: string;
  readonly tone: SegmentTone;
  readonly status: string;
}

export interface TimelineChain {
  /** The current (last) segment — what the actions act on. */
  readonly current: SegmentView;
  /** Newest first. */
  readonly segments: readonly TimelineSegment[];
  /** The current segment is still running or has not started: actions apply. */
  readonly open: boolean;
  /** A cancellation is scheduled and can still be undone. */
  readonly scheduledCancel: boolean;
  /** For the delete confirmation. */
  readonly invoiceCount: number;
}

const TONE_CLASS: Record<SegmentTone, string> = {
  live: "bg-positive/12 text-positive",
  scheduled: "bg-brand/12 text-brand",
  upcoming: "bg-brand/12 text-brand",
  ended: "bg-muted text-muted-foreground",
};

interface SubscriptionTimelineProps {
  organizationId: string;
  currency: string;
  chains: readonly TimelineChain[];
  /** Plans the Change dialog offers, per chain (active plans + the chain's own). */
  plansFor: (chain: TimelineChain) => readonly PlanOption[];
  canWrite: boolean;
}

export function SubscriptionTimeline({ organizationId, currency, chains, plansFor, canWrite }: SubscriptionTimelineProps) {
  return (
    <div className="grid gap-3">
      {chains.map((chain) => (
        <Card key={chain.current.id} className="gap-0 py-0" data-subscription={chain.current.id}>
          {canWrite ? (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5">
              {chain.open ? (
                <>
                  <ChangeSubscriptionDialog
                    organizationId={organizationId}
                    currency={currency}
                    segment={chain.current}
                    plans={plansFor(chain)}
                    mode="plan"
                  />
                  <ChangeSubscriptionDialog
                    organizationId={organizationId}
                    currency={currency}
                    segment={chain.current}
                    plans={plansFor(chain)}
                    mode="quantity"
                  />
                  {chain.scheduledCancel ? (
                    <ActionButton
                      action={undoScheduledCancel}
                      hidden={{ organizationId, subscriptionId: chain.current.id }}
                      label="Undo scheduled cancel"
                      successTitle="Cancellation undone"
                      failureTitle="Couldn't undo the cancellation"
                    />
                  ) : (
                    <CancelSubscriptionDialog organizationId={organizationId} segment={chain.current} />
                  )}
                  <CorrectSubscriptionDialog organizationId={organizationId} currency={currency} segment={chain.current} />
                </>
              ) : (
                <span className="text-xs text-muted-foreground">Ended — kept as history.</span>
              )}
              <div className="ml-auto">
                <DeleteSubscriptionDialog
                  organizationId={organizationId}
                  subscriptionId={chain.current.id}
                  customerName={chain.current.customerName}
                  segments={chain.segments.length}
                  invoices={chain.invoiceCount}
                />
              </div>
            </div>
          ) : null}

          <ol className="divide-y divide-border">
            {chain.segments.map((segment, index) => (
              <li
                key={segment.id}
                className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3", index > 0 && "bg-muted/20")}
              >
                <div className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className={cn("font-medium", index === 0 ? "text-foreground" : "text-muted-foreground")}>
                    {segment.terms}
                  </span>
                  <span className="font-mono text-[0.6875rem] text-muted-foreground">{segment.span}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className={TAG_CLASS}>
                    {segment.status}
                  </Badge>
                  <Badge variant="secondary" className={cn("font-medium", TONE_CLASS[segment.tone])}>
                    {segment.endedBy}
                  </Badge>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}

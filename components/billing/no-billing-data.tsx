// The empty state for the metric pages — Overview, Revenue, Retention — when
// the workspace has no subscriptions yet. Every figure on those pages derives
// from subscriptions, so without one they would draw $0 charts that explain
// nothing. This says what is missing and offers the next step instead.
//
// The actions are links to where each step lives (`?action=` opens the dialog
// there), so this server component carries no client code. Members, who cannot
// write, are told who can.
import Link from "next/link";
import { ChartNoAxesColumn } from "lucide-react";

import { CUSTOMERS_PATH } from "@/lib/customer-list";
import { PLANS_PATH } from "@/lib/plan-list";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { ImportSlot } from "@/components/billing/import-slot";

/** Where "Add subscription" opens its dialog. */
export const ADD_SUBSCRIPTION_HREF = "/dashboard/revenue?action=add-subscription";

interface NoBillingDataProps {
  /** What this page would show: "MRR, retention and billing", "the revenue bridge". */
  shows: string;
  canWrite: boolean;
  /** Whether the workspace has plans yet — decides which step comes first. */
  hasPlans: boolean;
  hasCustomers: boolean;
}

export function NoBillingData({ shows, canWrite, hasPlans, hasCustomers }: NoBillingDataProps) {
  const primary = "h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9";
  const secondary = "h-11 px-4 sm:h-9";

  return (
    <>
      <EmptyState
        icon={ChartNoAxesColumn}
        title="No subscriptions yet"
        description={
          canWrite
            ? `This page shows ${shows}, and every one of those figures comes from subscriptions. Add your first — with a past start date if you are entering history — and the numbers appear immediately.`
            : `This page shows ${shows} once the workspace has subscriptions. An owner or admin adds them.`
        }
        action={
          canWrite ? (
            <>
              <Button asChild className={primary}>
                <Link href={ADD_SUBSCRIPTION_HREF}>Add subscription</Link>
              </Button>
              {hasPlans ? null : (
                <Button asChild variant="outline" className={secondary}>
                  <Link href={`${PLANS_PATH}?action=create`}>Create a plan</Link>
                </Button>
              )}
              {hasCustomers ? null : (
                <Button asChild variant="outline" className={secondary}>
                  <Link href={`${CUSTOMERS_PATH}?action=add`}>Add customer</Link>
                </Button>
              )}
            </>
          ) : undefined
        }
        className="rise mt-3"
      />
      {canWrite ? <ImportSlot /> : null}
    </>
  );
}

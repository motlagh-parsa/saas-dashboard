import "server-only";

// What a workspace holds, as the product needs to know it in several places:
// the sample-data banner and Settings row (is there SAMPLE data? is there real
// data?), the currency lock (is there ANY billing data?), onboarding (has this
// workspace been set up?), and the sidebar's metrics status (when was the latest
// snapshot?). One query set, so they can never disagree.
import { prisma } from "@/lib/prisma";

export interface WorkspaceDataState {
  /** Customers, plans, subscriptions or invoices of ANY source. */
  readonly hasBillingData: boolean;
  /** Any row with source = SAMPLE. */
  readonly hasSampleData: boolean;
  /** Any row with a source other than SAMPLE — a founder's own data. */
  readonly hasOwnData: boolean;
  /** At least one subscription: the metrics have something to measure. */
  readonly hasSubscriptions: boolean;
  /** The latest stored snapshot day, or null. */
  readonly latestSnapshot: Date | null;
}

/** Sample rows only, or everything else. A plain shape every model's `source` filter accepts. */
type SourceFilter = { readonly equals: "SAMPLE" } | { readonly not: "SAMPLE" };

async function countBilling(organizationId: string, source?: SourceFilter): Promise<number[]> {
  const where = { organizationId, ...(source ? { source } : {}) };
  return Promise.all([
    prisma.customer.count({ where }),
    prisma.plan.count({ where }),
    prisma.subscription.count({ where }),
    prisma.invoice.count({ where }),
  ]);
}

export async function getWorkspaceDataState(organizationId: string): Promise<WorkspaceDataState> {
  const [sample, own, latest, subscriptions] = await Promise.all([
    countBilling(organizationId, { equals: "SAMPLE" }),
    countBilling(organizationId, { not: "SAMPLE" }),
    prisma.metricSnapshot.aggregate({ where: { organizationId }, _max: { date: true } }),
    prisma.subscription.count({ where: { organizationId } }),
  ]);
  const hasSampleData = sample.some((count) => count > 0);
  const hasOwnData = own.some((count) => count > 0);
  return {
    hasBillingData: hasSampleData || hasOwnData,
    hasSampleData,
    hasOwnData,
    hasSubscriptions: subscriptions > 0,
    latestSnapshot: latest._max.date,
  };
}

/** How many of each billing record the workspace holds that did NOT come from sample data. */
export async function countOwnBillingData(
  organizationId: string,
): Promise<{ customers: number; plans: number; subscriptions: number; invoices: number }> {
  const [customers, plans, subscriptions, invoices] = await countBilling(organizationId, { not: "SAMPLE" });
  return { customers, plans, subscriptions, invoices };
}

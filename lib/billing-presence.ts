import "server-only";

// Whether a workspace has any billing data yet — what the metric pages check
// before drawing charts that would otherwise be a wall of zeroes.
import { prisma } from "@/lib/prisma";

/** What the empty states need to know about a workspace, in one round trip. */
export interface BillingPresence {
  readonly subscriptions: number;
  readonly plans: number;
  readonly customers: number;
}

export async function getBillingPresence(organizationId: string): Promise<BillingPresence> {
  const [subscriptions, plans, customers] = await Promise.all([
    prisma.subscription.count({ where: { organizationId } }),
    prisma.plan.count({ where: { organizationId, archivedAt: null } }),
    prisma.customer.count({ where: { organizationId, archivedAt: null } }),
  ]);
  return { subscriptions, plans, customers };
}

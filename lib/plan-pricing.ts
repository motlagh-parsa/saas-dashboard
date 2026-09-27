// The list price of each plan, in integer cents — one table shared by the seed
// (prisma/seed.ts, which prices every seeded subscription from it) and the "Add
// subscription" form (which pre-fills its price field from it). Two copies would
// drift, and a form suggesting a price the seeded data never charged is a
// contradiction the dashboard would show.
//
// Plain and dependency-free: the seed runs under ts-node outside Next, and the
// client form imports it. Type-only Prisma import.
import type { BillingInterval, PlanTier } from "@prisma/client";

export const PLAN_PRICE_CENTS: Record<BillingInterval, Record<PlanTier, number>> = {
  MONTHLY: {
    FREE: 0,
    STARTER: 4_900, // $49 / mo
    PRO: 19_900, // $199 / mo
    ENTERPRISE: 99_900, // $999 / mo
  },
  // Chosen divisible by 12 so the monthly-normalized MRR is exact.
  YEARLY: {
    FREE: 0,
    STARTER: 52_800, // $528 / yr  -> $44 / mo
    PRO: 214_800, // $2,148 / yr -> $179 / mo
    ENTERPRISE: 1_078_800, // $10,788 / yr -> $899 / mo
  },
};

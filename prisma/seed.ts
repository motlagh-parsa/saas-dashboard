/**
 * Development seed — `npx prisma db seed`, and the last step of
 * `npx prisma migrate reset`. Runs through scripts/ts-runtime.cjs (see
 * prisma.config.ts) so it can use the app's own `@/` modules.
 *
 * What it does, and nothing else — `resetDemo` in lib/demo.ts:
 *   1. Upserts the demo user, the demo workspaces and the demo teammates.
 *   2. Clears what anyone added to those two workspaces, and replaces their
 *      SAMPLE billing data. Every delete is scoped to those two workspaces.
 *
 * It never deletes without a filter. The old seed began by wiping every
 * organization, subscription and invoice in the database — every tenant's data.
 * That is gone, and the seed refuses to run in production at all.
 *
 * The data ends on the day the seed runs (UTC). Pin it with
 * SEED_ANCHOR_DATE=YYYY-MM-DD for reproducible numbers.
 */
import { prisma } from "@/lib/prisma";
import { DEMO_TEAMMATES, resetDemo } from "@/lib/demo";

if (process.env.NODE_ENV === "production") {
  throw new Error(
    "prisma/seed.ts refuses to run with NODE_ENV=production. It writes demo users and sample data; production workspaces get sample data from the product, per workspace.",
  );
}

function anchorDate(): Date | undefined {
  const override = process.env.SEED_ANCHOR_DATE;
  if (override === undefined) return undefined;
  const parsed = new Date(`${override}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`SEED_ANCHOR_DATE must be YYYY-MM-DD; got "${override}".`);
  }
  return parsed;
}

async function main(): Promise<void> {
  // The demo user, its workspaces, teammates and sample data — the same
  // function the daily job uses to reset a public demo (lib/demo.ts).
  const result = await resetDemo({ anchorDate: anchorDate() });
  console.log("Seed complete.");
  for (const workspace of result.workspaces) {
    console.log(`  ${workspace.name} (${workspace.currency}): ${workspace.customers} customers, alerts: ${workspace.alerts.join(", ") || "none"}`);
  }
  console.log(`  demo user: ${process.env.DEMO_EMAIL ?? "demo@saas-dashboard.dev"} (owner of both), ${DEMO_TEAMMATES.length} teammates`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    // The pg pool behind the Prisma adapter keeps the event loop alive.
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

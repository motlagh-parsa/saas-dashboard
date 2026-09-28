/**
 * Development seed — `npx prisma db seed`, and the last step of
 * `npx prisma migrate reset`. Runs through scripts/ts-runtime.cjs (see
 * prisma.config.ts) so it can use the app's own `@/` modules.
 *
 * What it does, and nothing else:
 *   1. Upserts the demo user, the demo workspaces and the demo teammates.
 *   2. Replaces the SAMPLE billing data in those two workspaces only
 *      (lib/sample-data.ts), which deletes nothing but `source = SAMPLE` rows.
 *
 * It never deletes without a filter. The old seed began by wiping every
 * organization, subscription and invoice in the database — every tenant's data.
 * That is gone, and the seed refuses to run in production at all.
 *
 * The data ends on the day the seed runs (UTC). Pin it with
 * SEED_ANCHOR_DATE=YYYY-MM-DD for reproducible numbers.
 */
import type { Role } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { generateSampleData, removeSampleData } from "@/lib/sample-data";

if (process.env.NODE_ENV === "production") {
  throw new Error(
    "prisma/seed.ts refuses to run with NODE_ENV=production. It writes demo users and sample data; production workspaces get sample data from the product, per workspace.",
  );
}

const DEMO_EMAIL = "demo@saas-dashboard.dev";

interface WorkspaceSpec {
  readonly slug: string;
  readonly name: string;
  readonly currency: string;
}

/** The demo user owns both; the switcher and per-workspace currency need two. */
const WORKSPACES: readonly WorkspaceSpec[] = [
  { slug: "northwind-analytics", name: "Northwind Analytics", currency: "USD" },
  { slug: "globex-labs", name: "Globex Labs", currency: "EUR" },
];

interface TeammateSpec {
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly suspendedAt: Date | null;
}

/** Members of Northwind, so /dashboard/users has people to manage. Demo-only: no password. */
const TEAMMATES: readonly TeammateSpec[] = [
  { name: "Alice Chen", email: "alice@acme-demo.dev", role: "ADMIN", suspendedAt: null },
  { name: "Bob Martinez", email: "bob@acme-demo.dev", role: "MEMBER", suspendedAt: null },
  {
    name: "Carol Singh",
    email: "carol@acme-demo.dev",
    role: "MEMBER",
    suspendedAt: new Date("2026-06-01T00:00:00.000Z"),
  },
  { name: "Dan Lee", email: "dan@acme-demo.dev", role: "MEMBER", suspendedAt: null },
];

function anchorDate(): Date | undefined {
  const override = process.env.SEED_ANCHOR_DATE;
  if (override === undefined) return undefined;
  const parsed = new Date(`${override}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`SEED_ANCHOR_DATE must be YYYY-MM-DD; got "${override}".`);
  }
  return parsed;
}

async function upsertMembership(userId: string, organizationId: string, role: Role): Promise<void> {
  await prisma.membership.upsert({
    where: { userId_organizationId: { userId, organizationId } },
    update: { role },
    create: { userId, organizationId, role },
  });
}

async function main(): Promise<void> {
  const anchor = anchorDate();

  const demoUser = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: { name: "Demo Operator" },
    create: { email: DEMO_EMAIL, name: "Demo Operator" },
    select: { id: true },
  });

  const workspaces = [];
  for (const spec of WORKSPACES) {
    const workspace = await prisma.organization.upsert({
      where: { slug: spec.slug },
      update: { name: spec.name, currency: spec.currency },
      create: { slug: spec.slug, name: spec.name, currency: spec.currency },
      select: { id: true, name: true, currency: true },
    });
    await upsertMembership(demoUser.id, workspace.id, "OWNER");
    workspaces.push(workspace);
  }

  const [northwind] = workspaces;
  for (const teammate of TEAMMATES) {
    // `update` restores the seeded name and suspension, undoing anything changed
    // from the Users page on a re-seed.
    const user = await prisma.user.upsert({
      where: { email: teammate.email },
      update: { name: teammate.name, suspendedAt: teammate.suspendedAt },
      create: { email: teammate.email, name: teammate.name, suspendedAt: teammate.suspendedAt },
      select: { id: true },
    });
    await upsertMembership(user.id, northwind.id, teammate.role);
  }

  console.log("Seed complete.");
  for (const workspace of workspaces) {
    const removed = await removeSampleData(workspace.id);
    const written = await generateSampleData(workspace.id, { anchorDate: anchor });
    console.log(
      `  ${workspace.name} (${workspace.currency}): ` +
        `${written.plans} plans, ${written.customers} customers, ` +
        `${written.subscriptions} subscriptions, ${written.invoices} invoices, ` +
        `${written.snapshots} snapshots` +
        (removed.subscriptions > 0 ? ` (replaced ${removed.subscriptions} sample subscriptions)` : ""),
    );
  }
  console.log(`  demo user     : ${DEMO_EMAIL} (owner of both), ${TEAMMATES.length} teammates in ${northwind.name}`);
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

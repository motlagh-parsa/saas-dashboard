import "server-only";

// The demo account: who it is, what it may not do, and how its workspaces are
// (re)built.
//
// The demo is a showcase — possibly public (DEMO_PUBLIC=true puts a "Try the
// demo" button on the sign-in and landing pages, no password needed). So:
//   - It owns two workspaces of sample data with four teammates
//     (`resetDemo`), rebuilt by the seed in development and every night by the
//     daily job when the demo is public — whatever a visitor changed is undone.
//   - Anything that reaches OUTSIDE the app, or can't be undone by that reset,
//     is refused for it on the server (`demoRefusal`): inviting people (email),
//     API keys, connecting Stripe, scheduled report emails, creating, leaving
//     or deleting workspaces, and changing the account itself.
//   - No email is ever sent to the demo account or its teammates
//     (lib/demo-identity.ts, checked by lib/mail.ts).
import { evaluateAlerts } from "@/lib/alerts";
import { DEMO_TEAMMATES } from "@/lib/demo-identity";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { generateSampleData, removeSampleData } from "@/lib/sample-data";

interface WorkspaceSpec {
  readonly slug: string;
  readonly name: string;
  readonly currency: string;
}

/** The demo user owns both; the switcher and per-workspace currency need two. */
export const DEMO_WORKSPACES: readonly WorkspaceSpec[] = [
  { slug: "northwind-analytics", name: "Northwind Analytics", currency: "USD" },
  { slug: "globex-labs", name: "Globex Labs", currency: "EUR" },
];

export const DEMO_REFUSAL = "The demo account can't do this. Create your own free account to try it.";

/** The refusal message when `userId` is the demo account, else null. */
export async function demoRefusal(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return user !== null && user.email.toLowerCase() === env.DEMO_EMAIL.toLowerCase() ? DEMO_REFUSAL : null;
}

export interface DemoResetResult {
  readonly workspaces: readonly { readonly name: string; readonly currency: string; readonly customers: number; readonly alerts: readonly string[] }[];
}

/**
 * Builds — or rebuilds — the demo: the user, its two workspaces with their
 * names and currencies, the teammates and their roles, and fresh sample data.
 * Everything a visitor added to those workspaces is removed: their own billing
 * rows, notifications, report runs and schedules, imports, keys, the Stripe
 * link, the audit log, and any members who aren't the demo cast.
 */
export async function resetDemo(options: { readonly anchorDate?: Date } = {}): Promise<DemoResetResult> {
  const demoUser = await prisma.user.upsert({
    where: { email: env.DEMO_EMAIL },
    update: { name: "Demo Operator", suspendedAt: null },
    create: { email: env.DEMO_EMAIL, name: "Demo Operator" },
    select: { id: true },
  });

  const teammateIds: string[] = [];
  for (const teammate of DEMO_TEAMMATES) {
    const user = await prisma.user.upsert({
      where: { email: teammate.email },
      update: { name: teammate.name, suspendedAt: teammate.suspendedAt },
      create: { email: teammate.email, name: teammate.name, suspendedAt: teammate.suspendedAt },
      select: { id: true },
    });
    teammateIds.push(user.id);
  }

  const result: DemoResetResult["workspaces"][number][] = [];
  for (const [index, spec] of DEMO_WORKSPACES.entries()) {
    const workspace = await prisma.organization.upsert({
      where: { slug: spec.slug },
      update: { name: spec.name, currency: spec.currency },
      create: { slug: spec.slug, name: spec.name, currency: spec.currency },
      select: { id: true },
    });
    const organizationId = workspace.id;

    // A visitor's own data and side effects, first.
    await prisma.$transaction([
      prisma.invoice.deleteMany({ where: { organizationId, source: { not: "SAMPLE" } } }),
      prisma.subscription.deleteMany({ where: { organizationId, source: { not: "SAMPLE" } } }),
      prisma.customer.deleteMany({ where: { organizationId, source: { not: "SAMPLE" } } }),
      prisma.plan.deleteMany({ where: { organizationId, source: { not: "SAMPLE" } } }),
      prisma.notification.deleteMany({ where: { organizationId } }),
      prisma.alertMark.deleteMany({ where: { organizationId } }),
      prisma.reportRun.deleteMany({ where: { organizationId } }),
      prisma.reportSchedule.deleteMany({ where: { organizationId } }),
      prisma.importRun.deleteMany({ where: { organizationId } }),
      prisma.apiKey.deleteMany({ where: { organizationId } }),
      prisma.stripeConnection.deleteMany({ where: { organizationId } }),
      prisma.auditLog.deleteMany({ where: { organizationId } }),
    ]);

    // The cast, and only the cast.
    const cast = index === 0 ? [demoUser.id, ...teammateIds] : [demoUser.id];
    await prisma.membership.deleteMany({ where: { organizationId, userId: { notIn: cast } } });
    await prisma.membership.upsert({
      where: { userId_organizationId: { userId: demoUser.id, organizationId } },
      update: { role: "OWNER" },
      create: { userId: demoUser.id, organizationId, role: "OWNER" },
    });
    if (index === 0) {
      for (const [position, teammate] of DEMO_TEAMMATES.entries()) {
        await prisma.membership.upsert({
          where: { userId_organizationId: { userId: teammateIds[position], organizationId } },
          update: { role: teammate.role },
          create: { userId: teammateIds[position], organizationId, role: teammate.role },
        });
      }
    }

    await removeSampleData(organizationId);
    const written = await generateSampleData(organizationId, { anchorDate: options.anchorDate });
    // Real alerts on the sample data, so the feed has something true in it. In
    // the app only: alerts about sample data are never emailed (lib/alerts.ts).
    const alerts = await evaluateAlerts(organizationId);
    result.push({ name: spec.name, currency: spec.currency, customers: written.customers, alerts: alerts.raised });
  }
  return { workspaces: result };
}

export { DEMO_TEAMMATES };

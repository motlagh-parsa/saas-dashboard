/**
 * The demo half of `npm run verify:metrics`: `resetDemo` (lib/demo.ts) undoes
 * what a visitor did to the demo workspaces, and the demo account is fenced in.
 *
 * It runs against the seeded demo itself — which is exactly what the reset is
 * for — so afterwards the demo is as the seed leaves it.
 */
import { DEMO_REFUSAL, DEMO_WORKSPACES, demoRefusal, resetDemo } from "@/lib/demo";
import { isDemoAddress } from "@/lib/demo-identity";
import { env } from "@/lib/env";
import { sendMail } from "@/lib/mail";
import { prisma } from "@/lib/prisma";

type Check = (label: string, actual: unknown, expected: unknown) => void;

export async function verifyDemo(check: Check, stamp: string): Promise<string[]> {
  console.log("\n── demo: reset and restrictions ──");
  const strangerIds: string[] = [];
  try {
    await resetDemo();
    const demo = await prisma.user.findUniqueOrThrow({ where: { email: env.DEMO_EMAIL }, select: { id: true } });
    const northwind = await prisma.organization.findUniqueOrThrow({ where: { slug: DEMO_WORKSPACES[0].slug }, select: { id: true } });
    const baseline = await prisma.customer.count({ where: { organizationId: northwind.id } });

    // A visitor's mess.
    const stranger = await prisma.user.create({ data: { email: `stranger-${stamp}@example.test` }, select: { id: true } });
    strangerIds.push(stranger.id);
    await prisma.membership.create({ data: { userId: stranger.id, organizationId: northwind.id, role: "ADMIN" } });
    await prisma.customer.create({ data: { organizationId: northwind.id, name: "Visitor Co", source: "MANUAL" } });
    await prisma.organization.update({ where: { id: northwind.id }, data: { name: "Hacked", currency: "JPY" } });
    await prisma.apiKey.create({
      data: { organizationId: northwind.id, name: "visitor", prefix: "mrd_visitor", keyHash: `hash-${stamp}`, scope: "WRITE" },
    });
    await prisma.membership.update({
      where: { userId_organizationId: { userId: demo.id, organizationId: northwind.id } },
      data: { role: "MEMBER" },
    });

    const result = await resetDemo();
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: northwind.id }, select: { name: true, currency: true } });
    check("reset: name and currency restored", [after.name, after.currency], ["Northwind Analytics", "USD"]);
    check("reset: the visitor's customer is gone", await prisma.customer.count({ where: { organizationId: northwind.id, name: "Visitor Co" } }), 0);
    check("reset: the sample data is back in full", await prisma.customer.count({ where: { organizationId: northwind.id } }), baseline);
    check("reset: keys removed", await prisma.apiKey.count({ where: { organizationId: northwind.id } }), 0);
    check("reset: members who aren't the cast are removed", await prisma.membership.count({ where: { organizationId: northwind.id, userId: stranger.id } }), 0);
    const role = await prisma.membership.findUniqueOrThrow({ where: { userId_organizationId: { userId: demo.id, organizationId: northwind.id } }, select: { role: true } });
    check("reset: the demo account owns its workspace again", role.role, "OWNER");
    check("reset: alerts raised on the fresh data", result.workspaces[0].alerts.length > 0, true);

    check("restriction: the demo account is refused", await demoRefusal(demo.id), DEMO_REFUSAL);
    check("restriction: other accounts aren't", await demoRefusal(stranger.id), null);
    check("mail: the demo address is not an inbox", isDemoAddress(env.DEMO_EMAIL.toUpperCase()), true);
    check("mail: nor a teammate's", isDemoAddress("bob@acme-demo.dev"), true);
    check("mail: … so nothing is sent to it", await sendMail({ to: env.DEMO_EMAIL, subject: "x", text: "x", html: "x" }), false);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: strangerIds } } });
  }
  return [];
}

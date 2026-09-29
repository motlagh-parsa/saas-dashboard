/**
 * Rewrites one workspace's stored MetricSnapshot rows from a date through today,
 * with the same function every billing write uses (lib/snapshots.ts).
 *
 *   npm run snapshots:recompute -- <workspace slug or id> <YYYY-MM-DD>
 *
 * For repairs: after data was changed outside the app (a direct SQL fix, an
 * interrupted import), the stored days no longer match the history. Scoped to
 * the one workspace named; never touches another.
 */
import { prisma } from "@/lib/prisma";
import { recomputeSnapshots } from "@/lib/snapshots";

async function main(): Promise<void> {
  const [workspace, from] = process.argv.slice(2);
  if (!workspace || !from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    throw new Error("usage: snapshots:recompute <workspace slug or id> <YYYY-MM-DD>");
  }
  const org = await prisma.organization.findFirst({
    where: { OR: [{ slug: workspace }, { id: workspace }] },
    select: { id: true, name: true },
  });
  if (org === null) throw new Error(`no workspace "${workspace}"`);

  const result = await recomputeSnapshots(org.id, new Date(`${from}T00:00:00.000Z`));
  console.log(`${org.name}: rewrote ${result.days} day(s) from ${from}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await prisma.$disconnect();
    process.exit(1);
  });

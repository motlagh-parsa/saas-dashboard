/**
 * Rewrites one workspace's stored MetricSnapshot rows from a date through today,
 * with the same function every billing write uses (lib/snapshots.ts).
 *
 *   npm run snapshots:recompute -- <workspace slug or id> <YYYY-MM-DD> [--check]
 *
 * With --check it writes nothing: it compares the stored rows from that date
 * with a full rebuild and exits non-zero if any day differs (the e2e scripts use
 * this after overlapping writes).
 *
 * For repairs: after data was changed outside the app (a direct SQL fix, an
 * interrupted import), the stored days no longer match the history. Scoped to
 * the one workspace named; never touches another.
 */
import { prisma } from "@/lib/prisma";
import { diffAgainstRebuild, recomputeSnapshots } from "@/lib/snapshots";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const [workspace, from] = args.filter((arg) => arg !== "--check");
  if (!workspace || !from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    throw new Error("usage: snapshots:recompute <workspace slug or id> <YYYY-MM-DD>");
  }
  const org = await prisma.organization.findFirst({
    where: { OR: [{ slug: workspace }, { id: workspace }] },
    select: { id: true, name: true },
  });
  if (org === null) throw new Error(`no workspace "${workspace}"`);

  const fromDate = new Date(`${from}T00:00:00.000Z`);
  if (checkOnly) {
    const mismatches = await diffAgainstRebuild(org.id, fromDate);
    if (mismatches.length > 0) {
      throw new Error(
        `${org.name}: ${mismatches.length} day(s) differ from a full rebuild:\n${mismatches.slice(0, 5).join("\n")}`,
      );
    }
    console.log(`${org.name}: stored snapshots from ${from} equal a full rebuild`);
    return;
  }
  const result = await recomputeSnapshots(org.id, fromDate);
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

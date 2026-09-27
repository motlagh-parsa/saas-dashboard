// Records a report run for the "Generate" button on /dashboard/reports.
//
// Security, same order as the CSV export route beside it:
//   1. `requireSession()` is the authorization gate. An anonymous caller is
//      redirected to /sign-in; the report card detects the redirect.
//   2. The organization is resolved SERVER-SIDE by lib/active-org.ts — the
//      workspace picked in the switcher, verified against the caller's
//      memberships — the same resolver as the Reports page and the export
//      route, so a run lands in the workspace the page is showing.
//   3. `reportId` is the one untrusted input, and it must be one of the four
//      catalogue keys. Anything else is a 400 before a write happens.
//
// A successful run also raises a REPORT_READY notification. It is written AFTER
// the response via `after()`: the run is what the caller asked for, so a failed
// notification must never fail or delay it, and `after()` keeps the write alive
// past the response instead of leaving an orphaned promise the runtime may drop.
import "server-only";

import { NextResponse, after } from "next/server";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { createNotification } from "@/lib/notification-writer";
import { prisma } from "@/lib/prisma";
import { REPORTS } from "@/components/dashboard/report-catalogue";

const VALID_REPORT_IDS = [
  "mrr-summary",
  "churn-analysis",
  "revenue-bridge",
  "retention-cohorts",
] as const;
type ValidReportId = (typeof VALID_REPORT_IDS)[number];

function isValidReportId(id: string): id is ValidReportId {
  return (VALID_REPORT_IDS as readonly string[]).includes(id);
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ reportId: string }> },
): Promise<NextResponse> {
  const session = await requireSession();
  const { reportId } = await params;

  if (!isValidReportId(reportId)) {
    return NextResponse.json({ error: "Unknown report" }, { status: 400 });
  }

  const organizationId = await getActiveOrgId(session.user.id);
  if (organizationId === null) {
    // The report card turns this into "not a member of any workspace".
    return NextResponse.json({ error: "No workspace" }, { status: 403 });
  }

  const run = await prisma.reportRun.create({
    data: {
      organizationId,
      reportId,
    },
    select: { id: true, generatedAt: true },
  });

  after(() =>
    createNotification({
      organizationId,
      type: "REPORT_READY",
      title: REPORTS.find((report) => report.id === reportId)?.name ?? reportId,
      body: "Your report is ready to download.",
    }).catch((error: unknown) => {
      console.error("REPORT_READY notification failed", error);
    }),
  );

  return NextResponse.json({ id: run.id, generatedAt: run.generatedAt });
}

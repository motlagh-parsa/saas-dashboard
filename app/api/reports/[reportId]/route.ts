// CSV export for the four reports on /dashboard/reports. One dynamic GET route;
// `reportId` picks the query and the column layout.
//
// Security, same order as every protected page:
//   1. `requireSession()` is the authorization gate. An anonymous caller is
//      redirected to /sign-in; the download button detects the redirect.
//   2. The organization is resolved SERVER-SIDE by lib/active-org.ts: the
//      workspace picked in the switcher, honoured only while the caller is a
//      member of it. No org id is accepted from the URL or the request body.
//   3. `reportId` is the one untrusted input, and it only ever selects a key of
//      REPORT_BUILDERS. Anything else is a 400 before a query runs.
//
// The CSV itself is built by lib/reports.ts, shared with scheduled report emails.
import "server-only";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { buildReport, isReportId } from "@/lib/reports";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface RouteContext {
  params: Promise<{ reportId: string }>;
}

export async function GET(_request: Request, { params }: RouteContext): Promise<Response> {
  const session = await requireSession();
  const { reportId } = await params;

  if (!isReportId(reportId)) {
    return Response.json({ error: `Unknown report "${reportId}".` }, { status: 400 });
  }

  // The workspace the dashboard is showing (lib/active-org.ts), so the file
  // matches the page the download button sits on.
  const organizationId = await getActiveOrgId(session.user.id);
  if (organizationId === null) {
    return Response.json({ error: "No workspace for this account." }, { status: 403 });
  }

  const { filename, csv } = await buildReport(organizationId, reportId);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Tenant data: never let a shared cache hold it.
      "Cache-Control": "private, no-store",
    },
  });
}

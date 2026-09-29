"use client";

// Downloads a past run's error report — rebuilt on the server from the errors the
// run kept, through the shared formula-neutralizing CSV writer.
import * as React from "react";
import { Download, Loader2 } from "lucide-react";

import { importErrorReport } from "@/lib/import-actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/dashboard/use-toast";
import { downloadCsv } from "@/components/import/download";

export function ErrorReportButton({ organizationId, runId }: { organizationId: string; runId: string }) {
  const [pending, start] = React.useTransition();
  return (
    <Button
      type="button"
      variant="ghost"
      aria-disabled={pending ? "true" : undefined}
      aria-label="Download error report"
      className="h-11 px-2.5 sm:h-8"
      onClick={() => {
        if (pending) return;
        start(async () => {
          const result = await importErrorReport(organizationId, runId);
          if (result.status === "error") toast.error("Couldn't build the error report", { description: result.message });
          else downloadCsv(result.csv, result.filename);
        });
      }}
    >
      {pending ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}
      <span className="hidden lg:inline">Error report</span>
    </Button>
  );
}

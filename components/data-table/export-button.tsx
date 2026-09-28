"use client";

// "Export" for a table: asks a Server Action for the CSV of everything the
// current view matches (all pages, not just the one on screen) and hands it to
// the browser as a download.
import * as React from "react";
import { Download, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { CsvExportResult } from "@/lib/csv";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/dashboard/use-toast";
import { CONTROL_HEIGHT } from "@/components/data-table/styles";
import { plural } from "@/components/data-table/row-selection";

interface ExportButtonProps {
  /** Singular noun for the toasts: "Exported 12 users". */
  noun: string;
  run: () => Promise<CsvExportResult>;
}

export function ExportButton({ noun, run }: ExportButtonProps) {
  const [exporting, startExport] = React.useTransition();

  function handleExport(): void {
    if (exporting) return;
    startExport(async () => {
      const result = await run();
      if (result.status === "error") {
        toast.error(`Couldn't export ${noun}s`, { description: result.message });
        return;
      }
      const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.append(link);
      link.click();
      link.remove();
      // Revoked on the next tick: the click has handed the URL to the download.
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success(`Exported ${plural(result.count, noun)}`, { description: result.filename });
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleExport}
      aria-disabled={exporting ? "true" : undefined}
      className={cn("px-3", CONTROL_HEIGHT)}
    >
      {exporting ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}
      {exporting ? "Exporting…" : "Export"}
    </Button>
  );
}

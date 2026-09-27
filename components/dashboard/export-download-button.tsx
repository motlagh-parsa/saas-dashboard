"use client";

// The one interactive cell in the Recent Exports register. Fetches a real CSV of
// the workspace's metrics from /api/reports/[reportId], then saves the response
// through a temporary object URL and a throwaway `<a download>`.
//
// Every export is CSV, whatever the row's Format column says: the route only
// produces CSV. The filename comes from the route's Content-Disposition header.
import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/dashboard/use-toast";

interface ExportDownloadButtonProps {
  /** A `REPORTS[].id` — selects the report on the route. */
  reportId: string;
  /** Display name, for the accessible label and the error toast. */
  report: string;
  period: string;
}

/** `attachment; filename="mrr-summary-2026-09-26.csv"` -> `mrr-summary-2026-09-26.csv`. */
function filenameFromDisposition(header: string | null): string | null {
  const match = header?.match(/filename="([^"]+)"/);
  return match ? match[1] : null;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Revoke on the next task rather than synchronously: some engines resolve the
  // object URL asynchronously after `click()`, and revoking first cancels the
  // download.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ExportDownloadButton({ reportId, report, period }: ExportDownloadButtonProps) {
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);

  // Synchronizing with the network: a row that unmounts mid-download cancels the
  // request instead of saving a file (or raising a toast) after it is gone.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function handleDownload(): Promise<void> {
    if (isDownloading) return;
    setIsDownloading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}`, {
        signal: controller.signal,
      });

      // `requireSession()` redirects an expired session to /sign-in, and fetch
      // follows it — so a redirect here means "signed out", not a CSV.
      if (response.redirected) {
        window.location.assign(response.url);
        return;
      }
      if (!response.ok) throw new Error(`Export failed with status ${response.status}`);

      const blob = await response.blob();
      const filename =
        filenameFromDisposition(response.headers.get("Content-Disposition")) ??
        `${reportId}.csv`;
      saveBlob(blob, filename);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      console.error(error);
      toast.error("Download failed", { description: `${report} could not be exported.` });
    } finally {
      if (!controller.signal.aborted) {
        abortRef.current = null;
        setIsDownloading(false);
      }
    }
  }

  return (
    // 44px on touch, tightened to the app's 32px icon button on a pointer. The
    // label carries the PERIOD as well as the name because two rows share a
    // report name — "Download MRR Summary" twice would be ambiguous read aloud.
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`${isDownloading ? "Downloading" : "Download"} ${report} for ${period} (CSV)`}
      aria-busy={isDownloading}
      disabled={isDownloading}
      className="size-11 sm:size-8"
      onClick={handleDownload}
    >
      {isDownloading ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}
    </Button>
  );
}

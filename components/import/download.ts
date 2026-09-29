"use client";

/** Hands a CSV to the browser as a download (templates, error reports). */
export function downloadCsv(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next tick: the click has handed the URL to the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

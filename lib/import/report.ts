// The downloadable error report: every refused row as it was in the file, with
// its line number and what was wrong. Isomorphic — the wizard builds it from an
// import's result, the history builds it from a stored run — and written with the
// shared formula-neutralizing CSV writer, because every value in it came from an
// uploaded file.
import { buildCsv } from "@/lib/csv/write";

export interface ImportErrorRow {
  readonly line: number;
  readonly values: readonly string[];
  readonly message: string;
}

/** What a run keeps of its errors (`ImportRun.errors`). */
export interface ImportErrorLog {
  readonly headers: readonly string[];
  readonly rows: readonly ImportErrorRow[];
}

/** At most this many row errors are kept on a run. */
export const MAX_STORED_ERRORS = 1_000;

export function buildErrorReport(log: ImportErrorLog): string {
  const width = log.headers.length;
  return buildCsv(
    [...log.headers, "Line", "Error"],
    log.rows.map((row) => [
      ...Array.from({ length: width }, (_, index) => row.values[index] ?? ""),
      ...row.values.slice(width),
      String(row.line),
      row.message,
    ]),
  );
}

/** Narrows the stored JSON back to an error log; anything malformed is an empty one. */
export function readErrorLog(value: unknown): ImportErrorLog {
  if (typeof value !== "object" || value === null) return { headers: [], rows: [] };
  const record = value as { headers?: unknown; rows?: unknown };
  const headers = Array.isArray(record.headers) ? record.headers.filter((h): h is string => typeof h === "string") : [];
  const rows = Array.isArray(record.rows)
    ? record.rows.flatMap((row: unknown): ImportErrorRow[] => {
        if (typeof row !== "object" || row === null) return [];
        const candidate = row as { line?: unknown; values?: unknown; message?: unknown };
        if (typeof candidate.line !== "number" || typeof candidate.message !== "string" || !Array.isArray(candidate.values)) return [];
        return [
          {
            line: candidate.line,
            message: candidate.message,
            values: candidate.values.filter((v): v is string => typeof v === "string"),
          },
        ];
      })
    : [];
  return { headers, rows };
}

"use client";

// The CSV import wizard: choose what to import, upload, map columns, preview,
// import, see the result.
//
// The browser parses the file (lib/csv/parse.ts) only to give instant feedback
// and to fill the column mapping; every server call sends the raw text again and
// the server parses it itself (lib/import-actions.ts). The file is never stored.
//
// Nothing ambiguous is guessed: when the amounts could use either decimal
// separator, or the dates either day/month order, the mapping step asks and the
// preview stays blocked until it is answered.
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleAlert, Download, FileUp, Loader2, Upload } from "lucide-react";

import { cn } from "@/lib/utils";
import { CSV_MAX_BYTES, parseCsv, type CsvParseResult } from "@/lib/csv/parse";
import { buildCsv } from "@/lib/csv/write";
import { formatCount } from "@/lib/format";
import {
  importProgress,
  previewImport,
  runImport,
  type PreviewResult,
  type RunResult,
} from "@/lib/import-actions";
import {
  IMPORT_KINDS,
  IMPORT_KIND_KEYS,
  autoMap,
  missingMappings,
  templateRows,
  type ImportKindKey,
} from "@/lib/import/kinds";
import { buildErrorReport } from "@/lib/import/report";
import { detectDateOrder, detectDecimal, type DateOrder, type DecimalSeparator } from "@/lib/import/values";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SELECT_CLASS } from "@/components/billing/form-dialog";
import { downloadCsv } from "@/components/import/download";
import { EYEBROW } from "@/components/data-table/styles";

type Step = "kind" | "upload" | "map" | "preview" | "running" | "result";

const STEPS: readonly { key: Step; label: string }[] = [
  { key: "kind", label: "What" },
  { key: "upload", label: "Upload" },
  { key: "map", label: "Map columns" },
  { key: "preview", label: "Preview" },
  { key: "result", label: "Import" },
];

interface LoadedFile {
  readonly name: string;
  readonly text: string;
  readonly parse: CsvParseResult;
}

const PRIMARY = "h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9";

const OUTCOME_CLASS: Record<string, string> = {
  create: "bg-positive/12 text-positive",
  update: "bg-brand/12 text-brand",
  unchanged: "bg-muted text-muted-foreground",
  error: "bg-negative/12 text-negative",
};

const OUTCOME_LABEL: Record<string, string> = {
  create: "Create",
  update: "Update",
  unchanged: "Unchanged",
  error: "Error",
};

const DATE_FIELDS = new Set(["start_date", "end_date", "canceled_at", "issued_at", "due_at", "paid_at"]);

/** Where each kind's data lives once imported. */
const RESULT_LINKS: Record<ImportKindKey, { href: string; label: string }[]> = {
  customers: [{ href: "/dashboard/customers", label: "View customers" }],
  plans: [{ href: "/dashboard/plans", label: "View plans" }],
  subscriptions: [
    { href: "/dashboard", label: "Open the overview" },
    { href: "/dashboard/customers", label: "View customers" },
  ],
  invoices: [{ href: "/dashboard/invoices", label: "View invoices" }],
};

interface ImportWizardProps {
  organizationId: string;
  currency: string;
  /** From `?kind=` — preselects a kind and opens the upload step. */
  initialKind?: ImportKindKey;
}

export function ImportWizard({ organizationId, currency, initialKind }: ImportWizardProps) {
  const router = useRouter();
  const [step, setStep] = React.useState<Step>(initialKind ? "upload" : "kind");
  const [kind, setKind] = React.useState<ImportKindKey>(initialKind ?? "plans");
  const [file, setFile] = React.useState<LoadedFile | null>(null);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [mapping, setMapping] = React.useState<Record<string, number | null>>({});
  const [amountsInCents, setAmountsInCents] = React.useState<boolean>(false);
  const [decimal, setDecimal] = React.useState<DecimalSeparator | null>(null);
  const [dateOrder, setDateOrder] = React.useState<DateOrder | null>(null);
  const [preview, setPreview] = React.useState<PreviewResult | null>(null);
  const [result, setResult] = React.useState<RunResult | null>(null);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const [busy, startBusy] = React.useTransition();
  const [dragging, setDragging] = React.useState<boolean>(false);

  const spec = IMPORT_KINDS[kind];
  const hasAmount = spec.fields.some((field) => field.key === "amount");

  // ---- detection over the mapped columns ------------------------------------
  const sample = React.useCallback(
    (keys: readonly string[]): string[] => {
      if (!file) return [];
      const values: string[] = [];
      for (const key of keys) {
        const index = mapping[key];
        if (index === null || index === undefined) continue;
        for (const row of file.parse.rows.slice(0, 2000)) {
          const value = (row[index] ?? "").trim();
          if (value) values.push(value);
        }
      }
      return values;
    },
    [file, mapping],
  );
  const detectedDecimal = hasAmount && !amountsInCents ? detectDecimal(sample(["amount"])) : "point";
  const detectedOrder = detectDateOrder(sample(spec.fields.filter((field) => DATE_FIELDS.has(field.key)).map((f) => f.key)));
  const effectiveDecimal: DecimalSeparator | null = detectedDecimal === "ambiguous" ? decimal : (decimal ?? detectedDecimal);
  const effectiveOrder: DateOrder | null =
    detectedOrder === "dmy" || detectedOrder === "mdy" ? detectedOrder : detectedOrder === "ambiguous" ? dateOrder : null;
  const missing = missingMappings(kind, mapping);
  const blockers = [
    ...missing,
    ...(detectedDecimal === "ambiguous" && effectiveDecimal === null ? ["Choose how the amounts write decimals."] : []),
    ...(detectedOrder === "ambiguous" && dateOrder === null ? ["Choose whether dates are day/month or month/day."] : []),
    ...(detectedOrder === "conflict" ? ["The dates in this file use both day/month and month/day order. Fix the file so they use one."] : []),
  ];

  function request() {
    if (!file) throw new Error("no file");
    return {
      organizationId,
      kind,
      fileName: file.name,
      text: file.text,
      mapping,
      options: { amountsInCents, decimal: effectiveDecimal ?? "point", dateOrder: effectiveOrder },
    };
  }

  // ---- steps -------------------------------------------------------------------
  function chooseKind(next: ImportKindKey): void {
    setKind(next);
    setFile(null);
    setUploadError(null);
    setPreview(null);
    setResult(null);
    setStep("upload");
  }

  async function acceptFile(picked: File): Promise<void> {
    setUploadError(null);
    if (picked.size > CSV_MAX_BYTES) {
      setUploadError("The file is larger than 5 MB. Split it into smaller files and import them one after another.");
      return;
    }
    const text = await picked.text();
    const parse = parseCsv(text);
    if (parse.errors.length > 0) {
      const [first] = parse.errors;
      setUploadError(first ? `Line ${first.line}: ${first.message}` : "The file could not be read.");
      return;
    }
    if (parse.rows.length === 0) {
      setUploadError("The file has a header but no rows.");
      return;
    }
    setFile({ name: picked.name, text, parse });
    setMapping(autoMap(kind, parse.headers));
    setAmountsInCents(false);
    setDecimal(null);
    setDateOrder(null);
    setPreview(null);
    setStep("map");
  }

  function runPreview(): void {
    startBusy(async () => {
      const next = await previewImport(request());
      setPreview(next);
      setStep("preview");
    });
  }

  function runTheImport(): void {
    const runId = crypto.randomUUID();
    setStep("running");
    setProgress({ done: 0, total: file?.parse.rows.length ?? 0 });
    let finished = false;
    const poll = async (): Promise<void> => {
      while (!finished) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        if (finished) return;
        const state = await importProgress(organizationId, runId);
        if (state.status !== "missing") setProgress({ done: state.done, total: state.totalRows });
      }
    };
    void poll();
    startBusy(async () => {
      const outcome = await runImport({ ...request(), runId });
      finished = true;
      setResult(outcome);
      setStep("result");
      router.refresh();
    });
  }

  function reset(): void {
    setFile(null);
    setPreview(null);
    setResult(null);
    setProgress(null);
    setStep("kind");
  }

  const stepIndex = STEPS.findIndex((entry) => entry.key === (step === "running" ? "result" : step));

  return (
    <Card className="gap-0 py-0" data-testid="import-wizard">
      <CardHeader className="border-b border-border pt-4">
        <ol className="flex flex-wrap items-center gap-x-4 gap-y-1" aria-label="Import steps">
          {STEPS.map((entry, index) => (
            <li
              key={entry.key}
              aria-current={index === stepIndex ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 font-mono text-[0.6875rem] font-medium tracking-[0.12em] uppercase",
                index === stepIndex ? "text-foreground" : index < stepIndex ? "text-muted-foreground" : "text-muted-foreground/50",
              )}
            >
              <span
                className={cn(
                  "grid size-5 place-items-center rounded-full text-[0.625rem]",
                  index <= stepIndex ? "bg-brand text-brand-foreground" : "bg-muted text-muted-foreground",
                )}
              >
                {index + 1}
              </span>
              {entry.label}
            </li>
          ))}
        </ol>
      </CardHeader>

      {/* ---- 1. kind ---------------------------------------------------------- */}
      {step === "kind" ? (
        <CardContent className="grid gap-3 py-4 md:grid-cols-2">
          {IMPORT_KIND_KEYS.map((key) => {
            const option = IMPORT_KINDS[key];
            return (
              <section key={key} className="flex flex-col gap-3 rounded-xl border border-border p-4" data-kind={key}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-heading text-base font-semibold tracking-tight">{option.label}</h3>
                    <p className="mt-0.5 text-sm text-muted-foreground">{option.description}</p>
                  </div>
                </div>
                <ul className="grid gap-1 text-xs">
                  {option.fields.map((field) => (
                    <li key={field.key} className="flex gap-2">
                      <code className="shrink-0 font-mono text-foreground">
                        {field.key}
                        {field.required ? <span className="text-brand">*</span> : null}
                      </code>
                      <span className="text-muted-foreground">{field.description}</span>
                    </li>
                  ))}
                  {option.requiredGroups.map((group) => (
                    <li key={group.message} className="text-muted-foreground">
                      <span className="text-brand">*</span> {group.message.replace("Map ", "")}
                    </li>
                  ))}
                </ul>
                <div className="mt-auto flex flex-wrap gap-2">
                  <Button type="button" className={PRIMARY} onClick={() => chooseKind(key)}>
                    <FileUp aria-hidden />
                    Import {option.plural}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 px-3 sm:h-9"
                    onClick={() => {
                      const template = templateRows(key);
                      downloadCsv(buildCsv(template.headers, template.rows), `meridian-${key}-template.csv`);
                    }}
                  >
                    <Download aria-hidden />
                    Template
                  </Button>
                </div>
              </section>
            );
          })}
          <p className="text-xs text-muted-foreground md:col-span-2">
            Import in this order — plans, customers, subscriptions, invoices — or start with subscriptions: missing
            customers and plans are created from them. Re-importing a file only changes what differs.
          </p>
        </CardContent>
      ) : null}

      {/* ---- 2. upload -------------------------------------------------------- */}
      {step === "upload" ? (
        <CardContent className="grid gap-4 py-4">
          <BackLink onClick={() => setStep("kind")}>Choose a different kind</BackLink>
          <h2 className="font-heading text-lg font-semibold tracking-tight">Upload your {spec.plural} CSV</h2>
          <label
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const dropped = event.dataTransfer.files[0];
              if (dropped) void acceptFile(dropped);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
              dragging ? "border-brand bg-brand/5" : "border-border hover:border-brand/50",
            )}
          >
            <Upload aria-hidden className="size-6 text-muted-foreground" />
            <span className="text-sm font-medium">Drop a CSV here, or choose a file</span>
            <span className="text-xs text-muted-foreground">
              Up to 5 MB and 20,000 rows. Comma, semicolon and tab separated files all work.
            </span>
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
              className="sr-only"
              data-testid="import-file"
              onChange={(event) => {
                const picked = event.target.files?.[0];
                if (picked) void acceptFile(picked);
                event.target.value = "";
              }}
            />
          </label>
          {uploadError ? <Alert>{uploadError}</Alert> : null}
        </CardContent>
      ) : null}

      {/* ---- 3. map ------------------------------------------------------------ */}
      {step === "map" && file ? (
        <CardContent className="grid gap-4 py-4">
          <BackLink onClick={() => setStep("upload")}>Upload a different file</BackLink>
          <div>
            <h2 className="font-heading text-lg font-semibold tracking-tight">Match your columns</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              <span className="font-mono">{file.name}</span> · {formatCount(file.parse.rows.length)} rows ·{" "}
              {file.parse.headers.length} columns · {file.parse.delimiter === "\t" ? "tab" : file.parse.delimiter === ";" ? "semicolon" : "comma"} separated
            </p>
          </div>
          <div className="grid gap-2">
            {spec.fields.map((field) => {
              const index = mapping[field.key] ?? null;
              const example = index === null ? null : (file.parse.rows[0]?.[index] ?? "");
              return (
                <div key={field.key} className="grid items-center gap-2 sm:grid-cols-[14rem_1fr_12rem]">
                  <label htmlFor={`map-${field.key}`} className="text-sm">
                    <span className="font-medium">{field.label}</span>
                    {field.required ? <span className="text-brand"> *</span> : null}
                    <span className="block font-mono text-[0.6875rem] text-muted-foreground">{field.key}</span>
                  </label>
                  <select
                    id={`map-${field.key}`}
                    name={field.key}
                    value={index === null ? "" : String(index)}
                    onChange={(event) =>
                      setMapping((previous) => ({
                        ...previous,
                        [field.key]: event.target.value === "" ? null : Number(event.target.value),
                      }))
                    }
                    className={cn(SELECT_CLASS, "sm:h-9")}
                  >
                    <option value="">— Not in this file —</option>
                    {file.parse.headers.map((header, headerIndex) => (
                      <option key={`${header}-${headerIndex}`} value={String(headerIndex)}>
                        {header || `Column ${headerIndex + 1}`}
                      </option>
                    ))}
                  </select>
                  <span className="truncate font-mono text-xs text-muted-foreground" title={example ?? undefined}>
                    {example === null ? "" : example || "(empty)"}
                  </span>
                </div>
              );
            })}
          </div>

          {hasAmount || detectedOrder !== "none" ? (
            <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
              {hasAmount ? (
                <label className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    name="amountsInCents"
                    checked={amountsInCents}
                    onChange={(event) => setAmountsInCents(event.target.checked)}
                    className="mt-0.5 size-4 accent-brand"
                  />
                  <span>
                    Amounts are in cents
                    <span className="block text-xs text-muted-foreground">
                      For Stripe-style exports, where 4900 means 49.00 {currency}.
                    </span>
                  </span>
                </label>
              ) : null}
              {hasAmount && !amountsInCents ? (
                <fieldset className="grid gap-1.5">
                  <legend className="text-sm font-medium">
                    Decimal separator{" "}
                    {detectedDecimal === "ambiguous" ? (
                      <span className="text-brand">— values like 1,234 could be either; choose one</span>
                    ) : (
                      <span className="font-normal text-muted-foreground">— detected from the file</span>
                    )}
                  </legend>
                  <div className="flex flex-wrap gap-4">
                    {(["point", "comma"] as const).map((option) => (
                      <label key={option} className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="decimal"
                          value={option}
                          checked={effectiveDecimal === option}
                          onChange={() => setDecimal(option)}
                          className="accent-brand"
                        />
                        {option === "point" ? "Point — 1,234.56" : "Comma — 1.234,56"}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              {detectedOrder !== "none" && detectedOrder !== "conflict" ? (
                <fieldset className="grid gap-1.5">
                  <legend className="text-sm font-medium">
                    Date order{" "}
                    {detectedOrder === "ambiguous" ? (
                      <span className="text-brand">— every date could be either; choose one</span>
                    ) : (
                      <span className="font-normal text-muted-foreground">— detected from the file</span>
                    )}
                  </legend>
                  <div className="flex flex-wrap gap-4">
                    {(["dmy", "mdy"] as const).map((option) => (
                      <label key={option} className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="dateOrder"
                          value={option}
                          checked={effectiveOrder === option}
                          disabled={detectedOrder !== "ambiguous"}
                          onChange={() => setDateOrder(option)}
                          className="accent-brand"
                        />
                        {option === "dmy" ? "Day first — 31/01/2025" : "Month first — 01/31/2025"}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
            </div>
          ) : null}

          {blockers.length > 0 ? (
            <ul className="grid gap-1 text-sm text-destructive" data-testid="import-blockers">
              {blockers.map((blocker) => (
                <li key={blocker} className="flex items-start gap-1.5">
                  <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  {blocker}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex justify-end">
            <Button type="button" className={PRIMARY} aria-disabled={blockers.length > 0 || busy ? "true" : undefined} onClick={() => blockers.length === 0 && !busy && runPreview()}>
              {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {busy ? "Checking every row…" : "Preview import"}
            </Button>
          </div>
        </CardContent>
      ) : null}

      {/* ---- 4. preview ----------------------------------------------------------- */}
      {step === "preview" && preview ? (
        <CardContent className="grid gap-4 py-4" data-testid="import-preview">
          <BackLink onClick={() => setStep("map")}>Change the mapping</BackLink>
          {preview.status === "error" ? (
            <Alert>{preview.message}</Alert>
          ) : (
            <>
              <div>
                <h2 className="font-heading text-lg font-semibold tracking-tight">Preview — nothing is written yet</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Every row of {file?.name} was checked on the server against this workspace.
                </p>
              </div>
              <Counts
                items={[
                  ["Will create", preview.summary.create],
                  ["Will update", preview.summary.update],
                  ["Unchanged", preview.summary.unchanged],
                  ["Errors", preview.summary.error],
                ]}
              />
              {preview.summary.relatedCustomers + preview.summary.relatedPlans > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Along the way: {preview.summary.relatedCustomers} new customer
                  {preview.summary.relatedCustomers === 1 ? "" : "s"}
                  {kind === "subscriptions" ? ` and ${preview.summary.relatedPlans} new plan${preview.summary.relatedPlans === 1 ? "" : "s"}` : ""}.
                </p>
              ) : null}
              <RowTable title={`First ${Math.min(50, preview.rows.length)} rows`} rows={preview.rows} />
              {preview.summary.error > 0 && preview.errorRows.some((row) => row.index >= 50) ? (
                <RowTable title="First errors" rows={preview.errorRows} />
              ) : null}
              <div className="flex flex-wrap items-center justify-end gap-2">
                {preview.summary.error > 0 ? (
                  <span className="text-xs text-muted-foreground">Rows with errors are skipped; you get a report of them.</span>
                ) : null}
                <Button
                  type="button"
                  className={PRIMARY}
                  aria-disabled={preview.summary.create + preview.summary.update === 0 ? "true" : undefined}
                  onClick={() => preview.summary.create + preview.summary.update > 0 && runTheImport()}
                >
                  {preview.summary.create + preview.summary.update === 0
                    ? "Nothing to import"
                    : `Import ${formatCount(preview.summary.create + preview.summary.update)} row${preview.summary.create + preview.summary.update === 1 ? "" : "s"}`}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      ) : null}

      {/* ---- 5. running ------------------------------------------------------------- */}
      {step === "running" ? (
        <CardContent className="grid gap-3 py-8" role="status" aria-live="polite">
          <p className="flex items-center gap-2 font-medium">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            Importing {file?.name}…
          </p>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-500"
              style={{ width: `${progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 5}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {progress ? `${formatCount(progress.done)} of ${formatCount(progress.total)} rows processed` : "Starting…"} — written in
            chunks of 500, each saved as it completes.
          </p>
        </CardContent>
      ) : null}

      {/* ---- 6. result ------------------------------------------------------------ */}
      {step === "result" && result ? (
        <CardContent className="grid gap-4 py-4" data-testid="import-result">
          {result.status === "error" ? (
            <Alert>{result.message}</Alert>
          ) : (
            <>
              <h2 className="font-heading text-lg font-semibold tracking-tight">
                {result.status === "completed" ? "Import finished" : "Import stopped part-way"}
              </h2>
              {result.status === "failed" ? (
                <Alert>
                  {result.failure ?? "A database error stopped the import."} Chunks already written stay written — the
                  counts below are what was saved. Fix the cause and import the file again: rows already imported are
                  matched, not duplicated.
                </Alert>
              ) : null}
              <Counts
                items={[
                  ["Created", result.totals.created],
                  ["Updated", result.totals.updated],
                  ["Unchanged", result.totals.unchanged],
                  ["Errors", result.totals.errors],
                ]}
              />
              <div className="flex flex-wrap gap-2">
                {result.errorLog.rows.length > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 px-3 sm:h-9"
                    onClick={() => downloadCsv(buildErrorReport(result.errorLog), `import-errors-${kind}.csv`)}
                  >
                    <Download aria-hidden />
                    Download error report
                  </Button>
                ) : null}
                {RESULT_LINKS[kind].map((link) => (
                  <Button key={link.href} asChild variant="outline" className="h-11 px-3 sm:h-9">
                    <Link href={link.href}>{link.label}</Link>
                  </Button>
                ))}
                <Button type="button" className={PRIMARY} onClick={reset}>
                  Import another file
                </Button>
              </div>
            </>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}

function BackLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft aria-hidden className="size-3.5" />
      {children}
    </button>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Counts({ items }: { items: readonly (readonly [string, number])[] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="import-counts">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-border px-3 py-2.5" data-count={label}>
          <dt className={EYEBROW}>{label}</dt>
          <dd className="mt-1 font-mono text-2xl tabular-nums">{formatCount(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function RowTable({ title, rows }: { title: string; rows: readonly { index: number; line: number; outcome: string; label: string; messages: readonly string[] }[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <p className={cn(EYEBROW, "border-b border-border bg-muted/30 px-3 py-2")}>{title}</p>
      <ol className="max-h-96 divide-y divide-border overflow-y-auto">
        {rows.map((row) => (
          <li key={`${title}-${row.index}`} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2 text-sm" data-outcome={row.outcome}>
            <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">line {row.line}</span>
            <Badge variant="secondary" className={cn("shrink-0 font-medium", OUTCOME_CLASS[row.outcome])}>
              {OUTCOME_LABEL[row.outcome]}
            </Badge>
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.messages.length > 0 ? <span className="basis-full pl-[4.25rem] text-xs text-destructive">{row.messages.join(" ")}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

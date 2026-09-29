/**
 * The CSV-import half of `npm run verify:metrics`.
 *
 *   1. lib/csv/parse.ts — every RFC 4180 case and limit, and the value readers
 *      (amounts, dates, statuses, intervals) with their detectors.
 *   2. Imports through lib/import/run.ts `performImport` — the function the
 *      Server Action calls once it has authorized the caller — into throwaway
 *      workspaces: every kind, re-import is a no-op, a multi-row subscription
 *      history becomes the right chain with the right MRR / churn / NRR, the row
 *      errors, cents mode, a semicolon file with decimal commas, a DD/MM file,
 *      the Stripe-shaped fixture, and that nothing matches across workspaces.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { CSV_MAX_ROWS, parseCsv } from "@/lib/csv/parse";
import { autoMap, missingMappings, type ImportKindKey } from "@/lib/import/kinds";
import { performImport, writeRun, type PerformImportResult } from "@/lib/import/run";
import { analyzeImport } from "@/lib/import/engine";
import {
  detectDateOrder,
  detectDecimal,
  parseAmount,
  parseDate,
  parseInterval,
  parseSubscriptionStatus,
  type ImportOptions,
} from "@/lib/import/values";
import { getMetricsSummary, getNetRevenueRetention } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { diffAgainstRebuild } from "@/lib/snapshots";

type Check = (label: string, actual: unknown, expected: unknown) => void;

const POINT: ImportOptions = { amountsInCents: false, decimal: "point", dateOrder: null };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

// ---------------------------------------------------------------------------
// 1. Parser and values
// ---------------------------------------------------------------------------

function verifyParser(check: Check): void {
  console.log("\nlib/csv/parse.ts — RFC 4180 and real-world exports");

  const basic = parseCsv('name,email\r\n"Acme, Inc.",a@acme.example\r\n"Say ""hi""",b@x.example\r\n');
  check("quoted commas, escaped quotes, CRLF, trailing empty line", [basic.headers, basic.rows], [
    ["name", "email"],
    [
      ["Acme, Inc.", "a@acme.example"],
      ['Say "hi"', "b@x.example"],
    ],
  ]);

  const multiline = parseCsv('id,note\n1,"line one\nline two"\n2,plain\n');
  check("newline inside quotes; row line numbers are where each record starts", [multiline.rows, multiline.rowLines], [
    [
      ["1", "line one\nline two"],
      ["2", "plain"],
    ],
    [2, 4],
  ]);

  check("a UTF-8 byte-order mark is dropped", parseCsv("﻿name\nAcme").headers, ["name"]);
  check("LF only, no trailing newline", parseCsv("a,b\n1,2").rows, [["1", "2"]]);
  check("blank lines are skipped", parseCsv("a,b\n\n1,2\n\n").rows, [["1", "2"]]);

  const semicolon = parseCsv("name;amount\nEuro;49,90\n");
  check("semicolon delimiter detected (European Excel)", [semicolon.delimiter, semicolon.rows], [";", [["Euro", "49,90"]]]);
  const tab = parseCsv("name\tamount\nTabbed\t10\n");
  check("tab delimiter detected", [tab.delimiter, tab.rows], ["\t", [["Tabbed", "10"]]]);

  const unterminated = parseCsv('name,email\nok,a@x.example\n"broken,b@x.example\nmore,c@x.example\n');
  check("an unterminated quote is an error at the line it starts", unterminated.errors, [
    { line: 3, message: 'A quoted value starts here and is never closed. Check for a missing closing quote (").' },
  ]);

  check("an empty file is an error", parseCsv("").errors.length, 1);
  const big = parseCsv(`a\n${"x".repeat(5 * 1024 * 1024)}\n`);
  check("over 5 MB is refused with a clear message", big.errors[0]?.message.startsWith("The file is larger than 5 MB"), true);
  const many = parseCsv(`a\n${"1\n".repeat(CSV_MAX_ROWS + 1)}`);
  check("over 20,000 rows is refused with a clear message", many.errors[0]?.message.includes("more than 20,000 rows"), true);
  check("exactly 20,000 rows is fine", parseCsv(`a\n${"1\n".repeat(CSV_MAX_ROWS)}`).rows.length, CSV_MAX_ROWS);

  console.log("\nlib/import/values.ts — amounts, dates, statuses, intervals");
  const amount = (raw: string, currency = "USD", options: ImportOptions = POINT) => {
    const parsed = parseAmount(raw, currency, options);
    return parsed.ok ? parsed.value : parsed.error;
  };
  check("major units: 49.99 → 4999, $1,299.00 → 129900", [amount("49.99"), amount("$1,299.00")], [4999, 129_900]);
  check("cents mode: 4999 → 4999", amount("4999", "USD", { ...POINT, amountsInCents: true }), 4999);
  check("decimal comma: 1.234,56 → 123456", amount("1.234,56", "EUR", { ...POINT, decimal: "comma" }), 123_456);
  check("JPY has no minor unit: 4999 → 4999, 49.9 refused", [amount("4999", "JPY"), typeof amount("49.9", "JPY")], [4999, "string"]);
  check("negative refused", typeof amount("-5"), "string");
  check("detectDecimal: point / comma / ambiguous", [
    detectDecimal(["49.99", "1,299.00"]),
    detectDecimal(["49,99", "1.299,00"]),
    detectDecimal(["1,234", "2,500"]),
  ], ["point", "comma", "ambiguous"]);

  const date = (raw: string, options: ImportOptions = POINT) => {
    const parsed = parseDate(raw, options);
    return parsed.ok ? parsed.value.toISOString().slice(0, 10) : parsed.error;
  };
  check("ISO, ISO with time and offset (converted to UTC first)", [
    date("2025-01-15"),
    date("2025-01-15T10:23:00Z"),
    date("2025-01-15T23:30:00-05:00"),
  ], ["2025-01-15", "2025-01-15", "2025-01-16"]);
  check("Unix seconds (and milliseconds)", [date("1736936591"), date("1736936591000")], ["2025-01-15", "2025-01-15"]);
  check("DD/MM and MM/DD once the order is chosen", [
    date("15/01/2025", { ...POINT, dateOrder: "dmy" }),
    date("01/15/2025", { ...POINT, dateOrder: "mdy" }),
  ], ["2025-01-15", "2025-01-15"]);
  check("a slash date without a chosen order is refused, never guessed", date("03/04/2025").includes("choose the date order"), true);
  check("detectDateOrder: dmy / mdy / ambiguous / none / conflict", [
    detectDateOrder(["15/01/2025", "03/04/2025"]),
    detectDateOrder(["01/15/2025"]),
    detectDateOrder(["03/04/2025"]),
    detectDateOrder(["2025-01-15", "1736936591"]),
    detectDateOrder(["15/01/2025", "01/15/2025"]),
  ], ["dmy", "mdy", "ambiguous", "none", "conflict"]);
  check("impossible and out-of-bounds dates refused", [
    date("2025-02-30").includes("not a real date"),
    date("1999-12-31").includes("before 2000-01-01"),
  ], [true, true]);
  check("status and interval synonyms", [
    parseSubscriptionStatus("Cancelled"),
    parseSubscriptionStatus("in_trial"),
    parseInterval("Monthly", ""),
    parseInterval("quarterly", ""),
    parseInterval("annual", "2"),
  ], [
    { ok: true, value: "CANCELED" },
    { ok: true, value: "TRIALING" },
    { ok: true, value: { interval: "MONTH", intervalCount: 1 } },
    { ok: true, value: { interval: "MONTH", intervalCount: 3 } },
    { ok: true, value: { interval: "YEAR", intervalCount: 2 } },
  ]);
}

// ---------------------------------------------------------------------------
// 2. Imports
// ---------------------------------------------------------------------------

async function importFile(
  organizationId: string,
  currency: string,
  kind: ImportKindKey,
  text: string,
  options: ImportOptions = POINT,
): Promise<PerformImportResult> {
  const headers = parseCsv(text).headers;
  return performImport({
    organizationId,
    currency,
    userId: null,
    runId: randomUUID(),
    fileName: `${kind}.csv`,
    request: { kind, text, mapping: autoMap(kind, headers), options },
  });
}

function counts(result: PerformImportResult): [number, number, number, number] | string {
  if (result.status === "refused") return result.message;
  return [result.totals.created, result.totals.updated, result.totals.unchanged, result.totals.errors];
}

function errorsOf(result: PerformImportResult): string[] {
  return result.status === "refused" ? [result.message] : result.errorLog.rows.map((row) => `${row.line}: ${row.message}`);
}

const PLANS_CSV = "plan_id,name,amount,interval,interval_count\nprice_starter,Starter,29.00,month,1\nprice_pro,Pro,199.00,monthly,\nprice_annual,Annual,1200,year,1\n";
const CUSTOMERS_CSV = "customer_id,name,email\ncus_A,Alpha Co,alpha@import.example\ncus_B,Bravo Co,bravo@import.example\n,Charlie Co,charlie@import.example\n";
// sub_A: Starter from Jan 1, then Pro from Mar 1 (a plan change). sub_B: Pro,
// canceled Feb 15. sub_C: a custom 1,200/yr for a customer matched by email.
const SUBSCRIPTIONS_CSV = [
  "subscription_id,customer_id,customer_email,plan_name,amount,interval,quantity,status,start_date,end_date,canceled_at",
  "sub_A,cus_A,,Starter,,,1,active,2025-01-01,2025-03-01,",
  "sub_A,cus_A,,Pro,,,1,active,2025-03-01,,",
  "sub_B,cus_B,,Pro,,,1,canceled,2025-01-01,2025-02-15,2025-02-10",
  "sub_C,,charlie@import.example,,1200.00,year,1,active,2025-02-01,,",
  "",
].join("\n");
const INVOICES_CSV = [
  "invoice_id,customer_id,subscription_id,amount,status,issued_at,due_at,paid_at",
  "in_1,cus_A,sub_A,29.00,paid,2025-02-10,2025-02-24,2025-02-12",
  "in_2,cus_A,sub_A,199.00,open,2025-03-10,2025-03-24,",
  "in_3,cus_B,,50.00,paid,2025-01-05,,",
  "",
].join("\n");

export async function verifyImports(check: Check, stamp: string): Promise<string[]> {
  verifyParser(check);
  console.log("\nlib/import — every kind through performImport, the action's own function");

  const org = await prisma.organization.create({
    data: { name: "verify-import", slug: `verify-import-${stamp}`, currency: "USD" },
    select: { id: true },
  });
  const other = await prisma.organization.create({
    data: { name: "verify-import other", slug: `verify-import-other-${stamp}`, currency: "USD" },
    select: { id: true },
  });
  const eur = await prisma.organization.create({
    data: { name: "verify-import eur", slug: `verify-import-eur-${stamp}`, currency: "EUR" },
    select: { id: true },
  });
  const stripe = await prisma.organization.create({
    data: { name: "verify-import stripe", slug: `verify-import-stripe-${stamp}`, currency: "USD" },
    select: { id: true },
  });
  const orgId = org.id;

  // Plans
  check("plans: 3 created", counts(await importFile(orgId, "USD", "plans", PLANS_CSV)), [3, 0, 0, 0]);
  check("plans: re-import is a no-op", counts(await importFile(orgId, "USD", "plans", PLANS_CSV)), [0, 0, 3, 0]);
  const pro = await prisma.plan.findFirst({ where: { organizationId: orgId, externalId: "price_pro" } });
  check("plans: values and source", [pro?.amountCents, pro?.interval, pro?.source], [19_900, "MONTH", "CSV"]);

  // Customers
  check("customers: 3 created", counts(await importFile(orgId, "USD", "customers", CUSTOMERS_CSV)), [3, 0, 0, 0]);
  check("customers: re-import is a no-op", counts(await importFile(orgId, "USD", "customers", CUSTOMERS_CSV)), [0, 0, 3, 0]);
  const renamed = CUSTOMERS_CSV.replace("Alpha Co", "Alpha Company");
  check("customers: a changed value is one update", counts(await importFile(orgId, "USD", "customers", renamed)), [0, 1, 2, 0]);
  const manual = await prisma.customer.create({
    data: { organizationId: orgId, name: "Delta Manual", email: "delta@import.example", source: "MANUAL" },
  });
  check("customers: a MANUAL customer matched by email is updated and stays MANUAL", [
    counts(await importFile(orgId, "USD", "customers", "customer_id,name,email\ncus_D,Delta Co,DELTA@import.example\n")),
    (await prisma.customer.findUnique({ where: { id: manual.id } }))?.source,
    (await prisma.customer.findUnique({ where: { id: manual.id } }))?.externalId,
  ], [[0, 1, 0, 0], "MANUAL", "cus_D"]);

  // Subscriptions: history, re-import, metrics
  check("subscriptions: 4 segments created", counts(await importFile(orgId, "USD", "subscriptions", SUBSCRIPTIONS_CSV)), [4, 0, 0, 0]);
  const chainA = await prisma.subscription.findMany({
    where: { organizationId: orgId, externalId: { startsWith: "sub_A:" } },
    orderBy: { startedAt: "asc" },
    include: { plan: { select: { name: true } } },
  });
  check(
    "subscriptions: two rows of sub_A are one chain — Starter ends where Pro starts, linked",
    chainA.map((segment) => [segment.externalId, segment.plan?.name, segment.endedAt?.toISOString().slice(0, 10) ?? null, segment.previousSubscriptionId === (chainA[0]?.id ?? "") ? "linked" : null]),
    [
      ["sub_A:2025-01-01", "Starter", "2025-03-01", null],
      ["sub_A:2025-03-01", "Pro", null, "linked"],
    ],
  );
  const subB = await prisma.subscription.findFirst({ where: { organizationId: orgId, externalId: "sub_B:2025-01-01" } });
  check("subscriptions: sub_B canceled — ended Feb 15, canceled Feb 10, CANCELED", [
    subB?.endedAt?.toISOString().slice(0, 10),
    subB?.canceledAt?.toISOString().slice(0, 10),
    subB?.status,
  ], ["2025-02-15", "2025-02-10", "CANCELED"]);
  const charlie = await prisma.customer.findFirst({ where: { organizationId: orgId, email: "charlie@import.example" } });
  const subC = await prisma.subscription.findFirst({ where: { organizationId: orgId, externalId: "sub_C:2025-02-01" } });
  check("subscriptions: sub_C matched Charlie by email; custom price, no plan", [subC?.customerId === charlie?.id, subC?.planId, subC?.amountCents], [true, null, 120_000]);

  const period = { kind: "range" as const, start: day("2025-01-31"), end: day("2025-03-31") };
  const summary = await getMetricsSummary(orgId, period);
  const nrr = await getNetRevenueRetention(orgId, period);
  check("metrics: MRR at Mar 31 = Pro 199 + custom 100 = 299.00", summary.mrrCents.current, 29_900);
  check("metrics: MRR at the period start (Jan 31) = 228.00", (await getMetricsSummary(orgId, { kind: "range", start: day("2025-01-01"), end: day("2025-01-31") })).mrrCents.current, 22_800);
  check("metrics: customer churn 1/2, revenue churn 199/228", [summary.customerChurnRate.current, summary.revenueChurnRate.current], [0.5, 19_900 / 22_800]);
  check("metrics: NRR = (228 + 170 − 199) / 228 — the plan change is expansion", [nrr.expansionMRRCents, nrr.churnedMRRCents, nrr.nrr], [17_000, 19_900, 19_900 / 22_800]);
  check("metrics: snapshots equal a full rebuild after the import", await diffAgainstRebuild(orgId, day("2025-01-01")), []);

  check("subscriptions: re-import creates nothing", counts(await importFile(orgId, "USD", "subscriptions", SUBSCRIPTIONS_CSV)), [0, 0, 4, 0]);
  const changedQuantity = SUBSCRIPTIONS_CSV.replace("sub_A,cus_A,,Pro,,,1,", "sub_A,cus_A,,Pro,,,3,");
  check("subscriptions: a changed quantity updates just that segment", counts(await importFile(orgId, "USD", "subscriptions", changedQuantity)), [0, 1, 3, 0]);
  check("metrics: … and the snapshots follow", await diffAgainstRebuild(orgId, day("2025-01-01")), []);

  // Invoices
  check("invoices: 3 created", counts(await importFile(orgId, "USD", "invoices", INVOICES_CSV)), [3, 0, 0, 0]);
  const invoices = await prisma.invoice.findMany({
    where: { organizationId: orgId, externalId: { in: ["in_1", "in_2", "in_3"] } },
    orderBy: { externalId: "asc" },
    include: { subscription: { select: { externalId: true } } },
  });
  check(
    "invoices: linked to the terms in force on the issue date; a paid one without paid_at is paid on issue",
    invoices.map((invoice) => [invoice.externalId, invoice.subscription?.externalId ?? null, invoice.status, invoice.paidAt?.toISOString().slice(0, 10) ?? null]),
    [
      ["in_1", "sub_A:2025-01-01", "PAID", "2025-02-12"],
      ["in_2", "sub_A:2025-03-01", "OPEN", null],
      ["in_3", null, "PAID", "2025-01-05"],
    ],
  );
  check("invoices: re-import is a no-op", counts(await importFile(orgId, "USD", "invoices", INVOICES_CSV)), [0, 0, 3, 0]);

  // Row errors
  const bad = [
    "subscription_id,customer_id,plan_name,amount,interval,status,start_date,currency",
    "sub_X1,cus_A,Starter,29.00,month,active,2025-05-01,EUR", // currency mismatch
    "sub_X2,cus_A,Starter,,,active,2025-13-45,", // bad date
    "sub_X3,cus_A,Starter,35.00,month,active,2025-05-01,", // price conflict with the existing Starter
    "sub_X4,cus_A,Starter,,,active,,", // missing start date
    "sub_X5,cus_A,Starter,,,active,2025-05-01,", // valid
    "",
  ].join("\n");
  const badResult = await importFile(orgId, "USD", "subscriptions", bad);
  check("errors: 1 created, 4 errors", counts(badResult), [1, 0, 0, 4]);
  check("errors: each row reports its own problem", errorsOf(badResult), [
    "2: This workspace reports in USD; row is EUR.",
    "3: “2025-13-45” is not a real date.",
    "4: Plan “Starter” is $29 / month, but this row says $35 / month. Fix the row, or import it with a different plan name.",
    "5: Start date is required.",
  ]);
  const gap = [
    "subscription_id,customer_id,plan_name,start_date,end_date",
    "sub_G,cus_A,Starter,2025-01-01,2025-02-01",
    "sub_G,cus_A,Pro,2025-02-15,",
    "",
  ].join("\n");
  const gapResult = await importFile(orgId, "USD", "subscriptions", gap);
  check("errors: a history with a gap is refused as a whole", [counts(gapResult), errorsOf(gapResult)[0]?.startsWith("2: These terms end")], [[0, 0, 0, 2], true]);
  check("errors: an unmapped required column is refused before any row", counts(await importFile(orgId, "USD", "plans", "name,amount\nX,1\n")), "Map a column to Interval.");

  // Cents mode, semicolons with decimal commas, DD/MM
  check("cents mode: 4900 → 49.00", counts(await importFile(eur.id, "EUR", "plans", "name,amount,interval\nCents,4900,month\n", { ...POINT, amountsInCents: true })), [1, 0, 0, 0]);
  check("… stored as 4900 minor units", (await prisma.plan.findFirst({ where: { organizationId: eur.id, name: "Cents" } }))?.amountCents, 4900);
  const semicolonText = "name;amount;interval\nKomma;49,90;monatlich\nPunkt;1.234,50;month\n";
  const semicolonAnalysis = await analyzeImport(eur.id, "EUR", {
    kind: "plans",
    text: semicolonText,
    mapping: autoMap("plans", parseCsv(semicolonText).headers),
    options: { ...POINT, decimal: detectDecimal(["49,90", "1.234,50"]) === "comma" ? "comma" : "point" },
  });
  check("semicolon file with decimal commas: 49,90 → 4990; an unknown interval word is a row error", [
    semicolonAnalysis.summary.create,
    semicolonAnalysis.summary.error,
    semicolonAnalysis.reports[1]?.label,
  ], [1, 1, "Punkt · €1,234.50 / month"]);
  const dmyText = "subscription_id,customer_email,amount,interval,start_date\nsub_D,dmy@import.example,10,month,15/01/2025\nsub_E,dmy@import.example,10,month,03/02/2025\n";
  check("DD/MM file: order detected from 15/01", detectDateOrder(["15/01/2025", "03/02/2025"]), "dmy");
  check("DD/MM file imports with the chosen order", counts(await importFile(eur.id, "EUR", "subscriptions", dmyText, { ...POINT, dateOrder: "dmy" })), [2, 0, 0, 0]);
  check("… 03/02/2025 is 3 February", (await prisma.subscription.findFirst({ where: { organizationId: eur.id, externalId: "sub_E:2025-02-03" } })) !== null, true);

  // Stripe fixture
  const fixture = readFileSync("scripts/fixtures/stripe-subscriptions-export.csv", "utf8");
  const fixtureHeaders = parseCsv(fixture).headers;
  const mapping = autoMap("subscriptions", fixtureHeaders);
  const mapped = Object.entries(mapping).filter(([, index]) => index !== null).map(([key]) => key).sort();
  check("Stripe export: auto-mapping fills 14 of its 15 columns (all but Created), nothing required missing", [mapped, missingMappings("subscriptions", mapping)], [
    ["amount", "canceled_at", "currency", "customer_email", "customer_id", "customer_name", "end_date", "interval", "plan_id", "plan_name", "quantity", "start_date", "status", "subscription_id"],
    [],
  ]);
  const stripeResult = await importFile(stripe.id, "USD", "subscriptions", fixture, { ...POINT, amountsInCents: true });
  check("Stripe export: 8 subscriptions, cents and Unix timestamps", counts(stripeResult), [8, 0, 0, 0]);
  check("Stripe export: 7 customers and 3 plans created along the way", [
    await prisma.customer.count({ where: { organizationId: stripe.id, source: "CSV" } }),
    await prisma.plan.count({ where: { organizationId: stripe.id, source: "CSV" } }),
  ], [7, 3]);
  const stripeNow = await getMetricsSummary(stripe.id, { kind: "range", start: day("2026-01-01"), end: new Date() });
  check("Stripe export: live MRR = 900.50 (29 + 237 + 58 + 79 + (1,990 + 3,980) / 12)", stripeNow.mrrCents.current, 90_050);
  check("Stripe export: re-import creates nothing", counts(await importFile(stripe.id, "USD", "subscriptions", fixture, { ...POINT, amountsInCents: true })), [0, 0, 8, 0]);

  // Tenant isolation: the same IDs in another workspace match nothing there.
  check("isolation: the same file in another workspace creates everything anew", [
    counts(await importFile(other.id, "USD", "plans", PLANS_CSV)),
    counts(await importFile(other.id, "USD", "customers", CUSTOMERS_CSV)),
  ], [[3, 0, 0, 0], [3, 0, 0, 0]]);
  check("isolation: … and the first workspace is untouched", await prisma.plan.count({ where: { organizationId: orgId } }), 3);

  // A plan name taken by a plan with another ID is a row error, never a write
  // that the unique name would reject.
  const clash = await importFile(
    orgId,
    "USD",
    "subscriptions",
    "subscription_id,customer_id,plan_id,plan_name,amount,interval,start_date\nsub_N,cus_A,price_other,Starter,29.00,month,2025-06-01\n",
  );
  check("errors: a new plan whose name is taken under another ID", errorsOf(clash), [
    "2: A plan named “Starter” already exists with ID “price_starter”, not “price_other”. Rename the plan in the file, or use its ID.",
  ]);

  const runs = await prisma.importRun.findMany({ where: { organizationId: orgId }, select: { status: true } });
  check("every run recorded as COMPLETED", runs.every((run) => run.status === "COMPLETED") && runs.length > 5, true);

  // A crash part-way: 600 customers (chunk 1 = 500, chunk 2 = 100) plus a plan
  // the database refuses (interval count 0 breaks a CHECK constraint) in chunk 2.
  console.log("\nlib/import/run.ts — a run that fails part-way");
  const crashText = `name,email\n${Array.from({ length: 600 }, (_, i) => `Crash ${i},crash${i}@import.example`).join("\n")}\n`;
  const crashAnalysis = await analyzeImport(other.id, "USD", {
    kind: "customers",
    text: crashText,
    mapping: autoMap("customers", parseCsv(crashText).headers),
    options: POINT,
  });
  const poisoned = {
    ...crashAnalysis,
    units: [
      ...crashAnalysis.units,
      {
        type: "plan" as const,
        rows: [599],
        existingId: null,
        data: { externalId: null, name: "Poison", amountCents: 100, interval: "MONTH" as const, intervalCount: 0 },
      },
    ],
  };
  const crashRunId = randomUUID();
  await prisma.importRun.create({
    data: { id: crashRunId, organizationId: other.id, kind: "CUSTOMERS", fileName: "crash.csv", totalRows: 600 },
  });
  const crash = await writeRun(other.id, crashRunId, poisoned);
  const crashRun = await prisma.importRun.findUnique({ where: { id: crashRunId }, select: { status: true, created: true } });
  check("the failing chunk stops the run: FAILED, with the first chunk's 500 kept", [
    crash.failure !== null,
    crashRun?.status,
    crashRun?.created,
    await prisma.customer.count({ where: { organizationId: other.id, email: { startsWith: "crash" } } }),
  ], [true, "FAILED", 500, 500]);

  return [org.id, other.id, eur.id, stripe.id];
}

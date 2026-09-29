import "server-only";

// The CSV import engine: analyse a file against a workspace, then write it.
//
//   analyzeImport  — re-parses the raw text (the server never trusts the
//                    client's parse), reads every value with the mapping and
//                    options the founder chose, resolves each row against the
//                    workspace's existing records, and decides per row: create,
//                    update, unchanged, or error. Writes nothing. The preview
//                    is exactly this.
//   executeImport  — writes the analysis's valid "units" in chunks of about 500
//                    rows, each chunk in its own transaction, re-resolving
//                    customers and plans at write time so a record created by an
//                    earlier chunk is reused, never duplicated.
//
// Matching and idempotency:
//   - Every lookup is scoped to the one workspace: nothing here can match a
//     record of another.
//   - Records match by `externalId` (the file's ID column). Customers without an
//     ID match by email (case-insensitive); plans without an ID by name.
//   - A subscription SEGMENT's externalId is `${subscription_id}:${start date}`:
//     the rows sharing a subscription_id are one chain, ordered by start date,
//     linked through `previousSubscriptionId`, and a row's identity is "this
//     subscription's terms that began on this day". Re-importing the same file
//     therefore matches every segment, and a genuinely new plan change (a new
//     start date) becomes a new segment — the same segment model manual entry
//     uses.
//   - A matched record is updated only when a value differs; otherwise it is
//     counted as unchanged. Created rows get source = CSV; an updated record
//     keeps whatever source it had (a MANUAL customer stays MANUAL).
import type {
  BillingInterval,
  DataSource,
  InvoiceStatus,
  Prisma,
  SubscriptionStatus,
} from "@prisma/client";

import { parseCsv } from "@/lib/csv/parse";
import { formatDay, formatIntervalWords, formatPrice } from "@/lib/format";
import { IMPORT_KINDS, missingMappings, type ColumnMapping, type ImportKindKey } from "@/lib/import/kinds";
import {
  checkCurrency,
  parseAmount,
  parseDate,
  parseInterval,
  parseInvoiceStatus,
  parseQuantity,
  parseSubscriptionStatus,
  type ImportOptions,
} from "@/lib/import/values";
import { MAX_MINOR_UNITS } from "@/lib/money";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ImportRequest {
  readonly kind: ImportKindKey;
  readonly text: string;
  readonly mapping: ColumnMapping;
  readonly options: ImportOptions;
}

export type RowOutcome = "create" | "update" | "unchanged" | "error";

export interface RowReport {
  /** Index into the data rows (0-based). */
  readonly index: number;
  /** Physical line in the file (1-based, the header is line 1). */
  readonly line: number;
  readonly outcome: RowOutcome;
  /** A short description: "Acme · Pro · $199 / month from 15 Jun 2025". */
  readonly label: string;
  readonly messages: readonly string[];
}

export interface ImportSummary {
  readonly create: number;
  readonly update: number;
  readonly unchanged: number;
  readonly error: number;
  /** Customers and plans a subscriptions or invoices file will create along the way. */
  readonly relatedCustomers: number;
  readonly relatedPlans: number;
}

type CustomerRef =
  | { readonly kind: "existing"; readonly id: string }
  | { readonly kind: "new"; readonly externalId: string | null; readonly email: string | null; readonly name: string };

type PlanRef =
  | null
  | { readonly kind: "existing"; readonly id: string }
  | {
      readonly kind: "new";
      readonly externalId: string | null;
      readonly name: string;
      readonly amountCents: number;
      readonly interval: BillingInterval;
      readonly intervalCount: number;
    };

interface SegmentPlan {
  readonly row: number;
  readonly existingId: string | null;
  readonly externalId: string;
  readonly plan: PlanRef;
  readonly amountCents: number;
  readonly quantity: number;
  readonly interval: BillingInterval;
  readonly intervalCount: number;
  readonly status: SubscriptionStatus;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly canceledAt: Date | null;
  readonly outcome: "create" | "update" | "unchanged";
}

export type ImportUnit =
  | {
      readonly type: "customer";
      readonly rows: readonly number[];
      readonly existingId: string | null;
      readonly data: { readonly externalId: string | null; readonly name: string; readonly email: string | null };
    }
  | {
      readonly type: "plan";
      readonly rows: readonly number[];
      readonly existingId: string | null;
      readonly data: {
        readonly externalId: string | null;
        readonly name: string;
        readonly amountCents: number;
        readonly interval: BillingInterval;
        readonly intervalCount: number;
      };
    }
  | {
      readonly type: "chain";
      readonly rows: readonly number[];
      readonly customer: CustomerRef;
      readonly segments: readonly SegmentPlan[];
      /** Earliest day whose snapshot this chain can move; null when nothing changes. */
      readonly affectedFrom: Date | null;
    }
  | {
      readonly type: "invoice";
      readonly rows: readonly number[];
      readonly existingId: string | null;
      readonly customer: CustomerRef;
      readonly subscriptionId: string | null;
      readonly data: {
        readonly externalId: string;
        readonly amountCents: number;
        readonly status: InvoiceStatus;
        readonly issuedAt: Date;
        readonly dueAt: Date | null;
        readonly paidAt: Date | null;
      };
    };

export interface ImportAnalysis {
  /** Why the file cannot be imported at all (parse error, missing mapping); null otherwise. */
  readonly fatal: string | null;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly reports: readonly RowReport[];
  /** Only the units whose rows are all valid, in file order. */
  readonly units: readonly ImportUnit[];
  readonly summary: ImportSummary;
}

const EMPTY_SUMMARY: ImportSummary = { create: 0, update: 0, unchanged: 0, error: 0, relatedCustomers: 0, relatedPlans: 0 };

function fatal(message: string, headers: readonly string[] = []): ImportAnalysis {
  return { fatal: message, headers, rows: [], reports: [], units: [], summary: EMPTY_SUMMARY };
}

// ---------------------------------------------------------------------------
// Workspace context — everything a row may match, loaded once per analysis
// ---------------------------------------------------------------------------

interface CustomerRow {
  id: string;
  externalId: string | null;
  email: string | null;
  name: string;
}

interface PlanRow {
  id: string;
  externalId: string | null;
  name: string;
  amountCents: number;
  interval: BillingInterval;
  intervalCount: number;
}

interface SegmentRow {
  id: string;
  externalId: string | null;
  customerId: string;
  planId: string | null;
  amountCents: number;
  quantity: number;
  interval: BillingInterval;
  intervalCount: number;
  status: SubscriptionStatus;
  startedAt: Date;
  endedAt: Date | null;
  canceledAt: Date | null;
  previousSubscriptionId: string | null;
  next: { id: string; externalId: string | null } | null;
}

interface InvoiceRow {
  id: string;
  externalId: string | null;
  customerId: string;
  subscriptionId: string | null;
  amountCents: number;
  status: InvoiceStatus;
  issuedAt: Date;
  dueAt: Date | null;
  paidAt: Date | null;
}

class Context {
  readonly customersByExt = new Map<string, CustomerRow>();
  readonly customersByEmail = new Map<string, CustomerRow[]>();
  readonly plansByExt = new Map<string, PlanRow>();
  readonly plansByName = new Map<string, PlanRow>();
  readonly segmentsByExt = new Map<string, SegmentRow>();
  /** Imported segments grouped by their subscription_id (the part before ":"). */
  readonly segmentsBySubscription = new Map<string, SegmentRow[]>();
  readonly invoicesByExt = new Map<string, InvoiceRow>();
  /** Customers and plans this file will create — keyed so two rows share one. */
  readonly newCustomers = new Map<string, CustomerRef & { kind: "new" }>();
  readonly newPlans = new Map<string, PlanRef & { kind: "new" }>();

  constructor(
    readonly organizationId: string,
    readonly currency: string,
    readonly options: ImportOptions,
    customers: readonly CustomerRow[],
    plans: readonly PlanRow[],
    segments: readonly SegmentRow[],
    invoices: readonly InvoiceRow[],
  ) {
    for (const customer of customers) {
      if (customer.externalId) this.customersByExt.set(customer.externalId, customer);
      if (customer.email) {
        const key = customer.email.toLowerCase();
        this.customersByEmail.set(key, [...(this.customersByEmail.get(key) ?? []), customer]);
      }
    }
    for (const plan of plans) {
      if (plan.externalId) this.plansByExt.set(plan.externalId, plan);
      this.plansByName.set(plan.name.toLowerCase(), plan);
    }
    for (const segment of segments) {
      if (!segment.externalId) continue;
      this.segmentsByExt.set(segment.externalId, segment);
      const subscriptionId = segment.externalId.slice(0, segment.externalId.lastIndexOf(":"));
      this.segmentsBySubscription.set(subscriptionId, [...(this.segmentsBySubscription.get(subscriptionId) ?? []), segment]);
    }
    for (const invoice of invoices) {
      if (invoice.externalId) this.invoicesByExt.set(invoice.externalId, invoice);
    }
  }
}

async function loadContext(
  organizationId: string,
  currency: string,
  options: ImportOptions,
  kind: ImportKindKey,
): Promise<Context> {
  const needsSegments = kind === "subscriptions" || kind === "invoices";
  const [customers, plans, segments, invoices] = await Promise.all([
    prisma.customer.findMany({
      where: { organizationId },
      select: { id: true, externalId: true, email: true, name: true },
    }),
    prisma.plan.findMany({
      where: { organizationId },
      select: { id: true, externalId: true, name: true, amountCents: true, interval: true, intervalCount: true },
    }),
    needsSegments
      ? prisma.subscription.findMany({
          where: { organizationId, externalId: { not: null } },
          select: {
            id: true,
            externalId: true,
            customerId: true,
            planId: true,
            amountCents: true,
            quantity: true,
            interval: true,
            intervalCount: true,
            status: true,
            startedAt: true,
            endedAt: true,
            canceledAt: true,
            previousSubscriptionId: true,
            next: { select: { id: true, externalId: true } },
          },
        })
      : Promise.resolve([]),
    kind === "invoices"
      ? prisma.invoice.findMany({
          where: { organizationId, externalId: { not: null } },
          select: {
            id: true,
            externalId: true,
            customerId: true,
            subscriptionId: true,
            amountCents: true,
            status: true,
            issuedAt: true,
            dueAt: true,
            paidAt: true,
          },
        })
      : Promise.resolve([]),
  ]);
  return new Context(organizationId, currency, options, customers, plans, segments, invoices);
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EXTERNAL_ID_MAX = 191;

class RowReader {
  readonly messages: string[] = [];
  constructor(
    private readonly row: readonly string[],
    private readonly mapping: ColumnMapping,
  ) {}

  cell(key: string): string {
    const index = this.mapping[key];
    if (index === null || index === undefined) return "";
    return (this.row[index] ?? "").trim();
  }

  required(key: string, label: string): string {
    const value = this.cell(key);
    if (!value) this.messages.push(`${label} is required.`);
    return value;
  }

  id(key: string, label: string): string | null {
    const value = this.cell(key);
    if (!value) return null;
    if (value.length > EXTERNAL_ID_MAX) {
      this.messages.push(`${label} is longer than ${EXTERNAL_ID_MAX} characters.`);
      return null;
    }
    return value;
  }

  email(key: string): string | null {
    const value = this.cell(key).toLowerCase();
    if (!value) return null;
    if (!EMAIL.test(value) || value.length > 254) {
      this.messages.push(`“${value}” is not a valid email.`);
      return null;
    }
    return value;
  }

  take<T>(parsed: { ok: true; value: T } | { ok: false; error: string }): T | null {
    if (parsed.ok) return parsed.value;
    this.messages.push(parsed.error);
    return null;
  }

  currency(workspaceCurrency: string): void {
    const problem = checkCurrency(this.cell("currency"), workspaceCurrency);
    if (problem) this.messages.push(problem);
  }
}

const sameDay = (a: Date | null, b: Date | null): boolean =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

function priceText(amountCents: number, interval: BillingInterval, intervalCount: number, currency: string): string {
  return `${formatPrice(amountCents, currency)} / ${formatIntervalWords(interval, intervalCount)}`;
}

function earliest(dates: readonly (Date | null)[]): Date | null {
  let min: Date | null = null;
  for (const date of dates) if (date !== null && (min === null || date < min)) min = date;
  return min;
}

/**
 * The customer a subscription or invoice row belongs to: by customer_id, else
 * by email (one match only), else a customer this file creates — registered so
 * two rows naming the same new customer create it once.
 */
function resolveCustomer(
  ctx: Context,
  reader: RowReader,
  externalId: string | null,
  email: string | null,
  name: string,
): CustomerRef | null {
  if (externalId) {
    const byId = ctx.customersByExt.get(externalId);
    if (byId) return { kind: "existing", id: byId.id };
  }
  if (email) {
    const matches = (ctx.customersByEmail.get(email) ?? []).filter(
      (customer) => externalId === null || customer.externalId === null || customer.externalId === externalId,
    );
    if (matches.length > 1) {
      reader.messages.push(`${matches.length} customers share the email ${email}; add a customer_id column to tell them apart.`);
      return null;
    }
    const [match] = matches;
    if (match && (externalId === null || match.externalId === null)) return { kind: "existing", id: match.id };
  }
  if (!externalId && !email) {
    reader.messages.push("Customer ID or customer email is required.");
    return null;
  }
  const key = externalId ? `id:${externalId}` : `email:${email}`;
  const known = ctx.newCustomers.get(key);
  if (known) return known;
  const created = { kind: "new" as const, externalId, email, name: name || email || externalId || "Customer" };
  ctx.newCustomers.set(key, created);
  return created;
}

function customerKey(ref: CustomerRef): string {
  return ref.kind === "existing" ? `existing:${ref.id}` : ref.externalId ? `id:${ref.externalId}` : `email:${ref.email}`;
}

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

interface KindResult {
  readonly reports: RowReport[];
  readonly units: ImportUnit[];
}

function report(index: number, line: number, outcome: RowOutcome, label: string, messages: readonly string[] = []): RowReport {
  return { index, line, outcome, label, messages };
}

function analyzeCustomers(ctx: Context, rows: readonly (readonly string[])[], lines: readonly number[], mapping: ColumnMapping): KindResult {
  const reports: RowReport[] = [];
  const units: ImportUnit[] = [];
  const seenIds = new Map<string, number>();
  const seenEmails = new Map<string, number>();

  rows.forEach((row, index) => {
    const reader = new RowReader(row, mapping);
    const name = reader.required("name", "Name");
    const externalId = reader.id("customer_id", "Customer ID");
    const email = reader.email("email");
    const label = name || email || externalId || "(no name)";

    if (externalId && seenIds.has(externalId)) reader.messages.push(`Duplicate customer_id “${externalId}” (also on line ${seenIds.get(externalId)}).`);
    if (!externalId && email && seenEmails.has(email)) reader.messages.push(`Duplicate email ${email} (also on line ${seenEmails.get(email)}).`);
    if (externalId) seenIds.set(externalId, lines[index] ?? 0);
    else if (email) seenEmails.set(email, lines[index] ?? 0);

    let existing: CustomerRow | null = null;
    if (reader.messages.length === 0) {
      existing = externalId ? (ctx.customersByExt.get(externalId) ?? null) : null;
      if (existing === null && email) {
        const matches = ctx.customersByEmail.get(email) ?? [];
        if (matches.length > 1) {
          reader.messages.push(`${matches.length} customers already share the email ${email}; add a customer_id to choose one.`);
        } else if (matches[0]) {
          if (externalId && matches[0].externalId && matches[0].externalId !== externalId) {
            // A different customer in the source system that happens to share the email.
            existing = null;
          } else {
            existing = matches[0];
          }
        }
      }
    }
    if (reader.messages.length > 0) {
      reports.push(report(index, lines[index] ?? 0, "error", label, reader.messages));
      return;
    }

    const data = { externalId: externalId ?? existing?.externalId ?? null, name, email: email ?? existing?.email ?? null };
    const outcome: RowOutcome =
      existing === null
        ? "create"
        : existing.name === data.name && existing.email === data.email && existing.externalId === data.externalId
          ? "unchanged"
          : "update";
    reports.push(report(index, lines[index] ?? 0, outcome, label));
    if (outcome !== "unchanged") units.push({ type: "customer", rows: [index], existingId: existing?.id ?? null, data });
  });
  return { reports, units };
}

function analyzePlans(ctx: Context, rows: readonly (readonly string[])[], lines: readonly number[], mapping: ColumnMapping): KindResult {
  const reports: RowReport[] = [];
  const units: ImportUnit[] = [];
  const seenIds = new Map<string, number>();
  const seenNames = new Map<string, number>();

  rows.forEach((row, index) => {
    const reader = new RowReader(row, mapping);
    const name = reader.required("name", "Name");
    const externalId = reader.id("plan_id", "Plan ID");
    const rawAmount = reader.required("amount", "Amount");
    const rawInterval = reader.required("interval", "Interval");
    reader.currency(ctx.currency);
    const amountCents = rawAmount ? reader.take(parseAmount(rawAmount, ctx.currency, ctx.options)) : null;
    const terms = rawInterval ? reader.take(parseInterval(rawInterval, reader.cell("interval_count"))) : null;
    if (name.length > 60) reader.messages.push("Plan names are at most 60 characters.");
    const label = name || externalId || "(no name)";

    const nameKey = name.toLowerCase();
    if (externalId && seenIds.has(externalId)) reader.messages.push(`Duplicate plan_id “${externalId}” (also on line ${seenIds.get(externalId)}).`);
    if (name && seenNames.has(nameKey)) reader.messages.push(`Duplicate plan name “${name}” (also on line ${seenNames.get(nameKey)}).`);
    if (externalId) seenIds.set(externalId, lines[index] ?? 0);
    if (name) seenNames.set(nameKey, lines[index] ?? 0);

    let existing: PlanRow | null = null;
    if (reader.messages.length === 0) {
      existing = externalId ? (ctx.plansByExt.get(externalId) ?? null) : null;
      const byName = ctx.plansByName.get(nameKey) ?? null;
      if (existing === null && byName !== null) {
        if (externalId && byName.externalId && byName.externalId !== externalId) {
          reader.messages.push(`A plan named “${byName.name}” already exists with ID “${byName.externalId}”.`);
        } else {
          existing = byName;
        }
      } else if (existing !== null && byName !== null && byName.id !== existing.id) {
        reader.messages.push(`Renaming this plan to “${name}” would clash with another plan of that name.`);
      }
    }
    if (reader.messages.length > 0 || amountCents === null || terms === null) {
      reports.push(report(index, lines[index] ?? 0, "error", label, reader.messages));
      return;
    }

    const data = {
      externalId: externalId ?? existing?.externalId ?? null,
      name,
      amountCents,
      interval: terms.interval,
      intervalCount: terms.intervalCount,
    };
    const outcome: RowOutcome =
      existing === null
        ? "create"
        : existing.name === data.name &&
            existing.externalId === data.externalId &&
            existing.amountCents === data.amountCents &&
            existing.interval === data.interval &&
            existing.intervalCount === data.intervalCount
          ? "unchanged"
          : "update";
    reports.push(report(index, lines[index] ?? 0, outcome, `${name} · ${priceText(amountCents, terms.interval, terms.intervalCount, ctx.currency)}`));
    if (outcome !== "unchanged") units.push({ type: "plan", rows: [index], existingId: existing?.id ?? null, data });
  });
  return { reports, units };
}

interface ParsedSegmentRow {
  readonly index: number;
  readonly line: number;
  readonly reader: RowReader;
  readonly customer: CustomerRef | null;
  readonly plan: PlanRef | undefined;
  readonly amountCents: number | null;
  readonly interval: BillingInterval | null;
  readonly intervalCount: number | null;
  readonly quantity: number | null;
  readonly status: SubscriptionStatus | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly canceledAt: Date | null;
}

/**
 * The plan a subscription row is on — or `null` for a custom price, or
 * `undefined` when the row is in error (the reason is on the reader).
 */
function resolvePlan(
  ctx: Context,
  reader: RowReader,
  amountCents: number | null,
  terms: { interval: BillingInterval; intervalCount: number } | null,
): { plan: PlanRef; amountCents: number; interval: BillingInterval; intervalCount: number } | undefined {
  const planId = reader.id("plan_id", "Plan ID");
  const planName = reader.cell("plan_name");
  const describe = (amount: number, interval: BillingInterval, count: number) => priceText(amount, interval, count, ctx.currency);

  const conflict = (plan: { name: string; amountCents: number; interval: BillingInterval; intervalCount: number }): boolean => {
    if (amountCents === null && terms === null) return false;
    const differs =
      (amountCents !== null && amountCents !== plan.amountCents) ||
      (terms !== null && (terms.interval !== plan.interval || terms.intervalCount !== plan.intervalCount));
    if (differs) {
      reader.messages.push(
        `Plan “${plan.name}” is ${describe(plan.amountCents, plan.interval, plan.intervalCount)}, but this row says ${describe(
          amountCents ?? plan.amountCents,
          terms?.interval ?? plan.interval,
          terms?.intervalCount ?? plan.intervalCount,
        )}. Fix the row, or import it with a different plan name.`,
      );
    }
    return differs;
  };

  if (planId) {
    const existing = ctx.plansByExt.get(planId);
    if (existing) {
      // Matched by ID: the subscription may carry its own (discounted) price, but
      // not a different billing period.
      if (terms !== null && (terms.interval !== existing.interval || terms.intervalCount !== existing.intervalCount)) {
        reader.messages.push(
          `Plan “${existing.name}” bills every ${formatIntervalWords(existing.interval, existing.intervalCount)}; this row says every ${formatIntervalWords(terms.interval, terms.intervalCount)}.`,
        );
        return undefined;
      }
      return {
        plan: { kind: "existing", id: existing.id },
        amountCents: amountCents ?? existing.amountCents,
        interval: existing.interval,
        intervalCount: existing.intervalCount,
      };
    }
  }
  const name = planName || planId || "";
  if (name) {
    const pending = planId ? ctx.newPlans.get(`id:${planId}`) : ctx.newPlans.get(`name:${name.toLowerCase()}`);
    const byName = ctx.plansByName.get(name.toLowerCase());
    if (byName) {
      // Plan names are unique in a workspace: a plan by this name with ANOTHER
      // ID cannot be created beside it, and is not this row's plan either.
      if (planId && byName.externalId && byName.externalId !== planId) {
        reader.messages.push(
          `A plan named “${byName.name}” already exists with ID “${byName.externalId}”, not “${planId}”. Rename the plan in the file, or use its ID.`,
        );
        return undefined;
      }
      if (conflict(byName)) return undefined;
      return {
        plan: { kind: "existing", id: byName.id },
        amountCents: byName.amountCents,
        interval: byName.interval,
        intervalCount: byName.intervalCount,
      };
    }
    if (pending) {
      if (conflict(pending)) return undefined;
      return { plan: pending, amountCents: pending.amountCents, interval: pending.interval, intervalCount: pending.intervalCount };
    }
    if (amountCents === null || terms === null) {
      reader.messages.push(`Plan “${name}” doesn't exist yet; add amount and interval columns to create it, or import plans first.`);
      return undefined;
    }
    if (name.length > 60) {
      reader.messages.push("Plan names are at most 60 characters.");
      return undefined;
    }
    // Two new plans in one file may not share a name under different IDs.
    const sameName = [...ctx.newPlans.values()].find((plan) => plan.name.toLowerCase() === name.toLowerCase());
    if (sameName) {
      reader.messages.push(
        `This file creates two plans named “${name}” with different IDs (“${sameName.externalId ?? "none"}” and “${planId ?? "none"}”). Plan names are unique.`,
      );
      return undefined;
    }
    const created = { kind: "new" as const, externalId: planId, name, amountCents, interval: terms.interval, intervalCount: terms.intervalCount };
    ctx.newPlans.set(planId ? `id:${planId}` : `name:${name.toLowerCase()}`, created);
    return { plan: created, amountCents, interval: terms.interval, intervalCount: terms.intervalCount };
  }
  // No plan column filled: a custom price.
  if (amountCents === null || terms === null) {
    reader.messages.push("Give a plan (plan_id or plan_name), or an amount and interval for a custom price.");
    return undefined;
  }
  return { plan: null, amountCents, interval: terms.interval, intervalCount: terms.intervalCount };
}

function analyzeSubscriptions(
  ctx: Context,
  rows: readonly (readonly string[])[],
  lines: readonly number[],
  mapping: ColumnMapping,
): KindResult {
  const now = new Date();
  const parsed: ParsedSegmentRow[] = [];
  const groups = new Map<string, number[]>();
  const order: string[] = [];

  rows.forEach((row, index) => {
    const reader = new RowReader(row, mapping);
    const subscriptionId = reader.id("subscription_id", "Subscription ID");
    if (!subscriptionId && !reader.cell("subscription_id")) reader.messages.push("Subscription ID is required.");
    reader.currency(ctx.currency);

    const rawStart = reader.required("start_date", "Start date");
    const startedAt = rawStart ? reader.take(parseDate(rawStart, ctx.options)) : null;
    const rawEnd = reader.cell("end_date");
    const endedAt = rawEnd ? reader.take(parseDate(rawEnd, ctx.options)) : null;
    const rawCanceled = reader.cell("canceled_at");
    const canceledAt = rawCanceled ? reader.take(parseDate(rawCanceled, ctx.options)) : null;
    const status = reader.take(parseSubscriptionStatus(reader.cell("status")));
    const quantity = reader.take(parseQuantity(reader.cell("quantity")));
    const rawAmount = reader.cell("amount");
    const amount = rawAmount ? reader.take(parseAmount(rawAmount, ctx.currency, ctx.options)) : null;
    const rawInterval = reader.cell("interval");
    const terms = rawInterval ? reader.take(parseInterval(rawInterval, reader.cell("interval_count"))) : null;
    const resolved = reader.messages.length === 0 ? resolvePlan(ctx, reader, amount, terms) : undefined;
    const customer =
      reader.messages.length === 0
        ? resolveCustomer(ctx, reader, reader.id("customer_id", "Customer ID"), reader.email("customer_email"), reader.cell("customer_name"))
        : null;
    if (resolved && quantity !== null && resolved.amountCents * quantity > MAX_MINOR_UNITS) {
      reader.messages.push("Amount × quantity is too large.");
    }

    parsed.push({
      index,
      line: lines[index] ?? 0,
      reader,
      customer,
      plan: resolved?.plan,
      amountCents: resolved?.amountCents ?? null,
      interval: resolved?.interval ?? null,
      intervalCount: resolved?.intervalCount ?? null,
      quantity,
      status,
      startedAt,
      endedAt,
      canceledAt,
    });
    const key = subscriptionId ?? `__row_${index}`;
    if (!groups.has(key)) order.push(key);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });

  const reports: RowReport[] = new Array(rows.length);
  const units: ImportUnit[] = [];

  for (const subscriptionId of order) {
    const members = (groups.get(subscriptionId) ?? []).map((index) => parsed[index] as ParsedSegmentRow);
    const chainErrors = new Map<number, string[]>();
    const addError = (index: number, message: string) => chainErrors.set(index, [...(chainErrors.get(index) ?? []), message]);
    for (const member of members) for (const message of member.reader.messages) addError(member.index, message);

    const sorted = [...members].sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0));
    if (chainErrors.size === 0) {
      // One customer per subscription.
      const firstCustomer = sorted[0]?.customer ?? null;
      for (const member of sorted) {
        if (firstCustomer && member.customer && customerKey(member.customer) !== customerKey(firstCustomer)) {
          addError(member.index, `This row names a different customer than line ${sorted[0]?.line} of the same subscription.`);
        }
      }
      // Segments meet end to end, and only the last can be canceled.
      for (let i = 0; i < sorted.length; i++) {
        const member = sorted[i] as ParsedSegmentRow;
        const next = sorted[i + 1];
        if (next && sameDay(member.startedAt, next.startedAt)) {
          addError(next.index, `Two rows of this subscription start on the same day (line ${member.line}).`);
          continue;
        }
        if (next && next.startedAt) {
          if (member.endedAt && !sameDay(member.endedAt, next.startedAt)) {
            addError(
              member.index,
              `These terms end ${formatDay(member.endedAt)} but the next row starts ${formatDay(next.startedAt)}; each row must end where the next one starts.`,
            );
          }
          if (member.status === "CANCELED" || member.canceledAt) {
            addError(member.index, "Only the last row of a subscription can be canceled.");
          }
        }
      }
    }

    // What Meridian already holds for this subscription must still fit the file.
    const existingSegments = subscriptionId.startsWith("__row_") ? [] : (ctx.segmentsBySubscription.get(subscriptionId) ?? []);
    if (chainErrors.size === 0 && existingSegments.length > 0) {
      const starts = new Set(sorted.map((member) => `${subscriptionId}:${member.startedAt?.toISOString().slice(0, 10)}`));
      const inFile = new Set(existingSegments.filter((segment) => segment.externalId && starts.has(segment.externalId)).map((s) => s.id));
      for (const segment of existingSegments) {
        if (segment.externalId && !starts.has(segment.externalId)) {
          addError(
            sorted[0]?.index ?? 0,
            `Meridian has terms of this subscription starting ${formatDay(segment.startedAt)} that are not in this file. Import the subscription's full history.`,
          );
          break;
        }
        if (segment.next && !inFile.has(segment.next.id)) {
          addError(
            sorted[sorted.length - 1]?.index ?? 0,
            "This subscription was changed in Meridian after it was imported (a later plan change or cancellation exists). Re-importing would rewrite that history, so it was skipped.",
          );
          break;
        }
      }
    }

    // Build the segments.
    const segments: SegmentPlan[] = [];
    if (chainErrors.size === 0) {
      for (let i = 0; i < sorted.length; i++) {
        const member = sorted[i] as ParsedSegmentRow;
        const next = sorted[i + 1];
        const startedAt = member.startedAt as Date;
        let status = member.status ?? "ACTIVE";
        let endedAt: Date | null;
        let canceledAt: Date | null = null;
        if (next) {
          endedAt = next.startedAt;
        } else {
          endedAt = member.endedAt ?? (status === "CANCELED" ? member.canceledAt : null);
          if (status === "CANCELED" && endedAt === null) {
            addError(member.index, "A canceled subscription needs an end_date or canceled_at.");
            break;
          }
          if (endedAt !== null) canceledAt = member.canceledAt ?? endedAt;
        }
        if (endedAt !== null && endedAt.getTime() <= startedAt.getTime()) {
          addError(member.index, `It ends (${formatDay(endedAt)}) on or before it starts (${formatDay(startedAt)}).`);
          break;
        }
        // A stored status never contradicts the dates.
        if (endedAt !== null && endedAt.getTime() <= now.getTime()) status = "CANCELED";
        else if (status === "CANCELED") status = "ACTIVE";

        const externalId = `${subscriptionId}:${startedAt.toISOString().slice(0, 10)}`;
        const existing = ctx.segmentsByExt.get(externalId) ?? null;
        const previousId = i > 0 ? (segments[i - 1]?.existingId ?? null) : null;
        const customerId = member.customer?.kind === "existing" ? member.customer.id : null;
        const planId = member.plan && member.plan.kind === "existing" ? member.plan.id : null;
        const planIsNew = member.plan !== null && member.plan !== undefined && member.plan.kind === "new";
        const outcome: SegmentPlan["outcome"] =
          existing === null
            ? "create"
            : customerId !== null &&
                existing.customerId === customerId &&
                !planIsNew &&
                existing.planId === planId &&
                existing.amountCents === member.amountCents &&
                existing.quantity === member.quantity &&
                existing.interval === member.interval &&
                existing.intervalCount === member.intervalCount &&
                existing.status === status &&
                sameDay(existing.startedAt, startedAt) &&
                sameDay(existing.endedAt, endedAt) &&
                sameDay(existing.canceledAt, canceledAt) &&
                (i === 0 ? existing.previousSubscriptionId === null : previousId !== null && existing.previousSubscriptionId === previousId)
              ? "unchanged"
              : "update";
        segments.push({
          row: member.index,
          existingId: existing?.id ?? null,
          externalId,
          plan: member.plan ?? null,
          amountCents: member.amountCents as number,
          quantity: member.quantity ?? 1,
          interval: member.interval as BillingInterval,
          intervalCount: member.intervalCount as number,
          status,
          startedAt,
          endedAt,
          canceledAt,
          outcome,
        });
      }
    }

    if (chainErrors.size > 0) {
      const first = [...chainErrors.keys()].map((index) => parsed[index]?.line ?? 0).sort((a, b) => a - b)[0];
      for (const member of members) {
        const messages = chainErrors.get(member.index) ?? [
          `Skipped: another row of subscription “${subscriptionId}” has an error (line ${first}).`,
        ];
        reports[member.index] = report(member.index, member.line, "error", subscriptionId, messages);
      }
      continue;
    }

    const customer = sorted[0]?.customer as CustomerRef;
    const changed = segments.filter((segment) => segment.outcome !== "unchanged");
    for (const segment of segments) {
      const member = parsed[segment.row] as ParsedSegmentRow;
      const planLabel = segment.plan === null ? "Custom" : segment.plan.kind === "new" ? segment.plan.name : planNameOf(ctx, segment.plan.id);
      reports[segment.row] = report(
        segment.row,
        member.line,
        segment.outcome,
        `${subscriptionId} · ${planLabel} · ${priceText(segment.amountCents, segment.interval, segment.intervalCount, ctx.currency)}${segment.quantity === 1 ? "" : ` × ${segment.quantity}`} from ${formatDay(segment.startedAt)}`,
      );
    }
    if (changed.length > 0) {
      const affected = earliest(
        changed.flatMap((segment) => [segment.startedAt, segment.existingId ? (ctx.segmentsByExt.get(segment.externalId)?.startedAt ?? null) : null]),
      );
      units.push({ type: "chain", rows: segments.map((segment) => segment.row), customer, segments, affectedFrom: affected });
    }
  }
  return { reports, units };
}

function planNameOf(ctx: Context, planId: string): string {
  for (const plan of ctx.plansByName.values()) if (plan.id === planId) return plan.name;
  return "Plan";
}

function analyzeInvoices(ctx: Context, rows: readonly (readonly string[])[], lines: readonly number[], mapping: ColumnMapping): KindResult {
  const reports: RowReport[] = [];
  const units: ImportUnit[] = [];
  const seen = new Map<string, number>();

  rows.forEach((row, index) => {
    const reader = new RowReader(row, mapping);
    const externalId = reader.id("invoice_id", "Invoice ID");
    if (!externalId && !reader.cell("invoice_id")) reader.messages.push("Invoice ID is required.");
    reader.currency(ctx.currency);
    const rawAmount = reader.required("amount", "Amount");
    const amountCents = rawAmount ? reader.take(parseAmount(rawAmount, ctx.currency, ctx.options)) : null;
    if (amountCents === 0) reader.messages.push("An invoice amount must be above zero.");
    const rawStatus = reader.required("status", "Status");
    const status = rawStatus ? reader.take(parseInvoiceStatus(rawStatus)) : null;
    const rawIssued = reader.required("issued_at", "Issued at");
    const issuedAt = rawIssued ? reader.take(parseDate(rawIssued, ctx.options)) : null;
    const rawDue = reader.cell("due_at");
    const dueAt = rawDue ? reader.take(parseDate(rawDue, ctx.options)) : null;
    const rawPaid = reader.cell("paid_at");
    const paidAtRaw = rawPaid ? reader.take(parseDate(rawPaid, ctx.options, "today")) : null;

    if (externalId && seen.has(externalId)) reader.messages.push(`Duplicate invoice_id “${externalId}” (also on line ${seen.get(externalId)}).`);
    if (externalId) seen.set(externalId, lines[index] ?? 0);
    if (issuedAt && dueAt && dueAt < issuedAt) reader.messages.push("The due date is before the issue date.");
    if (issuedAt && paidAtRaw && paidAtRaw < issuedAt) reader.messages.push("It was paid before it was issued.");

    const customer =
      reader.messages.length === 0
        ? resolveCustomer(ctx, reader, reader.id("customer_id", "Customer ID"), reader.email("customer_email"), "")
        : null;

    // The subscription's terms in force on the issue date.
    let subscriptionId: string | null = null;
    const rawSubscription = reader.cell("subscription_id");
    if (reader.messages.length === 0 && rawSubscription && issuedAt) {
      const segments = (ctx.segmentsBySubscription.get(rawSubscription) ?? []).filter((segment) => segment.startedAt <= issuedAt);
      const segment = segments.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
      if ((ctx.segmentsBySubscription.get(rawSubscription) ?? []).length === 0) {
        reader.messages.push(`No subscription “${rawSubscription}” in this workspace — import subscriptions first.`);
      } else if (!segment) {
        reader.messages.push(`Subscription “${rawSubscription}” hadn't started by ${formatDay(issuedAt)}.`);
      } else if (customer && (customer.kind === "new" || customer.id !== segment.customerId)) {
        reader.messages.push(`Subscription “${rawSubscription}” belongs to a different customer.`);
      } else {
        subscriptionId = segment.id;
      }
    }

    const label = `${externalId ?? "(no id)"}${amountCents !== null ? ` · ${formatPrice(amountCents, ctx.currency)}` : ""}`;
    if (reader.messages.length > 0 || !externalId || amountCents === null || status === null || issuedAt === null || customer === null) {
      reports.push(report(index, lines[index] ?? 0, "error", label, reader.messages));
      return;
    }

    const paidAt = status === "PAID" ? (paidAtRaw ?? issuedAt) : null;
    const data = { externalId, amountCents, status, issuedAt, dueAt, paidAt };
    const existing = ctx.invoicesByExt.get(externalId) ?? null;
    const outcome: RowOutcome =
      existing === null
        ? "create"
        : customer.kind === "existing" &&
            existing.customerId === customer.id &&
            existing.subscriptionId === subscriptionId &&
            existing.amountCents === amountCents &&
            existing.status === status &&
            sameDay(existing.issuedAt, issuedAt) &&
            sameDay(existing.dueAt, dueAt) &&
            sameDay(existing.paidAt, paidAt)
          ? "unchanged"
          : "update";
    reports.push(report(index, lines[index] ?? 0, outcome, label));
    if (outcome !== "unchanged") {
      units.push({ type: "invoice", rows: [index], existingId: existing?.id ?? null, customer, subscriptionId, data });
    }
  });
  return { reports, units };
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

export async function analyzeImport(
  organizationId: string,
  currency: string,
  request: ImportRequest,
): Promise<ImportAnalysis> {
  const parsed = parseCsv(request.text);
  if (parsed.errors.length > 0) {
    const [first] = parsed.errors;
    return fatal(first ? `Line ${first.line}: ${first.message}` : "The file could not be read.");
  }
  const spec = IMPORT_KINDS[request.kind];
  // Only mappings to real columns count; anything else is dropped.
  const mapping: Record<string, number | null> = {};
  for (const field of spec.fields) {
    const index = request.mapping[field.key];
    mapping[field.key] = typeof index === "number" && index >= 0 && index < parsed.headers.length ? index : null;
  }
  const missing = missingMappings(request.kind, mapping);
  if (missing.length > 0) return fatal(missing.join(" "), parsed.headers);
  if (parsed.rows.length === 0) return fatal("The file has a header but no rows.", parsed.headers);

  const ctx = await loadContext(organizationId, currency, request.options, request.kind);
  const result =
    request.kind === "customers"
      ? analyzeCustomers(ctx, parsed.rows, parsed.rowLines, mapping)
      : request.kind === "plans"
        ? analyzePlans(ctx, parsed.rows, parsed.rowLines, mapping)
        : request.kind === "subscriptions"
          ? analyzeSubscriptions(ctx, parsed.rows, parsed.rowLines, mapping)
          : analyzeInvoices(ctx, parsed.rows, parsed.rowLines, mapping);

  const count = (outcome: RowOutcome) => result.reports.filter((row) => row.outcome === outcome).length;
  return {
    fatal: null,
    headers: parsed.headers,
    rows: parsed.rows,
    reports: result.reports,
    units: result.units,
    summary: {
      create: count("create"),
      update: count("update"),
      unchanged: count("unchanged"),
      error: count("error"),
      relatedCustomers: request.kind === "subscriptions" || request.kind === "invoices" ? ctx.newCustomers.size : 0,
      relatedPlans: request.kind === "subscriptions" ? ctx.newPlans.size : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

/** Rows per transaction. A subscription's rows are never split across two. */
export const CHUNK_ROWS = 500;

type Tx = Prisma.TransactionClient;

const SOURCE: DataSource = "CSV";

async function ensureCustomer(tx: Tx, organizationId: string, ref: CustomerRef): Promise<string> {
  if (ref.kind === "existing") return ref.id;
  // Created by an earlier row or chunk of this run, or in the meantime: reuse it.
  const found =
    (ref.externalId
      ? await tx.customer.findFirst({ where: { organizationId, externalId: ref.externalId }, select: { id: true } })
      : null) ??
    (ref.email && !ref.externalId
      ? await tx.customer.findFirst({
          where: { organizationId, email: { equals: ref.email, mode: "insensitive" } },
          select: { id: true },
        })
      : null);
  if (found) return found.id;
  const created = await tx.customer.create({
    data: { organizationId, name: ref.name.slice(0, 100), email: ref.email, externalId: ref.externalId, source: SOURCE },
    select: { id: true },
  });
  return created.id;
}

async function ensurePlan(tx: Tx, organizationId: string, ref: PlanRef): Promise<string | null> {
  if (ref === null) return null;
  if (ref.kind === "existing") return ref.id;
  const found =
    (ref.externalId
      ? await tx.plan.findFirst({ where: { organizationId, externalId: ref.externalId }, select: { id: true } })
      : null) ??
    (await tx.plan.findFirst({
      where: { organizationId, name: { equals: ref.name, mode: "insensitive" } },
      select: { id: true },
    }));
  if (found) return found.id;
  const created = await tx.plan.create({
    data: {
      organizationId,
      externalId: ref.externalId,
      name: ref.name,
      amountCents: ref.amountCents,
      interval: ref.interval,
      intervalCount: ref.intervalCount,
      source: SOURCE,
    },
    select: { id: true },
  });
  return created.id;
}

async function executeUnit(tx: Tx, organizationId: string, unit: ImportUnit): Promise<void> {
  switch (unit.type) {
    case "customer": {
      if (unit.existingId) {
        await tx.customer.updateMany({ where: { id: unit.existingId, organizationId }, data: unit.data });
      } else {
        await tx.customer.create({ data: { organizationId, ...unit.data, source: SOURCE } });
      }
      return;
    }
    case "plan": {
      if (unit.existingId) {
        await tx.plan.updateMany({ where: { id: unit.existingId, organizationId }, data: unit.data });
      } else {
        await tx.plan.create({ data: { organizationId, ...unit.data, source: SOURCE } });
      }
      return;
    }
    case "invoice": {
      const customerId = await ensureCustomer(tx, organizationId, unit.customer);
      const data = { customerId, subscriptionId: unit.subscriptionId, ...unit.data };
      if (unit.existingId) {
        await tx.invoice.updateMany({ where: { id: unit.existingId, organizationId }, data });
      } else {
        await tx.invoice.create({ data: { organizationId, ...data, source: SOURCE } });
      }
      return;
    }
    case "chain": {
      const customerId = await ensureCustomer(tx, organizationId, unit.customer);
      const ids: string[] = [];
      for (const segment of unit.segments) {
        const planId = await ensurePlan(tx, organizationId, segment.plan);
        const data = {
          customerId,
          planId,
          amountCents: segment.amountCents,
          quantity: segment.quantity,
          interval: segment.interval,
          intervalCount: segment.intervalCount,
          status: segment.status,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          canceledAt: segment.canceledAt,
        };
        if (segment.existingId) {
          await tx.subscription.updateMany({ where: { id: segment.existingId, organizationId }, data });
          ids.push(segment.existingId);
        } else {
          const created = await tx.subscription.create({
            data: { organizationId, externalId: segment.externalId, ...data, source: SOURCE },
            select: { id: true },
          });
          ids.push(created.id);
        }
      }
      // Hand-off links, oldest first. `previousSubscriptionId` is unique, so any
      // link that changes is cleared before the new ones are set.
      await tx.subscription.updateMany({
        where: { organizationId, id: { in: ids } },
        data: { previousSubscriptionId: null },
      });
      for (let i = 1; i < ids.length; i++) {
        await tx.subscription.updateMany({
          where: { organizationId, id: ids[i] },
          data: { previousSubscriptionId: ids[i - 1] },
        });
      }
      return;
    }
  }
}

/**
 * What one chunk wrote. Unchanged rows are not counted here: a row with nothing
 * to write never becomes a unit, so the analysis's count is the run's count.
 */
export interface ChunkResult {
  readonly created: number;
  readonly updated: number;
  /** Earliest day whose snapshots the chunk moved, or null. */
  readonly affectedFrom: Date | null;
}

/** The analysis's units grouped into chunks of about CHUNK_ROWS rows. */
export function chunkUnits(units: readonly ImportUnit[]): ImportUnit[][] {
  const chunks: ImportUnit[][] = [];
  let current: ImportUnit[] = [];
  let rows = 0;
  for (const unit of units) {
    if (rows > 0 && rows + unit.rows.length > CHUNK_ROWS) {
      chunks.push(current);
      current = [];
      rows = 0;
    }
    current.push(unit);
    rows += unit.rows.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Writes one chunk in one transaction and returns what it wrote. */
export async function executeChunk(
  organizationId: string,
  analysis: ImportAnalysis,
  chunk: readonly ImportUnit[],
): Promise<ChunkResult> {
  await prisma.$transaction(
    async (tx) => {
      for (const unit of chunk) await executeUnit(tx, organizationId, unit);
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  let created = 0;
  let updated = 0;
  const outcomeOf = new Map(analysis.reports.map((row) => [row.index, row.outcome]));
  for (const unit of chunk) {
    for (const row of unit.rows) {
      const outcome = outcomeOf.get(row);
      if (outcome === "create") created += 1;
      else if (outcome === "update") updated += 1;
    }
  }
  return {
    created,
    updated,
    affectedFrom: earliest(chunk.map((unit) => (unit.type === "chain" ? unit.affectedFrom : null))),
  };
}

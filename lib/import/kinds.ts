// What can be imported, and how a file's columns map onto it.
//
// Isomorphic: the import wizard shows these column docs and builds the
// templates in the browser, and the server resolves the same mapping against
// the re-parsed file. One definition, so the two never disagree about which
// columns exist or which are required.

export type ImportKindKey = "customers" | "plans" | "subscriptions" | "invoices";

export const IMPORT_KIND_KEYS: readonly ImportKindKey[] = ["plans", "customers", "subscriptions", "invoices"];

export interface ImportField {
  /** The template's column name — snake_case, as documented. */
  readonly key: string;
  readonly label: string;
  /** Required on its own. Fields that are required as "one of" use `requiredGroups`. */
  readonly required: boolean;
  readonly description: string;
  /**
   * Header spellings recognised when auto-mapping, compared after
   * `normalizeHeader` — so "E-mail", "Customer Email" and "customer_email" all
   * reduce to the same words.
   */
  readonly synonyms: readonly string[];
}

export interface RequiredGroup {
  readonly keys: readonly string[];
  readonly message: string;
}

export interface ImportKindSpec {
  readonly key: ImportKindKey;
  readonly label: string;
  readonly singular: string;
  readonly plural: string;
  readonly description: string;
  readonly fields: readonly ImportField[];
  readonly requiredGroups: readonly RequiredGroup[];
  /** Three example rows for the template, in `fields` order. */
  readonly example: readonly (readonly string[])[];
}

const CURRENCY_FIELD: ImportField = {
  key: "currency",
  label: "Currency",
  required: false,
  description: "Optional. When present it must be the workspace's currency; other rows are reported as errors.",
  synonyms: ["currency", "currency code"],
};

export const IMPORT_KINDS: Record<ImportKindKey, ImportKindSpec> = {
  customers: {
    key: "customers",
    label: "Customers",
    singular: "customer",
    plural: "customers",
    description: "The people and companies who pay you. Re-importing updates them in place.",
    fields: [
      {
        key: "customer_id",
        label: "Customer ID",
        required: false,
        description: "Your billing system's ID (e.g. cus_… from Stripe). Used to match on re-import.",
        synonyms: ["customer id", "id", "customer", "external id", "customer number"],
      },
      {
        key: "name",
        label: "Name",
        required: true,
        description: "The customer's or company's name.",
        synonyms: ["name", "customer name", "company", "company name", "full name", "description", "customer description"],
      },
      {
        key: "email",
        label: "Email",
        required: false,
        description: "Billing email. Customers without an ID are matched by email.",
        synonyms: ["email", "e mail", "customer email", "email address", "billing email"],
      },
    ],
    requiredGroups: [],
    example: [
      ["cus_001", "Acme Analytics", "billing@acme.example"],
      ["cus_002", "Bluebird Labs", "finance@bluebird.example"],
      ["", "Cobalt Studio", "hello@cobalt.example"],
    ],
  },

  plans: {
    key: "plans",
    label: "Plans",
    singular: "plan",
    plural: "plans",
    description: "The prices you sell at. Subscriptions copy a plan's price, so repricing never rewrites history.",
    fields: [
      {
        key: "plan_id",
        label: "Plan ID",
        required: false,
        description: "Your billing system's plan or price ID (e.g. price_… from Stripe).",
        synonyms: ["plan id", "price id", "id", "plan"],
      },
      {
        key: "name",
        label: "Name",
        required: true,
        description: "Unique in the workspace, e.g. Growth or Pro (annual).",
        synonyms: ["name", "plan name", "product", "product name", "nickname", "plan nickname"],
      },
      {
        key: "amount",
        label: "Amount",
        required: true,
        description: "Price per seat per billing period, e.g. 49.00 (or 4900 with “Amounts are in cents”).",
        synonyms: ["amount", "price", "unit amount", "plan amount", "unit price"],
      },
      {
        key: "interval",
        label: "Interval",
        required: true,
        description: "month or year (monthly, yearly, annual and quarterly are understood).",
        synonyms: ["interval", "billing interval", "billing period", "recurring interval", "period", "frequency"],
      },
      {
        key: "interval_count",
        label: "Interval count",
        required: false,
        description: "How many months or years one period lasts. Defaults to 1 (quarterly = month × 3).",
        synonyms: ["interval count", "recurring interval count", "billing interval count"],
      },
      CURRENCY_FIELD,
    ],
    requiredGroups: [],
    example: [
      ["price_starter", "Starter", "29.00", "month", "1", ""],
      ["price_pro", "Pro", "199.00", "month", "1", ""],
      ["price_pro_annual", "Pro (annual)", "1990.00", "year", "1", ""],
    ],
  },

  subscriptions: {
    key: "subscriptions",
    label: "Subscriptions",
    singular: "subscription",
    plural: "subscriptions",
    description:
      "What each customer pays, over time. Several rows with the same subscription_id are that subscription's history — a plan change is a new row starting the day the previous one ends.",
    fields: [
      {
        key: "subscription_id",
        label: "Subscription ID",
        required: true,
        description: "Your billing system's subscription ID (e.g. sub_…). Rows sharing it form one history.",
        synonyms: ["subscription id", "id", "subscription"],
      },
      {
        key: "customer_id",
        label: "Customer ID",
        required: false,
        description: "Matches an imported customer. Missing customers are created.",
        synonyms: ["customer id", "customer"],
      },
      {
        key: "customer_email",
        label: "Customer email",
        required: false,
        description: "Matches a customer by email when there is no customer ID.",
        synonyms: ["customer email", "email", "e mail"],
      },
      {
        key: "customer_name",
        label: "Customer name",
        required: false,
        description: "Used when the customer has to be created.",
        synonyms: ["customer name", "customer description", "name", "company"],
      },
      {
        key: "plan_id",
        label: "Plan ID",
        required: false,
        description: "Matches an imported plan by ID.",
        synonyms: ["plan id", "price id", "plan", "price"],
      },
      {
        key: "plan_name",
        label: "Plan name",
        required: false,
        description: "Matches a plan by name; with amount and interval, a missing plan is created.",
        synonyms: ["plan name", "product", "product name", "plan nickname", "nickname"],
      },
      {
        key: "amount",
        label: "Amount",
        required: false,
        description: "Price per seat per period. Required for a custom price with no plan.",
        synonyms: ["amount", "plan amount", "unit amount", "unit price"],
      },
      {
        key: "interval",
        label: "Interval",
        required: false,
        description: "month or year — for a custom price, or a plan created from this file.",
        synonyms: ["interval", "plan interval", "billing interval", "billing period"],
      },
      {
        key: "interval_count",
        label: "Interval count",
        required: false,
        description: "Defaults to 1.",
        synonyms: ["interval count", "plan interval count"],
      },
      {
        key: "quantity",
        label: "Quantity",
        required: false,
        description: "Seats. Defaults to 1.",
        synonyms: ["quantity", "qty", "seats", "units"],
      },
      {
        key: "status",
        label: "Status",
        required: false,
        description: "active, trialing, past_due or canceled. Defaults to active.",
        synonyms: ["status", "state", "subscription status"],
      },
      {
        key: "start_date",
        label: "Start date",
        required: true,
        description: "When these terms began.",
        synonyms: ["start date", "start", "started at", "start at", "subscription start", "current period start"],
      },
      {
        key: "end_date",
        label: "End date",
        required: false,
        description: "When these terms ended (or will end). Empty while it is running.",
        synonyms: ["end date", "ended at", "ended", "end", "ends at"],
      },
      {
        key: "canceled_at",
        label: "Canceled at",
        required: false,
        description: "When it was canceled. With no end date, the subscription ends on this day.",
        synonyms: ["canceled at", "cancelled at", "cancellation date", "canceled", "cancelled"],
      },
      CURRENCY_FIELD,
    ],
    requiredGroups: [
      { keys: ["customer_id", "customer_email"], message: "Map Customer ID or Customer email — at least one." },
    ],
    example: [
      ["sub_001", "cus_001", "billing@acme.example", "Acme Analytics", "price_starter", "Starter", "29.00", "month", "1", "1", "active", "2025-01-15", "2025-06-15", "", ""],
      ["sub_001", "cus_001", "billing@acme.example", "Acme Analytics", "price_pro", "Pro", "199.00", "month", "1", "1", "active", "2025-06-15", "", "", ""],
      ["sub_002", "cus_002", "finance@bluebird.example", "Bluebird Labs", "", "", "4200.00", "year", "1", "1", "canceled", "2024-03-01", "2025-03-01", "2025-02-10", ""],
    ],
  },

  invoices: {
    key: "invoices",
    label: "Invoices",
    singular: "invoice",
    plural: "invoices",
    description: "Money billed to customers. Invoices feed collections and outstanding balance, not MRR.",
    fields: [
      {
        key: "invoice_id",
        label: "Invoice ID",
        required: true,
        description: "Your billing system's invoice ID or number (e.g. in_…).",
        synonyms: ["invoice id", "id", "invoice", "invoice number", "number"],
      },
      {
        key: "customer_id",
        label: "Customer ID",
        required: false,
        description: "Matches an imported customer. Missing customers are created.",
        synonyms: ["customer id", "customer"],
      },
      {
        key: "customer_email",
        label: "Customer email",
        required: false,
        description: "Matches a customer by email when there is no customer ID.",
        synonyms: ["customer email", "email", "e mail"],
      },
      {
        key: "subscription_id",
        label: "Subscription ID",
        required: false,
        description: "Links the invoice to the subscription's terms in force on its issue date.",
        synonyms: ["subscription id", "subscription"],
      },
      {
        key: "amount",
        label: "Amount",
        required: true,
        description: "The invoice total.",
        synonyms: ["amount", "total", "amount due", "amount paid", "invoice total"],
      },
      {
        key: "status",
        label: "Status",
        required: true,
        description: "draft, open, paid, void or uncollectible.",
        synonyms: ["status", "state", "invoice status"],
      },
      {
        key: "issued_at",
        label: "Issued at",
        required: true,
        description: "The invoice date.",
        synonyms: ["issued at", "issued", "date", "invoice date", "created", "created at"],
      },
      {
        key: "due_at",
        label: "Due at",
        required: false,
        description: "When payment is due.",
        synonyms: ["due at", "due date", "due"],
      },
      {
        key: "paid_at",
        label: "Paid at",
        required: false,
        description: "When it was paid. A paid invoice without one is taken as paid on its issue date.",
        synonyms: ["paid at", "paid date", "paid on", "payment date"],
      },
      CURRENCY_FIELD,
    ],
    requiredGroups: [
      { keys: ["customer_id", "customer_email"], message: "Map Customer ID or Customer email — at least one." },
    ],
    example: [
      ["in_001", "cus_001", "billing@acme.example", "sub_001", "199.00", "paid", "2025-07-15", "2025-07-29", "2025-07-16", ""],
      ["in_002", "cus_001", "billing@acme.example", "sub_001", "199.00", "open", "2025-08-15", "2025-08-29", "", ""],
      ["in_003", "cus_002", "finance@bluebird.example", "", "150.00", "paid", "2025-02-01", "", "2025-02-03", ""],
    ],
  },
};

/** Column index per field key; null = not mapped. */
export type ColumnMapping = Readonly<Record<string, number | null>>;

/**
 * Header text reduced to comparable words: lowercase, the "(UTC)" Stripe and
 * others append removed, anything that is not a letter or digit a single space.
 * "Customer E-mail", "customer_email" and "Customer Email (UTC)" all become
 * "customer e mail" / "customer email".
 */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/\((utc|gmt|z)\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The best header for each field: the field's own key first, then its synonyms
 * in order. A header is used for one field at most, fields claim headers in the
 * order they are declared, and an exact key match anywhere beats a synonym.
 */
export function autoMap(kind: ImportKindKey, headers: readonly string[]): Record<string, number | null> {
  const normalized = headers.map(normalizeHeader);
  const used = new Set<number>();
  const mapping: Record<string, number | null> = {};
  const fields = IMPORT_KINDS[kind].fields;

  // Pass 1: headers that ARE a field key ("customer_email").
  for (const field of fields) {
    const index = normalized.findIndex((header, i) => !used.has(i) && header === normalizeHeader(field.key));
    mapping[field.key] = index >= 0 ? index : null;
    if (index >= 0) used.add(index);
  }
  // Pass 2: synonyms, for what is still unmapped.
  for (const field of fields) {
    if (mapping[field.key] !== null) continue;
    for (const synonym of field.synonyms) {
      const index = normalized.findIndex((header, i) => !used.has(i) && header === normalizeHeader(synonym));
      if (index >= 0) {
        mapping[field.key] = index;
        used.add(index);
        break;
      }
    }
  }
  return mapping;
}

/** What still blocks the next step: unmapped required fields and unsatisfied groups. */
export function missingMappings(kind: ImportKindKey, mapping: ColumnMapping): string[] {
  const spec = IMPORT_KINDS[kind];
  const missing: string[] = [];
  for (const field of spec.fields) {
    if (field.required && (mapping[field.key] ?? null) === null) missing.push(`Map a column to ${field.label}.`);
  }
  for (const group of spec.requiredGroups) {
    if (group.keys.every((key) => (mapping[key] ?? null) === null)) missing.push(group.message);
  }
  return missing;
}

/** The template for a kind: the documented headers and three example rows. */
export function templateRows(kind: ImportKindKey): { headers: string[]; rows: string[][] } {
  const spec = IMPORT_KINDS[kind];
  return { headers: spec.fields.map((field) => field.key), rows: spec.example.map((row) => [...row]) };
}

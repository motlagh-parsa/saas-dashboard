// The OpenAPI 3.1 description of /api/v1, served as-is at /api/v1/openapi.json.
//
// Written by hand to match lib/api/resources/*. scripts/verify-api.ts checks
// that every route under app/api/v1 and each method it exports appears here, so
// an endpoint cannot ship undocumented.

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const rateHeaders = {
  "X-Request-Id": { $ref: "#/components/headers/RequestId" },
  "X-RateLimit-Limit": { $ref: "#/components/headers/RateLimitLimit" },
  "X-RateLimit-Remaining": { $ref: "#/components/headers/RateLimitRemaining" },
  "X-RateLimit-Reset": { $ref: "#/components/headers/RateLimitReset" },
};

const ok = (description: string, schema: string, status: "200" | "201" = "200") => ({
  [status]: {
    description,
    headers: rateHeaders,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
  },
});

const readErrors = {
  "400": errorResponse("Invalid parameters. `details` lists every invalid field."),
  "401": errorResponse("Missing, unknown, revoked or expired API key."),
  "404": errorResponse("No such record."),
  "429": {
    ...errorResponse("Rate limit exceeded."),
    headers: { "Retry-After": { description: "Seconds until the window resets.", schema: { type: "integer" } } },
  },
  "500": errorResponse("Internal error. Quote X-Request-Id to support."),
};

const writeErrors = {
  ...readErrors,
  "403": errorResponse("The key is read-only."),
  "409": errorResponse("Meridian refused the change, with the same message its UI would show."),
};

const externalIdParam = {
  name: "external_id",
  in: "path",
  required: true,
  description: "Your ID for the record: 1–191 of `A–Z a–z 0–9 _ - .`.",
  schema: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,191}$" },
};

const pageParams = [
  { name: "limit", in: "query", description: "1–100, default 25.", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
  {
    name: "starting_after",
    in: "query",
    description: "The `next_cursor` of the previous page.",
    schema: { type: "string" },
  },
];

const jsonBody = (schema: string) => ({
  required: true,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
});

const day = { type: "string", format: "date", examples: ["2025-01-31"] };
const nullableDay = { type: ["string", "null"], format: "date" };
const money = { type: "integer", description: "Integer minor units of `currency` (4999 = 49.99 USD)." };
const listOf = (item: string) => ({
  type: "object",
  required: ["object", "data", "has_more", "next_cursor"],
  properties: {
    object: { const: "list" },
    data: { type: "array", items: { $ref: `#/components/schemas/${item}` } },
    has_more: { type: "boolean" },
    next_cursor: { type: ["string", "null"], description: "Pass as `starting_after` for the next page." },
  },
});

export const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "Meridian API",
    version: "1.0.0",
    description:
      "Push your billing state into Meridian whenever it changes, and read your metrics back. JSON only, snake_case, money in integer minor units, dates as YYYY-MM-DD. Full guide: /docs/api.",
  },
  servers: [{ url: "/api/v1" }],
  security: [{ bearerAuth: [] }],
  paths: {
    "/customers": {
      get: {
        operationId: "listCustomers",
        summary: "List customers",
        tags: ["Customers"],
        parameters: [
          ...pageParams,
          {
            name: "status",
            in: "query",
            description: "`all` (default) excludes archived customers.",
            schema: { enum: ["active", "churned", "all"], default: "all" },
          },
        ],
        responses: { ...ok("A page of customers.", "CustomerList"), ...readErrors },
      },
    },
    "/customers/{external_id}": {
      parameters: [externalIdParam],
      get: {
        operationId: "getCustomer",
        summary: "Get a customer, with current MRR, status and subscriptions",
        tags: ["Customers"],
        responses: { ...ok("The customer.", "CustomerDetail"), ...readErrors },
      },
      put: {
        operationId: "putCustomer",
        summary: "Create or update a customer",
        description: "Idempotent. Pushing an archived customer unarchives it.",
        tags: ["Customers"],
        requestBody: jsonBody("CustomerInput"),
        responses: {
          ...ok("Updated, or unchanged.", "CustomerDetail"),
          ...ok("Created.", "CustomerDetail", "201"),
          ...writeErrors,
        },
      },
      delete: {
        operationId: "archiveCustomer",
        summary: "Archive a customer",
        description: "History and metrics are kept. Returns the archived record. Idempotent.",
        tags: ["Customers"],
        responses: { ...ok("The archived customer.", "CustomerDetail"), ...writeErrors },
      },
    },
    "/plans": {
      get: {
        operationId: "listPlans",
        summary: "List plans",
        tags: ["Plans"],
        parameters: pageParams,
        responses: { ...ok("A page of plans.", "PlanList"), ...readErrors },
      },
    },
    "/plans/{external_id}": {
      parameters: [externalIdParam],
      put: {
        operationId: "putPlan",
        summary: "Create or update a plan",
        description: "A new price applies to new subscriptions only; running subscriptions keep the price they started on.",
        tags: ["Plans"],
        requestBody: jsonBody("PlanInput"),
        responses: { ...ok("Updated, or unchanged.", "Plan"), ...ok("Created.", "Plan", "201"), ...writeErrors },
      },
    },
    "/subscriptions": {
      get: {
        operationId: "listSubscriptions",
        summary: "List subscriptions",
        tags: ["Subscriptions"],
        parameters: [
          ...pageParams,
          { name: "customer_external_id", in: "query", schema: { type: "string" } },
        ],
        responses: { ...ok("A page of subscriptions.", "SubscriptionList"), ...readErrors },
      },
    },
    "/subscriptions/{external_id}": {
      parameters: [externalIdParam],
      get: {
        operationId: "getSubscription",
        summary: "Get a subscription and its segments",
        tags: ["Subscriptions"],
        responses: { ...ok("The subscription.", "Subscription"), ...readErrors },
      },
      put: {
        operationId: "putSubscription",
        summary: "Push a subscription's current state",
        description:
          "New external_id: created. Existing: plan, price or quantity changes take effect on `effective_date` (default today); `end_date` cancels (today or earlier) or schedules a cancellation (later); removing `end_date` undoes a scheduled cancellation. `changes` lists what happened.",
        tags: ["Subscriptions"],
        requestBody: jsonBody("SubscriptionInput"),
        responses: {
          ...ok("Updated, or unchanged.", "SubscriptionPutResult"),
          ...ok("Created.", "SubscriptionPutResult", "201"),
          ...writeErrors,
        },
      },
      delete: {
        operationId: "deleteSubscription",
        summary: "Delete a subscription",
        description: "Deletes every segment and their invoices, like Delete in Meridian. For mistakes; to end a subscription, send end_date.",
        tags: ["Subscriptions"],
        responses: { ...ok("Deleted.", "DeletedSubscription"), ...writeErrors },
      },
    },
    "/invoices": {
      get: {
        operationId: "listInvoices",
        summary: "List invoices",
        tags: ["Invoices"],
        parameters: [
          ...pageParams,
          { name: "status", in: "query", schema: { enum: ["draft", "open", "paid", "void", "uncollectible"] } },
          { name: "customer_external_id", in: "query", schema: { type: "string" } },
          { name: "issued_after", in: "query", description: "Exclusive.", schema: day },
          { name: "issued_before", in: "query", description: "Exclusive.", schema: day },
        ],
        responses: { ...ok("A page of invoices.", "InvoiceList"), ...readErrors },
      },
    },
    "/invoices/{external_id}": {
      parameters: [externalIdParam],
      get: {
        operationId: "getInvoice",
        summary: "Get an invoice",
        tags: ["Invoices"],
        responses: { ...ok("The invoice.", "Invoice"), ...readErrors },
      },
      put: {
        operationId: "putInvoice",
        summary: "Create or update an invoice",
        description:
          "Once recorded, only the status changes: draft/open → paid, void; open → uncollectible; uncollectible → paid. Amount, customer and dates are fixed.",
        tags: ["Invoices"],
        requestBody: jsonBody("InvoiceInput"),
        responses: { ...ok("Updated, or unchanged.", "Invoice"), ...ok("Created.", "Invoice", "201"), ...writeErrors },
      },
    },
    "/metrics/summary": {
      get: {
        operationId: "getMetricsSummary",
        summary: "Headline metrics for a day",
        description: "The figures the Overview shows: state as of the day, flows and rates over the 30 days up to it.",
        tags: ["Metrics"],
        parameters: [{ name: "date", in: "query", description: "Default today (UTC).", schema: day }],
        responses: { ...ok("The summary.", "MetricsSummary"), ...readErrors },
      },
    },
    "/metrics/mrr": {
      get: {
        operationId: "getMrrSeries",
        summary: "Daily MRR series",
        tags: ["Metrics"],
        parameters: [
          { name: "from", in: "query", description: "Default 29 days before `to`.", schema: day },
          { name: "to", in: "query", description: "Default today. At most 730 days after `from`.", schema: day },
        ],
        responses: { ...ok("One point per day with a snapshot.", "MrrSeries"), ...readErrors },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "An API key from Settings → API keys: `Authorization: Bearer mrd_…`.",
      },
    },
    headers: {
      RequestId: { description: "Unique per response; quote it to support.", schema: { type: "string" } },
      RateLimitLimit: { description: "Requests allowed per minute per key (120).", schema: { type: "integer" } },
      RateLimitRemaining: { description: "Requests left in this window.", schema: { type: "integer" } },
      RateLimitReset: { description: "Unix time (seconds) the window resets.", schema: { type: "integer" } },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["type", "message"],
            properties: {
              type: {
                enum: ["invalid_request", "authentication", "permission", "not_found", "conflict", "rate_limited", "internal"],
              },
              message: { type: "string" },
              param: { type: "string" },
              details: {
                type: "array",
                items: {
                  type: "object",
                  required: ["param", "message"],
                  properties: { param: { type: "string" }, message: { type: "string" } },
                },
              },
            },
          },
        },
      },
      CustomerInput: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          email: { type: ["string", "null"], format: "email", description: "Omit to leave unchanged; null clears it." },
        },
      },
      Customer: {
        type: "object",
        properties: {
          object: { const: "customer" },
          id: { type: "string" },
          external_id: { type: ["string", "null"] },
          name: { type: "string" },
          email: { type: ["string", "null"] },
          status: { enum: ["active", "past_due", "churned", "none"] },
          archived: { type: "boolean" },
          mrr: money,
          currency: { type: "string" },
          customer_since: nullableDay,
          source: { enum: ["manual", "csv", "api", "stripe", "sample"] },
        },
      },
      CustomerDetail: {
        allOf: [
          { $ref: "#/components/schemas/Customer" },
          {
            type: "object",
            properties: { subscriptions: { type: "array", items: { $ref: "#/components/schemas/Subscription" } } },
          },
        ],
      },
      CustomerList: listOf("Customer"),
      PlanInput: {
        type: "object",
        additionalProperties: false,
        required: ["name", "amount", "interval"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 60 },
          amount: { ...money, minimum: 0 },
          interval: { enum: ["month", "year"] },
          interval_count: { type: "integer", minimum: 1, maximum: 36, default: 1, description: "Up to 36 months or 3 years." },
        },
      },
      Plan: {
        type: "object",
        properties: {
          object: { const: "plan" },
          id: { type: "string" },
          external_id: { type: ["string", "null"] },
          name: { type: "string" },
          amount: money,
          currency: { type: "string" },
          interval: { enum: ["month", "year"] },
          interval_count: { type: "integer" },
          archived: { type: "boolean" },
          source: { type: "string" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      PlanList: listOf("Plan"),
      SubscriptionInput: {
        type: "object",
        additionalProperties: false,
        required: ["customer_external_id", "start_date"],
        description: "Send `plan_external_id` (optionally with `amount`, a price override), or `amount` + `interval` for a custom price.",
        properties: {
          customer_external_id: { type: "string" },
          plan_external_id: { type: "string" },
          amount: { ...money, minimum: 0 },
          interval: { enum: ["month", "year"] },
          interval_count: { type: "integer", minimum: 1, maximum: 36 },
          quantity: { type: "integer", minimum: 1, maximum: 10000, description: "Default 1 on create; unchanged if omitted." },
          status: { enum: ["active", "trialing", "past_due"], description: "Default active on create; unchanged if omitted." },
          start_date: day,
          end_date: { ...nullableDay, description: "Set to cancel; omit or null to keep running (undoes a scheduled cancellation)." },
          effective_date: { ...day, description: "When a plan, price or quantity change takes effect. Default today." },
        },
      },
      Segment: {
        type: "object",
        properties: {
          id: { type: "string" },
          external_id: { type: ["string", "null"] },
          plan_external_id: { type: ["string", "null"] },
          plan_name: { type: ["string", "null"] },
          amount: money,
          quantity: { type: "integer" },
          interval: { enum: ["month", "year"] },
          interval_count: { type: "integer" },
          status: { enum: ["active", "trialing", "past_due", "canceled"] },
          start_date: day,
          end_date: nullableDay,
          mrr: money,
        },
      },
      Subscription: {
        type: "object",
        properties: {
          object: { const: "subscription" },
          id: { type: "string" },
          external_id: { type: ["string", "null"] },
          customer_id: { type: "string" },
          customer_external_id: { type: ["string", "null"] },
          status: { enum: ["active", "trialing", "past_due", "canceled"] },
          start_date: day,
          end_date: nullableDay,
          cancel_scheduled: { type: "boolean" },
          plan_external_id: { type: ["string", "null"] },
          plan_name: { type: ["string", "null"] },
          amount: money,
          quantity: { type: "integer" },
          interval: { enum: ["month", "year"] },
          interval_count: { type: "integer" },
          mrr: money,
          currency: { type: "string" },
          segments: { type: "array", items: { $ref: "#/components/schemas/Segment" } },
        },
      },
      SubscriptionPutResult: {
        allOf: [
          { $ref: "#/components/schemas/Subscription" },
          {
            type: "object",
            properties: {
              changes: {
                type: "array",
                items: {
                  enum: [
                    "created",
                    "plan_changed",
                    "quantity_changed",
                    "status_changed",
                    "canceled",
                    "cancel_scheduled",
                    "cancel_undone",
                    "unchanged",
                  ],
                },
              },
            },
          },
        ],
      },
      SubscriptionList: listOf("Subscription"),
      DeletedSubscription: {
        type: "object",
        properties: {
          object: { const: "subscription" },
          external_id: { type: "string" },
          deleted: { const: true },
          segments: { type: "integer" },
          invoices: { type: "integer" },
        },
      },
      InvoiceInput: {
        type: "object",
        additionalProperties: false,
        required: ["customer_external_id", "amount", "status", "issued_at"],
        properties: {
          customer_external_id: { type: "string" },
          subscription_external_id: { type: ["string", "null"] },
          amount: { ...money, minimum: 1 },
          status: { enum: ["draft", "open", "paid", "void", "uncollectible"] },
          issued_at: day,
          due_at: nullableDay,
          paid_at: { ...nullableDay, description: "Required with status paid; today or earlier." },
        },
      },
      Invoice: {
        type: "object",
        properties: {
          object: { const: "invoice" },
          id: { type: "string" },
          external_id: { type: ["string", "null"] },
          customer_external_id: { type: ["string", "null"] },
          subscription_external_id: { type: ["string", "null"] },
          amount: money,
          currency: { type: "string" },
          status: { enum: ["draft", "open", "paid", "void", "uncollectible"] },
          issued_at: day,
          due_at: nullableDay,
          paid_at: nullableDay,
          source: { type: "string" },
        },
      },
      InvoiceList: listOf("Invoice"),
      MetricsSummary: {
        type: "object",
        properties: {
          object: { const: "metrics_summary" },
          date: day,
          as_of: { type: "string", format: "date-time" },
          period: {
            type: "object",
            properties: { start: { type: "string", format: "date-time" }, end: { type: "string", format: "date-time" } },
          },
          currency: { type: "string" },
          mrr: money,
          arr: money,
          active_customers: { type: "integer" },
          new_customers: { type: "integer" },
          churned_customers: { type: "integer" },
          reactivated_customers: { type: "integer" },
          customer_churn_rate: { type: ["number", "null"], description: "Fraction: 0.05 = 5%." },
          revenue_churn_rate: { type: ["number", "null"] },
          nrr: { type: ["number", "null"] },
          grr: { type: ["number", "null"] },
          arpa: money,
        },
      },
      MrrSeries: {
        type: "object",
        properties: {
          object: { const: "list" },
          currency: { type: "string" },
          from: day,
          to: day,
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: day,
                mrr: money,
                arr: money,
                active_customers: { type: "integer" },
                new_customers: { type: "integer" },
                churned_customers: { type: "integer" },
              },
            },
          },
        },
      },
    },
  },
} as const;

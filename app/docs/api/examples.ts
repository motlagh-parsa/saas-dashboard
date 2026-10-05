// Request and response examples for /docs/api, in the exact shapes
// lib/api/resources/* return — kept as data so each is written once and
// rendered as JSON, never hand-typed twice.

const SEGMENT = {
  id: "cm4sg1a0b0001",
  external_id: "sub_1001:2025-03-01",
  plan_external_id: "growth",
  plan_name: "Growth",
  amount: 9900,
  quantity: 1,
  interval: "month",
  interval_count: 1,
  status: "active",
  start_date: "2025-03-01",
  end_date: null,
  mrr: 9900,
};

export const SUBSCRIPTION = {
  object: "subscription",
  id: "cm4sg1a0b0001",
  external_id: "sub_1001",
  customer_id: "cm4cu7x2k0000",
  customer_external_id: "cus_42",
  status: "active",
  start_date: "2025-03-01",
  end_date: null,
  cancel_scheduled: false,
  plan_external_id: "growth",
  plan_name: "Growth",
  amount: 9900,
  quantity: 1,
  interval: "month",
  interval_count: 1,
  mrr: 9900,
  currency: "USD",
  segments: [SEGMENT],
};

export const SUBSCRIPTION_UPGRADED = {
  ...SUBSCRIPTION,
  plan_external_id: "scale",
  plan_name: "Scale",
  amount: 29900,
  mrr: 29900,
  segments: [
    { ...SEGMENT, status: "canceled", end_date: "2025-06-10", mrr: 0 },
    {
      ...SEGMENT,
      id: "cm4sg9z3q0007",
      external_id: "sub_1001:2025-06-10",
      plan_external_id: "scale",
      plan_name: "Scale",
      amount: 29900,
      start_date: "2025-06-10",
      mrr: 29900,
    },
  ],
  changes: ["plan_changed"],
};

export const CUSTOMER = {
  object: "customer",
  id: "cm4cu7x2k0000",
  external_id: "cus_42",
  name: "Acme Inc",
  email: "billing@acme.test",
  status: "active",
  archived: false,
  mrr: 9900,
  currency: "USD",
  customer_since: "2025-03-01",
  source: "api",
  subscriptions: [SUBSCRIPTION],
};

export const PLAN = {
  object: "plan",
  id: "cm4pl3m8d0002",
  external_id: "growth",
  name: "Growth",
  amount: 9900,
  currency: "USD",
  interval: "month",
  interval_count: 1,
  archived: false,
  source: "api",
  created_at: "2025-03-01T09:12:44.120Z",
};

export const INVOICE = {
  object: "invoice",
  id: "cm4in5t1w0003",
  external_id: "in_8841",
  customer_external_id: "cus_42",
  subscription_external_id: "sub_1001",
  amount: 9900,
  currency: "USD",
  status: "paid",
  issued_at: "2025-06-01",
  due_at: "2025-06-15",
  paid_at: "2025-06-02",
  source: "api",
};

export const SUMMARY = {
  object: "metrics_summary",
  date: "2025-06-30",
  as_of: "2025-06-30T23:59:59.999Z",
  period: { start: "2025-05-31T23:59:59.999Z", end: "2025-06-30T23:59:59.999Z" },
  currency: "USD",
  mrr: 1284500,
  arr: 15414000,
  active_customers: 212,
  new_customers: 14,
  churned_customers: 3,
  reactivated_customers: 1,
  customer_churn_rate: 0.0149,
  revenue_churn_rate: 0.0102,
  nrr: 1.043,
  grr: 0.978,
  arpa: 6059,
};

export const MRR_SERIES = {
  object: "list",
  currency: "USD",
  from: "2025-06-28",
  to: "2025-06-30",
  data: [
    { date: "2025-06-28", mrr: 1279600, arr: 15355200, active_customers: 211, new_customers: 1, churned_customers: 0 },
    { date: "2025-06-29", mrr: 1279600, arr: 15355200, active_customers: 211, new_customers: 0, churned_customers: 0 },
    { date: "2025-06-30", mrr: 1284500, arr: 15414000, active_customers: 212, new_customers: 1, churned_customers: 0 },
  ],
};

export function listOf<T>(item: T): { object: "list"; data: T[]; has_more: boolean; next_cursor: string | null } {
  return { object: "list", data: [item], has_more: true, next_cursor: "cm4cu7x2k0000" };
}

export const VALIDATION_ERROR = {
  error: {
    type: "invalid_request",
    message: "2 fields are invalid.",
    param: "amount",
    details: [
      { param: "amount", message: "Send the amount as an integer in minor units (4999 = 49.99)." },
      { param: "start_date", message: "Send a real date as YYYY-MM-DD." },
    ],
  },
};

export const CONFLICT_ERROR = {
  error: {
    type: "conflict",
    message: "Pick a date after 01 Mar 2025, when the current terms began. To fix the start itself, use Correct.",
    param: "effective_date",
  },
};

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

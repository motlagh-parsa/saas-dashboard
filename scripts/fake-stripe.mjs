// A small fake of Stripe's read API, for tests: the list and retrieve
// endpoints Meridian's sync uses, with Stripe's pagination (has_more /
// starting_after — deliberately 2 per page, so every list paginates), its
// auth errors, and a control endpoint to change the account between syncs.
//
//   node scripts/fake-stripe.mjs              # listens on FAKE_STRIPE_PORT (default 12111)
//   import { startFakeStripe } from "./fake-stripe.mjs"   # in-process
//
// Run the app with STRIPE_API_BASE=http://127.0.0.1:12111 to sync from it.
// Keys: FAKE_KEY reads everything; FAKE_KEY_NO_INVOICES gets 403 on invoices.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const FAKE_KEY = "rk_test_meridianfake000000000000";
export const FAKE_KEY_NO_INVOICES = "rk_test_meridiannoinvoices000000";
const PAGE = 2;
const DAY = 86_400;

const now = () => Math.floor(Date.now() / 1000);

/** The default account: what the sync tests expect (see scripts/verify-stripe.ts). */
export function defaultFixtures(at = now()) {
  const T = at - (at % DAY);
  const products = {
    prod_basic: { id: "prod_basic", object: "product", name: "Basic" },
    prod_pro: { id: "prod_pro", object: "product", name: "Pro" },
  };
  const price = (id, product, unit_amount, interval, interval_count = 1, currency = "usd", type = "recurring") => ({
    id,
    object: "price",
    product,
    currency,
    unit_amount,
    nickname: null,
    type,
    recurring: type === "recurring" ? { interval, interval_count } : null,
  });
  const prices = [
    price("price_basic_m", "prod_basic", 1500, "month"),
    price("price_pro_m", "prod_pro", 4900, "month"),
    price("price_pro_y", "prod_pro", 49000, "year"),
    price("price_pro_eur", "prod_pro", 4500, "month", 1, "eur"),
    price("price_basic_w", "prod_basic", 400, "week"),
    price("price_metered", "prod_pro", null, "month"),
    price("price_setup", "prod_pro", 10000, null, 1, "usd", "one_time"),
  ];
  const customers = [
    { id: "cus_a", object: "customer", name: "Acme Corp", email: "billing@acme.test" },
    { id: "cus_b", object: "customer", name: "Beta LLC", email: "ap@beta.test" },
    { id: "cus_c", object: "customer", name: "Gamma Inc", email: null },
    { id: "cus_d", object: "customer", name: null, email: "delta@delta.test" },
  ];
  const sub = (id, customer, status, priceId, start, extra = {}) => ({
    id,
    object: "subscription",
    customer,
    status,
    currency: (prices.find((p) => p.id === priceId)?.currency) ?? "usd",
    start_date: start,
    ended_at: null,
    cancel_at: null,
    items: { data: [{ id: `si_${id.slice(4)}`, quantity: extra.quantity ?? 1, price: prices.find((p) => p.id === priceId) }] },
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "quantity")),
  });
  const subscriptions = [
    sub("sub_a", "cus_a", "active", "price_pro_m", T - 90 * DAY, { quantity: 2 }),
    sub("sub_b", "cus_b", "canceled", "price_basic_m", T - 120 * DAY, { ended_at: T - 30 * DAY }),
    sub("sub_c", "cus_c", "trialing", "price_pro_y", T - 10 * DAY),
    sub("sub_d", "cus_d", "active", "price_basic_m", T - 60 * DAY, { cancel_at: T + 20 * DAY }),
    sub("sub_e", "cus_a", "incomplete", "price_basic_m", T - 2 * DAY),
    sub("sub_f", "cus_b", "past_due", "price_pro_eur", T - 40 * DAY),
  ];
  const invoice = (id, customer, subscription, total, status, created, extra = {}) => ({
    id,
    object: "invoice",
    customer,
    subscription,
    currency: "usd",
    total,
    status,
    created,
    due_date: null,
    status_transitions: { finalized_at: created, paid_at: status === "paid" ? created + 3600 : null },
    ...extra,
  });
  const invoices = [
    invoice("in_a1", "cus_a", "sub_a", 9800, "paid", T - 30 * DAY),
    invoice("in_b1", "cus_b", "sub_b", 1500, "uncollectible", T - 60 * DAY),
    invoice("in_d1", "cus_d", "sub_d", 1500, "open", T - 12 * DAY, { due_date: T - 5 * DAY }),
    invoice("in_zero", "cus_c", "sub_c", 0, "paid", T - 10 * DAY),
  ];
  return { products, prices, customers, subscriptions, invoices };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startFakeStripe({ port = 0, fixtures = defaultFixtures() } = {}) {
  let state = fixtures;
  const requests = [];

  const expandProduct = (price) => ({ ...price, product: state.products[price.product] ?? price.product });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/__control/")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (url.pathname === "/__control/reset") state = defaultFixtures();
      if (url.pathname === "/__control/state") state = JSON.parse(body);
      if (url.pathname === "/__control/get") return send(res, 200, state);
      return send(res, 200, { ok: true });
    }

    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    requests.push(`${req.method} ${url.pathname}`);
    if (key !== FAKE_KEY && key !== FAKE_KEY_NO_INVOICES) {
      return send(res, 401, { error: { type: "invalid_request_error", message: "Invalid API Key provided." } });
    }
    if (req.method !== "GET") return send(res, 405, { error: { message: "This fake is read-only." } });

    const parts = url.pathname.split("/").filter(Boolean); // ["v1", "customers", id?]
    const collection = { customers: state.customers, prices: state.prices, subscriptions: state.subscriptions, invoices: state.invoices }[parts[1]];
    if (parts[0] !== "v1" || collection === undefined) return send(res, 404, { error: { message: "Unknown endpoint." } });
    if (parts[1] === "invoices" && key === FAKE_KEY_NO_INVOICES) {
      return send(res, 403, { error: { type: "invalid_request_error", message: "The provided key does not have the required permissions." } });
    }
    const expand = url.searchParams.getAll("expand[]");
    const shape = (item) => (parts[1] === "prices" && (expand.includes("data.product") || expand.includes("product")) ? expandProduct(item) : item);

    if (parts[2]) {
      const item = collection.find((entry) => entry.id === parts[2]);
      return item ? send(res, 200, shape(item)) : send(res, 404, { error: { message: `No such ${parts[1]}: ${parts[2]}` } });
    }

    let items = collection;
    if (parts[1] === "subscriptions" && url.searchParams.get("status") !== "all") {
      items = items.filter((entry) => entry.status !== "canceled");
    }
    const after = url.searchParams.get("starting_after");
    const start = after ? items.findIndex((entry) => entry.id === after) + 1 : 0;
    const size = Math.min(Number(url.searchParams.get("limit") ?? 10), PAGE);
    const page = items.slice(start, start + size);
    send(res, 200, { object: "list", data: page.map(shape), has_more: start + size < items.length });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        setState(next) {
          state = next;
        },
        getState() {
          return state;
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const fake = await startFakeStripe({ port: Number(process.env.FAKE_STRIPE_PORT ?? 12111) });
  console.log(`fake Stripe listening on ${fake.url}`);
}

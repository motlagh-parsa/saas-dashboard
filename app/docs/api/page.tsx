// /docs/api — the public REST API reference. No sign-in: middleware only
// guards /dashboard and /onboarding, and nothing here reads a session.
//
// The auth pages' visual language — brand mark, the dark ledger-grid panel,
// mono eyebrows, brass accents — in both themes (the root layout's cookie
// decides; the toggle here writes it). Code sits on the pinned-dark "terminal"
// surface in either theme. Mobile first: the section nav is a wrapped chip row
// on a phone and a sticky column from `lg`; code scrolls inside its own block.
//
// Examples come from ./examples.ts in the shapes lib/api/resources/* return.
// The machine-readable contract is /api/v1/openapi.json.
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import { BrandMark } from "@/components/dashboard/brand-mark";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { RATE_LIMIT } from "@/lib/api/rate-limit";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

import {
  CONFLICT_ERROR,
  CUSTOMER,
  INVOICE,
  MRR_SERIES,
  PLAN,
  SUBSCRIPTION,
  SUBSCRIPTION_UPGRADED,
  SUMMARY,
  VALIDATION_ERROR,
  json,
  listOf,
} from "./examples";

export const metadata: Metadata = {
  title: "API reference",
  description: "Push customers, plans, subscriptions and invoices into Meridian as they change, and read your metrics back.",
};

const EYEBROW = "font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase";

const SECTIONS: readonly { id: string; label: string }[] = [
  { id: "introduction", label: "Introduction" },
  { id: "authentication", label: "Authentication" },
  { id: "errors", label: "Errors" },
  { id: "rate-limits", label: "Rate limits" },
  { id: "pagination", label: "Pagination" },
  { id: "syncing", label: "Syncing guide" },
  { id: "customers", label: "Customers" },
  { id: "plans", label: "Plans" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "invoices", label: "Invoices" },
  { id: "metrics", label: "Metrics" },
];

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Code({ children, title }: { children: string; title?: string }) {
  return (
    <figure className="dark min-w-0 overflow-hidden rounded-xl bg-sidebar text-sidebar-foreground ring-1 ring-foreground/10">
      {title ? (
        <figcaption className="border-b border-foreground/10 px-4 py-2 font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
          {title}
        </figcaption>
      ) : null}
      <pre className="overflow-x-auto p-4 font-mono text-[0.75rem] leading-relaxed">
        <code>{children}</code>
      </pre>
    </figure>
  );
}

function Inline({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8em] text-foreground">{children}</code>;
}

function Section({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 border-t border-border pt-10">
      <p className={EYEBROW}>{eyebrow}</p>
      <h2 id={`${id}-title`} className="mt-2 font-heading text-2xl font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-4 flex flex-col gap-4 text-[0.9375rem] leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
        {children}
      </div>
    </section>
  );
}

const METHOD_CLASS: Record<string, string> = {
  GET: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  PUT: "bg-brand/15 text-foreground",
  DELETE: "bg-destructive/10 text-destructive",
};

interface FieldDoc {
  readonly name: string;
  readonly type: string;
  readonly required?: boolean;
  readonly description: ReactNode;
}

function Fields({ title, fields }: { title: string; fields: readonly FieldDoc[] }) {
  return (
    <div className="min-w-0">
      <h4 className={EYEBROW}>{title}</h4>
      <dl className="mt-2 divide-y divide-border rounded-xl border border-border">
        {fields.map((field) => (
          <div key={field.name} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:gap-4">
            <dt className="flex flex-wrap items-baseline gap-x-2 font-mono text-[0.8125rem] text-foreground">
              {field.name}
              <span className="text-[0.6875rem] text-muted-foreground">{field.type}</span>
              {field.required ? <span className="text-[0.6875rem] text-brand">required</span> : null}
            </dt>
            <dd className="text-sm text-muted-foreground">{field.description}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

interface EndpointProps {
  readonly method: "GET" | "PUT" | "DELETE";
  readonly path: string;
  readonly scope: "read" | "write";
  readonly summary: ReactNode;
  readonly params?: readonly FieldDoc[];
  readonly body?: readonly FieldDoc[];
  readonly curl: string;
  readonly response: unknown;
  readonly responseTitle?: string;
}

function Endpoint({ method, path, scope, summary, params, body, curl, response, responseTitle }: EndpointProps) {
  return (
    <article className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-card p-4 sm:p-6">
      <header className="flex flex-col gap-2">
        <h3 className="flex flex-wrap items-center gap-2 font-mono text-sm text-foreground">
          <span className={cn("rounded-md px-1.5 py-0.5 text-[0.6875rem] font-semibold", METHOD_CLASS[method])}>{method}</span>
          <span className="break-all">/v1{path}</span>
          <span className="rounded-full border border-border px-2 py-0.5 text-[0.625rem] tracking-[0.12em] text-muted-foreground uppercase">
            {scope} key
          </span>
        </h3>
        <div className="text-sm leading-relaxed text-muted-foreground">{summary}</div>
      </header>
      {params ? <Fields title="Query parameters" fields={params} /> : null}
      {body ? <Fields title="Body" fields={body} /> : null}
      <div className="grid min-w-0 gap-3 xl:grid-cols-2">
        <Code title="Request">{curl}</Code>
        <Code title={responseTitle ?? "Response"}>{json(response)}</Code>
      </div>
    </article>
  );
}

const PAGE_PARAMS: readonly FieldDoc[] = [
  { name: "limit", type: "integer", description: "1–100. Default 25." },
  { name: "starting_after", type: "string", description: <>The <Inline>next_cursor</Inline> of the previous page.</> },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ApiDocsPage() {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  const theme = parseTheme(cookieStore.get(THEME_COOKIE)?.value);
  // Examples show the host this page was served from, so they paste as-is.
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "meridian.example";
  const protocol = headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = `${protocol}://${host}/api/v1`;
  const auth = `-H "Authorization: Bearer $MERIDIAN_KEY"`;
  const put = (path: string, body: unknown) =>
    `curl -X PUT ${base}${path} \\\n  ${auth} \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body, null, 2).replace(/\n/g, "\n  ")}'`;
  const get = (path: string) => `curl ${base}${path} \\\n  ${auth}`;
  const del = (path: string) => `curl -X DELETE ${base}${path} \\\n  ${auth}`;

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link href="/docs/api" className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <BrandMark />
            <span className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[0.625rem] tracking-[0.14em] text-muted-foreground uppercase">
              API
            </span>
          </Link>
          <div className="flex items-center gap-1">
            <ThemeToggle theme={theme} />
            <Link
              href="/dashboard/settings/api-keys"
              className="inline-flex h-9 items-center rounded-lg bg-brand px-3 text-sm font-medium text-brand-foreground hover:bg-brand/90"
            >
              Get a key
            </Link>
          </div>
        </div>
      </header>

      {/* Hero on the pinned-dark ledger panel, as on sign-in. */}
      <div className="dark relative overflow-hidden bg-sidebar text-sidebar-foreground">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.4]"
          style={{
            backgroundImage:
              "linear-gradient(to right, color-mix(in oklch, var(--foreground) 6%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklch, var(--foreground) 6%, transparent) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage: "radial-gradient(120% 100% at 0% 0%, black, transparent 70%)",
          }}
        />
        <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-12 sm:px-6 sm:py-16">
          <p className={EYEBROW}>REST API · v1</p>
          <h1 className="max-w-2xl font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Push your billing state. Read your metrics back.
          </h1>
          <p className="max-w-2xl text-[0.9375rem] leading-relaxed text-muted-foreground">
            Your backend tells Meridian what a customer&apos;s subscription looks like <em>now</em>, whenever it
            changes. Meridian works out what changed, records it in its history, and your MRR, churn and retention
            update within seconds.
          </p>
          <div className="flex flex-wrap gap-2 font-mono text-xs">
            <span className="rounded-lg bg-card px-3 py-1.5 ring-1 ring-foreground/10">{base}</span>
            <a
              href="/api/v1/openapi.json"
              className="rounded-lg px-3 py-1.5 text-muted-foreground ring-1 ring-foreground/10 hover:text-foreground"
            >
              openapi.json
            </a>
          </div>
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-12">
        <nav aria-label="On this page" className="lg:sticky lg:top-20 lg:self-start">
          <p className={cn(EYEBROW, "hidden lg:block")}>On this page</p>
          <ul className="flex flex-wrap gap-1.5 lg:mt-3 lg:flex-col lg:gap-0.5">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="inline-flex h-9 items-center rounded-lg border border-border px-2.5 text-sm text-muted-foreground hover:text-foreground lg:h-8 lg:border-0 lg:px-2"
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <main className="flex min-w-0 flex-col gap-10 pb-16">
          <Section id="introduction" eyebrow="Start here" title="Push the current state whenever it changes">
            <p>
              The API is built around one idea: <strong>you don&apos;t send events, you send state.</strong> When
              something changes in your billing system — a signup, an upgrade, a cancellation, a payment — send Meridian
              the record as it is now, under <strong>your own ID</strong> for it. Every write is an idempotent{" "}
              <Inline>PUT</Inline> keyed by that ID: sending the same state twice changes nothing, so retries are safe
              and a nightly full re-sync is harmless.
            </p>
            <p>
              Behind each <Inline>PUT</Inline>, Meridian runs the same operations as its own UI — add a subscription,
              change plan, cancel, record an invoice — with the same rules. If the UI would refuse a change, the API
              refuses it too, with the same explanation.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>JSON in and out, with <Inline>snake_case</Inline> fields. Send <Inline>Content-Type: application/json</Inline>; bodies are limited to 1 MB.</li>
              <li>
                Money is an <strong>integer in minor units</strong> of your workspace currency, with a{" "}
                <Inline>currency</Inline> field beside it: <Inline>4999</Inline> is $49.99, or ¥4,999.
              </li>
              <li>Dates are <Inline>YYYY-MM-DD</Inline> (UTC days); timestamps are ISO 8601.</li>
              <li>Your IDs (<Inline>external_id</Inline>) use letters, digits, <Inline>_</Inline>, <Inline>-</Inline> and <Inline>.</Inline>, up to 191 characters.</li>
              <li>Every response carries an <Inline>X-Request-Id</Inline>. Quote it if you contact support.</li>
            </ul>
          </Section>

          <Section id="authentication" eyebrow="Authentication" title="API keys">
            <p>
              An owner or admin creates keys in <strong>Settings → API keys</strong>. A key starts with{" "}
              <Inline>mrd_</Inline>, is shown once, and belongs to one workspace — every request acts on that
              workspace, and nothing in the request can choose another. Send it as a bearer token:
            </p>
            <Code>{`curl ${base}/customers \\\n  -H "Authorization: Bearer mrd_…"`}</Code>
            <p>
              A <strong>read</strong> key can call every <Inline>GET</Inline>; a <strong>read and write</strong> key
              can call everything. A missing, unknown, revoked or expired key gets <Inline>401</Inline>; a read key on
              a write endpoint gets <Inline>403</Inline>. Keep keys on your server — the API sends no CORS headers,
              so browsers can&apos;t call it directly.
            </p>
          </Section>

          <Section id="errors" eyebrow="Errors" title="One error shape">
            <p>
              Every failure has the same envelope. <Inline>param</Inline> names the field at fault;
              validation errors list <strong>every</strong> invalid field in <Inline>details</Inline>.
            </p>
            <div className="grid min-w-0 gap-3 xl:grid-cols-2">
              <Code title="400 invalid_request">{json(VALIDATION_ERROR)}</Code>
              <Code title="409 conflict">{json(CONFLICT_ERROR)}</Code>
            </div>
            <Fields
              title="Types"
              fields={[
                { name: "invalid_request", type: "400", description: "The body or a parameter is malformed. Fix it before retrying." },
                { name: "authentication", type: "401", description: "No valid API key." },
                { name: "permission", type: "403", description: "The key is read-only." },
                { name: "not_found", type: "404", description: "No record with that ID — or a record your request refers to (a customer, a plan) doesn't exist yet; `param` says which." },
                { name: "conflict", type: "409", description: "Meridian refused the change, with the reason its UI would give — e.g. changing a subscription that already ended." },
                { name: "rate_limited", type: "429", description: "Too many requests. Wait `Retry-After` seconds." },
                { name: "internal", type: "500", description: "Our fault. Safe to retry; quote the request id if it persists." },
              ]}
            />
          </Section>

          <Section id="rate-limits" eyebrow="Rate limits" title={`${RATE_LIMIT} requests a minute, per key`}>
            <p>
              Each response says where you stand: <Inline>X-RateLimit-Limit</Inline>,{" "}
              <Inline>X-RateLimit-Remaining</Inline>, and <Inline>X-RateLimit-Reset</Inline> (Unix seconds when the
              window restarts). Past the limit you get <Inline>429</Inline> with <Inline>Retry-After</Inline> in
              seconds. For a large backfill, use a CSV import instead — it handles thousands of rows at once.
            </p>
          </Section>

          <Section id="pagination" eyebrow="Pagination" title="Cursor pages">
            <p>
              List endpoints return up to <Inline>limit</Inline> records (default 25, at most 100) in a stable order.
              When <Inline>has_more</Inline> is true, pass <Inline>next_cursor</Inline> as{" "}
              <Inline>starting_after</Inline> to get the next page.
            </p>
            <Code>{`curl "${base}/customers?limit=100&starting_after=cm4cu7x2k0000" \\\n  ${auth}`}</Code>
          </Section>

          <Section id="syncing" eyebrow="Guide" title="Syncing from your billing system">
            <p>
              Wire these four moments in your billing code (or your Stripe / Paddle webhook handler) and Meridian stays
              current. Create your plans once first with <Inline>PUT /v1/plans/{"{id}"}</Inline>.
            </p>
            <ol className="flex flex-col gap-6">
              <li className="flex flex-col gap-3">
                <p>
                  <strong>1. Signup.</strong> Send the customer, then their subscription. Order matters: a
                  subscription refers to a customer and plan that must already exist (else <Inline>404</Inline> with
                  the <Inline>param</Inline>).
                </p>
                <Code>{`${put("/customers/cus_42", { name: "Acme Inc", email: "billing@acme.test" })}\n\n${put("/subscriptions/sub_1001", {
                  customer_external_id: "cus_42",
                  plan_external_id: "growth",
                  start_date: "2025-03-01",
                })}`}</Code>
              </li>
              <li className="flex flex-col gap-3">
                <p>
                  <strong>2. Upgrade, downgrade, seats.</strong> Send the subscription again with the new plan or
                  quantity. The change takes effect today, or on <Inline>effective_date</Inline> — which may be in the
                  past, to record a change late. Meridian keeps the old terms as history.
                </p>
                <Code>{put("/subscriptions/sub_1001", {
                  customer_external_id: "cus_42",
                  plan_external_id: "scale",
                  start_date: "2025-03-01",
                  effective_date: "2025-06-10",
                })}</Code>
              </li>
              <li className="flex flex-col gap-3">
                <p>
                  <strong>3. Cancellation.</strong> Send it with <Inline>end_date</Inline>. Today or earlier cancels it
                  as of that day; a later date schedules the cancellation. If the customer changes their mind before
                  then, send it again <em>without</em> <Inline>end_date</Inline> and the cancellation is undone.
                </p>
                <Code>{put("/subscriptions/sub_1001", {
                  customer_external_id: "cus_42",
                  plan_external_id: "scale",
                  start_date: "2025-03-01",
                  end_date: "2025-07-01",
                })}</Code>
              </li>
              <li className="flex flex-col gap-3">
                <p>
                  <strong>4. Payment.</strong> Send the invoice when it is issued and again when it is paid, voided or
                  written off. Only the status moves once it is recorded.
                </p>
                <Code>{put("/invoices/in_8841", {
                  customer_external_id: "cus_42",
                  subscription_external_id: "sub_1001",
                  amount: 29900,
                  status: "paid",
                  issued_at: "2025-06-10",
                  paid_at: "2025-06-10",
                })}</Code>
              </li>
            </ol>
            <p>
              Each subscription response lists what it did in <Inline>changes</Inline> —{" "}
              <Inline>created</Inline>, <Inline>plan_changed</Inline>, <Inline>quantity_changed</Inline>,{" "}
              <Inline>status_changed</Inline>, <Inline>canceled</Inline>, <Inline>cancel_scheduled</Inline>,{" "}
              <Inline>cancel_undone</Inline>, or <Inline>unchanged</Inline> — so your logs show exactly what Meridian
              recorded.
            </p>
          </Section>

          <Section id="customers" eyebrow="Endpoints" title="Customers">
            <Endpoint
              method="PUT"
              path="/customers/{external_id}"
              scope="write"
              summary={<>Creates the customer, or updates their name and email. Sending an archived customer brings them back. <Inline>201</Inline> when created, <Inline>200</Inline> otherwise.</>}
              body={[
                { name: "name", type: "string", required: true, description: "1–100 characters." },
                { name: "email", type: "string | null", description: "Omit to leave it as it is; null clears it." },
              ]}
              curl={put("/customers/cus_42", { name: "Acme Inc", email: "billing@acme.test" })}
              response={CUSTOMER}
            />
            <Endpoint
              method="GET"
              path="/customers"
              scope="read"
              summary="Customers in a stable order, with their current MRR and status."
              params={[
                ...PAGE_PARAMS,
                { name: "status", type: "string", description: <><Inline>active</Inline>, <Inline>churned</Inline>, or <Inline>all</Inline> (default). Archived customers are left out.</> },
              ]}
              curl={get("/customers?status=active")}
              response={listOf({ ...CUSTOMER, subscriptions: undefined })}
            />
            <Endpoint
              method="GET"
              path="/customers/{external_id}"
              scope="read"
              summary={<>One customer: <Inline>status</Inline> is <Inline>active</Inline>, <Inline>past_due</Inline>, <Inline>churned</Inline> or <Inline>none</Inline> (never paid), with current <Inline>mrr</Inline> and every subscription.</>}
              curl={get("/customers/cus_42")}
              response={CUSTOMER}
            />
            <Endpoint
              method="DELETE"
              path="/customers/{external_id}"
              scope="write"
              summary="Archives the customer and returns the record. Their history — and every metric — is kept; they just leave lists and pickers."
              curl={del("/customers/cus_42")}
              response={{ ...CUSTOMER, archived: true }}
            />
          </Section>

          <Section id="plans" eyebrow="Endpoints" title="Plans">
            <Endpoint
              method="PUT"
              path="/plans/{external_id}"
              scope="write"
              summary={<>Creates or updates a plan. A subscription copies its plan&apos;s price when it starts, so <strong>a new price applies to new subscriptions only</strong>.</>}
              body={[
                { name: "name", type: "string", required: true, description: "1–60 characters, unique in the workspace." },
                { name: "amount", type: "integer", required: true, description: "Price per seat per interval, in minor units." },
                { name: "interval", type: "string", required: true, description: <><Inline>month</Inline> or <Inline>year</Inline>.</> },
                { name: "interval_count", type: "integer", description: "Default 1. Quarterly is month × 3. Up to 36 months or 3 years." },
              ]}
              curl={put("/plans/growth", { name: "Growth", amount: 9900, interval: "month" })}
              response={PLAN}
            />
            <Endpoint
              method="GET"
              path="/plans"
              scope="read"
              summary="Every plan, archived ones included."
              params={PAGE_PARAMS}
              curl={get("/plans")}
              response={listOf(PLAN)}
            />
          </Section>

          <Section id="subscriptions" eyebrow="Endpoints" title="Subscriptions">
            <p>
              A subscription is kept as <strong>segments</strong>: each plan, price or quantity change ends one and
              starts the next, so history stays exact. Responses show the whole chain.
            </p>
            <Endpoint
              method="PUT"
              path="/subscriptions/{external_id}"
              scope="write"
              summary={
                <>
                  Send the subscription as it is now. A new ID creates it. For an existing one, Meridian compares and
                  applies only what differs: new plan, price or quantity → a change from <Inline>effective_date</Inline>;{" "}
                  <Inline>end_date</Inline> set → a cancellation (today or earlier) or a scheduled one (later);{" "}
                  <Inline>end_date</Inline> gone while one is scheduled → undone. Nothing different → <Inline>200</Inline>{" "}
                  with <Inline>{`"changes": ["unchanged"]`}</Inline> and no write.
                </>
              }
              body={[
                { name: "customer_external_id", type: "string", required: true, description: "The customer, created first. A subscription can't move between customers." },
                { name: "plan_external_id", type: "string", description: <>The plan. Or omit it and send <Inline>amount</Inline> + <Inline>interval</Inline> for a custom price.</> },
                { name: "amount", type: "integer", description: "With a plan: a price override (a discount). Without: the custom price per seat." },
                { name: "interval, interval_count", type: "string, integer", description: "Custom price only: month or year, and how many." },
                { name: "quantity", type: "integer", description: "Seats, 1–10,000. Default 1; omitted on an update, it stays as it is." },
                { name: "status", type: "string", description: <><Inline>active</Inline> (default), <Inline>trialing</Inline> or <Inline>past_due</Inline>. To cancel, send <Inline>end_date</Inline>.</> },
                { name: "start_date", type: "date", required: true, description: "When it started. Fixed once created." },
                { name: "end_date", type: "date | null", description: "When it ends or ended. Omit or null while it runs on." },
                { name: "effective_date", type: "date", description: "When a plan, price or quantity change takes effect. Default today; must be after the current terms began." },
              ]}
              curl={put("/subscriptions/sub_1001", {
                customer_external_id: "cus_42",
                plan_external_id: "scale",
                start_date: "2025-03-01",
                effective_date: "2025-06-10",
              })}
              response={SUBSCRIPTION_UPGRADED}
              responseTitle="Response — changes lists what happened"
            />
            <Endpoint
              method="GET"
              path="/subscriptions"
              scope="read"
              summary="Every subscription, including ones added in Meridian's UI (their external_id is null)."
              params={[...PAGE_PARAMS, { name: "customer_external_id", type: "string", description: "Only this customer's." }]}
              curl={get("/subscriptions?customer_external_id=cus_42")}
              response={listOf(SUBSCRIPTION)}
            />
            <Endpoint
              method="GET"
              path="/subscriptions/{external_id}"
              scope="read"
              summary="One subscription and its segments."
              curl={get("/subscriptions/sub_1001")}
              response={SUBSCRIPTION}
            />
            <Endpoint
              method="DELETE"
              path="/subscriptions/{external_id}"
              scope="write"
              summary={<>Deletes the subscription — every segment and its invoices — as if it never existed, like Delete in Meridian. For mistakes; to end a subscription, send <Inline>end_date</Inline>.</>}
              curl={del("/subscriptions/sub_1001")}
              response={{ object: "subscription", external_id: "sub_1001", deleted: true, segments: 2, invoices: 4 }}
            />
          </Section>

          <Section id="invoices" eyebrow="Endpoints" title="Invoices">
            <Endpoint
              method="PUT"
              path="/invoices/{external_id}"
              scope="write"
              summary={
                <>
                  Records the invoice, or moves its status. Once recorded, the amount, customer and dates are a
                  financial record and don&apos;t change. Status moves as in the UI: <Inline>draft</Inline> or{" "}
                  <Inline>open</Inline> → <Inline>paid</Inline> or <Inline>void</Inline>; <Inline>open</Inline> →{" "}
                  <Inline>uncollectible</Inline>; <Inline>uncollectible</Inline> → <Inline>paid</Inline>. Anything else
                  is a <Inline>409</Inline>.
                </>
              }
              body={[
                { name: "customer_external_id", type: "string", required: true, description: "The customer billed." },
                { name: "subscription_external_id", type: "string | null", description: "The subscription it bills; omit for a one-off charge." },
                { name: "amount", type: "integer", required: true, description: "Above zero, in minor units." },
                { name: "status", type: "string", required: true, description: <><Inline>draft</Inline>, <Inline>open</Inline>, <Inline>paid</Inline>, <Inline>void</Inline> or <Inline>uncollectible</Inline>.</> },
                { name: "issued_at", type: "date", required: true, description: "The issue day." },
                { name: "due_at", type: "date | null", description: "Not before issued_at." },
                { name: "paid_at", type: "date", description: "Required with status paid: today or earlier, not before issued_at." },
              ]}
              curl={put("/invoices/in_8841", {
                customer_external_id: "cus_42",
                subscription_external_id: "sub_1001",
                amount: 9900,
                status: "paid",
                issued_at: "2025-06-01",
                due_at: "2025-06-15",
                paid_at: "2025-06-02",
              })}
              response={INVOICE}
            />
            <Endpoint
              method="GET"
              path="/invoices"
              scope="read"
              summary="Invoices, newest records last."
              params={[
                ...PAGE_PARAMS,
                { name: "status", type: "string", description: "Only this status." },
                { name: "customer_external_id", type: "string", description: "Only this customer's." },
                { name: "issued_after, issued_before", type: "date", description: "Issue day strictly after / before." },
              ]}
              curl={get("/invoices?status=open&issued_after=2025-05-31")}
              response={listOf(INVOICE)}
            />
            <Endpoint
              method="GET"
              path="/invoices/{external_id}"
              scope="read"
              summary="One invoice."
              curl={get("/invoices/in_8841")}
              response={INVOICE}
            />
          </Section>

          <Section id="metrics" eyebrow="Endpoints" title="Metrics">
            <Endpoint
              method="GET"
              path="/metrics/summary"
              scope="read"
              summary={
                <>
                  The numbers the Overview shows. State (MRR, ARR, active customers, ARPA) is as of the day — for today,
                  as of now; flows and rates cover the 30 days up to it. Rates are fractions (<Inline>0.05</Inline> = 5%)
                  and <Inline>null</Inline> when there was no one to measure.
                </>
              }
              params={[{ name: "date", type: "date", description: "Default today (UTC)." }]}
              curl={get("/metrics/summary?date=2025-06-30")}
              response={SUMMARY}
            />
            <Endpoint
              method="GET"
              path="/metrics/mrr"
              scope="read"
              summary="The daily MRR series from Meridian's snapshots, one point per day."
              params={[
                { name: "from", type: "date", description: "Default 29 days before `to`." },
                { name: "to", type: "date", description: "Default today. At most 730 days in one request." },
              ]}
              curl={get("/metrics/mrr?from=2025-06-28&to=2025-06-30")}
              response={MRR_SERIES}
            />
          </Section>
        </main>
      </div>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-muted-foreground sm:px-6">
          <BrandMark />
          <span>
            OpenAPI 3.1: <a href="/api/v1/openapi.json" className="underline underline-offset-4 hover:text-foreground">/api/v1/openapi.json</a>
          </span>
        </div>
      </footer>
    </div>
  );
}

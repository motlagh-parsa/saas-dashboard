// The public landing page. A Server Component with no data of its own: it says
// what Meridian does, shows the one question it answers (the revenue bridge,
// with example figures that say they are an example), and sends people to sign
// up, sign in, or read the API docs.
//
// Signed-in visitors get "Open dashboard" instead of the sign-up pair.
import type { Metadata } from "next";
import Link from "next/link";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { isPublicDemo } from "@/lib/env";
import { DemoButton } from "@/components/auth/demo-button";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/dashboard/brand-mark";
import { MrrBridge } from "@/components/marketing/mrr-bridge";

export const metadata: Metadata = {
  title: "Meridian — SaaS revenue metrics you can reconcile",
  description:
    "MRR, churn, retention and the revenue bridge from your own billing data. Import a CSV, push from your backend over a REST API, or enter it by hand.",
};

const SOURCES: readonly { title: string; body: string; detail: string }[] = [
  {
    title: "Import a CSV",
    body: "Upload the export from Stripe, Paddle, Chargebee or a spreadsheet. Map the columns, preview every row, then import.",
    detail: "Re-importing the same file changes nothing, so you can sync by hand as often as you like.",
  },
  {
    title: "Push from your backend",
    body: "Send the current state of a customer, plan, subscription or invoice whenever it changes. Meridian works out what happened.",
    detail: "REST API with scoped keys, rate limits and an OpenAPI document.",
  },
  {
    title: "Enter it by hand",
    body: "Add customers, plans and subscriptions in the app — including history. Change plans, cancel, record invoices.",
    detail: "Every change recalculates the past days it touches, so the charts are right immediately.",
  },
];

const METRICS: readonly { term: string; definition: string }[] = [
  { term: "MRR and ARR", definition: "Every subscription normalized to a month, yearly and quarterly plans included." },
  { term: "Revenue bridge", definition: "New, expansion, contraction, churn and reactivation, adding up to the change in MRR." },
  { term: "Net and gross revenue retention", definition: "What last month's customers pay you now, with and without upgrades." },
  { term: "Customer and revenue churn", definition: "Two rates, labelled apart: how many customers left, and how much money left with them." },
  { term: "Cohorts and plan mix", definition: "Retention by signup month, and MRR by plan." },
  { term: "Reports", definition: "CSV exports of every view, on demand or emailed to you weekly, monthly or quarterly." },
];

const TEAM: readonly string[] = [
  "Workspaces in their own currency, with owners, admins and members",
  "Invites by email, and an audit log of who changed what",
  "Alerts when a large customer churns, MRR dips or an invoice goes overdue",
  "A weekly summary every Monday, in the app or in your inbox",
];

export default async function Home() {
  const session = await getServerSession(authOptions);
  const signedIn = Boolean(session?.user);

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Link href="/" aria-label="Meridian home" className="rounded-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
          <BrandMark />
        </Link>
        <nav aria-label="Account" className="flex items-center gap-2">
          {signedIn ? (
            <Button asChild className="h-10 bg-brand px-4 text-brand-foreground hover:bg-brand/90">
              <Link href="/dashboard">Open dashboard</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" className="h-10 px-3">
                <Link href="/sign-in">Sign in</Link>
              </Button>
              <Button asChild className="h-10 bg-brand px-4 text-brand-foreground hover:bg-brand/90">
                <Link href="/register">Create a workspace</Link>
              </Button>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="mx-auto w-full max-w-6xl px-4 pt-14 pb-16 sm:px-6 sm:pt-24 sm:pb-24">
          <h1 className="max-w-3xl font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
            Know why your MRR moved.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            Meridian turns your billing data into MRR, churn and retention that reconcile to the cent — and shows
            exactly which customers moved the number.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild className="h-11 bg-brand px-5 text-brand-foreground hover:bg-brand/90">
              <Link href={signedIn ? "/dashboard" : "/register"}>{signedIn ? "Open dashboard" : "Create a workspace"}</Link>
            </Button>
            {isPublicDemo && !signedIn ? <DemoButton className="h-11 px-5" /> : null}
            <Button asChild variant={isPublicDemo && !signedIn ? "ghost" : "outline"} className="h-11 px-5">
              <Link href="/docs/api">Read the API docs</Link>
            </Button>
          </div>

          <div className="mt-16 border-t border-border pt-10 sm:mt-20">
            <MrrBridge />
          </div>
        </section>

        <section aria-labelledby="sources" className="border-t border-border bg-muted/30">
          <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
            <h2 id="sources" className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
              Bring the data you already have
            </h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">
              Three ways in, all going through the same rules — so a subscription means the same thing however it
              arrived.
            </p>
            <div className="mt-10 grid gap-10 md:grid-cols-3 md:gap-8">
              {SOURCES.map((source) => (
                <div key={source.title} className="border-l-2 border-brand pl-5">
                  <h3 className="font-heading text-lg font-semibold">{source.title}</h3>
                  <p className="mt-2 leading-relaxed text-foreground/90">{source.body}</p>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{source.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="metrics" className="border-t border-border">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 id="metrics" className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
                The numbers a board asks for
              </h2>
              <p className="mt-3 text-muted-foreground">
                Defined once, in one place, and checked against hand-computed examples on every change to the code.
              </p>
            </div>
            <dl className="grid gap-x-10 gap-y-7 sm:grid-cols-2">
              {METRICS.map((metric) => (
                <div key={metric.term}>
                  <dt className="font-medium">{metric.term}</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{metric.definition}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section aria-labelledby="team" className="border-t border-border bg-sidebar text-sidebar-foreground dark">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-2">
            <div>
              <h2 id="team" className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
                Built for the whole team
              </h2>
              <p className="mt-3 max-w-md text-muted-foreground">
                Finance, founders and support look at the same numbers, with the access each of them needs.
              </p>
            </div>
            <ul className="grid gap-4">
              {TEAM.map((item) => (
                <li key={item} className="flex gap-3 leading-relaxed">
                  <span aria-hidden className="mt-2.5 size-1.5 shrink-0 rounded-full bg-brand" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="border-t border-border">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-6 px-4 py-14 sm:px-6">
            <p className="max-w-xl font-heading text-xl font-semibold tracking-tight sm:text-2xl">
              Start with sample data, or your own. Either takes a couple of minutes.
            </p>
            <Button asChild className="h-11 bg-brand px-5 text-brand-foreground hover:bg-brand/90">
              <Link href={signedIn ? "/dashboard" : "/register"}>{signedIn ? "Open dashboard" : "Create a workspace"}</Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:px-6">
          <BrandMark />
          <nav aria-label="Footer" className="flex gap-5">
            <Link href="/docs/api" className="hover:text-foreground">
              API docs
            </Link>
            <Link href="/sign-in" className="hover:text-foreground">
              Sign in
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

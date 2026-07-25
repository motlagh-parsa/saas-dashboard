// Presentational auth shell: a dark "terminal" brand panel paired with the form.
// The left panel is pinned to the dark palette regardless of theme so the product
// identity — and a preview of what you're signing into — reads on first contact.
import { ArrowUpRight } from "lucide-react";

import { BrandMark } from "@/components/dashboard/brand-mark";

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      {/* Brand panel — dark terminal, hidden on small screens. */}
      <aside className="dark relative hidden flex-col justify-between overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex">
        {/* Faint ledger grid, not a gradient. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.4]"
          style={{
            backgroundImage:
              "linear-gradient(to right, color-mix(in oklch, var(--foreground) 6%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklch, var(--foreground) 6%, transparent) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage:
              "radial-gradient(120% 100% at 0% 0%, black, transparent 70%)",
          }}
        />

        <div className="relative">
          <BrandMark />
        </div>

        <div className="relative flex flex-col gap-8">
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-balance">
            The numbers your whole team can trust.
          </h1>

          {/* Signature preview: a compact metric marquee. */}
          <div className="w-full max-w-sm rounded-xl bg-card p-4 ring-1 ring-foreground/10">
            <div className="flex items-center justify-between">
              <span className="text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                Net MRR
              </span>
              <span className="inline-flex items-center gap-0.5 rounded-full bg-positive/15 px-1.5 py-0.5 font-mono text-[0.6875rem] font-medium text-positive tabular-nums">
                <ArrowUpRight className="size-3" />
                12.4%
              </span>
            </div>
            <p className="mt-2 font-mono text-3xl font-semibold tracking-tight tabular-nums">
              $284,610
            </p>
            <svg
              viewBox="0 0 240 56"
              className="mt-4 h-14 w-full"
              fill="none"
              preserveAspectRatio="none"
              aria-hidden
            >
              <path
                d="M0 46 L30 42 L60 44 L90 33 L120 36 L150 24 L180 26 L210 14 L240 8"
                stroke="var(--brand)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M0 46 L30 42 L60 44 L90 33 L120 36 L150 24 L180 26 L210 14 L240 8 L240 56 L0 56 Z"
                fill="var(--brand)"
                fillOpacity="0.08"
              />
            </svg>
          </div>
        </div>

        <p className="relative text-xs text-muted-foreground">
          Trusted by operators at 2,400+ SaaS teams.
        </p>
      </aside>

      {/* Form column — uses the ambient theme. */}
      <div className="flex flex-col">
        <div className="flex items-center justify-between p-6 lg:hidden">
          <BrandMark />
        </div>
        <main className="flex flex-1 items-center justify-center px-6 pb-10 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
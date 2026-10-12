// Presentational auth shell: a dark "terminal" brand panel paired with the form.
// The left panel is pinned to the dark palette regardless of theme so the product
// identity — and a preview of what you're signing into — reads on first contact.
import { BrandMark } from "@/components/dashboard/brand-mark";
import { MrrBridge } from "@/components/marketing/mrr-bridge";

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
          <p className="font-heading text-3xl font-semibold tracking-tight text-balance">
            Know why your MRR moved.
          </p>

          {/* The question the product answers, as one line of arithmetic. */}
          <div className="w-full max-w-md rounded-xl bg-card p-5 ring-1 ring-foreground/10">
            <MrrBridge size="compact" />
          </div>
        </div>

        <p className="relative max-w-sm text-xs text-muted-foreground">
          MRR, churn and retention from your own billing data — imported from a CSV, pushed from your backend, or
          entered by hand.
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
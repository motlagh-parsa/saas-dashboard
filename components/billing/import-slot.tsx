// The way in to CSV import from places where a workspace has no data yet:
// onboarding's "Bring your data" cards, and the empty states of Customers,
// Plans, Invoices and the metric pages.
//
// Callers render it only for owners and admins — members cannot import, and a
// link to a page that sends them away would be a dead end. "Connect via API" will
// sit beside it once it exists; until then nothing is shown for it.
import Link from "next/link";
import { ArrowRight, FileUp } from "lucide-react";

import type { ImportKindKey } from "@/lib/import/kinds";

interface ImportSlotProps {
  /** "card" on onboarding, "link" under an empty state. */
  variant?: "card" | "link";
  /** Opens the wizard at this kind's upload step. */
  kind?: ImportKindKey;
}

export function ImportSlot({ variant = "link", kind }: ImportSlotProps) {
  const href = kind ? `/dashboard/import?kind=${kind}` : "/dashboard/import";

  if (variant === "card") {
    return (
      <Link
        href={href}
        className="group flex h-full flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 outline-none transition-colors hover:border-brand/60 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring sm:col-span-2"
      >
        <span className="grid size-10 place-items-center rounded-lg bg-brand/12 text-brand ring-1 ring-brand/20">
          <FileUp aria-hidden className="size-5" />
        </span>
        <span className="font-heading text-base font-semibold tracking-tight">Import a CSV</span>
        <span className="text-sm text-muted-foreground">
          Bring your history from a Stripe, Paddle or Chargebee export, or a spreadsheet — plans, customers,
          subscriptions and invoices. Templates included.
        </span>
        <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-foreground">
          Import a file
          <ArrowRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </Link>
    );
  }

  return (
    <p className="text-center text-sm text-muted-foreground">
      Have an export from Stripe, Paddle or a spreadsheet?{" "}
      <Link href={href} className="font-medium text-foreground underline-offset-4 hover:underline">
        Import a CSV
      </Link>
    </p>
  );
}

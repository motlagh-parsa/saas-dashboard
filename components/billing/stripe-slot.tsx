// "Connect Stripe" — onboarding's card for workspaces that bill with Stripe.
// Rendered only for owners and admins (onboarding redirects members away),
// since only they can connect an integration.
import Link from "next/link";
import { ArrowRight, RefreshCcw } from "lucide-react";

export function StripeSlot({ className }: { className?: string }) {
  return (
    <Link
      href="/dashboard/settings/integrations"
      className={`group flex h-full flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 outline-none transition-colors hover:border-brand/60 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring ${className ?? ""}`}
    >
      <span className="grid size-10 place-items-center rounded-lg bg-brand/12 text-brand ring-1 ring-brand/20">
        <RefreshCcw aria-hidden className="size-5" />
      </span>
      <span className="font-heading text-base font-semibold tracking-tight">Connect Stripe</span>
      <span className="text-sm text-muted-foreground">
        Paste a read-only restricted key. Meridian brings in your customers, prices, subscriptions and invoices, then
        keeps them in sync — nightly, or within seconds with a webhook.
      </span>
      <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-foreground">
        Connect Stripe
        <ArrowRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

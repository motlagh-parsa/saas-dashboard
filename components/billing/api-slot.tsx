// "Connect via API" — onboarding's card beside Import a CSV. Rendered only for
// owners and admins (onboarding redirects members away), since only they can
// create the key it points to.
import Link from "next/link";
import { ArrowRight, BookOpen, PlugZap } from "lucide-react";

import { API_DOCS_PATH } from "@/lib/api-key-form";

export function ApiSlot() {
  return (
    <div className="group flex h-full flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 transition-colors hover:border-brand/60">
      <span className="grid size-10 place-items-center rounded-lg bg-brand/12 text-brand ring-1 ring-brand/20">
        <PlugZap aria-hidden className="size-5" />
      </span>
      <span className="font-heading text-base font-semibold tracking-tight">Connect via API</span>
      <span className="text-sm text-muted-foreground">
        Create an API key, and have your backend push each customer, subscription and payment to Meridian as it
        happens — your metrics stay current without exports.
      </span>
      <span className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-medium">
        <Link
          href="/dashboard/settings/api-keys"
          className="inline-flex items-center gap-1 rounded-sm text-foreground outline-none underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Create an API key
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
        <Link
          href={API_DOCS_PATH}
          className="inline-flex items-center gap-1 rounded-sm text-muted-foreground outline-none underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BookOpen aria-hidden className="size-3.5" />
          Read the docs
        </Link>
      </span>
    </div>
  );
}

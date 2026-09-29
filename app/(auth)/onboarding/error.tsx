"use client";

// Error boundary for /onboarding. States what happened and offers the two ways
// forward: try again, or go to the dashboard (which sends someone without a
// workspace straight back here).
import { RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

interface OnboardingErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function OnboardingError({ error, reset }: OnboardingErrorProps) {
  return (
    <div className="flex w-full max-w-md flex-col items-start gap-5">
      <span className="grid size-12 place-items-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlert className="size-6" aria-hidden />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-xl font-semibold tracking-tight">Setup didn&apos;t load</h1>
        <p className="text-sm text-muted-foreground">
          Nothing you entered was lost. Try again — if it keeps happening, the database may be unreachable.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" onClick={reset} className="bg-brand text-brand-foreground hover:bg-brand/90">
          <RotateCcw aria-hidden />
          Try again
        </Button>
        <Button type="button" variant="outline" asChild>
          <a href="/dashboard">Go to dashboard</a>
        </Button>
      </div>
      {error.digest ? <p className="font-mono text-xs text-muted-foreground/70">Reference: {error.digest}</p> : null}
    </div>
  );
}

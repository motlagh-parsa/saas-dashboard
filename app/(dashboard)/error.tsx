"use client";

// Error boundary for the (dashboard) route group. Renders inside the shell as the
// page content. Copy states what happened and how to recover — no apology.
import { RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

type DashboardErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function DashboardError({ error, reset }: DashboardErrorProps) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-5 px-4 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlert className="size-6" />
      </span>

      <div className="flex flex-col gap-1.5">
        <h2 className="font-heading text-lg font-semibold tracking-tight">
          We couldn&apos;t load your metrics
        </h2>
        <p className="text-sm text-muted-foreground">
          The metrics service didn&apos;t respond. This is usually temporary —
          try again, and if it keeps happening, check the status page.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={reset}
          className="bg-brand text-brand-foreground hover:bg-brand/90"
        >
          <RotateCcw />
          Try again
        </Button>
        <Button type="button" variant="outline" asChild>
          <a href="/dashboard">Back to overview</a>
        </Button>
      </div>

      {error.digest ? (
        <p className="font-mono text-xs text-muted-foreground/70">
          Reference: {error.digest}
        </p>
      ) : null}
    </main>
  );
}
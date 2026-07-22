"use client";

// Error boundary for the (dashboard) route group. Minimal + functional;
// ui-designer will polish later.
import { Button } from "@/components/ui/button";

type DashboardErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function DashboardError({ error, reset }: DashboardErrorProps) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-start gap-4 p-8">
      <h2 className="text-xl font-semibold tracking-tight">
        Something went wrong
      </h2>
      <p className="text-sm text-muted-foreground">
        {error.message || "An unexpected error occurred loading the dashboard."}
      </p>
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
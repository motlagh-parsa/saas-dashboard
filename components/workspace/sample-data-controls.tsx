"use client";

// Load and remove sample data — the controls the banner, Settings and
// onboarding share. Both are Server Actions in lib/sample-data-actions.ts, which
// re-check the caller's role and refuse to mix sample data into real data.
import { useActionState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { IDLE_BILLING_FORM, type BillingFormState } from "@/lib/billing-form";
import { loadSampleData, removeSampleData } from "@/lib/sample-data-actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/dashboard/use-toast";
import { FormDialog } from "@/components/billing/form-dialog";

interface RemoveSampleDataDialogProps {
  organizationId: string;
  /** "link" in the banner, "button" in Settings. */
  variant?: "link" | "button";
}

export function RemoveSampleDataDialog({ organizationId, variant = "button" }: RemoveSampleDataDialogProps) {
  return (
    <FormDialog
      trigger={
        variant === "link" ? (
          <button
            type="button"
            className="font-medium text-foreground underline underline-offset-4 outline-none hover:text-brand focus-visible:ring-2 focus-visible:ring-ring"
          >
            Remove sample data
          </button>
        ) : (
          <Button type="button" variant="outline" className="h-11 px-4 sm:h-9">
            Remove sample data
          </Button>
        )
      }
      destructive
      title="Remove sample data?"
      description="Deletes every sample customer, plan, subscription and invoice in this workspace, and recalculates the metrics. Anything you entered yourself stays."
      action={removeSampleData}
      hidden={{ organizationId }}
      initial={{}}
      submitLabel="Remove sample data"
      pendingLabel="Removing…"
      successTitle="Sample data removed"
    />
  );
}

interface LoadSampleDataButtonProps {
  organizationId: string;
  /** Where to go once loaded: stay and refresh (Settings), or open the dashboard (onboarding). */
  then: "refresh" | "dashboard";
  /** The onboarding card is a large tile; Settings uses a normal button. */
  appearance?: "button" | "card";
  children?: ReactNode;
}

export function LoadSampleDataButton({
  organizationId,
  then,
  appearance = "button",
  children,
}: LoadSampleDataButtonProps) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    async (previous: BillingFormState, formData: FormData): Promise<BillingFormState> => {
      const result = await loadSampleData(previous, formData);
      if (result.status === "success") {
        toast.success("Sample data loaded", { description: result.message ?? undefined });
        if (then === "dashboard") router.push("/dashboard");
        else router.refresh();
      }
      return result;
    },
    IDLE_BILLING_FORM,
  );

  function guard(event: FormEvent<HTMLFormElement>): void {
    if (pending) event.preventDefault();
  }

  return (
    <form action={formAction} onSubmit={guard} className={appearance === "card" ? "contents" : "grid gap-2"}>
      <input type="hidden" name="organizationId" value={organizationId} />
      {appearance === "card" ? (
        <button
          type="submit"
          aria-disabled={pending ? "true" : undefined}
          aria-busy={pending}
          className="group flex h-full w-full flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 text-left outline-none transition-colors hover:border-brand/60 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid size-10 place-items-center rounded-lg bg-brand/12 text-brand ring-1 ring-brand/20">
            {pending ? <Loader2 aria-hidden className="size-5 animate-spin" /> : <Sparkles aria-hidden className="size-5" />}
          </span>
          {children}
          {pending ? <span className="text-xs text-muted-foreground">Generating 18 months of history…</span> : null}
        </button>
      ) : (
        <Button
          type="submit"
          variant="outline"
          aria-disabled={pending ? "true" : undefined}
          className="h-11 w-fit px-4 sm:h-9"
        >
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
          {pending ? "Loading sample data…" : "Load sample data"}
        </Button>
      )}
      {state.status === "error" && state.message ? (
        <p role="alert" className={cn("text-xs text-destructive", appearance === "card" && "mt-2")}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

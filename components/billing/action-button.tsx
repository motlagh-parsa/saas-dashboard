"use client";

// A one-click billing action — archive, unarchive, undo a scheduled
// cancellation. Reversible actions only; anything that destroys data or moves
// money goes through a FormDialog that asks first.
//
// A form, not an onClick fetch: it posts the hidden fields to the Server Action
// like every other write, and reports through a toast because the row it sits in
// re-renders under it.
import { useActionState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { IDLE_BILLING_FORM, type BillingAction, type BillingFormState } from "@/lib/billing-form";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/dashboard/use-toast";

interface ActionButtonProps {
  action: BillingAction;
  hidden: Readonly<Record<string, string>>;
  label: string;
  /** Accessible name when the visible label is not enough on its own. */
  ariaLabel?: string;
  icon?: ReactNode;
  successTitle: string;
  failureTitle: string;
  variant?: "outline" | "ghost";
  className?: string;
}

export function ActionButton({
  action,
  hidden,
  label,
  ariaLabel,
  icon,
  successTitle,
  failureTitle,
  variant = "outline",
  className,
}: ActionButtonProps) {
  const [, formAction, pending] = useActionState(
    async (previous: BillingFormState, formData: FormData): Promise<BillingFormState> => {
      const result = await action(previous, formData);
      if (result.status === "success") {
        toast.success(successTitle, { description: result.message ?? undefined });
      } else if (result.status === "error") {
        toast.error(failureTitle, {
          description: result.message ?? Object.values(result.fieldErrors)[0] ?? undefined,
        });
      }
      return result;
    },
    IDLE_BILLING_FORM,
  );

  function guard(event: FormEvent<HTMLFormElement>): void {
    if (pending) event.preventDefault();
  }

  return (
    <form action={formAction} onSubmit={guard}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button
        type="submit"
        variant={variant}
        aria-label={ariaLabel}
        aria-disabled={pending ? "true" : undefined}
        className={cn("h-11 px-3 sm:h-8", className)}
      >
        {pending ? <Loader2 aria-hidden className="animate-spin" /> : icon}
        {label}
      </Button>
    </form>
  );
}

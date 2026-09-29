"use client";

// The Settings currency field. Editable only while the workspace holds no
// billing data at all, and only for owners and admins; otherwise it is a fact
// with its reason beside it. The Server Action (`updateWorkspaceCurrency`)
// re-checks both, inside a transaction.
import { useActionState, useState } from "react";
import type { FormEvent } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { IDLE_BILLING_FORM } from "@/lib/billing-form";
import type { CurrencyOption } from "@/lib/currencies";
import { updateWorkspaceCurrency } from "@/lib/workspace-actions";
import { CURRENCY_LOCKED } from "@/lib/workspace-form";
import { Button } from "@/components/ui/button";
import { SELECT_CLASS } from "@/components/billing/form-dialog";

const FIELD_LABEL =
  "font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase";

interface WorkspaceCurrencyFormProps {
  organizationId: string;
  currency: string;
  currencies: readonly CurrencyOption[];
  /** No billing data of any source: the currency can still change. */
  editable: boolean;
  canEdit: boolean;
}

export function WorkspaceCurrencyForm({
  organizationId,
  currency,
  currencies,
  editable,
  canEdit,
}: WorkspaceCurrencyFormProps) {
  const [state, formAction, pending] = useActionState(updateWorkspaceCurrency, IDLE_BILLING_FORM);
  const [draft, setDraft] = useState<string>(currency);
  const label = currencies.find((option) => option.code === currency)?.label ?? currency;

  if (!editable || !canEdit) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className={FIELD_LABEL}>Reporting currency</span>
        <div className="flex h-11 items-center rounded-lg bg-muted px-2.5 sm:h-9">
          <span className="truncate text-sm text-foreground" data-testid="workspace-currency">
            {label}
          </span>
        </div>
        <p className="text-[0.6875rem] text-muted-foreground">
          {!editable ? CURRENCY_LOCKED : "Only owners and admins can change the currency."}
        </p>
      </div>
    );
  }

  function guard(event: FormEvent<HTMLFormElement>): void {
    if (pending || draft === currency) event.preventDefault();
  }

  const message =
    state.message ?? state.fieldErrors.currency ?? "Every amount is stored in this currency. You can change it until you add billing data.";

  return (
    <form action={formAction} onSubmit={guard} className="flex flex-col gap-1.5">
      <input type="hidden" name="organizationId" value={organizationId} />
      <label htmlFor="workspace-currency" className={FIELD_LABEL}>
        Reporting currency
      </label>
      <div className="flex gap-2">
        <select
          id="workspace-currency"
          name="currency"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-describedby="workspace-currency-status"
          className={cn(SELECT_CLASS, "sm:h-9")}
        >
          {currencies.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>
        <Button
          type="submit"
          variant="outline"
          aria-disabled={pending || draft === currency ? "true" : undefined}
          className={cn("h-11 shrink-0 px-3 sm:h-9", draft === currency && "opacity-50")}
        >
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Save
        </Button>
      </div>
      <p
        id="workspace-currency-status"
        aria-live="polite"
        className={cn(
          "text-[0.6875rem]",
          state.status === "error" ? "text-destructive" : state.status === "success" ? "text-positive" : "text-muted-foreground",
        )}
      >
        {message}
      </p>
    </form>
  );
}

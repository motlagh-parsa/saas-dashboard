"use client";

// Name + currency -> a new workspace. One form, two places: step 1 of
// /onboarding, and the "New workspace" dialog in the switcher.
//
// On success the Server Action (lib/workspace-actions.ts `createWorkspace`)
// selects the new workspace and redirects to /onboarding, which continues at
// "Bring your data" — so this form never has a success state of its own.
//
// Validation runs twice with one schema (lib/workspace-form.ts): here on submit
// for instant feedback, and in the action, the check that counts. Fields are
// CONTROLLED because React resets uncontrolled inputs after a form action,
// including a refused one.
import { useActionState, useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Loader2, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { IDLE_BILLING_FORM, fieldErrorsOf } from "@/lib/billing-form";
import { DEFAULT_CURRENCY, type CurrencyOption } from "@/lib/currencies";
import { createWorkspace } from "@/lib/workspace-actions";
import { WORKSPACE_NAME_MAX } from "@/lib/workspace-action-state";
import { createWorkspaceSchema } from "@/lib/workspace-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SELECT_CLASS } from "@/components/billing/form-dialog";

interface CreateWorkspaceFormProps {
  /** Built on the server (lib/currencies.ts), so both sides print the same labels. */
  currencies: readonly CurrencyOption[];
  /** Taller controls on the full-page onboarding form. */
  size?: "page" | "dialog";
  /** Rendered before the submit button — the dialog's Cancel. */
  secondary?: ReactNode;
}

export function CreateWorkspaceForm({ currencies, size = "dialog", secondary }: CreateWorkspaceFormProps) {
  const [state, formAction, pending] = useActionState(createWorkspace, IDLE_BILLING_FORM);
  const [name, setName] = useState<string>("");
  const [currency, setCurrency] = useState<string>(DEFAULT_CURRENCY);
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const id = useId();

  const errors: Record<string, string> = { ...state.fieldErrors, ...clientErrors };
  const control = size === "page" ? "h-11" : "h-11 sm:h-9";

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (pending) {
      event.preventDefault();
      return;
    }
    const result = createWorkspaceSchema().safeParse({ name, currency });
    if (result.success) {
      setClientErrors({});
      return;
    }
    event.preventDefault();
    setClientErrors(fieldErrorsOf(result.error));
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="grid gap-4">
      {state.status === "error" && state.message ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{state.message}</span>
        </p>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor={`${id}-name`}>Workspace name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setClientErrors((previous) => ({ ...previous, name: "" }));
          }}
          maxLength={WORKSPACE_NAME_MAX}
          autoComplete="organization"
          placeholder="Acme Analytics"
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? `${id}-name-error` : `${id}-name-hint`}
          className={control}
        />
        {errors.name ? (
          <p id={`${id}-name-error`} className="text-xs text-destructive">
            {errors.name}
          </p>
        ) : (
          <p id={`${id}-name-hint`} className="text-xs text-muted-foreground">
            Usually your company or product. You can rename it later.
          </p>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${id}-currency`}>Reporting currency</Label>
        <select
          id={`${id}-currency`}
          name="currency"
          value={currency}
          onChange={(event) => {
            setCurrency(event.target.value);
            setClientErrors((previous) => ({ ...previous, currency: "" }));
          }}
          aria-invalid={errors.currency ? true : undefined}
          aria-describedby={`${id}-currency-hint`}
          className={cn(SELECT_CLASS, size === "page" && "sm:h-11")}
        >
          {currencies.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>
        <p id={`${id}-currency-hint`} className={cn("text-xs", errors.currency ? "text-destructive" : "text-muted-foreground")}>
          {errors.currency || "Every amount in the workspace is in this currency. It is fixed once you add billing data."}
        </p>
      </div>

      <div className={cn("flex gap-2", size === "page" ? "flex-col" : "flex-col-reverse sm:flex-row sm:justify-end")}>
        {secondary}
        <Button
          type="submit"
          aria-disabled={pending ? "true" : undefined}
          className={cn(control, "bg-brand px-4 text-brand-foreground hover:bg-brand/90", size === "page" && "w-full")}
        >
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {pending ? "Creating workspace…" : "Create workspace"}
        </Button>
      </div>
    </form>
  );
}

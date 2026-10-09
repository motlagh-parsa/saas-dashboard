"use client";

// Client leaf of /forgot-password: one email field. After a successful submit
// the form gives way to the confirmation, which is worded the same whether or
// not the address has an account.
import * as React from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";

import { requestPasswordReset } from "@/app/(auth)/forgot-password/actions";
import { INITIAL_FORGOT_PASSWORD_STATE, forgotPasswordSchema } from "@/lib/forgot-password-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ForgotPasswordForm() {
  const [state, formAction, pending] = React.useActionState(requestPasswordReset, INITIAL_FORGOT_PASSWORD_STATE);
  const [email, setEmail] = React.useState("");
  const [clientError, setClientError] = React.useState<string | null>(null);

  if (state.status === "sent") {
    return (
      <p
        role="status"
        data-testid="reset-requested"
        className="flex items-start gap-2 rounded-md border border-positive/25 bg-positive/10 px-3 py-2.5 text-sm text-positive"
      >
        <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{state.message}</span>
      </p>
    );
  }

  const error = clientError ?? state.fieldError;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    if (pending) {
      event.preventDefault();
      return;
    }
    const result = forgotPasswordSchema.safeParse({ email });
    if (result.success) {
      setClientError(null);
      return;
    }
    event.preventDefault();
    setClientError(result.error.issues[0]?.message ?? "Enter a valid email address.");
    const control = event.currentTarget.elements.namedItem("email");
    if (control instanceof HTMLElement) control.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      {state.message ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{state.message}</span>
        </p>
      ) : null}

      <form action={formAction} onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              if (clientError) setClientError(null);
            }}
            disabled={pending}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "email-error" : undefined}
            className="h-11"
          />
          {error ? (
            <p id="email-error" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <Button
          type="submit"
          disabled={pending}
          className="mt-1 h-11 w-full bg-brand text-brand-foreground hover:bg-brand/90"
        >
          {pending ? "Sending…" : "Send reset link"}
        </Button>
      </form>
    </div>
  );
}

"use client";

// Client leaf of the invite page — same structure and styling as RegisterForm.
//
// Validation happens twice with one schema (lib/invite-schema.ts): here, on
// submit, so a mismatch is caught without a round trip; and again in
// `acceptInvite`, which is the check that counts. Fields are CONTROLLED because
// React resets uncontrolled inputs after every form action.
//
// Success never renders here: `acceptInvite` redirects to /sign-in?invited=1.
import * as React from "react";
import { TriangleAlert } from "lucide-react";

import { acceptInvite } from "@/app/(auth)/invite/[token]/actions";
import {
  ACCEPT_INVITE_FIELDS,
  INITIAL_ACCEPT_INVITE_STATE,
  acceptInviteFieldErrors,
  acceptInviteSchema,
  type AcceptInviteField,
  type AcceptInviteFieldErrors,
} from "@/lib/invite-schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AcceptInviteValues = Record<AcceptInviteField, string>;

const EMPTY_VALUES: AcceptInviteValues = { password: "", confirmPassword: "" };

const FIELDS: readonly { readonly field: AcceptInviteField; readonly label: string }[] = [
  { field: "password", label: "Password" },
  { field: "confirmPassword", label: "Confirm password" },
];

interface AcceptInviteFormProps {
  token: string;
  /** Offered to password managers as the username, so the new password is saved against it. */
  email: string;
}

export function AcceptInviteForm({ token, email }: AcceptInviteFormProps) {
  const [state, formAction, pending] = React.useActionState(
    acceptInvite,
    INITIAL_ACCEPT_INVITE_STATE,
  );
  const [values, setValues] = React.useState<AcceptInviteValues>(EMPTY_VALUES);
  const [clientErrors, setClientErrors] = React.useState<AcceptInviteFieldErrors>({});

  const errors: AcceptInviteFieldErrors = { ...clientErrors, ...state.fieldErrors };

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    if (pending) {
      event.preventDefault();
      return;
    }
    const result = acceptInviteSchema.safeParse(values);
    if (result.success) {
      setClientErrors({});
      return; // let the form action run
    }

    event.preventDefault();
    const nextErrors = acceptInviteFieldErrors(result.error);
    setClientErrors(nextErrors);

    const firstInvalid = ACCEPT_INVITE_FIELDS.find((field) => nextErrors[field]);
    if (firstInvalid) {
      const control = event.currentTarget.elements.namedItem(firstInvalid);
      if (control instanceof HTMLElement) control.focus();
    }
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
        <input type="hidden" name="token" value={token} />
        {/* Not shown and never submitted as a field the server reads: it tells a
            password manager which account this new password belongs to. */}
        <input
          type="email"
          name="username"
          autoComplete="username"
          value={email}
          readOnly
          hidden
        />

        {FIELDS.map(({ field, label }) => {
          const error = errors[field];
          const errorId = `${field}-error`;
          return (
            <div key={field} className="flex flex-col gap-2">
              <Label htmlFor={field}>{label}</Label>
              <Input
                id={field}
                name={field}
                type="password"
                autoComplete="new-password"
                required
                value={values[field]}
                onChange={(event) => {
                  const { value } = event.target;
                  setValues((previous) => ({ ...previous, [field]: value }));
                  if (clientErrors[field]) {
                    setClientErrors((previous) => ({ ...previous, [field]: undefined }));
                  }
                }}
                disabled={pending}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className="h-11"
              />
              {error ? (
                <p id={errorId} className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          );
        })}

        <Button
          type="submit"
          disabled={pending}
          className="mt-1 h-11 w-full bg-brand text-brand-foreground hover:bg-brand/90"
        >
          {pending ? "Setting password…" : "Set password"}
        </Button>
      </form>
    </div>
  );
}

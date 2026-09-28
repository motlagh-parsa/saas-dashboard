"use client";

// The Password card's form: current, new, and confirm. Same `display: contents`
// shape as the Profile form beside it.
//
// Validation runs twice with one schema (lib/profile-form.ts): here on submit for
// instant feedback, and again in `updatePassword`, which also checks the current
// password against the stored hash — the check only the server can make.
//
// Fields are CONTROLLED so a rejected attempt keeps what was typed, and they are
// cleared in the action's own completion path once the server says yes — a
// password must not sit in the DOM after it has done its job.
import { useActionState, useState } from "react";
import type { FormEvent } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { updatePassword } from "@/lib/profile-actions";
import {
  IDLE_PROFILE_FORM,
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordSchema,
  profileFieldErrors,
  type ProfileFieldErrors,
  type ProfileFormState,
} from "@/lib/profile-form";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const FIELD_LABEL =
  "font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase";

const CONTROL_HEIGHT = "h-11 sm:h-9";

const STATUS_ID = "password-status";

type PasswordField = "currentPassword" | "newPassword" | "confirmPassword";

interface PasswordDraft {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

const EMPTY_DRAFT: PasswordDraft = { currentPassword: "", newPassword: "", confirmPassword: "" };

/** Order in which fields appear, so the first invalid one can take focus. */
const FIELDS: readonly {
  readonly name: PasswordField;
  readonly label: string;
  readonly autoComplete: "current-password" | "new-password";
}[] = [
  { name: "currentPassword", label: "Current password", autoComplete: "current-password" },
  { name: "newPassword", label: "New password", autoComplete: "new-password" },
  { name: "confirmPassword", label: "Confirm new password", autoComplete: "new-password" },
];

export function PasswordForm() {
  const [draft, setDraft] = useState<PasswordDraft>(EMPTY_DRAFT);
  const [clientErrors, setClientErrors] = useState<ProfileFieldErrors>({});

  const [state, formAction, isPending] = useActionState(
    async (previous: ProfileFormState, formData: FormData): Promise<ProfileFormState> => {
      const result = await updatePassword(previous, formData);
      if (result.status === "success") setDraft(EMPTY_DRAFT);
      return result;
    },
    IDLE_PROFILE_FORM,
  );

  const errors: ProfileFieldErrors = { ...clientErrors, ...state.fieldErrors };
  const isError = state.status === "error" && state.message !== null;

  let statusText = `At least ${PASSWORD_MIN} characters. Other signed-in devices stay signed in.`;
  if (state.message !== null) statusText = state.message;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (isPending) {
      event.preventDefault();
      return;
    }
    const result = passwordSchema.safeParse(draft);
    if (result.success) {
      setClientErrors({});
      return; // let the form action run
    }

    event.preventDefault();
    const nextErrors = profileFieldErrors(result.error);
    setClientErrors(nextErrors);
    const firstInvalid = FIELDS.find((field) => nextErrors[field.name]);
    if (firstInvalid) {
      const control = event.currentTarget.elements.namedItem(firstInvalid.name);
      if (control instanceof HTMLElement) control.focus();
    }
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="contents">
      <CardContent className="grid gap-4 sm:grid-cols-3">
        {FIELDS.map((field) => {
          const error = errors[field.name];
          const errorId = `${field.name}-error`;
          return (
            <div key={field.name} className="flex flex-col gap-1.5">
              <Label htmlFor={field.name} className={FIELD_LABEL}>
                {field.label}
              </Label>
              <Input
                id={field.name}
                name={field.name}
                type="password"
                autoComplete={field.autoComplete}
                maxLength={PASSWORD_MAX}
                value={draft[field.name]}
                onChange={(event) => {
                  const { value } = event.target;
                  setDraft((previous) => ({ ...previous, [field.name]: value }));
                  if (clientErrors[field.name]) {
                    setClientErrors((previous) => ({ ...previous, [field.name]: undefined }));
                  }
                }}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className={CONTROL_HEIGHT}
              />
              {error ? (
                <p id={errorId} className="text-[0.6875rem] text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          );
        })}
      </CardContent>

      <CardContent className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <p
          id={STATUS_ID}
          aria-live="polite"
          className={cn(
            "text-[0.6875rem]",
            isError
              ? "text-destructive"
              : state.status === "success"
                ? "text-positive"
                : "text-muted-foreground",
          )}
        >
          {statusText}
        </p>
        <Button
          type="submit"
          aria-disabled={isPending ? "true" : undefined}
          aria-describedby={STATUS_ID}
          className={cn("px-4", CONTROL_HEIGHT)}
        >
          {isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {isPending ? "Changing…" : "Change password"}
        </Button>
      </CardContent>
    </form>
  );
}

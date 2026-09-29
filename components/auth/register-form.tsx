"use client";

// Client leaf of the register page — same structure and styling as SignInForm.
//
// Validation happens twice with one schema (lib/register-schema.ts): here, on
// submit, so a typo is caught without a round trip; and again in `registerUser`,
// which is the check that counts. Fields are CONTROLLED because React resets
// uncontrolled inputs after every form action — a server-side "Email already in
// use" would otherwise wipe everything the user typed.
//
// Once the account exists, the form signs in with the credentials just typed
// (NextAuth's client `signIn`, the sign-in form's own path) and continues to
// /onboarding. Should that sign-in fail, it falls back to the sign-in page with
// the "Account created" note rather than leaving the user on a stale form.
import * as React from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { TriangleAlert } from "lucide-react";

import { registerUser } from "@/app/(auth)/register/actions";
import {
  INITIAL_REGISTER_STATE,
  REGISTER_FIELDS,
  registerFieldErrors,
  registerSchema,
  type RegisterField,
  type RegisterFieldErrors,
  type RegisterState,
} from "@/lib/register-schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type RegisterValues = Record<RegisterField, string>;

const EMPTY_VALUES: RegisterValues = {
  name: "",
  email: "",
  password: "",
  confirmPassword: "",
};

interface FieldSpec {
  readonly field: RegisterField;
  readonly label: string;
  readonly type: "text" | "email" | "password";
  readonly autoComplete: string;
  readonly placeholder?: string;
}

const FIELDS: readonly FieldSpec[] = [
  { field: "name", label: "Full name", type: "text", autoComplete: "name", placeholder: "Ada Lovelace" },
  { field: "email", label: "Email", type: "email", autoComplete: "email", placeholder: "you@company.com" },
  { field: "password", label: "Password", type: "password", autoComplete: "new-password" },
  { field: "confirmPassword", label: "Confirm password", type: "password", autoComplete: "new-password" },
];

export function RegisterForm() {
  const router = useRouter();
  const [values, setValues] = React.useState<RegisterValues>(EMPTY_VALUES);
  const [state, formAction, pending] = React.useActionState(
    async (previous: RegisterState, formData: FormData): Promise<RegisterState> => {
      const result = await registerUser(previous, formData);
      if (result.registered) {
        const signedIn = await signIn("credentials", {
          email: values.email.trim().toLowerCase(),
          password: values.password,
          redirect: false,
        });
        if (signedIn && !signedIn.error) {
          router.push("/onboarding");
          router.refresh();
        } else {
          router.push("/sign-in?registered=1");
        }
      }
      return result;
    },
    INITIAL_REGISTER_STATE,
  );
  // Still true after the action returns, while the sign-in and the navigation run.
  const busy = pending || state.registered;
  const [clientErrors, setClientErrors] = React.useState<RegisterFieldErrors>({});

  // The server's verdict wins for any field it spoke about; a field the user has
  // edited since clears its own client-side error (see `onChange` below).
  const errors: RegisterFieldErrors = { ...clientErrors, ...state.fieldErrors };

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    if (busy) {
      event.preventDefault();
      return;
    }
    const result = registerSchema.safeParse(values);
    if (result.success) {
      setClientErrors({});
      return; // let the form action run
    }

    event.preventDefault();
    const nextErrors = registerFieldErrors(result.error);
    setClientErrors(nextErrors);

    const firstInvalid = REGISTER_FIELDS.find((field) => nextErrors[field]);
    if (firstInvalid) {
      const control = event.currentTarget.elements.namedItem(firstInvalid);
      if (control instanceof HTMLElement) control.focus();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {state.error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{state.error}</span>
        </p>
      ) : null}

      <form
        action={formAction}
        onSubmit={handleSubmit}
        noValidate
        className="flex flex-col gap-4"
      >
        {FIELDS.map(({ field, label, type, autoComplete, placeholder }) => {
          const error = errors[field];
          const errorId = `${field}-error`;
          return (
            <div key={field} className="flex flex-col gap-2">
              <Label htmlFor={field}>{label}</Label>
              <Input
                id={field}
                name={field}
                type={type}
                autoComplete={autoComplete}
                placeholder={placeholder}
                required
                value={values[field]}
                onChange={(event) => {
                  const { value } = event.target;
                  setValues((previous) => ({ ...previous, [field]: value }));
                  if (clientErrors[field]) {
                    setClientErrors((previous) => ({ ...previous, [field]: undefined }));
                  }
                }}
                disabled={busy}
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
          disabled={busy}
          className="mt-1 h-11 w-full bg-brand text-brand-foreground hover:bg-brand/90"
        >
          {state.registered ? "Signing you in…" : pending ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </div>
  );
}

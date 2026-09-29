// The registration form's rules and result shape — shared by the client form
// (instant feedback) and the `registerUser` Server Action (the real check), so
// the two can never disagree about what is valid.
//
// A plain module on purpose: a `"use server"` module cannot export a schema, a
// type or a constant (see the note in lib/notifications.ts), and the client
// bundle must be able to import this without pulling in anything server-side.
import { z } from "zod";

/** Workspace names are capped at 50 in lib/workspace-action-state.ts; so are these. */
export const NAME_MAX = 50;
export const PASSWORD_MIN = 8;
/** An upper bound so a megabyte "password" cannot be used to burn server CPU. */
export const PASSWORD_MAX = 128;

export const registerSchema = z
  .object({
    name: z
      .string({ error: "Enter your full name." })
      .trim()
      .min(2, { error: "Use at least 2 characters." })
      .max(NAME_MAX, { error: `Use at most ${NAME_MAX} characters.` }),
    // Trimmed and lowercased BEFORE the format check, so "Ada@Example.com " is
    // stored — and later looked up at sign-in — as "ada@example.com".
    email: z
      .string({ error: "Enter a valid email address." })
      .trim()
      .toLowerCase()
      .pipe(z.email({ error: "Enter a valid email address." })),
    password: z
      .string({ error: `Use at least ${PASSWORD_MIN} characters.` })
      .min(PASSWORD_MIN, { error: `Use at least ${PASSWORD_MIN} characters.` })
      .max(PASSWORD_MAX, { error: `Use at most ${PASSWORD_MAX} characters.` }),
    confirmPassword: z.string({ error: "Confirm your password." }),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ["confirmPassword"],
    error: "Passwords don't match.",
  });

export type RegisterField = "name" | "email" | "password" | "confirmPassword";

/** Field order, so the first invalid field can take focus. */
export const REGISTER_FIELDS: readonly RegisterField[] = [
  "name",
  "email",
  "password",
  "confirmPassword",
];

export type RegisterFieldErrors = Partial<Record<RegisterField, string>>;

export interface RegisterState {
  /** A form-level message (e.g. "Email already in use"), or null. */
  readonly error: string | null;
  readonly fieldErrors: RegisterFieldErrors;
  /** The account exists: the form signs the user in and continues to /onboarding. */
  readonly registered: boolean;
}

export const INITIAL_REGISTER_STATE: RegisterState = { error: null, fieldErrors: {}, registered: false };

/** The first message for each field, from a failed parse of `registerSchema`. */
export function registerFieldErrors(
  error: z.ZodError<z.input<typeof registerSchema>>,
): RegisterFieldErrors {
  const { fieldErrors } = z.flattenError(error);
  return {
    name: fieldErrors.name?.[0],
    email: fieldErrors.email?.[0],
    password: fieldErrors.password?.[0],
    confirmPassword: fieldErrors.confirmPassword?.[0],
  };
}

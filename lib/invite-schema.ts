// The accept-invite form's rules and result shape — shared by the client form
// (instant feedback) and the `acceptInvite` Server Action (the real check), the
// same split as lib/register-schema.ts.
//
// A plain module on purpose: a `"use server"` module cannot export a schema, a
// type or a constant, and the client bundle imports this directly.
import { z } from "zod";

import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/register-schema";

export { PASSWORD_MIN };

// Registration's limits, so an invited account's password is one the sign-up
// form would also have accepted.
export const acceptInviteSchema = z
  .object({
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

export type AcceptInviteField = "password" | "confirmPassword";

/** Field order, so the first invalid field can take focus. */
export const ACCEPT_INVITE_FIELDS: readonly AcceptInviteField[] = ["password", "confirmPassword"];

export type AcceptInviteFieldErrors = Partial<Record<AcceptInviteField, string>>;

export interface AcceptInviteState {
  readonly status: "idle" | "error";
  /** A form-level message (e.g. the link expired mid-form), or null. */
  readonly message: string | null;
  readonly fieldErrors: AcceptInviteFieldErrors;
}

export const INITIAL_ACCEPT_INVITE_STATE: AcceptInviteState = {
  status: "idle",
  message: null,
  fieldErrors: {},
};

/** The first message for each field, from a failed parse of `acceptInviteSchema`. */
export function acceptInviteFieldErrors(
  error: z.ZodError<z.input<typeof acceptInviteSchema>>,
): AcceptInviteFieldErrors {
  const { fieldErrors } = z.flattenError(error);
  return {
    password: fieldErrors.password?.[0],
    confirmPassword: fieldErrors.confirmPassword?.[0],
  };
}

// The Profile page's form rules and result shape — shared by the client forms
// (instant feedback) and lib/profile-actions.ts (the check that counts), so the
// two can never disagree.
//
// A plain module: a `"use server"` module cannot export a schema, a type or a
// constant (see lib/notifications.ts), and the client imports this directly.
import { z } from "zod";

import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/register-schema";
import { USER_NAME_MAX, USER_NAME_MIN } from "@/lib/user-form";

export { PASSWORD_MAX, PASSWORD_MIN, USER_NAME_MAX };

export const profileSchema = z.object({
  name: z
    .string({ error: "Enter your full name." })
    .trim()
    .min(USER_NAME_MIN, { error: `Use at least ${USER_NAME_MIN} characters.` })
    .max(USER_NAME_MAX, { error: `Use at most ${USER_NAME_MAX} characters.` }),
});

// Same limits as registration (lib/register-schema.ts): a password set here must
// be one the sign-in form would also have accepted at sign-up.
export const passwordSchema = z
  .object({
    currentPassword: z
      .string({ error: "Enter your current password." })
      .min(1, { error: "Enter your current password." })
      .max(PASSWORD_MAX, { error: "That's not your current password." }),
    newPassword: z
      .string({ error: `Use at least ${PASSWORD_MIN} characters.` })
      .min(PASSWORD_MIN, { error: `Use at least ${PASSWORD_MIN} characters.` })
      .max(PASSWORD_MAX, { error: `Use at most ${PASSWORD_MAX} characters.` }),
    confirmPassword: z.string({ error: "Confirm your new password." }),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    path: ["confirmPassword"],
    error: "Passwords don't match.",
  })
  .refine((values) => values.newPassword !== values.currentPassword, {
    path: ["newPassword"],
    error: "Choose a password different from your current one.",
  });

export type ProfileField = "name" | "currentPassword" | "newPassword" | "confirmPassword";

export type ProfileFieldErrors = Partial<Record<ProfileField, string>>;

export interface ProfileFormState {
  readonly status: "idle" | "success" | "error";
  /** A form-level message — the outcome line under the form — or null. */
  readonly message: string | null;
  readonly fieldErrors: ProfileFieldErrors;
}

export const IDLE_PROFILE_FORM: ProfileFormState = {
  status: "idle",
  message: null,
  fieldErrors: {},
};

/** The first message for each field, from a failed parse of either schema. */
export function profileFieldErrors(
  error: z.ZodError<{
    name?: unknown;
    currentPassword?: unknown;
    newPassword?: unknown;
    confirmPassword?: unknown;
  }>,
): ProfileFieldErrors {
  const { fieldErrors } = z.flattenError(error);
  return {
    name: fieldErrors.name?.[0],
    currentPassword: fieldErrors.currentPassword?.[0],
    newPassword: fieldErrors.newPassword?.[0],
    confirmPassword: fieldErrors.confirmPassword?.[0],
  };
}

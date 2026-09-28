// The "Add user" and "Edit user" forms' rules and result shape — shared by the
// client dialogs (instant feedback) and the `createUser` / `updateUser` Server
// Actions (the check that counts), so the two can never disagree.
//
// A plain module: a `"use server"` module cannot export a schema, a type or a
// constant (see lib/notifications.ts), and the client imports this directly.
import type { Role } from "@prisma/client";
import { z } from "zod";

export const USER_NAME_MIN = 2;
export const USER_NAME_MAX = 100;

const nameSchema = z
  .string({ error: "Enter their full name." })
  .trim()
  .min(USER_NAME_MIN, { error: `Use at least ${USER_NAME_MIN} characters.` })
  .max(USER_NAME_MAX, { error: `Use at most ${USER_NAME_MAX} characters.` });

export const createUserSchema = z.object({
  name: nameSchema,
  // Trimmed and lowercased BEFORE the format check — the same rule as
  // lib/register-schema.ts, because sign-in looks emails up lowercased.
  email: z
    .string({ error: "Enter a valid email address." })
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: "Enter a valid email address." })),
  role: z.enum(["OWNER", "ADMIN", "MEMBER"] as const satisfies readonly Role[], {
    error: "Choose a role.",
  }),
});

export const updateUserSchema = z.object({ name: nameSchema });

export type UserFormField = "name" | "email" | "role";

export type UserFormFieldErrors = Partial<Record<UserFormField, string>>;

export interface UserFormState {
  readonly status: "idle" | "success" | "error";
  /** A form-level message (authorization, stale page), or null. */
  readonly message: string | null;
  readonly fieldErrors: UserFormFieldErrors;
}

export const IDLE_USER_FORM: UserFormState = { status: "idle", message: null, fieldErrors: {} };

/** Shown on the email field, from the pre-check and from the unique index alike. */
export const EMAIL_TAKEN = "Email already in use";

/** The first message for each field, from a failed parse of either schema. */
export function userFormFieldErrors(
  error: z.ZodError<{ name?: unknown; email?: unknown; role?: unknown }>,
): UserFormFieldErrors {
  const { fieldErrors } = z.flattenError(error);
  return {
    name: fieldErrors.name?.[0],
    email: fieldErrors.email?.[0],
    role: fieldErrors.role?.[0],
  };
}

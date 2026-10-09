// The "forgot password" form's rules and result shape, shared by the client
// form and the `requestPasswordReset` Server Action — the same split as
// lib/register-schema.ts.
import { z } from "zod";

export const forgotPasswordSchema = z.object({
  email: z
    .string({ error: "Enter your email address." })
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: "Enter a valid email address." })),
});

export interface ForgotPasswordState {
  readonly status: "idle" | "sent" | "error";
  readonly message: string | null;
  readonly fieldError: string | null;
}

export const INITIAL_FORGOT_PASSWORD_STATE: ForgotPasswordState = {
  status: "idle",
  message: null,
  fieldError: null,
};

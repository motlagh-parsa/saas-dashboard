"use server";

// "Forgot password": one public Server Action.
//
// The answer is the SAME whether or not an account exists for the address, and
// the lookup and the send both happen after the response (`after()`), so
// neither the wording nor the response time tells anyone which addresses have
// accounts. lib/account-email.ts decides who actually gets an email.
import { after } from "next/server";

import { sendPasswordResetEmail } from "@/lib/account-email";
import { isMailEnabled } from "@/lib/env";
import { forgotPasswordSchema, type ForgotPasswordState } from "@/lib/forgot-password-form";

export async function requestPasswordReset(
  _previous: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  if (!isMailEnabled) {
    return {
      status: "error",
      message: "Password reset by email isn't available on this deployment. Ask a workspace owner for help.",
      fieldError: null,
    };
  }

  const parsed = forgotPasswordSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { status: "error", message: null, fieldError: parsed.error.issues[0]?.message ?? "Enter a valid email address." };
  }

  const { email } = parsed.data;
  after(async () => {
    await sendPasswordResetEmail(email);
  });

  return {
    status: "sent",
    message: `If an account exists for ${email}, we've sent a link to reset its password. It works for 60 minutes.`,
    fieldError: null,
  };
}

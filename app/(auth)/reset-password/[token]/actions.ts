"use server";

// Setting a new password through a reset link: one public Server Action. The
// token in the form IS the authorization — whoever holds a live one may set
// that account's password once, which is what a reset link means.
//
// lib/email-tokens.ts consumes the token and sets the password in one
// transaction, and revokes every existing session of the account, so a reset
// also signs out whoever knew the old password.
import { after } from "next/server";
import { redirect } from "next/navigation";

import { sendPasswordChangedEmail } from "@/lib/account-email";
import { consumeResetToken, lookupEmailToken } from "@/lib/email-tokens";
import { acceptInviteFieldErrors, acceptInviteSchema, type AcceptInviteState } from "@/lib/invite-schema";
import { hashPassword } from "@/lib/password";

const INVALID_LINK = "This reset link is invalid or has expired. Request a new one.";

export async function resetPassword(_previous: AcceptInviteState, formData: FormData): Promise<AcceptInviteState> {
  const token = formData.get("token");
  if (typeof token !== "string") return { status: "error", message: INVALID_LINK, fieldErrors: {} };

  const parsed = acceptInviteSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { status: "error", message: null, fieldErrors: acceptInviteFieldErrors(parsed.error) };
  }

  // Checked BEFORE hashing: scrypt costs ~128 MiB and real time, and a dead link
  // should not be able to spend either.
  if ((await lookupEmailToken(token, "RESET_PASSWORD")) === null) {
    return { status: "error", message: INVALID_LINK, fieldErrors: {} };
  }

  const owner = await consumeResetToken(token, await hashPassword(parsed.data.password));
  if (owner === null) return { status: "error", message: INVALID_LINK, fieldErrors: {} };

  after(async () => {
    await sendPasswordChangedEmail(owner);
  });

  // Outside any try: `redirect` throws by design.
  redirect("/sign-in?reset=1");
}

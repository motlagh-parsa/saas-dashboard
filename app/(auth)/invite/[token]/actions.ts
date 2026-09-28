"use server";

// Accepting an invite: one Server Action, called from the set-password form.
//
// `"use server"` makes every export a public endpoint, so this file exports ONLY
// the action, and everything in the FormData is untrusted — the token included.
// The token IS the authorization here: whoever holds a live one may set that
// account's password once, which is exactly what an invite link means.
//
// The password is set and the token consumed in ONE conditional write
// (`consumeInvite`), so a link cannot be used twice, even by two tabs at once.
// Then it redirects to /sign-in: accepting does not sign anyone in, the same as
// registering.
import { redirect } from "next/navigation";

import {
  acceptInviteFieldErrors,
  acceptInviteSchema,
  type AcceptInviteState,
} from "@/lib/invite-schema";
import { consumeInvite, lookupInvite } from "@/lib/invite-token";
import { hashPassword } from "@/lib/password";

const INVALID_LINK = "This invite link is invalid or has expired.";

export async function acceptInvite(
  _previous: AcceptInviteState,
  formData: FormData,
): Promise<AcceptInviteState> {
  const token = formData.get("token");
  if (typeof token !== "string") {
    return { status: "error", message: INVALID_LINK, fieldErrors: {} };
  }

  const parsed = acceptInviteSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { status: "error", message: null, fieldErrors: acceptInviteFieldErrors(parsed.error) };
  }

  // Checked BEFORE hashing: scrypt costs ~128 MiB and real time, and a dead
  // link should not be able to spend either.
  const invite = await lookupInvite(token);
  if (invite.kind !== "pending") {
    return { status: "error", message: INVALID_LINK, fieldErrors: {} };
  }

  const passwordHash = await hashPassword(parsed.data.password);
  if (!(await consumeInvite(token, passwordHash))) {
    // Used or expired between the lookup and the write.
    return { status: "error", message: INVALID_LINK, fieldErrors: {} };
  }

  // Outside any try: `redirect` throws by design.
  redirect("/sign-in?invited=1");
}

"use server";

// The signed-in user's own account: name and password.
//
// File-level `"use server"`: the forms that call these are client islands, so
// every export is a public endpoint and everything in the FormData is untrusted.
// It exports ONLY the actions; the schemas and result shape live in
// lib/profile-form.ts.
//
// Whose account: always the SESSION's user. No id is read from the form, so
// there is nothing to forge — the one thing these actions can reach is the
// caller themselves.
import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { sendPasswordChangedEmail } from "@/lib/account-email";
import { requireSession } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import {
  passwordSchema,
  profileFieldErrors,
  profileSchema,
  type ProfileFormState,
} from "@/lib/profile-form";

const NO_PASSWORD = "Password login is not available for this account.";

/**
 * Renames the caller. Layout-scoped revalidation, because the name also shows in
 * the header's account menu, not only on this page.
 */
export async function updateProfile(
  _previous: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const session = await requireSession();

  const parsed = profileSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { status: "error", message: null, fieldErrors: profileFieldErrors(parsed.error) };
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: { name: parsed.data.name },
    select: { id: true },
  });

  revalidatePath("/dashboard", "layout");
  return { status: "success", message: "Profile saved.", fieldErrors: {} };
}

/**
 * Changes the caller's password after re-proving the current one — a session
 * alone is not enough, or an unattended signed-in browser could take the account.
 *
 * Accounts with no hash (the env-configured demo account, GitHub-only users,
 * accounts an admin added) have no password to change and are refused.
 *
 * Other signed-in sessions are NOT ended: sessions are JWTs with nothing
 * server-side to revoke (see lib/auth.ts).
 */
export async function updatePassword(
  _previous: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const session = await requireSession();

  const parsed = passwordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { status: "error", message: null, fieldErrors: profileFieldErrors(parsed.error) };
  }
  const { currentPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { passwordHash: true },
  });
  if (user === null || user.passwordHash === null) {
    return { status: "error", message: NO_PASSWORD, fieldErrors: {} };
  }

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return {
      status: "error",
      message: null,
      fieldErrors: { currentPassword: "That's not your current password." },
    };
  }

  // Conditional on the hash just verified: if the password changed in another
  // tab in the meantime, this matches nothing rather than overwriting it.
  const { count } = await prisma.user.updateMany({
    where: { id: session.user.id, passwordHash: user.passwordHash },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  if (count === 0) {
    return {
      status: "error",
      message: "Your password was changed somewhere else just now. Reload and try again.",
      fieldErrors: {},
    };
  }

  // A heads-up to the inbox, with a reset link in case it wasn't them.
  after(async () => {
    const account = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, name: true, email: true },
    });
    if (account !== null) await sendPasswordChangedEmail(account);
  });

  return { status: "success", message: "Password changed.", fieldErrors: {} };
}

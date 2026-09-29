"use server";

// Self-service registration: one Server Action, called from the register form.
//
// `"use server"` makes every export a public endpoint, so this file exports ONLY
// the action, and everything in the FormData is untrusted — it is re-validated
// here with the same schema the client used (lib/register-schema.ts).
//
// A successful call creates the User only, with an scrypt hash of the password
// (lib/password.ts). No workspace: the new user names their own, in their own
// currency, at /onboarding. The form then signs them in with the same
// credentials (NextAuth's client `signIn`) and continues there — no second
// "please sign in" step.
import { Prisma } from "@prisma/client";

import { hashPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import {
  registerFieldErrors,
  registerSchema,
  type RegisterState,
} from "@/lib/register-schema";

const EMAIL_TAKEN = "Email already in use";

function failure(error: string | null, fieldErrors: RegisterState["fieldErrors"] = {}): RegisterState {
  return { error, fieldErrors, registered: false };
}

export async function registerUser(
  _previous: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return failure(null, registerFieldErrors(parsed.error));
  }
  const { name, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing !== null) {
    return failure(EMAIL_TAKEN);
  }

  const passwordHash = await hashPassword(password);

  try {
    await prisma.user.create({
      data: { name, email, passwordHash },
      select: { id: true },
    });
  } catch (error: unknown) {
    // The unique index is the real guard: two sign-ups racing with one email pass
    // the check above together, and exactly one of them lands here.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const taken = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      return failure(taken !== null ? EMAIL_TAKEN : "Couldn't create your account. Try again.");
    }
    throw error;
  }

  return { error: null, fieldErrors: {}, registered: true };
}

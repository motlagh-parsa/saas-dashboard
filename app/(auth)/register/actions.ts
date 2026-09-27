"use server";

// Self-service registration: one Server Action, called from the register form.
//
// `"use server"` makes every export a public endpoint, so this file exports ONLY
// the action, and everything in the FormData is untrusted — it is re-validated
// here with the same schema the client used (lib/register-schema.ts).
//
// What a successful call creates, in ONE nested write (a single transaction):
//   - the User, with an scrypt hash of the password (lib/password.ts);
//   - a personal Organization, "<name>'s workspace", with a generated slug;
//   - the OWNER Membership joining the two.
// A failure part-way leaves nothing behind — never an account with no workspace.
// Then it redirects to /sign-in: registering does not sign anyone in.
import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";

import { hashPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import {
  NAME_MAX,
  registerFieldErrors,
  registerSchema,
  type RegisterState,
} from "@/lib/register-schema";

const EMAIL_TAKEN = "Email already in use";

/** `<name>'s workspace`, falling back to the bare name past the 50-char workspace limit. */
function workspaceNameFor(name: string): string {
  const possessive = `${name}'s workspace`;
  return possessive.length <= NAME_MAX ? possessive : name;
}

/**
 * URL-safe and unique in practice: a slugified name plus 6 random hex chars
 * (16.7M values per name). The column is `@unique`, so a collision would fail the
 * write rather than share a workspace.
 */
function workspaceSlugFor(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "workspace"}-${randomBytes(3).toString("hex")}`;
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
    return { error: null, fieldErrors: registerFieldErrors(parsed.error) };
  }
  const { name, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing !== null) {
    return { error: EMAIL_TAKEN, fieldErrors: {} };
  }

  const passwordHash = await hashPassword(password);

  try {
    await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        memberships: {
          create: {
            role: "OWNER",
            organization: {
              create: { name: workspaceNameFor(name), slug: workspaceSlugFor(name) },
            },
          },
        },
      },
      select: { id: true },
    });
  } catch (error: unknown) {
    // The unique index is the real guard: two sign-ups racing with one email pass
    // the check above together, and exactly one of them lands here.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const taken = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      return {
        error: taken !== null ? EMAIL_TAKEN : "Couldn't create your account. Try again.",
        fieldErrors: {},
      };
    }
    throw error;
  }

  // Outside the try: `redirect` throws by design.
  redirect("/sign-in?registered=1");
}

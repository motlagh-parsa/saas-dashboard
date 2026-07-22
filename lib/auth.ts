import "server-only";

// NextAuth (v4) configuration + the server-side session gate.
//
// Session strategy is JWT — this is REQUIRED, not a preference: NextAuth v4 only
// allows the Credentials provider when sessions are JWTs. The Prisma adapter is
// still used to persist OAuth users/accounts (GitHub) via the shared singleton.
import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import { redirect } from "next/navigation";
import { PrismaAdapter } from "@auth/prisma-adapter";
import GitHubProvider from "next-auth/providers/github";
import CredentialsProvider from "next-auth/providers/credentials";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { env, isGithubEnabled } from "@/lib/env";

// Shape of the demo login form. Validated inside `authorize` so we never trust
// the raw client payload.
const credentialsSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

// Build the provider list. GitHub is only registered when configured, so the app
// boots (and the reviewer can use the demo account) without OAuth secrets.
const providers: NextAuthOptions["providers"] = [];

if (isGithubEnabled) {
  providers.push(
    GitHubProvider({
      clientId: env.GITHUB_ID as string,
      clientSecret: env.GITHUB_SECRET as string,
    }),
  );
}

providers.push(
  CredentialsProvider({
    id: "credentials",
    name: "Demo account",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(rawCredentials) {
      const parsed = credentialsSchema.safeParse(rawCredentials);
      if (!parsed.success) return null;

      const { email, password } = parsed.data;

      // Constant-shape comparison against the env-provided demo credentials.
      const emailMatches =
        email.trim().toLowerCase() === env.DEMO_EMAIL.trim().toLowerCase();
      const passwordMatches = password === env.DEMO_PASSWORD;
      if (!emailMatches || !passwordMatches) return null;

      // Resolve to a REAL database user so the demo session carries a valid id
      // with memberships/orgs (prisma/seed.ts upserts the same email). Upsert
      // keeps login working even before the seed has been run.
      const user = await prisma.user.upsert({
        where: { email: env.DEMO_EMAIL },
        update: {},
        create: { email: env.DEMO_EMAIL, name: "Demo Operator" },
        select: { id: true, name: true, email: true, image: true },
      });

      return user;
    },
  }),
);

export const authOptions: NextAuthOptions = {
  // Cast bridges the @auth/core adapter type to next-auth v4's Adapter type;
  // the Prisma adapter is structurally compatible across the two.
  adapter: PrismaAdapter(prisma) as Adapter,
  session: { strategy: "jwt" },
  secret: env.NEXTAUTH_SECRET,
  pages: { signIn: "/sign-in" },
  providers,
  callbacks: {
    async jwt({ token, user }) {
      // On initial sign-in (`user` present) stamp the id onto the token; it then
      // persists across subsequent requests.
      if (user) token.id = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id ?? token.sub ?? "";
      }
      return session;
    },
  },
};

/**
 * The real authorization gate. Re-checks the session server-side and redirects
 * unauthenticated callers to the sign-in page. Middleware is defense-in-depth;
 * THIS is what every protected page and every Server Action must call.
 */
export async function requireSession(): Promise<Session> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/sign-in");
  }
  return session;
}
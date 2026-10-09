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
import { cache } from "react";
import { PrismaAdapter } from "@auth/prisma-adapter";
import GitHubProvider from "next-auth/providers/github";
import CredentialsProvider from "next-auth/providers/credentials";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { env, isGithubEnabled, isPublicDemo } from "@/lib/env";
import { verifyPassword } from "@/lib/password";
import { survivesRevocation } from "@/lib/session-revocation";

// Shape of the credentials form. Validated inside `authorize` so we never trust
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
    name: "Email and password",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    // Two ways in, tried in order:
    //   1. The env-configured demo account — only when DEMO_PASSWORD is set;
    //      without it there is no demo sign-in at all.
    //   2. A user who registered at /register: looked up by email, password
    //      checked against their stored scrypt hash. Users without a hash
    //      (GitHub-only accounts) can never match here.
    // Every failure returns null, which NextAuth reports as the one generic
    // "CredentialsSignin" — never "no such user" vs "wrong password". A
    // suspended account fails the same way, and only AFTER the password check,
    // so neither the message nor the timing tells a guesser the password was right.
    async authorize(rawCredentials) {
      const parsed = credentialsSchema.safeParse(rawCredentials);
      if (!parsed.success) return null;

      const email = parsed.data.email.trim().toLowerCase();
      const { password } = parsed.data;

      // 1. Demo account — constant-shape comparison against the env credentials.
      const isDemoEmail = email === env.DEMO_EMAIL.trim().toLowerCase();
      if (env.DEMO_PASSWORD !== undefined && isDemoEmail && password === env.DEMO_PASSWORD) {
        // Resolve to a REAL database user so the demo session carries a valid id
        // with memberships/orgs (prisma/seed.ts upserts the same email). Upsert
        // keeps login working even before the seed has been run.
        const demo = await prisma.user.upsert({
          where: { email: env.DEMO_EMAIL },
          update: {},
          create: { email: env.DEMO_EMAIL, name: "Demo Operator" },
          select: { id: true, name: true, email: true, image: true, suspendedAt: true },
        });
        if (demo.suspendedAt !== null) return null;
        return { id: demo.id, name: demo.name, email: demo.email, image: demo.image };
      }

      // 2. Registered user. Emails are stored lowercased by `registerUser`.
      const user = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          passwordHash: true,
          suspendedAt: true,
        },
      });
      if (user === null || user.passwordHash === null) return null;
      if (!(await verifyPassword(password, user.passwordHash))) return null;
      if (user.suspendedAt !== null) return null;

      // The hash never leaves this function.
      return { id: user.id, name: user.name, email: user.email, image: user.image };
    },
  }),
);

// The public demo's one-click sign-in: no credentials at all, so it exists only
// when the deployment says the demo is public (lib/env.ts → isPublicDemo). The
// demo account itself is fenced in by lib/demo.ts.
if (isPublicDemo) {
  providers.push(
    CredentialsProvider({
      id: "demo",
      name: "Demo",
      credentials: {},
      async authorize() {
        const demo = await prisma.user.findUnique({
          where: { email: env.DEMO_EMAIL },
          select: { id: true, name: true, email: true, image: true, suspendedAt: true },
        });
        if (demo === null || demo.suspendedAt !== null) return null;
        return { id: demo.id, name: demo.name, email: demo.email, image: demo.image };
      },
    }),
  );
}

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
      // On initial sign-in (`user` present) stamp the id and the sign-in time
      // onto the token; both then persist across subsequent requests.
      if (user) {
        token.id = user.id;
        token.authAt = Date.now();
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id ?? token.sub ?? "";
      }
      session.authAt = token.authAt;
      return session;
    },
  },
};

/**
 * Whether a session may still use the app: the account exists, is not
 * suspended, and the session signed in after the account's last session
 * revocation (a password reset sets `sessionsRevokedAt`).
 *
 * Sessions are JWTs, so the token stays valid for its whole lifetime no matter
 * what happens to the account. `authorize` stops a suspended user signing in
 * again, but only this check cuts off a session that is ALREADY open. It also
 * catches a deleted account, whose leftover token would otherwise carry an id
 * that matches nothing. A session from before `authAt` existed counts as
 * signed in at 0, so a revocation cuts it off too.
 *
 * A primary-key lookup. Wrapped in React `cache()` so a page and the helpers it
 * calls during one render share a single read, the same way `getActiveOrgId`
 * does. Route handlers and Server Actions are not a React render, so there each
 * call simply runs.
 */
const isSessionActive = cache(async (userId: string, authAt: number): Promise<boolean> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { suspendedAt: true, sessionsRevokedAt: true },
  });
  if (user === null || user.suspendedAt !== null) return false;
  return survivesRevocation(authAt, user.sessionsRevokedAt);
});

/**
 * The real authorization gate. Re-checks the session server-side and redirects
 * unauthenticated callers to the sign-in page. Middleware is defense-in-depth;
 * THIS is what every protected page and every Server Action must call.
 *
 * A suspended or deleted account is sent to sign-in too, where `authorize`
 * refuses it. The edge middleware cannot do this check: it only verifies the
 * JWT signature and has no database access.
 */
export async function requireSession(): Promise<Session> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!(await isSessionActive(session.user.id, session.authAt ?? 0))) {
    redirect("/sign-in");
  }
  return session;
}
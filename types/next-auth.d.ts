// Module augmentation so the session/user/token carry a typed `id`.
// Keeps every `session.user.id` read fully typed — no `any`, no casts at call sites.
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
    /** When this session signed in (ms since epoch) — see `authAt` on the JWT. */
    authAt?: number;
  }

  interface User {
    id: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    /**
     * When the user signed in, ms since epoch. Stamped once and carried across
     * every re-encode — unlike `iat`, which NextAuth refreshes — so lib/auth.ts
     * can refuse sessions older than `User.sessionsRevokedAt`.
     */
    authAt?: number;
  }
}
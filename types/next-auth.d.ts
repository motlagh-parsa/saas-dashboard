// Module augmentation so the session/user/token carry a typed `id`.
// Keeps every `session.user.id` read fully typed — no `any`, no casts at call sites.
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }

  interface User {
    id: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
  }
}
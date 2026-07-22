// NextAuth v4 App Router handler. This is the one route handler that legitimately
// exists for the framework to talk to itself: OAuth callbacks, the credentials
// callback, sign-out, CSRF, and session endpoints all live under /api/auth/*.
import NextAuth from "next-auth";

import { authOptions } from "@/lib/auth";

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
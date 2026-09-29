// Edge middleware — the first (not the only) line of defense for the (dashboard)
// route group. It verifies the session JWT and redirects unauthenticated requests
// to the sign-in page (with a callbackUrl). Real authorization is re-checked
// server-side via requireSession() in every protected page and Server Action.
import { withAuth } from "next-auth/middleware";

// NOTE: do not import lib/env here. This runs on the Edge runtime, and lib/env's
// module-load validation hard-throws on any missing var (DATABASE_URL, DEMO_*),
// which the edge has no business needing — a throw here 500s every request.
// withAuth reads NEXTAUTH_SECRET from process.env itself, so the edge needs nothing.
export default withAuth({
  pages: { signIn: "/sign-in" },
});

// Route groups like (dashboard) are invisible in the URL, so we match the actual
// authenticated paths: everything under /dashboard, and /onboarding (which lives
// in the (auth) group for its look, but needs a signed-in user). The marketing
// root, /sign-in, /register and invite links stay public.
export const config = {
  matcher: ["/dashboard", "/dashboard/:path*", "/onboarding"],
};
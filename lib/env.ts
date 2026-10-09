import "server-only";

// Centralized, validated, typed environment access.
//
// Nothing else in the app reads `process.env` directly — import `env` from here.
// Validation runs once at module load, so a missing/invalid variable fails fast
// with a readable message instead of surfacing as an undefined at some random
// call site later.
import { z } from "zod";

const envSchema = z.object({
  // Postgres connection string consumed by the Prisma singleton (lib/prisma.ts).
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // NextAuth (v4) core config. NEXTAUTH_SECRET signs/verifies the session JWT and
  // is required in every environment. NEXTAUTH_URL is optional in local dev
  // (auto-detected) but should be set behind a proxy / in production.
  NEXTAUTH_SECRET: z.string().min(1, "NEXTAUTH_SECRET is required"),
  NEXTAUTH_URL: z.string().url().optional(),

  // GitHub OAuth — optional. The provider is only registered when BOTH are set,
  // so a reviewer can run the app with just the demo credentials.
  GITHUB_ID: z.string().min(1).optional(),
  GITHUB_SECRET: z.string().min(1).optional(),

  // Optional demo account for reviewers. Never hard-code these. With
  // DEMO_PASSWORD unset (or empty) the demo sign-in does not exist at all — the
  // credentials provider only accepts registered users. The default email
  // matches the demo user created by prisma/seed.ts, so a demo login resolves to
  // a real, tenant-connected user.
  DEMO_EMAIL: z.string().min(1).default("demo@saas-dashboard.dev"),
  DEMO_PASSWORD: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),

  // Shared secret for the daily snapshot job (GET /api/cron/snapshots), sent as
  // `Authorization: Bearer <CRON_SECRET>` — the header Vercel Cron sends when
  // this variable is set on the project. Optional: without it the app runs and
  // the job endpoint refuses every call. An empty value counts as unset.
  CRON_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(16, "CRON_SECRET must be at least 16 characters").optional(),
  ),

  // Email (lib/mail.ts). With RESEND_API_KEY set, mail goes out through Resend's
  // HTTP API. Without it, messages are written to a local mailbox directory
  // instead (MAIL_DEV_DIR, or a temp folder in development) — that is how dev
  // and the e2e tests read them. A production deployment with neither has no
  // email at all, and the flows that need it step aside gracefully.
  RESEND_API_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  // The From header. Resend only sends from a domain verified in its dashboard;
  // its shared onboarding address only delivers to the account owner's inbox.
  MAIL_FROM: z.string().min(3).default("Meridian <onboarding@resend.dev>"),
  // Where the local mail driver writes messages (one JSON file each). Setting it
  // turns that driver on even in a production build (CI's e2e run does this).
  MAIL_DEV_DIR: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),

  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment variables:\n${issues}`);
}

/** The CRON_SECRET value .env.example ships with — fine locally, public everywhere else. */
const EXAMPLE_CRON_SECRET = "dev-only-cron-secret-change-me";

if (parsed.data.NODE_ENV === "production" && parsed.data.CRON_SECRET === EXAMPLE_CRON_SECRET) {
  throw new Error(
    "Invalid environment variables:\n  - CRON_SECRET: still the .env.example development value — generate one with: openssl rand -hex 32",
  );
}

if (
  parsed.data.NODE_ENV === "production" &&
  parsed.data.RESEND_API_KEY !== undefined &&
  parsed.data.NEXTAUTH_URL === undefined
) {
  throw new Error(
    "Invalid environment variables:\n  - NEXTAUTH_URL: required in production when email is enabled — links in emails are built from it",
  );
}

/** The single, typed, validated environment object for the whole app. */
export const env = parsed.data;

/** How this deployment sends email — see lib/mail.ts. */
export const mailDriver: "resend" | "local" | "none" =
  env.RESEND_API_KEY !== undefined
    ? "resend"
    : env.MAIL_DEV_DIR !== undefined || env.NODE_ENV !== "production"
      ? "local"
      : "none";

/** Whether this deployment can send email at all. */
export const isMailEnabled: boolean = mailDriver !== "none";

/** Absolute base URL for links that leave the app (emails). No trailing slash. */
export function appUrl(): string {
  return (env.NEXTAUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** GitHub OAuth is only wired up when both credentials are present. */
export const isGithubEnabled: boolean = Boolean(
  env.GITHUB_ID && env.GITHUB_SECRET,
);
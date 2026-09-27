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

  // Single demo account for reviewers without GitHub. Never hard-code these.
  // The default email matches the demo user created by prisma/seed.ts so a demo
  // login resolves to a real, tenant-connected user.
  DEMO_EMAIL: z.string().min(1).default("demo@saas-dashboard.dev"),
  DEMO_PASSWORD: z.string().min(1, "DEMO_PASSWORD is required"),

  // Shared secret for the daily snapshot job (GET /api/cron/snapshots), sent in
  // the `x-cron-secret` header. Optional: without it the app runs and the job
  // endpoint refuses every call. An empty value counts as unset, and the
  // .env.example placeholder is rejected outright — a secret printed in the repo
  // protects nothing.
  CRON_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .min(16, "CRON_SECRET must be at least 16 characters")
      .refine((value) => value !== "your-secret-here", {
        message: "CRON_SECRET is still the .env.example placeholder — generate one with: openssl rand -hex 32",
      })
      .optional(),
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

/** The single, typed, validated environment object for the whole app. */
export const env = parsed.data;

/** GitHub OAuth is only wired up when both credentials are present. */
export const isGithubEnabled: boolean = Boolean(
  env.GITHUB_ID && env.GITHUB_SECRET,
);
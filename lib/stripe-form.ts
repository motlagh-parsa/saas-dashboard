// Shapes and rules for the Stripe forms on Settings → Integrations. A plain
// module: the client forms and the Server Actions share it.
import { z } from "zod";

export const restrictedKeySchema = z
  .string({ error: "Paste a restricted key." })
  .trim()
  .refine((value) => !value.startsWith("sk_"), {
    error: "That's a secret key, which can change your Stripe account. Create a restricted key with read-only access instead.",
  })
  .refine((value) => /^rk_(test|live)_[A-Za-z0-9]{10,}$/.test(value), {
    error: "A restricted key starts with rk_test_ or rk_live_.",
  });

export const webhookSecretSchema = z
  .string({ error: "Paste the signing secret." })
  .trim()
  .regex(/^whsec_[A-Za-z0-9+/=]{10,}$/, { error: "A signing secret starts with whsec_." });

export interface StripeFormState {
  readonly status: "idle" | "success" | "error";
  readonly message: string | null;
  readonly fieldError: string | null;
}

export const IDLE_STRIPE_FORM: StripeFormState = { status: "idle", message: null, fieldError: null };

"use server";

// Settings → Integrations → Stripe: connect, add the webhook secret, sync now,
// disconnect. OWNER and ADMIN only, checked per action against the workspace
// the form was rendered for.
//
// Connecting validates the key against Stripe before storing anything: it must
// be a RESTRICTED key (never a secret key, which can write to the account) and
// able to read the four resources the sync needs. It is stored encrypted
// (lib/secret-box.ts) and never shown again; the page only shows its last four
// characters. The first sync starts right after.
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { Prisma } from "@prisma/client";

import { writeAudit } from "@/lib/audit-writer";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { seal } from "@/lib/secret-box";
import { stripeClient, StripeError } from "@/lib/stripe/client";
import { runStripeSync } from "@/lib/stripe/sync";
import { restrictedKeySchema, webhookSecretSchema, type StripeFormState } from "@/lib/stripe-form";

const PAGE = "/dashboard/settings/integrations";
const STALE_PAGE = "This page is out of date. Reload it and try again.";
const ID_PATTERN = /^[a-z0-9]{20,40}$/i;

type Manager = { readonly ok: true; readonly userId: string; readonly organizationId: string } | { readonly ok: false; readonly state: StripeFormState };

function failure(message: string | null, fieldError: string | null = null): StripeFormState {
  return { status: "error", message, fieldError };
}

async function manager(formData: FormData): Promise<Manager> {
  const session = await requireSession();
  const organizationId = formData.get("organizationId");
  if (typeof organizationId !== "string" || !ID_PATTERN.test(organizationId)) return { ok: false, state: failure(STALE_PAGE) };
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: session.user.id, organizationId } },
    select: { role: true },
  });
  if (membership === null) return { ok: false, state: failure(STALE_PAGE) };
  if (membership.role === "MEMBER") return { ok: false, state: failure("Only owners and admins can manage integrations.") };
  return { ok: true, userId: session.user.id, organizationId };
}

export async function connectStripe(_previous: StripeFormState, formData: FormData): Promise<StripeFormState> {
  const caller = await manager(formData);
  if (!caller.ok) return caller.state;
  const parsed = restrictedKeySchema.safeParse(formData.get("key"));
  if (!parsed.success) return failure(null, parsed.error.issues[0]?.message ?? "Paste a restricted key.");
  const key = parsed.data;

  // Every resource the sync reads, once each — the error names a missing one.
  const client = stripeClient(key);
  try {
    await client.get("/v1/prices", { limit: "1" });
    await client.get("/v1/customers", { limit: "1" });
    await client.get("/v1/subscriptions", { limit: "1", status: "all" });
    await client.get("/v1/invoices", { limit: "1" });
  } catch (error: unknown) {
    return failure(null, error instanceof StripeError ? error.message : "Couldn't check the key with Stripe. Try again.");
  }

  try {
    await prisma.stripeConnection.create({
      data: {
        organizationId: caller.organizationId,
        encryptedKey: seal(key),
        keyHint: key.slice(-4),
        livemode: key.startsWith("rk_live_"),
        createdById: caller.userId,
      },
    });
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return failure("Stripe is already connected to this workspace. Reload the page.");
    }
    throw error;
  }

  await writeAudit({
    organizationId: caller.organizationId,
    actorId: caller.userId,
    action: "stripe.connected",
    targetType: "integration",
    targetId: caller.organizationId,
    targetLabel: "Stripe",
    metadata: { mode: key.startsWith("rk_live_") ? "live" : "test", keyHint: key.slice(-4) },
  });
  after(async () => {
    await runStripeSync(caller.organizationId, { actorId: caller.userId });
  });
  revalidatePath(PAGE);
  return { status: "success", message: "Connected. The first sync has started — it can take a few minutes.", fieldError: null };
}

export async function saveStripeWebhookSecret(_previous: StripeFormState, formData: FormData): Promise<StripeFormState> {
  const caller = await manager(formData);
  if (!caller.ok) return caller.state;
  const parsed = webhookSecretSchema.safeParse(formData.get("secret"));
  if (!parsed.success) return failure(null, parsed.error.issues[0]?.message ?? "Paste the signing secret.");
  const { count } = await prisma.stripeConnection.updateMany({
    where: { organizationId: caller.organizationId },
    data: { encryptedWebhookSecret: seal(parsed.data) },
  });
  if (count === 0) return failure("Connect Stripe first.");
  revalidatePath(PAGE);
  return { status: "success", message: "Signing secret saved. Stripe changes now arrive within seconds.", fieldError: null };
}

export async function syncStripeNow(_previous: StripeFormState, formData: FormData): Promise<StripeFormState> {
  const caller = await manager(formData);
  if (!caller.ok) return caller.state;
  const connection = await prisma.stripeConnection.findUnique({
    where: { organizationId: caller.organizationId },
    select: { syncState: true },
  });
  if (connection === null) return failure("Connect Stripe first.");
  if (connection.syncState === "running") return failure("A sync is already running.");
  after(async () => {
    await runStripeSync(caller.organizationId, { actorId: caller.userId });
  });
  return { status: "success", message: "Sync started. Reload in a minute to see the result.", fieldError: null };
}

export async function disconnectStripe(_previous: StripeFormState, formData: FormData): Promise<StripeFormState> {
  const caller = await manager(formData);
  if (!caller.ok) return caller.state;
  const { count } = await prisma.stripeConnection.deleteMany({ where: { organizationId: caller.organizationId } });
  if (count === 0) return failure("Stripe isn't connected.");
  await writeAudit({
    organizationId: caller.organizationId,
    actorId: caller.userId,
    action: "stripe.disconnected",
    targetType: "integration",
    targetId: caller.organizationId,
    targetLabel: "Stripe",
    metadata: {},
  });
  revalidatePath(PAGE);
  return { status: "success", message: "Disconnected. The data already synced stays in Meridian.", fieldError: null };
}

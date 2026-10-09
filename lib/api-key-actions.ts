"use server";

// API keys — create and revoke, from Settings → API keys. OWNER and ADMIN only,
// re-checked here by composite-key membership lookup whatever the UI showed.
//
// A key is generated here, hashed, and only the hash and a display prefix are
// stored (lib/api/keys.ts). The key itself goes back in this one response, for
// the dialog to show once; it is never logged, audited or stored.
import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { MAX_ACTIVE_KEYS, generateApiKey } from "@/lib/api/keys";
import {
  CREATE_API_KEY_FIELDS,
  EXPIRY_OPTIONS,
  createApiKeySchema,
  type CreateApiKeyState,
} from "@/lib/api-key-form";
import { unverifiedEmailRefusal } from "@/lib/account-email";
import { writeAudit } from "@/lib/audit-writer";
import { requireSession } from "@/lib/auth";
import { ID_PATTERN, fieldErrorsOf, readForm, type BillingFormState } from "@/lib/billing-form";
import { formatDay } from "@/lib/format";
import { prisma } from "@/lib/prisma";

const STALE_PAGE = "This page is out of date. Reload it and try again.";
const MANAGERS_ONLY = "Only owners and admins can manage API keys.";
const API_KEYS_PATH = "/dashboard/settings/api-keys";
const DAY_MS = 86_400_000;

type Manager = { ok: true; userId: string; organizationId: string } | { ok: false; message: string };

async function keyManager(formData: FormData): Promise<Manager> {
  const session = await requireSession();
  const organizationId = formData.get("organizationId");
  if (typeof organizationId !== "string" || !ID_PATTERN.test(organizationId)) return { ok: false, message: STALE_PAGE };
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: session.user.id, organizationId } },
    select: { role: true },
  });
  if (membership === null) return { ok: false, message: STALE_PAGE };
  if (membership.role === "MEMBER") return { ok: false, message: MANAGERS_ONLY };
  return { ok: true, userId: session.user.id, organizationId };
}

function createFailure(message: string | null, fieldErrors: Record<string, string> = {}): CreateApiKeyState {
  return { status: "error", message, fieldErrors, key: null };
}

export async function createApiKey(_previous: CreateApiKeyState, formData: FormData): Promise<CreateApiKeyState> {
  const caller = await keyManager(formData);
  if (!caller.ok) return createFailure(caller.message);
  const unverified = await unverifiedEmailRefusal(caller.userId);
  if (unverified !== null) return createFailure(unverified);
  const parsed = createApiKeySchema.safeParse(readForm(formData, CREATE_API_KEY_FIELDS));
  if (!parsed.success) return createFailure(null, fieldErrorsOf(parsed.error));
  const { name, scope, expiry } = parsed.data;

  const now = new Date();
  const days = EXPIRY_OPTIONS.find((option) => option.value === expiry)?.days ?? null;
  const expiresAt = days === null ? null : new Date(now.getTime() + days * DAY_MS);
  const generated = generateApiKey();

  // The count and the insert under one per-workspace lock, so two creates at
  // once cannot both see 19 and make 21.
  const created = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`api-keys:${caller.organizationId}`}))`;
    const active = await tx.apiKey.count({
      where: {
        organizationId: caller.organizationId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    if (active >= MAX_ACTIVE_KEYS) return null;
    return tx.apiKey.create({
      data: {
        organizationId: caller.organizationId,
        name,
        prefix: generated.prefix,
        keyHash: generated.keyHash,
        scope,
        createdById: caller.userId,
        expiresAt,
      },
      select: { id: true },
    });
  });
  if (created === null) {
    return createFailure(`A workspace can have ${MAX_ACTIVE_KEYS} active keys. Revoke one you no longer use first.`);
  }

  after(() =>
    writeAudit({
      organizationId: caller.organizationId,
      actorId: caller.userId,
      action: "api_key.created",
      targetType: "api_key",
      targetId: created.id,
      targetLabel: name,
      metadata: {
        prefix: generated.prefix,
        scope,
        expiresAt: expiresAt?.toISOString() ?? null,
        detail: `${generated.prefix}… · ${scope === "WRITE" ? "Read and write" : "Read only"} · ${expiresAt ? `expires ${formatDay(expiresAt)}` : "never expires"}`,
      },
    }),
  );
  revalidatePath(API_KEYS_PATH);
  return { status: "success", message: `${name} was created.`, fieldErrors: {}, key: generated.key };
}

export async function revokeApiKey(_previous: BillingFormState, formData: FormData): Promise<BillingFormState> {
  const caller = await keyManager(formData);
  if (!caller.ok) return { status: "error", message: caller.message, fieldErrors: {} };
  const keyId = formData.get("keyId");
  if (typeof keyId !== "string" || !ID_PATTERN.test(keyId)) return { status: "error", message: STALE_PAGE, fieldErrors: {} };

  const key = await prisma.apiKey.findFirst({
    where: { id: keyId, organizationId: caller.organizationId },
    select: { name: true, prefix: true, revokedAt: true },
  });
  if (key === null) return { status: "error", message: STALE_PAGE, fieldErrors: {} };
  const { count } = await prisma.apiKey.updateMany({
    where: { id: keyId, organizationId: caller.organizationId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count === 0) return { status: "error", message: `${key.name} is already revoked.`, fieldErrors: {} };

  after(() =>
    writeAudit({
      organizationId: caller.organizationId,
      actorId: caller.userId,
      action: "api_key.revoked",
      targetType: "api_key",
      targetId: keyId,
      targetLabel: key.name,
      metadata: { prefix: key.prefix, detail: `${key.prefix}… · requests with it now get 401` },
    }),
  );
  revalidatePath(API_KEYS_PATH);
  return { status: "success", message: `${key.name} no longer works.`, fieldErrors: {} };
}

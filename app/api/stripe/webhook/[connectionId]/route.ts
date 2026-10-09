// POST /api/stripe/webhook/<connectionId> — the endpoint a workspace adds in
// Stripe (Settings → Integrations shows the URL). No session: the request
// proves itself with Stripe's signature over the raw body, checked against the
// workspace's signing secret (lib/stripe/webhook.ts). The id in the path only
// says which secret to check against; a wrong id or signature is a 400 that
// reveals nothing.
//
// The event is answered first and applied after the response (`after()`), so
// Stripe never waits on our database.
import { after, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { open } from "@/lib/secret-box";
import { connectionContext } from "@/lib/stripe/sync";
import { applyStripeEvent, verifyStripeSignature, type StripeEvent } from "@/lib/stripe/webhook";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_000_000;

function rejected(): NextResponse {
  return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> },
): Promise<NextResponse> {
  const { connectionId } = await params;
  const payload = await request.text();
  if (payload.length > MAX_BODY_BYTES) return rejected();

  const connection = /^[a-z0-9]{20,40}$/i.test(connectionId)
    ? await prisma.stripeConnection.findUnique({
        where: { id: connectionId },
        select: { organizationId: true, encryptedWebhookSecret: true },
      })
    : null;
  const secret = connection?.encryptedWebhookSecret ? open(connection.encryptedWebhookSecret) : null;
  if (connection === null || secret === null || !verifyStripeSignature(payload, request.headers.get("stripe-signature"), secret)) {
    return rejected();
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return rejected();
  }

  const organizationId = connection.organizationId;
  after(async () => {
    const context = await connectionContext(organizationId);
    if (context === null) return;
    if (await applyStripeEvent(context, event)) {
      await prisma.stripeConnection.update({ where: { organizationId }, data: { lastWebhookAt: new Date() } });
    }
  });
  return NextResponse.json({ received: true });
}

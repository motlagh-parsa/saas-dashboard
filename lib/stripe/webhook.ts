import "server-only";

// Stripe webhooks: signature verification and applying one event.
//
// Verification follows Stripe's scheme exactly: the `Stripe-Signature` header
// carries a timestamp `t` and one or more `v1` HMAC-SHA256 signatures of
// "<t>.<raw body>" under the endpoint's signing secret. The event is accepted
// only if one of them matches (constant-time) and `t` is within five minutes —
// so a captured request can't be replayed later.
import { createHmac, timingSafeEqual } from "node:crypto";

import { writeContext } from "@/lib/api/context";
import {
  settle,
  StripeSync,
  type ConnectionContext,
  type StripeCustomer,
  type StripeInvoice,
  type StripePrice,
  type StripeSubscription,
} from "@/lib/stripe/sync";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (header === null) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [name, value] = part.split("=", 2);
    if (name === "t" && value !== undefined) timestamp = Number(value);
    if (name === "v1" && value !== undefined) signatures.push(value);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest();
  return signatures.some((signature) => {
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly data: { readonly object: unknown };
}

/** The event types Meridian listens to — shown in the setup instructions. */
export const HANDLED_EVENTS: readonly string[] = [
  "customer.created",
  "customer.updated",
  "price.created",
  "price.updated",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
];

/** Applies one event. Returns whether it was one Meridian handles. Never throws. */
export async function applyStripeEvent(connection: ConnectionContext, event: StripeEvent): Promise<boolean> {
  if (!HANDLED_EVENTS.includes(event.type)) return false;
  const sync = new StripeSync(writeContext(connection.organizationId, connection.currency, new Date(), "STRIPE"), connection.client);
  try {
    if (event.type.startsWith("customer.subscription.")) {
      const subscription = event.data.object as StripeSubscription;
      await sync.ensureCustomer(subscription.customer);
      await sync.syncSubscription(subscription);
    } else if (event.type.startsWith("customer.")) {
      await sync.syncCustomer(event.data.object as StripeCustomer);
    } else if (event.type.startsWith("price.")) {
      let price = event.data.object as StripePrice;
      if (typeof price.product === "string") {
        try {
          price = await connection.client.get<StripePrice>(`/v1/prices/${price.id}`, { "expand[]": "product" });
        } catch {
          // Named after the product id then.
        }
      }
      sync.nameForPrices([price]);
      await sync.syncPrice(price);
    } else if (event.type.startsWith("invoice.")) {
      const invoice = event.data.object as StripeInvoice;
      await sync.ensureCustomer(invoice.customer);
      await sync.syncInvoice(invoice);
    }
    await settle(sync.ctx);
  } catch (error: unknown) {
    console.error("[stripe] webhook event failed", { type: event.type, id: event.id, error });
  }
  return true;
}

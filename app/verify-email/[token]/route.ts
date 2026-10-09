// GET /verify-email/<token> — the link in the confirmation email.
//
// Consumes the token (lib/email-tokens.ts — single use, 24 hours) and redirects
// to a page that says how it went. A redirect rather than a page so the token
// leaves the address bar at once and never lands in history or a Referer.
//
// A GET that writes, on purpose: some mail security scanners open links before
// the person does. That still only confirms an address whose inbox the link was
// delivered to, which is exactly what confirming means.
import { NextResponse, type NextRequest } from "next/server";

import { consumeVerifyToken } from "@/lib/email-tokens";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  const owner = await consumeVerifyToken(token);
  const target = new URL(`/email-verified?status=${owner === null ? "invalid" : "verified"}`, request.url);
  const response = NextResponse.redirect(target, 303);
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

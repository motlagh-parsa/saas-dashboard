// Selects the workspace the dashboard shows, by setting the `meridian_org` cookie.
//
// Security:
//   1. `requireSession()` is the authorization gate. An anonymous caller is
//      redirected to /sign-in; the switcher detects the redirect.
//   2. `orgId` is the one untrusted input. It is only written to the cookie when
//      the caller has a membership in that org — 403 otherwise. The cookie is
//      re-verified on every read (lib/active-org.ts), so even a hand-edited
//      cookie cannot select a workspace the user does not belong to.
//   3. JSON only. A cross-site page cannot send `application/json` without a
//      CORS preflight this route never approves, and the session cookie is
//      SameSite=Lax, so it is not sent on a cross-site POST in the first place.
import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ACTIVE_ORG_COOKIE, ACTIVE_ORG_COOKIE_MAX_AGE } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

const switchBodySchema = z.object({ orgId: z.string().min(1) });

export async function POST(request: Request): Promise<NextResponse> {
  const session = await requireSession();

  if (!request.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "orgId is required" }, { status: 400 });
  }

  const parsed = switchBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "orgId is required" }, { status: 400 });
  }
  const { orgId } = parsed.data;

  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: session.user.id, organizationId: orgId } },
    select: { organizationId: true },
  });
  if (membership === null) {
    return NextResponse.json({ error: "Not a member of that workspace" }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ACTIVE_ORG_COOKIE, membership.organizationId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: ACTIVE_ORG_COOKIE_MAX_AGE,
    // Local dev runs over plain http, where a Secure cookie would never be sent.
    secure: env.NODE_ENV === "production",
  });
  return response;
}

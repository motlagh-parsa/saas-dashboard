// POST /api/vitals — Core Web Vitals from real visits (components/web-vitals.tsx
// sends them with sendBeacon). Each is validated and written as one structured
// log line, the same shape as the server's error lines (instrumentation.ts), so
// the hosting platform's logs show LCP / INP / CLS per page without a third-
// party analytics script. Nothing identifying is kept: no IP, no user.
import { NextResponse } from "next/server";
import { z } from "zod";

const vitalSchema = z.object({
  name: z.enum(["LCP", "INP", "CLS", "FCP", "TTFB"]),
  value: z.number().finite().nonnegative().max(600_000),
  rating: z.enum(["good", "needs-improvement", "poor"]),
  path: z.string().max(200).regex(/^\/[A-Za-z0-9/_\-.[\]]*$/),
});

export async function POST(request: Request): Promise<NextResponse> {
  const text = await request.text();
  if (text.length > 2_000) return new NextResponse(null, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const parsed = vitalSchema.safeParse(body);
  if (!parsed.success) return new NextResponse(null, { status: 400 });
  console.info(JSON.stringify({ level: "info", event: "web_vital", ...parsed.data }));
  return new NextResponse(null, { status: 204 });
}

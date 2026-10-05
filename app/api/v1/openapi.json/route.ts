// GET /api/v1/openapi.json — the API's OpenAPI 3.1 description. Public and
// static: it is the same for everyone and built once.
import { OPENAPI_DOCUMENT } from "@/lib/api/openapi";

export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(OPENAPI_DOCUMENT);
}

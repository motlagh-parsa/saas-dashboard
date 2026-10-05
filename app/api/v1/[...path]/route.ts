// Any other path under /api/v1: the API's JSON 404, not the site's HTML one.
import { notFoundRoute } from "@/lib/api/handler";

export const GET = notFoundRoute();
export const POST = notFoundRoute();
export const PUT = notFoundRoute();
export const PATCH = notFoundRoute();
export const DELETE = notFoundRoute();

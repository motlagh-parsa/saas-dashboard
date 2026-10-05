// GET /api/v1/metrics/summary?date=YYYY-MM-DD — the Overview's figures for a day.
import { apiRoute } from "@/lib/api/handler";
import { getSummary } from "@/lib/api/resources/metrics";

export const GET = apiRoute("READ", async ({ ctx, query }) => ({ body: await getSummary(ctx, query) }));

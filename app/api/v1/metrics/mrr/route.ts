// GET /api/v1/metrics/mrr?from=&to= — the daily MRR series from the snapshots.
import { apiRoute } from "@/lib/api/handler";
import { getMrrSeries } from "@/lib/api/resources/metrics";

export const GET = apiRoute("READ", async ({ ctx, query }) => ({ body: await getMrrSeries(ctx, query) }));

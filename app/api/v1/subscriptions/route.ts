// GET /api/v1/subscriptions — chains, cursor-paginated, `customer_external_id` filter.
import { apiRoute } from "@/lib/api/handler";
import { listSubscriptions } from "@/lib/api/resources/subscriptions";

export const GET = apiRoute("READ", async ({ ctx, query }) => ({ body: await listSubscriptions(ctx, query) }));

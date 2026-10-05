// GET /api/v1/plans — cursor-paginated, archived plans included.
import { apiRoute } from "@/lib/api/handler";
import { listPlans } from "@/lib/api/resources/plans";

export const GET = apiRoute("READ", async ({ ctx, query }) => ({ body: await listPlans(ctx, query) }));

// GET /api/v1/customers — cursor-paginated, `status=active|churned|all`.
import { apiRoute } from "@/lib/api/handler";
import { listCustomers } from "@/lib/api/resources/customers";

export const GET = apiRoute("READ", async ({ ctx, query }) => ({ body: await listCustomers(ctx, query) }));

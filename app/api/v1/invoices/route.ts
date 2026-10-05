// GET /api/v1/invoices — cursor-paginated; status, customer_external_id,
// issued_after and issued_before filters.
import { apiRoute } from "@/lib/api/handler";
import { listInvoices } from "@/lib/api/resources/invoices";

export const GET = apiRoute("READ", async ({ ctx, query }) => ({ body: await listInvoices(ctx, query) }));

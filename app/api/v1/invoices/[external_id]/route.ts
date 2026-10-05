// /api/v1/invoices/{external_id} — read, upsert (status moves along the UI's transitions).
import { apiRoute } from "@/lib/api/handler";
import { getInvoice, putInvoice } from "@/lib/api/resources/invoices";
import { externalIdParam } from "@/lib/api/schema";

type Params = { external_id: string };

export const GET = apiRoute<Params>("READ", async ({ ctx, params }) => ({
  body: await getInvoice(ctx, externalIdParam(params.external_id)),
}));

export const PUT = apiRoute<Params>("WRITE", async ({ ctx, params, body }) => {
  const externalId = externalIdParam(params.external_id);
  const result = await putInvoice(ctx, externalId, await body());
  return { status: result.created ? 201 : 200, body: result.record };
});

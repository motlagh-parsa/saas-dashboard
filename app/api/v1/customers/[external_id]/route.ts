// /api/v1/customers/{external_id} — read, upsert, archive.
import { apiRoute } from "@/lib/api/handler";
import { archiveCustomer, getCustomer, putCustomer } from "@/lib/api/resources/customers";
import { externalIdParam } from "@/lib/api/schema";

type Params = { external_id: string };

export const GET = apiRoute<Params>("READ", async ({ ctx, params }) => ({
  body: await getCustomer(ctx, externalIdParam(params.external_id)),
}));

export const PUT = apiRoute<Params>("WRITE", async ({ ctx, params, body }) => {
  const externalId = externalIdParam(params.external_id);
  const result = await putCustomer(ctx, externalId, await body());
  return { status: result.created ? 201 : 200, body: result.record };
});

export const DELETE = apiRoute<Params>("WRITE", async ({ ctx, params }) => ({
  body: await archiveCustomer(ctx, externalIdParam(params.external_id)),
}));

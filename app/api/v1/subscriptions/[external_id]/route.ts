// /api/v1/subscriptions/{external_id} — read, push current state, delete.
import { apiRoute } from "@/lib/api/handler";
import { deleteSubscription, getSubscription, putSubscription } from "@/lib/api/resources/subscriptions";
import { externalIdParam } from "@/lib/api/schema";

type Params = { external_id: string };

export const GET = apiRoute<Params>("READ", async ({ ctx, params }) => ({
  body: await getSubscription(ctx, externalIdParam(params.external_id)),
}));

export const PUT = apiRoute<Params>("WRITE", async ({ ctx, params, body }) => {
  const externalId = externalIdParam(params.external_id);
  const result = await putSubscription(ctx, externalId, await body());
  return { status: result.created ? 201 : 200, body: result.record };
});

export const DELETE = apiRoute<Params>("WRITE", async ({ ctx, params }) => ({
  body: await deleteSubscription(ctx, externalIdParam(params.external_id)),
}));

// PUT /api/v1/plans/{external_id} — upsert. A new price applies to new subscriptions only.
import { apiRoute } from "@/lib/api/handler";
import { putPlan } from "@/lib/api/resources/plans";
import { externalIdParam } from "@/lib/api/schema";

type Params = { external_id: string };

export const PUT = apiRoute<Params>("WRITE", async ({ ctx, params, body }) => {
  const externalId = externalIdParam(params.external_id);
  const result = await putPlan(ctx, externalId, await body());
  return { status: result.created ? 201 : 200, body: result.record };
});

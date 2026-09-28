"use server";

// Plan writes: create, edit, archive, unarchive, delete.
//
// File-level `"use server"`: every export is a public endpoint and the FormData
// is untrusted. Authorization is `billingWriter` (OWNER or ADMIN of the rendered
// organization, by composite key); the writes are lib/billing-ops.ts, which
// re-checks the plan id against that organization. No plan write moves a
// snapshot: subscriptions copy their plan's price when they start.
import { billingWriter, finishWrite, parseForm, readId } from "@/lib/billing-caller";
import { PLAN_FIELDS, planSchema, type BillingFormState } from "@/lib/billing-form";
import {
  createPlanOp,
  deletePlanOp,
  setPlanArchivedOp,
  updatePlanOp,
} from "@/lib/billing-ops";

export async function createPlan(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const { caller } = check;
  const parsed = parseForm(planSchema(caller.currency), formData, PLAN_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(caller, await createPlanOp(caller.organizationId, caller.currency, parsed.data));
}

export async function updatePlan(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const { caller } = check;
  const planId = readId(formData, "planId");
  if (!planId.ok) return planId.state;
  const parsed = parseForm(planSchema(caller.currency), formData, PLAN_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(
    caller,
    await updatePlanOp(caller.organizationId, caller.currency, planId.data, parsed.data),
  );
}

async function setArchived(formData: FormData, archived: boolean): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const planId = readId(formData, "planId");
  if (!planId.ok) return planId.state;
  return finishWrite(check.caller, await setPlanArchivedOp(check.caller.organizationId, planId.data, archived));
}

export async function archivePlan(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  return setArchived(formData, true);
}

export async function unarchivePlan(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  return setArchived(formData, false);
}

export async function deletePlan(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const planId = readId(formData, "planId");
  if (!planId.ok) return planId.state;
  return finishWrite(check.caller, await deletePlanOp(check.caller.organizationId, planId.data));
}

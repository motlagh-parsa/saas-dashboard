"use server";

// The subscription lifecycle: create, change plan or quantity, cancel, undo a
// scheduled cancellation, correct, delete.
//
// File-level `"use server"`: the dialogs that call these are client islands, so
// every export is a public endpoint and everything in the FormData is untrusted.
// Authorization is `billingWriter` (lib/billing-caller.ts) — OWNER or ADMIN of
// the organization the form was rendered for, by composite key. Parsing is
// lib/billing-form.ts, the same schemas the dialogs run. The writes are
// lib/billing-ops.ts, which re-checks every customer, plan and subscription id
// against the organization and keeps the segment model: a change ends the
// current segment and opens the next; only Correct edits a segment in place.
//
// Every success records an audit entry and rewrites the workspace's snapshots
// from the first day the change touches, both after the response (`after()`).
import { billingWriter, finishWrite, parseForm } from "@/lib/billing-caller";
import {
  CANCEL_SUBSCRIPTION_FIELDS,
  CHANGE_SUBSCRIPTION_FIELDS,
  CORRECT_SUBSCRIPTION_FIELDS,
  CREATE_SUBSCRIPTION_FIELDS,
  SUBSCRIPTION_ID_FIELDS,
  cancelSubscriptionSchema,
  changeSubscriptionSchema,
  correctSubscriptionSchema,
  createSubscriptionSchema,
  subscriptionIdSchema,
  type BillingFormState,
} from "@/lib/billing-form";
import {
  cancelSubscriptionOp,
  changeSubscriptionOp,
  correctSubscriptionOp,
  createSubscriptionOp,
  deleteSubscriptionChainOp,
  undoScheduledCancelOp,
} from "@/lib/billing-ops";

export async function createSubscription(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const { caller } = check;
  const parsed = parseForm(createSubscriptionSchema(caller.currency), formData, CREATE_SUBSCRIPTION_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(caller, await createSubscriptionOp(caller.organizationId, caller.currency, parsed.data));
}

/** Change plan and change quantity — one action; the quantity dialog posts the current plan. */
export async function changeSubscription(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const { caller } = check;
  const parsed = parseForm(changeSubscriptionSchema(caller.currency), formData, CHANGE_SUBSCRIPTION_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(caller, await changeSubscriptionOp(caller.organizationId, caller.currency, parsed.data));
}

export async function cancelSubscription(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const parsed = parseForm(cancelSubscriptionSchema(), formData, CANCEL_SUBSCRIPTION_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(check.caller, await cancelSubscriptionOp(check.caller.organizationId, parsed.data));
}

export async function undoScheduledCancel(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const parsed = parseForm(subscriptionIdSchema(), formData, SUBSCRIPTION_ID_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(
    check.caller,
    await undoScheduledCancelOp(check.caller.organizationId, parsed.data.subscriptionId),
  );
}

export async function correctSubscription(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const { caller } = check;
  const parsed = parseForm(correctSubscriptionSchema(caller.currency), formData, CORRECT_SUBSCRIPTION_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(caller, await correctSubscriptionOp(caller.organizationId, caller.currency, parsed.data));
}

/** Deletes a whole subscription chain (every linked segment) and its invoices. */
export async function deleteSubscription(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const parsed = parseForm(subscriptionIdSchema(), formData, SUBSCRIPTION_ID_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(
    check.caller,
    await deleteSubscriptionChainOp(check.caller.organizationId, parsed.data.subscriptionId),
  );
}

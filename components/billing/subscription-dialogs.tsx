"use client";

// The subscription lifecycle dialogs: create, change plan, change quantity,
// cancel, correct, delete. Every rule is enforced again on the server
// (lib/billing-ops.ts); what these add is feedback before the round trip and
// copy that says what each action does to history.
//
// `SubscriptionCreateDialog` is THE create form — the Revenue page's "Add
// subscription" and the customer page's "Add subscription" are this one
// component, the second with the customer fixed.
import type { BillingInterval, SubscriptionStatus } from "@prisma/client";
import { Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  CUSTOMER_NAME_MAX,
  CUSTOM_PRICE,
  LIVE_STATUSES,
  MAX_INTERVAL_COUNT,
  MIN_DAY,
  NEW_CUSTOMER,
  QUANTITY_MAX,
  cancelSubscriptionSchema,
  changeSubscriptionSchema,
  correctSubscriptionSchema,
  createSubscriptionSchema,
  maxFutureDay,
  priceInput,
  todayUtc,
  type CustomerOption,
  type PlanOption,
} from "@/lib/billing-form";
import { formatDay, formatEnumLabel, formatIntervalWords, formatPrice } from "@/lib/format";
import { moneyInputExample } from "@/lib/money";
import {
  cancelSubscription,
  changeSubscription,
  correctSubscription,
  createSubscription,
  deleteSubscription,
} from "@/lib/subscription-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormDialog, INPUT_CLASS, SELECT_CLASS, type FormApi } from "@/components/billing/form-dialog";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** The current segment of a subscription, as the dialogs need it — serializable. */
export interface SegmentView {
  readonly id: string;
  readonly customerName: string;
  readonly planId: string | null;
  readonly planName: string | null;
  readonly amountCents: number;
  readonly quantity: number;
  readonly interval: BillingInterval;
  readonly intervalCount: number;
  readonly status: SubscriptionStatus;
  /** `YYYY-MM-DD`. */
  readonly startedDay: string;
}

function DateInput({ form, field, max }: { form: FormApi; field: string; max?: string }) {
  return <Input {...form.control(field)} type="date" min={MIN_DAY} max={max ?? maxFutureDay()} className={INPUT_CLASS} />;
}

function MoneyInput({ form, field }: { form: FormApi; field: string }) {
  return (
    <Input
      {...form.control(field)}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={cn(INPUT_CLASS, "font-mono tabular-nums")}
    />
  );
}

function QuantityInput({ form }: { form: FormApi }) {
  return (
    <Input
      {...form.control("quantity")}
      type="number"
      min={1}
      max={QUANTITY_MAX}
      step={1}
      inputMode="numeric"
      className={cn(INPUT_CLASS, "font-mono tabular-nums")}
    />
  );
}

/** "Every [3] [months]" — a custom price's billing period. */
function IntervalFields({ form }: { form: FormApi }) {
  const interval: BillingInterval = form.draft.interval === "YEAR" ? "YEAR" : "MONTH";
  return (
    <Field
      form={form}
      field="intervalCount"
      label="Bills every"
      hint={`Up to ${MAX_INTERVAL_COUNT.MONTH} months or ${MAX_INTERVAL_COUNT.YEAR} years.`}
    >
      <div className="grid grid-cols-[5.5rem_1fr] gap-2">
        <Input
          {...form.control("intervalCount")}
          type="number"
          min={1}
          max={MAX_INTERVAL_COUNT[interval]}
          inputMode="numeric"
          aria-label="Number of months or years"
          className={cn(INPUT_CLASS, "font-mono tabular-nums")}
        />
        <select {...form.control("interval")} aria-label="Months or years" className={SELECT_CLASS}>
          <option value="MONTH">{form.draft.intervalCount === "1" ? "month" : "months"}</option>
          <option value="YEAR">{form.draft.intervalCount === "1" ? "year" : "years"}</option>
        </select>
      </div>
    </Field>
  );
}

function planLabel(plan: PlanOption, currency: string): string {
  return `${plan.name} — ${formatPrice(plan.amountCents, currency)} / ${formatIntervalWords(plan.interval, plan.intervalCount)}`;
}

/** Plan picker that re-quotes the price input when the plan changes. */
function PlanSelect({ form, plans, currency }: { form: FormApi; plans: readonly PlanOption[]; currency: string }) {
  return (
    <select
      {...form.control("planId")}
      onChange={(event) => {
        const next = plans.find((plan) => plan.id === event.target.value);
        form.setMany({
          planId: event.target.value,
          price: next ? priceInput(next.amountCents, currency) : "",
        });
      }}
      className={SELECT_CLASS}
    >
      {plans.map((plan) => (
        <option key={plan.id} value={plan.id}>
          {planLabel(plan, currency)}
        </option>
      ))}
      <option value={CUSTOM_PRICE}>Custom price</option>
    </select>
  );
}

function StatusSelect({ form }: { form: FormApi }) {
  return (
    <select {...form.control("status")} className={SELECT_CLASS}>
      {LIVE_STATUSES.map((status) => (
        <option key={status} value={status}>
          {formatEnumLabel(status)}
        </option>
      ))}
    </select>
  );
}

function priceLabel(form: FormApi, plans: readonly PlanOption[], currency: string): string {
  const plan = plans.find((candidate) => candidate.id === form.draft.planId);
  const interval: BillingInterval = plan?.interval ?? (form.draft.interval === "YEAR" ? "YEAR" : "MONTH");
  const count = plan?.intervalCount ?? (Number(form.draft.intervalCount) || 1);
  return `Price per seat (${currency} per ${formatIntervalWords(interval, count)})`;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

interface SubscriptionCreateDialogProps {
  organizationId: string;
  currency: string;
  /** The workspace's active (unarchived) customers, by name. */
  customers: readonly CustomerOption[];
  /** The workspace's active plans. */
  plans: readonly PlanOption[];
  /** Set on a customer's page: the customer is fixed and the picker is hidden. */
  fixedCustomer?: CustomerOption;
  openOnMount?: boolean;
  /** "primary" for a page's main action, "outline" beside a stronger one. */
  tone?: "primary" | "outline";
}

export function SubscriptionCreateDialog({
  organizationId,
  currency,
  customers,
  plans,
  fixedCustomer,
  openOnMount,
  tone = "outline",
}: SubscriptionCreateDialogProps) {
  const firstPlan = plans[0];
  return (
    <FormDialog
      openOnMount={openOnMount}
      trigger={
        <Button
          type="button"
          variant={tone === "primary" ? "default" : "outline"}
          className={cn(
            "h-11 px-4 sm:h-9",
            tone === "primary" && "bg-brand text-brand-foreground hover:bg-brand/90",
          )}
        >
          <Plus aria-hidden />
          Add subscription
        </Button>
      }
      wide
      title={fixedCustomer ? `Add a subscription for ${fixedCustomer.name}` : "Add a subscription"}
      description="It counts toward MRR from its start date — which can be in the past, so you can enter your history, or up to a year ahead."
      action={createSubscription}
      hidden={{ organizationId }}
      initial={{
        // A workspace with no customers yet starts on "new customer".
        customerId: fixedCustomer?.id ?? customers[0]?.id ?? NEW_CUSTOMER,
        newCustomerName: "",
        planId: firstPlan?.id ?? CUSTOM_PRICE,
        price: firstPlan ? priceInput(firstPlan.amountCents, currency) : "",
        interval: "MONTH",
        intervalCount: "1",
        quantity: "1",
        status: "ACTIVE",
        startDate: todayUtc(),
        recordPastInvoices: "",
      }}
      schema={createSubscriptionSchema(currency)}
      submitLabel="Add subscription"
      pendingLabel="Adding…"
      successTitle="Subscription added"
    >
      {(form) => {
        const isCustom = form.draft.planId === CUSTOM_PRICE;
        const pastStart = (form.draft.startDate ?? "") < todayUtc();
        return (
          <>
            {fixedCustomer ? (
              <input type="hidden" name="customerId" value={fixedCustomer.id} />
            ) : (
              <Field form={form} field="customerId" label="Customer">
                <select {...form.control("customerId")} className={SELECT_CLASS}>
                  <option value={NEW_CUSTOMER}>New customer…</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {!fixedCustomer && form.draft.customerId === NEW_CUSTOMER ? (
              <Field form={form} field="newCustomerName" label="New customer's name">
                <Input
                  {...form.control("newCustomerName")}
                  type="text"
                  autoComplete="organization"
                  maxLength={CUSTOMER_NAME_MAX}
                  className={INPUT_CLASS}
                />
              </Field>
            ) : null}

            <Field form={form} field="planId" label="Plan">
              <PlanSelect form={form} plans={plans} currency={currency} />
            </Field>

            {isCustom ? <IntervalFields form={form} /> : null}

            <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
              <Field
                form={form}
                field="price"
                label={priceLabel(form, plans, currency)}
                hint={
                  isCustom
                    ? `A negotiated price with no plan, like ${moneyInputExample(currency)}. It shows as Custom in the plan mix.`
                    : "The plan's list price. Change it for a discounted deal."
                }
              >
                <MoneyInput form={form} field="price" />
              </Field>
              <Field form={form} field="quantity" label="Seats">
                <QuantityInput form={form} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field form={form} field="status" label="Status">
                <StatusSelect form={form} />
              </Field>
              <Field form={form} field="startDate" label="Start date (UTC)">
                <DateInput form={form} field="startDate" />
              </Field>
            </div>

            {pastStart ? (
              <label className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5 text-sm">
                <input
                  type="checkbox"
                  name="recordPastInvoices"
                  checked={form.draft.recordPastInvoices === "on"}
                  onChange={(event) => form.set("recordPastInvoices", event.target.checked ? "on" : "")}
                  className="mt-0.5 size-4 accent-brand"
                />
                <span>
                  Also record past invoices
                  <span className="block text-xs text-muted-foreground">
                    One paid invoice for every billing period from the start date to today.
                  </span>
                </span>
              </label>
            ) : null}
          </>
        );
      }}
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Change plan / change quantity
// ---------------------------------------------------------------------------

interface ChangeDialogProps {
  organizationId: string;
  currency: string;
  segment: SegmentView;
  /** Active plans, plus the current one if it has been archived. */
  plans: readonly PlanOption[];
  mode: "plan" | "quantity";
}

export function ChangeSubscriptionDialog({ organizationId, currency, segment, plans, mode }: ChangeDialogProps) {
  const current = {
    planId: segment.planId ?? CUSTOM_PRICE,
    price: priceInput(segment.amountCents, currency),
    interval: segment.interval,
    intervalCount: String(segment.intervalCount),
  };
  const isPlan = mode === "plan";
  return (
    <FormDialog
      trigger={
        <Button type="button" variant="outline" className="h-11 px-3 sm:h-8">
          {isPlan ? "Change plan" : "Change quantity"}
        </Button>
      }
      wide={isPlan}
      title={isPlan ? `Change ${segment.customerName}'s plan` : `Change ${segment.customerName}'s seats`}
      description={
        <>
          The current terms end on the effective date and the new ones start the same day, so the
          history keeps both. Pick a past date to record a change that already happened. Current:{" "}
          <span className="font-medium text-foreground">
            {segment.planName ?? "Custom"} · {formatPrice(segment.amountCents, currency)}
            {segment.quantity === 1 ? "" : ` × ${segment.quantity}`} /{" "}
            {formatIntervalWords(segment.interval, segment.intervalCount)}
          </span>{" "}
          since {formatDay(new Date(`${segment.startedDay}T00:00:00Z`))}.
        </>
      }
      action={changeSubscription}
      hidden={
        isPlan
          ? { organizationId, subscriptionId: segment.id }
          : {
              organizationId,
              subscriptionId: segment.id,
              planId: current.planId,
              price: current.price,
              interval: current.interval,
              intervalCount: current.intervalCount,
            }
      }
      initial={{ ...current, quantity: String(segment.quantity), effectiveDate: todayUtc() }}
      schema={changeSubscriptionSchema(currency)}
      submitLabel={isPlan ? "Change plan" : "Change quantity"}
      pendingLabel="Saving…"
      successTitle={isPlan ? "Plan changed" : "Quantity changed"}
    >
      {(form) => (
        <>
          {isPlan ? (
            <>
              <Field form={form} field="planId" label="New plan">
                <PlanSelect form={form} plans={plans} currency={currency} />
              </Field>
              {form.draft.planId === CUSTOM_PRICE ? <IntervalFields form={form} /> : null}
              <Field form={form} field="price" label={priceLabel(form, plans, currency)}>
                <MoneyInput form={form} field="price" />
              </Field>
            </>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field form={form} field="quantity" label="Seats">
              <QuantityInput form={form} />
            </Field>
            <Field form={form} field="effectiveDate" label="Effective date (UTC)">
              <DateInput form={form} field="effectiveDate" />
            </Field>
          </div>
        </>
      )}
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export function CancelSubscriptionDialog({
  organizationId,
  segment,
}: {
  organizationId: string;
  segment: SegmentView;
}) {
  return (
    <FormDialog
      trigger={
        <Button type="button" variant="outline" className="h-11 px-3 text-negative sm:h-8">
          Cancel subscription
        </Button>
      }
      title={`Cancel ${segment.customerName}'s subscription`}
      description="Today or an earlier date ends it on that day — it stops counting toward MRR and counts as churn. A later date schedules the cancellation: it keeps billing until then, and you can undo it before it happens."
      action={cancelSubscription}
      hidden={{ organizationId, subscriptionId: segment.id }}
      initial={{ effectiveDate: todayUtc() }}
      schema={cancelSubscriptionSchema()}
      submitLabel="Cancel subscription"
      pendingLabel="Canceling…"
      successTitle="Subscription canceled"
    >
      {(form) => (
        <Field form={form} field="effectiveDate" label="Ends on (UTC)">
          <DateInput form={form} field="effectiveDate" />
        </Field>
      )}
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Correct
// ---------------------------------------------------------------------------

export function CorrectSubscriptionDialog({
  organizationId,
  currency,
  segment,
}: {
  organizationId: string;
  currency: string;
  segment: SegmentView;
}) {
  return (
    <FormDialog
      trigger={
        <Button type="button" variant="outline" className="h-11 px-3 sm:h-8">
          Correct
        </Button>
      }
      title="Correct the current terms"
      description={
        <>
          For fixing a data-entry mistake. This <strong className="font-medium text-foreground">rewrites history</strong>:
          the start date, price, seats and status are changed in place, as if they had always been this way,
          and every metric from the earlier of the two start dates is recalculated. The audit log keeps the
          before and after. To record a real change of plan or seats, use Change instead.
        </>
      }
      action={correctSubscription}
      hidden={{ organizationId, subscriptionId: segment.id }}
      initial={{
        startDate: segment.startedDay,
        price: priceInput(segment.amountCents, currency),
        quantity: String(segment.quantity),
        status: segment.status === "CANCELED" ? "ACTIVE" : segment.status,
      }}
      schema={correctSubscriptionSchema(currency)}
      submitLabel="Rewrite history"
      pendingLabel="Saving…"
      successTitle="Subscription corrected"
    >
      {(form) => (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field form={form} field="startDate" label="Start date (UTC)">
              <DateInput form={form} field="startDate" />
            </Field>
            <Field form={form} field="status" label="Status">
              <StatusSelect form={form} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <Field
              form={form}
              field="price"
              label={`Price per seat (${currency} per ${formatIntervalWords(segment.interval, segment.intervalCount)})`}
            >
              <MoneyInput form={form} field="price" />
            </Field>
            <Field form={form} field="quantity" label="Seats">
              <QuantityInput form={form} />
            </Field>
          </div>
        </>
      )}
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export function DeleteSubscriptionDialog({
  organizationId,
  subscriptionId,
  customerName,
  segments,
  invoices,
}: {
  organizationId: string;
  subscriptionId: string;
  customerName: string;
  segments: number;
  invoices: number;
}) {
  return (
    <FormDialog
      trigger={
        <Button type="button" variant="ghost" className="h-11 px-3 text-negative hover:text-negative sm:h-8">
          Delete
        </Button>
      }
      destructive
      title="Delete this subscription?"
      description={
        <>
          For a subscription entered by mistake. This permanently deletes{" "}
          <strong className="font-medium text-foreground">
            {segments} segment{segments === 1 ? "" : "s"}
          </strong>{" "}
          of {customerName}&apos;s subscription history and{" "}
          <strong className="font-medium text-foreground">
            {invoices} invoice{invoices === 1 ? "" : "s"}
          </strong>
          , and recalculates every metric they touched. To stop a real subscription, cancel it instead.
        </>
      }
      action={deleteSubscription}
      hidden={{ organizationId, subscriptionId }}
      initial={{}}
      submitLabel="Delete subscription"
      pendingLabel="Deleting…"
      successTitle="Subscription deleted"
    />
  );
}

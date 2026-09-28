"use client";

// "Add subscription" — records a new Subscription for one of the workspace's
// customers, optionally creating the customer in the same step.
//
// Two components on purpose. The dialog owns only `open`; the form inside is
// remounted (fresh `key`) every time the dialog opens, so a new attempt never
// inherits the previous one's draft, errors or action state — no effect needed
// to reset anything.
//
// Validation runs twice with one schema (lib/subscription-form.ts): here on
// submit for instant feedback, and again in `addSubscription`, which is the
// check that counts. Fields are CONTROLLED because React resets uncontrolled
// inputs after every form action, including a rejected one.
import { useActionState, useId, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Loader2, Plus, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatEnumLabel, formatIntervalSuffix, formatMoney } from "@/lib/format";
import { addSubscription } from "@/lib/subscription-actions";
import {
  BILLING_OPTIONS,
  CUSTOMER_NAME_MAX,
  CUSTOM_PRICE,
  IDLE_SUBSCRIPTION_FORM,
  NEW_CUSTOMER,
  START_STATUSES,
  billingOption,
  centsToPriceInput,
  priceToCents,
  subscriptionFieldErrors,
  subscriptionSchema,
  todayUtc,
  type BillingKey,
  type CustomerOption,
  type PlanOption,
  type SubscriptionField,
  type SubscriptionFieldErrors,
  type SubscriptionFormState,
} from "@/lib/subscription-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/dashboard/use-toast";

interface SubscriptionDraft {
  customerId: string;
  newCustomerName: string;
  planId: string;
  price: string;
  billing: BillingKey;
  status: (typeof START_STATUSES)[number];
  startDate: string;
}

/** Order in which fields appear, so the first invalid one can take focus. */
const FIELD_ORDER: readonly SubscriptionField[] = [
  "customerId",
  "newCustomerName",
  "planId",
  "billing",
  "price",
  "status",
  "startDate",
];

/** Same native-select styling as the Schedule dialog (see its note on why native). */
const SELECT_CLASS =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 sm:h-8 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

const ERROR_CLASS = "text-xs text-destructive";

interface AddSubscriptionDialogProps {
  /** The workspace this page shows — the action re-checks the caller's role in it. */
  organizationId: string;
  /** The workspace's reporting currency: every price here is in it. */
  currency: string;
  /** The workspace's active customers, by name. */
  customers: readonly CustomerOption[];
  /** The workspace's active plans. */
  plans: readonly PlanOption[];
}

export function AddSubscriptionDialog({
  organizationId,
  currency,
  customers,
  plans,
}: AddSubscriptionDialogProps) {
  const [open, setOpen] = useState<boolean>(false);
  // Bumped on every open, so the form below mounts fresh each time.
  const [attempt, setAttempt] = useState<number>(0);

  function handleOpenChange(next: boolean): void {
    if (next) setAttempt((previous) => previous + 1);
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="h-11 px-4 sm:h-9">
          <Plus aria-hidden />
          Add subscription
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a subscription</DialogTitle>
          <DialogDescription>
            Starts a subscription for one of your customers. It counts toward MRR from
            its start date.
          </DialogDescription>
        </DialogHeader>

        <SubscriptionForm
          key={attempt}
          organizationId={organizationId}
          currency={currency}
          customers={customers}
          plans={plans}
          onAdded={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

interface SubscriptionFormProps extends AddSubscriptionDialogProps {
  onAdded: () => void;
}

function SubscriptionForm({
  organizationId,
  currency,
  customers,
  plans,
  onAdded,
}: SubscriptionFormProps) {
  const firstPlan = plans[0];
  const [draft, setDraft] = useState<SubscriptionDraft>(() => ({
    // A workspace with no customers yet starts on "new customer".
    customerId: customers[0]?.id ?? NEW_CUSTOMER,
    newCustomerName: "",
    planId: firstPlan?.id ?? CUSTOM_PRICE,
    price: firstPlan ? centsToPriceInput(firstPlan.amountCents) : "",
    billing: "MONTH_1",
    status: "ACTIVE",
    startDate: todayUtc(),
  }));
  const [clientErrors, setClientErrors] = useState<SubscriptionFieldErrors>({});

  const plan = plans.find((candidate) => candidate.id === draft.planId) ?? null;
  const isCustom = draft.planId === CUSTOM_PRICE;
  const isNewCustomer = draft.customerId === NEW_CUSTOMER;
  const terms = plan ?? billingOption(draft.billing);
  const suffix = formatIntervalSuffix(terms.interval, terms.intervalCount);

  // Closing and confirming happen in the action's own completion path — after
  // the server has said yes — rather than in an effect watching the state.
  const [state, formAction, pending] = useActionState(
    async (previous: SubscriptionFormState, formData: FormData): Promise<SubscriptionFormState> => {
      const result = await addSubscription(previous, formData);
      if (result.status === "success") {
        const customerName = isNewCustomer
          ? draft.newCustomerName.trim()
          : (customers.find((customer) => customer.id === draft.customerId)?.name ?? "Customer");
        const cents = draft.price === "" && plan ? plan.amountCents : priceToCents(draft.price);
        toast.success("Subscription added", {
          description: `${customerName} · ${plan?.name ?? "Custom"} · ${formatMoney(cents, currency)}/${suffix}`,
        });
        onAdded();
      }
      return result;
    },
    IDLE_SUBSCRIPTION_FORM,
  );

  const baseId = useId();
  const fieldId = (field: SubscriptionField): string => `${baseId}-${field}`;
  const errorId = (field: SubscriptionField): string => `${baseId}-${field}-error`;

  const errors: SubscriptionFieldErrors = { ...clientErrors, ...state.fieldErrors };

  function clearError(field: SubscriptionField): void {
    if (clientErrors[field]) setClientErrors((previous) => ({ ...previous, [field]: undefined }));
  }

  function set<K extends keyof SubscriptionDraft>(field: K, value: SubscriptionDraft[K]): void {
    setDraft((previous) => ({ ...previous, [field]: value }));
    clearError(field);
  }

  // Choosing a plan re-quotes its price; the price stays editable afterwards
  // (a discount is a real thing). "Custom price" clears it to be typed.
  function handlePlanChange(event: ChangeEvent<HTMLSelectElement>): void {
    const planId = event.target.value;
    const next = plans.find((candidate) => candidate.id === planId);
    setDraft((previous) => ({
      ...previous,
      planId,
      price: next ? centsToPriceInput(next.amountCents) : "",
    }));
    clearError("planId");
    clearError("price");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (pending) {
      event.preventDefault();
      return;
    }
    const result = subscriptionSchema.safeParse(draft);
    if (result.success) {
      setClientErrors({});
      return; // let the form action run
    }

    event.preventDefault();
    const nextErrors = subscriptionFieldErrors(result.error);
    setClientErrors(nextErrors);
    const firstInvalid = FIELD_ORDER.find((field) => nextErrors[field]);
    if (firstInvalid) {
      const control = event.currentTarget.elements.namedItem(firstInvalid);
      if (control instanceof HTMLElement) control.focus();
    }
  }

  function describedBy(field: SubscriptionField): string | undefined {
    return errors[field] ? errorId(field) : undefined;
  }

  function fieldError(field: SubscriptionField) {
    return errors[field] ? (
      <p id={errorId(field)} className={ERROR_CLASS}>
        {errors[field]}
      </p>
    ) : null;
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="grid gap-4">
      <input type="hidden" name="organizationId" value={organizationId} />

      {state.message ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{state.message}</span>
        </p>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor={fieldId("customerId")}>Customer</Label>
        <select
          id={fieldId("customerId")}
          name="customerId"
          value={draft.customerId}
          onChange={(event) => set("customerId", event.target.value)}
          aria-invalid={errors.customerId ? true : undefined}
          aria-describedby={describedBy("customerId")}
          className={SELECT_CLASS}
        >
          <option value={NEW_CUSTOMER}>New customer…</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
        {fieldError("customerId")}
      </div>

      {isNewCustomer ? (
        <div className="grid gap-2">
          <Label htmlFor={fieldId("newCustomerName")}>New customer&apos;s name</Label>
          <Input
            id={fieldId("newCustomerName")}
            name="newCustomerName"
            type="text"
            autoComplete="organization"
            maxLength={CUSTOMER_NAME_MAX}
            value={draft.newCustomerName}
            onChange={(event) => set("newCustomerName", event.target.value)}
            aria-invalid={errors.newCustomerName ? true : undefined}
            aria-describedby={describedBy("newCustomerName")}
            className="h-11 sm:h-8"
          />
          {fieldError("newCustomerName")}
        </div>
      ) : null}

      <div className={cn("grid gap-4", isCustom && "sm:grid-cols-2")}>
        <div className="grid gap-2">
          <Label htmlFor={fieldId("planId")}>Plan</Label>
          <select
            id={fieldId("planId")}
            name="planId"
            value={draft.planId}
            onChange={handlePlanChange}
            aria-invalid={errors.planId ? true : undefined}
            aria-describedby={describedBy("planId")}
            className={SELECT_CLASS}
          >
            {plans.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} — {formatMoney(option.amountCents, currency)}/
                {formatIntervalSuffix(option.interval, option.intervalCount)}
              </option>
            ))}
            <option value={CUSTOM_PRICE}>Custom price</option>
          </select>
          {fieldError("planId")}
        </div>

        {isCustom ? (
          <div className="grid gap-2">
            <Label htmlFor={fieldId("billing")}>Billing</Label>
            <select
              id={fieldId("billing")}
              name="billing"
              value={draft.billing}
              onChange={(event) => set("billing", event.target.value as BillingKey)}
              aria-invalid={errors.billing ? true : undefined}
              aria-describedby={describedBy("billing")}
              className={SELECT_CLASS}
            >
              {BILLING_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            {fieldError("billing")}
          </div>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor={fieldId("price")}>
          Price ({currency}/{suffix})
        </Label>
        <Input
          id={fieldId("price")}
          name="price"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={draft.price}
          onChange={(event) => set("price", event.target.value)}
          aria-invalid={errors.price ? true : undefined}
          aria-describedby={cn(`${baseId}-price-hint`, errors.price && errorId("price"))}
          className="h-11 font-mono tabular-nums sm:h-8"
        />
        <p id={`${baseId}-price-hint`} className="text-xs text-muted-foreground">
          {plan
            ? `List price ${formatMoney(plan.amountCents, currency)}/${suffix}. Change it for a discounted deal.`
            : "A negotiated price with no plan. It is reported as Custom in the plan mix."}
        </p>
        {fieldError("price")}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={fieldId("status")}>Status</Label>
          <select
            id={fieldId("status")}
            name="status"
            value={draft.status}
            onChange={(event) => set("status", event.target.value as SubscriptionDraft["status"])}
            aria-invalid={errors.status ? true : undefined}
            aria-describedby={describedBy("status")}
            className={SELECT_CLASS}
          >
            {START_STATUSES.map((status) => (
              <option key={status} value={status}>
                {formatEnumLabel(status)}
              </option>
            ))}
          </select>
          {fieldError("status")}
        </div>

        <div className="grid gap-2">
          <Label htmlFor={fieldId("startDate")}>Start date (UTC)</Label>
          <Input
            id={fieldId("startDate")}
            name="startDate"
            type="date"
            min={todayUtc()}
            value={draft.startDate}
            onChange={(event) => set("startDate", event.target.value)}
            aria-invalid={errors.startDate ? true : undefined}
            aria-describedby={describedBy("startDate")}
            className="h-11 sm:h-8"
          />
          {fieldError("startDate")}
        </div>
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" className="h-11 sm:h-8">
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="submit"
          aria-disabled={pending ? "true" : undefined}
          className="h-11 bg-brand text-brand-foreground hover:bg-brand/90 sm:h-8"
        >
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {pending ? "Adding…" : "Add subscription"}
        </Button>
      </DialogFooter>
    </form>
  );
}

"use client";

// "Add subscription" — records a new Subscription for the workspace on screen.
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
import { formatEnumLabel, formatMoney } from "@/lib/format";
import { PLAN_PRICE_CENTS } from "@/lib/plan-pricing";
import { addSubscription } from "@/lib/subscription-actions";
import {
  BILLING_INTERVALS,
  IDLE_SUBSCRIPTION_FORM,
  PLAN_TIERS,
  START_STATUSES,
  centsToPriceInput,
  subscriptionFieldErrors,
  subscriptionSchema,
  todayUtc,
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

type Tier = (typeof PLAN_TIERS)[number];
type Interval = (typeof BILLING_INTERVALS)[number];

interface SubscriptionDraft {
  tier: Tier;
  interval: Interval;
  status: (typeof START_STATUSES)[number];
  price: string;
  startDate: string;
}

/** Order in which fields appear, so the first invalid one can take focus. */
const FIELD_ORDER: readonly SubscriptionField[] = ["tier", "interval", "price", "status", "startDate"];

/** Same native-select styling as the Schedule dialog (see its note on why native). */
const SELECT_CLASS =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 sm:h-8 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

const ERROR_CLASS = "text-xs text-destructive";

const INTERVAL_SUFFIX: Record<Interval, string> = { MONTHLY: "mo", YEARLY: "yr" };

function listPrice(tier: Tier, interval: Interval): string {
  return centsToPriceInput(PLAN_PRICE_CENTS[interval][tier]);
}

function initialDraft(): SubscriptionDraft {
  return {
    tier: "STARTER",
    interval: "MONTHLY",
    status: "ACTIVE",
    price: listPrice("STARTER", "MONTHLY"),
    startDate: todayUtc(),
  };
}

interface AddSubscriptionDialogProps {
  /** The workspace this page shows — the action re-checks the caller's role in it. */
  organizationId: string;
}

export function AddSubscriptionDialog({ organizationId }: AddSubscriptionDialogProps) {
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
            Starts a new subscription in this workspace. It counts toward MRR from its
            start date.
          </DialogDescription>
        </DialogHeader>

        <SubscriptionForm
          key={attempt}
          organizationId={organizationId}
          onAdded={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

interface SubscriptionFormProps {
  organizationId: string;
  onAdded: () => void;
}

function SubscriptionForm({ organizationId, onAdded }: SubscriptionFormProps) {
  const [draft, setDraft] = useState<SubscriptionDraft>(initialDraft);
  const [clientErrors, setClientErrors] = useState<SubscriptionFieldErrors>({});

  // Closing and confirming happen in the action's own completion path — after
  // the server has said yes — rather than in an effect watching the state.
  const [state, formAction, pending] = useActionState(
    async (previous: SubscriptionFormState, formData: FormData): Promise<SubscriptionFormState> => {
      const result = await addSubscription(previous, formData);
      if (result.status === "success") {
        toast.success("Subscription added", {
          description: `${formatEnumLabel(draft.tier)} · ${formatMoney(
            Math.round(Number(draft.price) * 100),
            "USD",
          )}/${INTERVAL_SUFFIX[draft.interval]}`,
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
  const isFree = draft.tier === "FREE";

  function clearError(field: SubscriptionField): void {
    if (clientErrors[field]) setClientErrors((previous) => ({ ...previous, [field]: undefined }));
  }

  // Changing the plan or the interval re-quotes the list price; the price stays
  // editable afterwards (a discount is a real thing), except on Free.
  function handlePlanChange(field: "tier" | "interval") {
    return (event: ChangeEvent<HTMLSelectElement>): void => {
      const value = event.target.value;
      setDraft((previous) => {
        const tier = field === "tier" ? (value as Tier) : previous.tier;
        const interval = field === "interval" ? (value as Interval) : previous.interval;
        return { ...previous, tier, interval, price: listPrice(tier, interval) };
      });
      clearError(field);
      clearError("price");
    };
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

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={fieldId("tier")}>Plan</Label>
          <select
            id={fieldId("tier")}
            name="tier"
            value={draft.tier}
            onChange={handlePlanChange("tier")}
            aria-invalid={errors.tier ? true : undefined}
            aria-describedby={describedBy("tier")}
            className={SELECT_CLASS}
          >
            {PLAN_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {formatEnumLabel(tier)}
              </option>
            ))}
          </select>
          {fieldError("tier")}
        </div>

        <div className="grid gap-2">
          <Label htmlFor={fieldId("interval")}>Billing</Label>
          <select
            id={fieldId("interval")}
            name="interval"
            value={draft.interval}
            onChange={handlePlanChange("interval")}
            aria-invalid={errors.interval ? true : undefined}
            aria-describedby={describedBy("interval")}
            className={SELECT_CLASS}
          >
            {BILLING_INTERVALS.map((interval) => (
              <option key={interval} value={interval}>
                {formatEnumLabel(interval)}
              </option>
            ))}
          </select>
          {fieldError("interval")}
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={fieldId("price")}>
          Price (USD per {draft.interval === "YEARLY" ? "year" : "month"})
        </Label>
        <Input
          id={fieldId("price")}
          name="price"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={draft.price}
          readOnly={isFree}
          onChange={(event) => {
            const { value } = event.target;
            setDraft((previous) => ({ ...previous, price: value }));
            clearError("price");
          }}
          aria-invalid={errors.price ? true : undefined}
          aria-describedby={cn(`${baseId}-price-hint`, errors.price && errorId("price"))}
          className={cn("h-11 font-mono tabular-nums sm:h-8", isFree && "text-muted-foreground")}
        />
        <p id={`${baseId}-price-hint`} className="text-xs text-muted-foreground">
          {isFree
            ? "The Free plan never bills."
            : `List price ${formatMoney(PLAN_PRICE_CENTS[draft.interval][draft.tier], "USD")}/${INTERVAL_SUFFIX[draft.interval]}. Yearly plans count as one twelfth toward MRR.`}
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
            onChange={(event) => {
              const value = event.target.value as SubscriptionDraft["status"];
              setDraft((previous) => ({ ...previous, status: value }));
              clearError("status");
            }}
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
            onChange={(event) => {
              const { value } = event.target;
              setDraft((previous) => ({ ...previous, startDate: value }));
              clearError("startDate");
            }}
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

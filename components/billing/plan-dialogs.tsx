"use client";

// Create and edit a plan, and delete an unused one.
//
// A plan is a price list entry. Subscriptions COPY its price when they start, so
// the edit dialog says plainly that repricing reaches new subscriptions only.
import type { BillingInterval } from "@prisma/client";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { MAX_INTERVAL_COUNT, PLAN_NAME_MAX, planSchema, priceInput } from "@/lib/billing-form";
import { formatIntervalWords } from "@/lib/format";
import { moneyInputExample } from "@/lib/money";
import { createPlan, deletePlan, updatePlan } from "@/lib/plan-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormDialog, INPUT_CLASS, SELECT_CLASS } from "@/components/billing/form-dialog";

export interface PlanView {
  readonly id: string;
  readonly name: string;
  readonly amountCents: number;
  readonly interval: BillingInterval;
  readonly intervalCount: number;
}

interface PlanFormDialogProps {
  organizationId: string;
  currency: string;
  /** Omitted to create a new plan. */
  plan?: PlanView;
  openOnMount?: boolean;
}

export function PlanFormDialog({ organizationId, currency, plan, openOnMount }: PlanFormDialogProps) {
  const editing = plan !== undefined;
  return (
    <FormDialog
      openOnMount={openOnMount}
      trigger={
        editing ? (
          <Button type="button" variant="outline" aria-label={`Edit ${plan.name}`} className="h-11 px-2.5 sm:h-8">
            <Pencil aria-hidden />
            <span className="hidden lg:inline">Edit</span>
          </Button>
        ) : (
          <Button type="button" className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9">
            <Plus aria-hidden />
            Create plan
          </Button>
        )
      }
      title={editing ? `Edit ${plan.name}` : "Create a plan"}
      description={
        editing
          ? "Changing the price affects new subscriptions only. Existing subscriptions keep the price they started with."
          : "A price you sell at. Subscriptions copy it when they start, so changing it later never rewrites history."
      }
      action={editing ? updatePlan : createPlan}
      hidden={editing ? { organizationId, planId: plan.id } : { organizationId }}
      initial={{
        name: plan?.name ?? "",
        price: plan ? priceInput(plan.amountCents, currency) : "",
        interval: plan?.interval ?? "MONTH",
        intervalCount: String(plan?.intervalCount ?? 1),
      }}
      schema={planSchema(currency)}
      submitLabel={editing ? "Save plan" : "Create plan"}
      pendingLabel={editing ? "Saving…" : "Creating…"}
      successTitle={editing ? "Plan saved" : "Plan created"}
    >
      {(form) => {
        const interval: BillingInterval = form.draft.interval === "YEAR" ? "YEAR" : "MONTH";
        const count = Number(form.draft.intervalCount) || 1;
        return (
          <>
            <Field form={form} field="name" label="Name" hint="Unique in this workspace, e.g. Growth or Pro (annual).">
              <Input {...form.control("name")} type="text" maxLength={PLAN_NAME_MAX} autoComplete="off" className={INPUT_CLASS} />
            </Field>
            <Field
              form={form}
              field="price"
              label={`Price per seat (${currency} per ${formatIntervalWords(interval, count)})`}
              hint={`Like ${moneyInputExample(currency)}. Zero makes a free plan, which adds no MRR.`}
            >
              <Input
                {...form.control("price")}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                className={cn(INPUT_CLASS, "font-mono tabular-nums")}
              />
            </Field>
            <Field
              form={form}
              field="intervalCount"
              label="Bills every"
              hint="Quarterly is every 3 months."
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
                  <option value="MONTH">{count === 1 ? "month" : "months"}</option>
                  <option value="YEAR">{count === 1 ? "year" : "years"}</option>
                </select>
              </div>
            </Field>
          </>
        );
      }}
    </FormDialog>
  );
}

export function DeletePlanDialog({ organizationId, plan }: { organizationId: string; plan: PlanView }) {
  return (
    <FormDialog
      trigger={
        <Button type="button" variant="destructive" aria-label={`Delete ${plan.name}`} className="h-11 px-2.5 sm:h-8">
          <Trash2 aria-hidden />
          <span className="hidden lg:inline">Delete</span>
        </Button>
      }
      destructive
      title={`Delete ${plan.name}?`}
      description="No subscription has ever used this plan, so nothing else changes. It can't be undone."
      action={deletePlan}
      hidden={{ organizationId, planId: plan.id }}
      initial={{}}
      submitLabel="Delete plan"
      pendingLabel="Deleting…"
      successTitle="Plan deleted"
    />
  );
}

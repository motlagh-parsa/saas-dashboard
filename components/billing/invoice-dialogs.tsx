"use client";

// Record an invoice, and the per-row invoice actions: mark paid, void, mark
// uncollectible, delete.
//
// What each row OFFERS follows the same transition rules the server enforces
// (lib/billing-ops.ts `TRANSITIONS`): a paid invoice is never voided, only an
// open one becomes uncollectible, and only a draft or void one is deleted — the
// others explain why instead of offering a button that would be refused.
import { useState } from "react";
import type { InvoiceStatus } from "@prisma/client";
import { Ellipsis, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  RECORD_STATUSES,
  markPaidSchema,
  recordInvoiceSchema,
  todayUtc,
  type CustomerOption,
  type SubscriptionOption,
} from "@/lib/billing-form";
import { formatEnumLabel } from "@/lib/format";
import { moneyInputExample } from "@/lib/money";
import {
  deleteInvoice,
  markInvoicePaid,
  markInvoiceUncollectible,
  recordInvoice,
  voidInvoice,
} from "@/lib/invoice-actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Field, FormDialog, INPUT_CLASS, SELECT_CLASS } from "@/components/billing/form-dialog";

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

interface RecordInvoiceDialogProps {
  organizationId: string;
  currency: string;
  customers: readonly CustomerOption[];
  /** Every current subscription of those customers; filtered by the chosen customer. */
  subscriptions: readonly SubscriptionOption[];
  fixedCustomer?: CustomerOption;
  openOnMount?: boolean;
  tone?: "primary" | "outline";
}

export function RecordInvoiceDialog({
  organizationId,
  currency,
  customers,
  subscriptions,
  fixedCustomer,
  openOnMount,
  tone = "outline",
}: RecordInvoiceDialogProps) {
  return (
    <FormDialog
      openOnMount={openOnMount}
      trigger={
        <Button
          type="button"
          variant={tone === "primary" ? "default" : "outline"}
          className={cn("h-11 px-4 sm:h-9", tone === "primary" && "bg-brand text-brand-foreground hover:bg-brand/90")}
        >
          <Plus aria-hidden />
          Record invoice
        </Button>
      }
      title={fixedCustomer ? `Record an invoice for ${fixedCustomer.name}` : "Record an invoice"}
      description="Money billed to a customer — for a subscription period or a one-off charge. Invoices feed collections and outstanding balance, not MRR."
      action={recordInvoice}
      hidden={{ organizationId }}
      initial={{
        customerId: fixedCustomer?.id ?? customers[0]?.id ?? "",
        subscriptionId: "",
        amount: "",
        issuedDate: todayUtc(),
        dueDate: "",
        status: "OPEN",
        paidDate: todayUtc(),
      }}
      schema={recordInvoiceSchema(currency)}
      submitLabel="Record invoice"
      pendingLabel="Recording…"
      successTitle="Invoice recorded"
    >
      {(form) => {
        const theirs = subscriptions.filter((option) => option.customerId === form.draft.customerId);
        return (
          <>
            {fixedCustomer ? (
              <input type="hidden" name="customerId" value={fixedCustomer.id} />
            ) : (
              <Field form={form} field="customerId" label="Customer">
                <select
                  {...form.control("customerId")}
                  // A subscription belongs to one customer: a new customer clears it.
                  onChange={(event) => form.setMany({ customerId: event.target.value, subscriptionId: "" })}
                  className={SELECT_CLASS}
                >
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field form={form} field="subscriptionId" label="For">
              <select {...form.control("subscriptionId")} className={SELECT_CLASS}>
                <option value="">A one-off charge</option>
                {theirs.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field form={form} field="amount" label={`Amount (${currency})`} hint={`Like ${moneyInputExample(currency)}.`}>
                <Input
                  {...form.control("amount")}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  className={cn(INPUT_CLASS, "font-mono tabular-nums")}
                />
              </Field>
              <Field form={form} field="status" label="Status">
                <select {...form.control("status")} className={SELECT_CLASS}>
                  {RECORD_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {formatEnumLabel(status)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field form={form} field="issuedDate" label="Issued (UTC)">
                <Input {...form.control("issuedDate")} type="date" className={INPUT_CLASS} />
              </Field>
              <Field form={form} field="dueDate" label="Due (optional)">
                <Input {...form.control("dueDate")} type="date" className={INPUT_CLASS} />
              </Field>
            </div>

            {form.draft.status === "PAID" ? (
              <Field form={form} field="paidDate" label="Paid on (UTC)">
                <Input {...form.control("paidDate")} type="date" max={todayUtc()} className={INPUT_CLASS} />
              </Field>
            ) : (
              // Not rendered, so not posted: a draft or open invoice has no paid date.
              null
            )}
          </>
        );
      }}
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------------

type RowDialog = "paid" | "void" | "uncollectible" | "delete" | null;

interface InvoiceRowActionsProps {
  organizationId: string;
  invoiceId: string;
  /** "#a1b2c3d4 · Acme" — names the invoice in the dialogs. */
  label: string;
  status: InvoiceStatus;
  /** `YYYY-MM-DD` — the earliest a paid date may be. */
  issuedDay: string;
}

const CAN = {
  paid: ["DRAFT", "OPEN", "UNCOLLECTIBLE"],
  void: ["DRAFT", "OPEN"],
  uncollectible: ["OPEN"],
  delete: ["DRAFT", "VOID"],
} as const satisfies Record<Exclude<RowDialog, null>, readonly InvoiceStatus[]>;

function allows(kind: Exclude<RowDialog, null>, status: InvoiceStatus): boolean {
  return (CAN[kind] as readonly InvoiceStatus[]).includes(status);
}

export function InvoiceRowActions({ organizationId, invoiceId, label, status, issuedDay }: InvoiceRowActionsProps) {
  const [dialog, setDialog] = useState<RowDialog>(null);
  const hidden = { organizationId, invoiceId };
  const close = (open: boolean): void => {
    if (!open) setDialog(null);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label={`Actions for invoice ${label}`} className="size-11 sm:size-8">
            <Ellipsis aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>{formatEnumLabel(status)} invoice</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!allows("paid", status)} onSelect={() => setDialog("paid")}>
            Mark paid…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!allows("void", status)} onSelect={() => setDialog("void")}>
            Void…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!allows("uncollectible", status)} onSelect={() => setDialog("uncollectible")}>
            Mark uncollectible…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!allows("delete", status)}
            onSelect={() => setDialog("delete")}
            className="text-negative focus:text-negative"
          >
            Delete…
          </DropdownMenuItem>
          {!allows("delete", status) ? (
            <p className="px-2 pt-1 pb-1.5 text-[0.6875rem] text-muted-foreground text-balance">
              Only draft or void invoices can be deleted{status === "PAID" ? " — a paid one is a record of money received" : status === "OPEN" ? " — void it first if it was a mistake" : ""}.
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <FormDialog
        open={dialog === "paid"}
        onOpenChange={close}
        title={`Mark ${label} paid`}
        description="Counts as collected on the paid date."
        action={markInvoicePaid}
        hidden={hidden}
        initial={{ paidDate: todayUtc() }}
        schema={markPaidSchema()}
        submitLabel="Mark paid"
        pendingLabel="Saving…"
        successTitle="Invoice paid"
      >
        {(form) => (
          <Field form={form} field="paidDate" label="Paid on (UTC)">
            <Input {...form.control("paidDate")} type="date" min={issuedDay} max={todayUtc()} className={INPUT_CLASS} />
          </Field>
        )}
      </FormDialog>

      <FormDialog
        open={dialog === "void"}
        onOpenChange={close}
        destructive
        title={`Void ${label}?`}
        description="The invoice stays on record as void and no longer counts as outstanding. Use it for an invoice sent in error."
        action={voidInvoice}
        hidden={hidden}
        initial={{}}
        submitLabel="Void invoice"
        pendingLabel="Voiding…"
        successTitle="Invoice voided"
      />

      <FormDialog
        open={dialog === "uncollectible"}
        onOpenChange={close}
        destructive
        title={`Mark ${label} uncollectible?`}
        description="For money you don't expect to receive. It leaves the outstanding balance; if it is paid after all, mark it paid."
        action={markInvoiceUncollectible}
        hidden={hidden}
        initial={{}}
        submitLabel="Mark uncollectible"
        pendingLabel="Saving…"
        successTitle="Marked uncollectible"
      />

      <FormDialog
        open={dialog === "delete"}
        onOpenChange={close}
        destructive
        title={`Delete ${label}?`}
        description="The invoice is removed for good. Only draft and void invoices can be deleted."
        action={deleteInvoice}
        hidden={hidden}
        initial={{}}
        submitLabel="Delete invoice"
        pendingLabel="Deleting…"
        successTitle="Invoice deleted"
      />
    </>
  );
}

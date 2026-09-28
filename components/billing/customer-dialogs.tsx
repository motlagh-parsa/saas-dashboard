"use client";

// Add, edit and delete a customer.
//
// Delete is for mistakes: the dialog says how many subscriptions and invoices go
// with the customer and will not submit until their name is typed exactly —
// which the server re-checks against the stored name.
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { createCustomer, deleteCustomer, updateCustomer } from "@/lib/customer-actions";
import { CUSTOMER_NAME_MAX, EMAIL_MAX, customerSchema } from "@/lib/billing-form";
import { CUSTOMERS_PATH } from "@/lib/customer-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormDialog, INPUT_CLASS } from "@/components/billing/form-dialog";

const PRIMARY = "h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9";

interface CustomerFormDialogProps {
  organizationId: string;
  /** Omitted to add a new customer. */
  customer?: { readonly id: string; readonly name: string; readonly email: string | null };
  openOnMount?: boolean;
  /** Smaller trigger for a page header beside other controls. */
  compact?: boolean;
}

export function CustomerFormDialog({ organizationId, customer, openOnMount, compact }: CustomerFormDialogProps) {
  const editing = customer !== undefined;
  return (
    <FormDialog
      openOnMount={openOnMount}
      trigger={
        editing ? (
          <Button type="button" variant="outline" className="h-11 px-3 sm:h-8">
            <Pencil aria-hidden />
            Edit
          </Button>
        ) : (
          <Button type="button" className={cn(PRIMARY, compact && "sm:h-8")}>
            <Plus aria-hidden />
            Add customer
          </Button>
        )
      }
      title={editing ? `Edit ${customer.name}` : "Add a customer"}
      description={
        editing
          ? "Changes the name and email everywhere they appear. History and metrics are unaffected."
          : "Someone who pays you. Add their subscription next — they count toward MRR from its start date."
      }
      action={editing ? updateCustomer : createCustomer}
      hidden={editing ? { organizationId, customerId: customer.id } : { organizationId }}
      initial={{ name: customer?.name ?? "", email: customer?.email ?? "" }}
      schema={customerSchema()}
      submitLabel={editing ? "Save" : "Add customer"}
      pendingLabel={editing ? "Saving…" : "Adding…"}
      successTitle={editing ? "Customer saved" : "Customer added"}
    >
      {(form) => (
        <>
          <Field form={form} field="name" label="Name">
            <Input
              {...form.control("name")}
              type="text"
              autoComplete="organization"
              maxLength={CUSTOMER_NAME_MAX}
              className={INPUT_CLASS}
            />
          </Field>
          <Field form={form} field="email" label="Billing email (optional)">
            <Input
              {...form.control("email")}
              type="email"
              autoComplete="email"
              maxLength={EMAIL_MAX}
              className={INPUT_CLASS}
            />
          </Field>
        </>
      )}
    </FormDialog>
  );
}

interface DeleteCustomerDialogProps {
  organizationId: string;
  customer: { readonly id: string; readonly name: string };
  subscriptions: number;
  invoices: number;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function DeleteCustomerDialog({ organizationId, customer, subscriptions, invoices }: DeleteCustomerDialogProps) {
  const router = useRouter();
  return (
    <FormDialog
      trigger={
        <Button type="button" variant="destructive" className="h-11 px-3 sm:h-8">
          <Trash2 aria-hidden />
          Delete
        </Button>
      }
      destructive
      title={`Delete ${customer.name}?`}
      description={
        <>
          This permanently deletes the customer with{" "}
          <strong className="font-medium text-foreground">{count(subscriptions, "subscription")}</strong> and{" "}
          <strong className="font-medium text-foreground">{count(invoices, "invoice")}</strong>, and rewrites
          every metric they touched. It can&apos;t be undone. To keep their history, archive them instead.
        </>
      }
      action={deleteCustomer}
      hidden={{ organizationId, customerId: customer.id }}
      initial={{ confirmName: "" }}
      canSubmit={(draft) => draft.confirmName?.trim() === customer.name}
      submitLabel="Delete customer"
      pendingLabel="Deleting…"
      successTitle="Customer deleted"
      // The page this dialog sits on no longer exists.
      onSuccess={() => router.push(CUSTOMERS_PATH)}
    >
      {(form) => (
        <Field form={form} field="confirmName" label={<>Type <strong>{customer.name}</strong> to confirm</>}>
          <Input {...form.control("confirmName")} type="text" autoComplete="off" className={INPUT_CLASS} />
        </Field>
      )}
    </FormDialog>
  );
}

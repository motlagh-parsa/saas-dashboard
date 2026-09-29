"use client";

// The dialog every billing write goes through — add a customer, change a plan,
// cancel, record an invoice, confirm a delete.
//
// The patterns are the add-subscription and add-user dialogs', made generic:
//   - Two components. The dialog owns only `open`; the form inside is remounted
//     (fresh `key`) every time it opens, so a new attempt never inherits the
//     previous one's draft, errors or action state — no effect resets anything.
//   - Validation runs twice with one schema (lib/billing-form.ts): here on submit
//     for instant feedback, and again in the Server Action, which is the check
//     that counts. Fields are CONTROLLED because React resets uncontrolled
//     inputs after every form action, including a rejected one.
//   - Closing and toasting happen in the action's own completion path, after the
//     server has said yes — never in an effect watching the state. A refusal
//     keeps the dialog open with the reason inside it.
//   - The cancel button is first in DOM order, so Enter on the initial focus
//     never completes a destructive action.
import { useActionState, useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, TriangleAlert } from "lucide-react";
import type { z } from "zod";

import { cn } from "@/lib/utils";
import {
  IDLE_BILLING_FORM,
  fieldErrorsOf,
  type BillingAction,
  type BillingFormState,
} from "@/lib/billing-form";
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
import { Label } from "@/components/ui/label";
import { toast } from "@/components/dashboard/use-toast";

/** Same native-select styling as the other dialogs (native: it works on every phone). */
export const SELECT_CLASS =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 sm:h-8 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

export const INPUT_CLASS = "h-11 sm:h-8";

type Draft = Record<string, string>;

export interface FormApi {
  readonly draft: Readonly<Draft>;
  readonly set: (field: string, value: string) => void;
  readonly setMany: (values: Readonly<Draft>) => void;
  readonly error: (field: string) => string | undefined;
  readonly id: (field: string) => string;
  /** Props for a text input or select bound to `field`. */
  readonly control: (field: string) => {
    id: string;
    name: string;
    value: string;
    onChange: (event: { target: { value: string } }) => void;
    "aria-invalid": true | undefined;
    "aria-describedby": string | undefined;
  };
  readonly pending: boolean;
}

interface FormDialogProps {
  /** Renders its own trigger and owns `open`. Omit and pass `open` to control it. */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Start open — for `?action=…` links from the palette and empty states. */
  openOnMount?: boolean;

  title: string;
  description: ReactNode;
  action: BillingAction;
  /** Hidden fields: the organization and the record ids. */
  hidden: Readonly<Record<string, string>>;
  initial: Readonly<Draft>;
  /** The same schema the action parses with; omitted for a confirmation with no fields. */
  schema?: z.ZodType;
  submitLabel: string;
  pendingLabel: string;
  destructive?: boolean;
  /** Blocks submit until true — e.g. the typed name of a customer to delete. */
  canSubmit?: (draft: Readonly<Draft>) => boolean;
  /** Toast title on success; the action's message becomes its description. */
  successTitle: string;
  /** Runs after a success has closed the dialog — e.g. leave a page whose record was deleted. */
  onSuccess?: () => void;
  wide?: boolean;
  children?: (form: FormApi) => ReactNode;
}

export function FormDialog(props: FormDialogProps) {
  const { trigger, open: controlledOpen, onOpenChange, openOnMount = false } = props;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [innerOpen, setInnerOpen] = useState<boolean>(openOnMount);
  // Bumped on every open, so the form below mounts fresh each time.
  const [attempt, setAttempt] = useState<number>(openOnMount ? 1 : 0);
  const open = controlledOpen ?? innerOpen;

  function handleOpenChange(next: boolean): void {
    if (next) setAttempt((previous) => previous + 1);
    if (controlledOpen === undefined) setInnerOpen(next);
    onOpenChange?.(next);

    // Closing consumes `?action=…`, so a refresh or Back does not reopen a
    // dialog that was already dismissed. Every other param is kept.
    if (!next && openOnMount && searchParams.has("action")) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("action");
      const search = params.toString();
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent
        showCloseButton={!props.destructive}
        className={cn(props.wide ? "sm:max-w-lg" : "sm:max-w-md", "max-h-[92vh] overflow-y-auto")}
      >
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        {open ? (
          <DialogForm
            key={attempt}
            {...props}
            onDone={() => handleOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface DialogFormProps extends FormDialogProps {
  onDone: () => void;
}

function DialogForm({
  action,
  hidden,
  initial,
  schema,
  submitLabel,
  pendingLabel,
  destructive = false,
  canSubmit,
  successTitle,
  onSuccess,
  children,
  onDone,
}: DialogFormProps) {
  const [draft, setDraft] = useState<Draft>(() => ({ ...initial }));
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});

  const [state, formAction, pending] = useActionState(
    async (previous: BillingFormState, formData: FormData): Promise<BillingFormState> => {
      const result = await action(previous, formData);
      if (result.status === "success") {
        toast.success(successTitle, { description: result.message ?? undefined });
        onDone();
        onSuccess?.();
      }
      return result;
    },
    IDLE_BILLING_FORM,
  );

  const baseId = useId();
  const id = (field: string): string => `${baseId}-${field}`;
  const errorId = (field: string): string => `${baseId}-${field}-error`;
  // A server field error for a field the client has since edited is stale.
  const errors: Record<string, string> = { ...state.fieldErrors, ...clientErrors };
  for (const field of Object.keys(clientErrors)) {
    if (clientErrors[field] === "") delete errors[field];
  }

  function set(field: string, value: string): void {
    setDraft((previous) => ({ ...previous, [field]: value }));
    // An empty string marks "edited since the last error" — it hides a stale
    // server message for this field until the next submit.
    setClientErrors((previous) => ({ ...previous, [field]: "" }));
  }

  function setMany(values: Readonly<Draft>): void {
    setDraft((previous) => ({ ...previous, ...values }));
    setClientErrors((previous) => {
      const next = { ...previous };
      for (const field of Object.keys(values)) next[field] = "";
      return next;
    });
  }

  const form: FormApi = {
    draft,
    set,
    setMany,
    error: (field) => errors[field] || undefined,
    id,
    control: (field) => ({
      id: id(field),
      name: field,
      value: draft[field] ?? "",
      onChange: (event) => set(field, event.target.value),
      "aria-invalid": errors[field] ? true : undefined,
      "aria-describedby": errors[field] ? errorId(field) : undefined,
    }),
    pending,
  };

  const blocked = canSubmit ? !canSubmit(draft) : false;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (pending || blocked) {
      event.preventDefault();
      return;
    }
    if (schema === undefined) {
      setClientErrors({});
      return;
    }
    // The hidden fields are part of what the server parses, so they are part of
    // what is checked here — otherwise a schema that requires an id would fail
    // on the client with no control to show the error on.
    const result = schema.safeParse({ ...draft, ...hidden });
    if (result.success) {
      setClientErrors({});
      return; // let the form action run
    }
    event.preventDefault();
    const next = fieldErrorsOf(result.error);
    setClientErrors(next);
    // Focus the first invalid control in DOM order.
    const firstInvalid = Array.from(event.currentTarget.elements).find(
      (element) => element instanceof HTMLElement && "name" in element && typeof element.name === "string" && next[element.name],
    );
    if (firstInvalid instanceof HTMLElement) firstInvalid.focus();
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="grid gap-4">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {state.status === "error" && state.message ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{state.message}</span>
        </p>
      ) : null}

      {children ? children(form) : null}

      {/* Errors on fields the form has no control for — a hidden id, or the form
          as a whole — so no refusal is ever silent. */}
      {["form", ...Object.keys(hidden)]
        .filter((field) => errors[field])
        .map((field) => (
          <p key={field} role="alert" className="text-xs text-destructive">
            {errors[field]}
          </p>
        ))}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" className={INPUT_CLASS}>
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="submit"
          variant={destructive ? "destructive" : "default"}
          aria-disabled={pending || blocked ? "true" : undefined}
          className={cn(
            INPUT_CLASS,
            !destructive && "bg-brand text-brand-foreground hover:bg-brand/90",
            blocked && "opacity-50",
          )}
        >
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {pending ? pendingLabel : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

interface FieldProps {
  form: FormApi;
  field: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Label, control, optional hint, and the field's error — wired for screen readers. */
export function Field({ form, field, label, hint, children, className }: FieldProps) {
  const message = form.error(field);
  return (
    <div className={cn("grid gap-2", className)}>
      <Label htmlFor={form.id(field)}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {message ? (
        <p id={`${form.id(field)}-error`} className="text-xs text-destructive">
          {message}
        </p>
      ) : null}
    </div>
  );
}

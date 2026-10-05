"use client";

// Create and revoke API keys, from Settings → API keys.
//
// Create is two steps in one dialog: the form, then — once the server has said
// yes — the key itself, with Copy and a warning. The key exists only in that
// action response (the database keeps a hash, lib/api/keys.ts), so this is the
// one chance to copy it; closing the dialog drops it. The form is remounted on
// every open, so a second key never shows the first one's state.
//
// Revoke is the shared confirmation dialog: destructive, Cancel first.
import { useActionState, useId, useState } from "react";
import type { FocusEvent, FormEvent } from "react";
import { Check, Copy, KeyRound, Loader2, TriangleAlert } from "lucide-react";

import { createApiKey, revokeApiKey } from "@/lib/api-key-actions";
import {
  EXPIRY_OPTIONS,
  IDLE_CREATE_API_KEY,
  createApiKeySchema,
  type CreateApiKeyState,
} from "@/lib/api-key-form";
import { fieldErrorsOf } from "@/lib/billing-form";
import { cn } from "@/lib/utils";
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
import { FormDialog, INPUT_CLASS, SELECT_CLASS } from "@/components/billing/form-dialog";

interface CreateApiKeyDialogProps {
  organizationId: string;
  /** At the active-key limit: the trigger is shown disabled with the reason beside it. */
  atLimit: boolean;
}

export function CreateApiKeyDialog({ organizationId, atLimit }: CreateApiKeyDialogProps) {
  const [open, setOpen] = useState<boolean>(false);
  const [attempt, setAttempt] = useState<number>(0);

  function handleOpenChange(next: boolean): void {
    if (next) setAttempt((previous) => previous + 1);
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          disabled={atLimit}
          className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9"
        >
          <KeyRound aria-hidden />
          Create key
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md">
        {open ? <CreateKeyBody key={attempt} organizationId={organizationId} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateKeyBody({ organizationId }: { organizationId: string }) {
  const [draft, setDraft] = useState<Record<string, string>>({ name: "", scope: "WRITE", expiry: "never" });
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const [state, formAction, pending] = useActionState<CreateApiKeyState, FormData>(createApiKey, IDLE_CREATE_API_KEY);
  const baseId = useId();

  if (state.status === "success" && state.key !== null) {
    return <KeyRevealed name={draft.name?.trim() ?? ""} apiKey={state.key} />;
  }

  const errors: Record<string, string> = { ...state.fieldErrors, ...clientErrors };
  for (const [field, message] of Object.entries(clientErrors)) if (message === "") delete errors[field];

  function set(field: string, value: string): void {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setClientErrors((previous) => ({ ...previous, [field]: "" }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (pending) {
      event.preventDefault();
      return;
    }
    const result = createApiKeySchema.safeParse(draft);
    if (result.success) {
      setClientErrors({});
      return;
    }
    event.preventDefault();
    setClientErrors(fieldErrorsOf(result.error));
  }

  const control = (field: string) => ({
    id: `${baseId}-${field}`,
    name: field,
    value: draft[field] ?? "",
    "aria-invalid": errors[field] ? (true as const) : undefined,
    "aria-describedby": errors[field] ? `${baseId}-${field}-error` : undefined,
  });
  const fieldError = (field: string) =>
    errors[field] ? (
      <p id={`${baseId}-${field}-error`} className="text-xs text-destructive">
        {errors[field]}
      </p>
    ) : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create API key</DialogTitle>
        <DialogDescription>
          Your backend sends it as <code className="font-mono text-xs">Authorization: Bearer mrd_…</code>. It acts on
          this workspace only.
        </DialogDescription>
      </DialogHeader>
      <form action={formAction} onSubmit={handleSubmit} noValidate className="grid gap-4">
        <input type="hidden" name="organizationId" value={organizationId} />
        {state.status === "error" && state.message ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{state.message}</span>
          </p>
        ) : null}

        <div className="grid gap-2">
          <Label htmlFor={`${baseId}-name`}>Name</Label>
          <Input
            {...control("name")}
            onChange={(event) => set("name", event.target.value)}
            placeholder="Production backend"
            autoComplete="off"
            className={INPUT_CLASS}
          />
          {fieldError("name")}
        </div>

        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">Access</legend>
          {(
            [
              { value: "WRITE", label: "Read and write", hint: "Push customers, plans, subscriptions and invoices; read metrics." },
              { value: "READ", label: "Read only", hint: "Read records and metrics. Writes are refused with 403." },
            ] as const
          ).map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 text-sm",
                draft.scope === option.value && "border-brand/60 bg-brand/5",
              )}
            >
              <input
                type="radio"
                name="scope"
                value={option.value}
                checked={draft.scope === option.value}
                onChange={() => set("scope", option.value)}
                className="mt-1 accent-[var(--brand)]"
              />
              <span className="grid gap-0.5">
                <span className="font-medium">{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.hint}</span>
              </span>
            </label>
          ))}
          {fieldError("scope")}
        </fieldset>

        <div className="grid gap-2">
          <Label htmlFor={`${baseId}-expiry`}>Expires</Label>
          <select {...control("expiry")} onChange={(event) => set("expiry", event.target.value)} className={SELECT_CLASS}>
            {EXPIRY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {fieldError("expiry")}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" className={INPUT_CLASS}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="submit"
            aria-disabled={pending ? "true" : undefined}
            className={cn(INPUT_CLASS, "bg-brand text-brand-foreground hover:bg-brand/90")}
          >
            {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {pending ? "Creating…" : "Create key"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

type CopyState = "idle" | "copied" | "failed";

function KeyRevealed({ name, apiKey }: { name: string; apiKey: string }) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const inputId = useId();
  const hintId = useId();

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Copy your new key</DialogTitle>
        <DialogDescription>{name} is ready. Store it in your backend&apos;s secrets.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <Label htmlFor={inputId}>API key</Label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            data-testid="new-api-key"
            readOnly
            value={apiKey}
            onFocus={(event: FocusEvent<HTMLInputElement>) => event.currentTarget.select()}
            aria-describedby={hintId}
            className="h-11 min-w-0 font-mono text-xs sm:h-8"
          />
          <Button type="button" variant="outline" onClick={() => void handleCopy()} className="h-11 shrink-0 px-3 sm:h-8">
            {copy === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copy === "copied" ? "Copied" : "Copy"}
          </Button>
        </div>
        <p
          id={hintId}
          aria-live="polite"
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs",
            copy === "failed"
              ? "border-destructive/25 bg-destructive/10 text-destructive"
              : "border-brand/30 bg-brand/10 text-foreground",
          )}
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            {copy === "failed"
              ? "Couldn't copy automatically. Select the key and copy it yourself — "
              : "This is the only time the key is shown. Meridian keeps only a fingerprint of it, so "}
            if it is lost, revoke it and create another. Anyone holding it can act on this workspace&apos;s billing data.
          </span>
        </p>
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" className="h-11 bg-brand text-brand-foreground hover:bg-brand/90 sm:h-8">
            Done
          </Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}

interface RevokeApiKeyDialogProps {
  organizationId: string;
  keyId: string;
  name: string;
  prefix: string;
}

export function RevokeApiKeyDialog({ organizationId, keyId, name, prefix }: RevokeApiKeyDialogProps) {
  return (
    <FormDialog
      trigger={
        <Button type="button" variant="outline" size="sm" className="h-11 px-3 sm:h-7">
          Revoke
          <span className="sr-only"> {name}</span>
        </Button>
      }
      destructive
      title={`Revoke ${name}?`}
      description={
        <>
          Requests with <code className="font-mono text-xs">{prefix}…</code> will be refused with 401 from now on.
          Anything using it stops syncing until it has a new key. <strong className="font-medium text-foreground">This
          can&apos;t be undone.</strong>
        </>
      }
      action={revokeApiKey}
      hidden={{ organizationId, keyId }}
      initial={{}}
      submitLabel="Revoke key"
      pendingLabel="Revoking…"
      successTitle="Key revoked"
    />
  );
}

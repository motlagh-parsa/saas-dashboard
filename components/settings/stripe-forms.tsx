"use client";

// The interactive parts of Settings → Integrations → Stripe. Each is one form
// posting to lib/stripe-actions.ts; results show inline (and as a toast where
// the page changes under them).
import { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";

import { connectStripe, disconnectStripe, saveStripeWebhookSecret, syncStripeNow } from "@/lib/stripe-actions";
import { IDLE_STRIPE_FORM, type StripeFormState } from "@/lib/stripe-form";
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

type Action = (previous: StripeFormState, formData: FormData) => Promise<StripeFormState>;

function Result({ state }: { state: StripeFormState }) {
  if (state.message === null) return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "text-xs text-destructive" : "text-xs text-positive"}>
      {state.message}
    </p>
  );
}

function SecretField({
  id,
  name,
  label,
  placeholder,
  hint,
  action,
  organizationId,
  submitLabel,
  pendingLabel,
}: {
  id: string;
  name: string;
  label: string;
  placeholder: string;
  hint: string;
  action: Action;
  organizationId: string;
  submitLabel: string;
  pendingLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE_STRIPE_FORM);
  const [value, setValue] = useState("");
  return (
    <form action={formAction} className="flex flex-col gap-2" data-testid={`${id}-form`}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <Label htmlFor={id}>{label}</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={id}
          name={name}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-invalid={state.fieldError ? true : undefined}
          aria-describedby={`${id}-hint${state.fieldError ? ` ${id}-error` : ""}`}
          className="h-11 min-w-0 flex-1 font-mono text-xs sm:h-9"
        />
        <Button type="submit" aria-disabled={pending ? "true" : undefined} className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9">
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {pending ? pendingLabel : submitLabel}
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
      {state.fieldError ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {state.fieldError}
        </p>
      ) : null}
      <Result state={state} />
    </form>
  );
}

export function ConnectStripeForm({ organizationId }: { organizationId: string }) {
  return (
    <SecretField
      id="stripe-key"
      name="key"
      label="Restricted key"
      placeholder="rk_live_… or rk_test_…"
      hint="Stored encrypted and never shown again — only its last four characters."
      action={connectStripe}
      organizationId={organizationId}
      submitLabel="Connect Stripe"
      pendingLabel="Checking…"
    />
  );
}

export function WebhookSecretForm({ organizationId, saved }: { organizationId: string; saved: boolean }) {
  return (
    <SecretField
      id="stripe-webhook-secret"
      name="secret"
      label={saved ? "Replace the signing secret" : "Signing secret"}
      placeholder="whsec_…"
      hint="Shown in Stripe after you add the endpoint. Stored encrypted."
      action={saveStripeWebhookSecret}
      organizationId={organizationId}
      submitLabel="Save secret"
      pendingLabel="Saving…"
    />
  );
}

export function SyncNowButton({ organizationId, running }: { organizationId: string; running: boolean }) {
  const [state, formAction, pending] = useActionState(syncStripeNow, IDLE_STRIPE_FORM);
  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="organizationId" value={organizationId} />
      <Button type="submit" variant="outline" aria-disabled={pending || running ? "true" : undefined} className="h-11 px-4 sm:h-9">
        {pending || running ? <Loader2 aria-hidden className="animate-spin" /> : null}
        {running ? "Syncing…" : "Sync now"}
      </Button>
      <Result state={state} />
    </form>
  );
}

export function DisconnectStripeDialog({ organizationId }: { organizationId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(async (previous: StripeFormState, formData: FormData) => {
    const result = await disconnectStripe(previous, formData);
    if (result.status === "success") {
      toast.success("Stripe disconnected", { description: result.message ?? undefined });
      setOpen(false);
    }
    return result;
  }, IDLE_STRIPE_FORM);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="destructive" className="h-11 px-4 sm:h-9">
          Disconnect Stripe
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect Stripe?</DialogTitle>
          <DialogDescription>
            Meridian stops syncing and deletes the stored key. Everything already synced stays — customers, plans,
            subscriptions and invoices — and you can still edit it by hand. Remove the webhook endpoint in Stripe too.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction}>
          <input type="hidden" name="organizationId" value={organizationId} />
          <Result state={state} />
          <DialogFooter className="mt-4">
            <DialogClose asChild>
              <Button type="button" variant="outline" className="h-11 sm:h-8">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" aria-disabled={pending ? "true" : undefined} className="h-11 sm:h-8">
              {pending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

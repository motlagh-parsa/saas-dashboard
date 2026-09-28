"use client";

// "Edit user" — renames someone from their row on /dashboard/users.
//
// Same shape as the add-user dialog: the dialog owns `open`, and the form is
// remounted on every open, so it always starts from the CURRENT name — never a
// draft left over from a cancelled edit. `User.name` is account-wide, which the
// description says, because the new name shows in every workspace they belong to.
import { useActionState, useId, useState } from "react";
import type { FormEvent } from "react";
import { Loader2, Pencil, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { updateUser } from "@/lib/user-actions";
import {
  IDLE_USER_FORM,
  USER_NAME_MAX,
  updateUserSchema,
  userFormFieldErrors,
  type UserFormFieldErrors,
  type UserFormState,
} from "@/lib/user-form";
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

interface EditUserDialogProps {
  organizationId: string;
  userId: string;
  /** The stored name, which may be null — the field then starts empty. */
  currentName: string | null;
  /** What the row shows for them (falls back to the email's local part). */
  displayName: string;
  /** Row-level lock while another action on this row is in flight. */
  disabled: boolean;
  /** Matches the other row controls' height. */
  className?: string;
}

export function EditUserDialog({
  organizationId,
  userId,
  currentName,
  displayName,
  disabled,
  className,
}: EditUserDialogProps) {
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
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={`Edit ${displayName}`}
          className={cn("px-2.5", className)}
        >
          <Pencil aria-hidden />
          <span className="hidden lg:inline">Edit</span>
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {displayName}</DialogTitle>
          <DialogDescription>
            Their name changes everywhere it appears, in every workspace they belong to.
          </DialogDescription>
        </DialogHeader>

        <EditUserForm
          key={attempt}
          organizationId={organizationId}
          userId={userId}
          currentName={currentName ?? ""}
          onSaved={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

interface EditUserFormProps {
  organizationId: string;
  userId: string;
  currentName: string;
  onSaved: () => void;
}

function EditUserForm({ organizationId, userId, currentName, onSaved }: EditUserFormProps) {
  const [name, setName] = useState<string>(currentName);
  const [clientErrors, setClientErrors] = useState<UserFormFieldErrors>({});

  // Closing and confirming happen in the action's own completion path — after
  // the server has said yes — rather than in an effect watching the state.
  const [state, formAction, pending] = useActionState(
    async (previous: UserFormState, formData: FormData): Promise<UserFormState> => {
      const result = await updateUser(previous, formData);
      if (result.status === "success") {
        toast.success("User updated", { description: name.trim() });
        onSaved();
      }
      return result;
    },
    IDLE_USER_FORM,
  );

  const baseId = useId();
  const inputId = `${baseId}-name`;
  const errorId = `${baseId}-name-error`;
  const error = clientErrors.name ?? state.fieldErrors.name;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (pending) {
      event.preventDefault();
      return;
    }
    const result = updateUserSchema.safeParse({ name });
    if (result.success) {
      setClientErrors({});
      return; // let the form action run
    }

    event.preventDefault();
    setClientErrors(userFormFieldErrors(result.error));
    const control = event.currentTarget.elements.namedItem("name");
    if (control instanceof HTMLElement) control.focus();
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="grid gap-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="userId" value={userId} />

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
        <Label htmlFor={inputId}>Name</Label>
        <Input
          id={inputId}
          name="name"
          type="text"
          autoComplete="off"
          maxLength={USER_NAME_MAX}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (clientErrors.name) setClientErrors({});
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="h-11 sm:h-8"
        />
        {error ? (
          <p id={errorId} className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
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
          {pending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

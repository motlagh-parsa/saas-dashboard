"use client";

// Per-row controls on /dashboard/users: change role, suspend or unsuspend, and
// delete.
//
// What is OFFERED here is decided on the server (lib/user-permissions.ts) and
// arrives as props. Every action re-checks it in lib/user-actions.ts, which is
// the check that counts, so a prop that went stale is refused there rather than
// trusted.
//
// Feedback: role and suspension changes report through a toast, because the
// row they would otherwise annotate re-renders under them. Delete reports
// inside its confirm dialog, which stays open on a refusal so the reason is read
// in the same place the decision was made.
import { startTransition, useActionState, useId, useState } from "react";
import type { FormEvent } from "react";
import type { Role } from "@prisma/client";
import { ChevronDown, Loader2, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatEnumLabel } from "@/lib/format";
import { deleteUser, suspendUser, unsuspendUser, updateUserRole } from "@/lib/user-actions";
import { IDLE_USER_ACTION, type UserActionState } from "@/lib/user-action-state";
import { ROLES } from "@/lib/user-permissions";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/dashboard/use-toast";

/** Touch first: 44px on a phone, tightened to the table's density on a pointer. */
const CONTROL_HEIGHT = "h-11 sm:h-8";

type Action = (previous: UserActionState, formData: FormData) => Promise<UserActionState>;

interface UserRowActionsProps {
  organizationId: string;
  userId: string;
  /** Already resolved through `formatPersonName` — used in labels and toasts. */
  displayName: string;
  role: Role;
  suspended: boolean;
  /** Roles the caller may set on this person. Empty means the role is out of reach. */
  assignableRoles: readonly Role[];
  /** Whether suspend and delete are offered: the caller outranks them everywhere they belong. */
  canManageAccount: boolean;
}

export function UserRowActions({
  organizationId,
  userId,
  displayName,
  role,
  suspended,
  assignableRoles,
  canManageAccount,
}: UserRowActionsProps) {
  const canChangeRole = assignableRoles.length > 0;

  /**
   * Wraps an action so success and refusal both surface as a toast. Closing
   * over the name is fine: the row is re-rendered with fresh props after every
   * write, and the toast only needs the name as it was when pressed.
   */
  function reported(action: Action, successTitle: string): Action {
    return async (previous, formData) => {
      const result = await action(previous, formData);
      if (result.status === "success") {
        toast.success(successTitle, { description: displayName });
      } else if (result.status === "error" && result.message) {
        toast.error("Couldn't update this user", { description: result.message });
      }
      return result;
    };
  }

  const [, roleAction, rolePending] = useActionState(
    reported(updateUserRole, "Role updated"),
    IDLE_USER_ACTION,
  );
  const [, suspendAction, suspendPending] = useActionState(
    reported(suspendUser, "Account suspended"),
    IDLE_USER_ACTION,
  );
  const [, unsuspendAction, unsuspendPending] = useActionState(
    reported(unsuspendUser, "Account unsuspended"),
    IDLE_USER_ACTION,
  );

  const togglePending = suspendPending || unsuspendPending;
  const busy = rolePending || togglePending;

  function changeRole(next: string): void {
    if (busy || next === role) return;
    const formData = new FormData();
    formData.set("organizationId", organizationId);
    formData.set("userId", userId);
    formData.set("role", next);
    startTransition(() => roleAction(formData));
  }

  function guard(event: FormEvent<HTMLFormElement>): void {
    if (busy) event.preventDefault();
  }

  if (!canChangeRole && !canManageAccount) {
    return (
      <span className="font-mono text-[0.625rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">
        Owner only
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center justify-end gap-1.5">
        {canChangeRole ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                aria-label={`Change role for ${displayName}, currently ${formatEnumLabel(role)}`}
                aria-disabled={busy ? "true" : undefined}
                className={cn("gap-1 px-2.5", CONTROL_HEIGHT)}
              >
                {rolePending ? <Loader2 aria-hidden className="animate-spin" /> : null}
                {formatEnumLabel(role)}
                <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuLabel>Role in this workspace</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={role} onValueChange={changeRole}>
                {ROLES.map((option) => (
                  <DropdownMenuRadioItem
                    key={option}
                    value={option}
                    disabled={!assignableRoles.includes(option)}
                  >
                    {formatEnumLabel(option)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {canManageAccount ? (
          <>
            <form action={suspended ? unsuspendAction : suspendAction} onSubmit={guard}>
              <input type="hidden" name="organizationId" value={organizationId} />
              <input type="hidden" name="userId" value={userId} />
              <Button
                type="submit"
                variant="outline"
                aria-disabled={busy ? "true" : undefined}
                aria-label={`${suspended ? "Unsuspend" : "Suspend"} ${displayName}`}
                className={cn("px-2.5", CONTROL_HEIGHT)}
              >
                {togglePending ? <Loader2 aria-hidden className="animate-spin" /> : null}
                {suspended ? "Unsuspend" : "Suspend"}
              </Button>
            </form>

            <DeleteUserDialog
              organizationId={organizationId}
              userId={userId}
              displayName={displayName}
              disabled={busy}
            />
          </>
        ) : null}
      </div>

      {canChangeRole && !canManageAccount ? (
        <p className="max-w-56 text-right text-[0.6875rem] text-muted-foreground text-balance">
          Also in workspaces you don&apos;t manage, so suspend and delete are unavailable.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete — the only irreversible control on the page, so it asks first
// ---------------------------------------------------------------------------

interface DeleteUserDialogProps {
  organizationId: string;
  userId: string;
  displayName: string;
  disabled: boolean;
}

function DeleteUserDialog({ organizationId, userId, displayName, disabled }: DeleteUserDialogProps) {
  const [open, setOpen] = useState<boolean>(false);
  // Bumped on every open, so the form below mounts fresh and a new attempt never
  // shows the previous one's refusal — the add-subscription dialog's pattern.
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
          variant="destructive"
          disabled={disabled}
          aria-label={`Delete ${displayName}`}
          className={cn("px-2.5", CONTROL_HEIGHT)}
        >
          <Trash2 aria-hidden />
          <span className="hidden lg:inline">Delete</span>
        </Button>
      </DialogTrigger>

      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {displayName}&apos;s account?</DialogTitle>
          <DialogDescription>
            This permanently deletes the account and removes them from every workspace they
            belong to. It can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>

        <DeleteUserForm
          key={attempt}
          organizationId={organizationId}
          userId={userId}
          displayName={displayName}
          onDeleted={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

interface DeleteUserFormProps {
  organizationId: string;
  userId: string;
  displayName: string;
  onDeleted: () => void;
}

function DeleteUserForm({ organizationId, userId, displayName, onDeleted }: DeleteUserFormProps) {
  // Closing and confirming happen in the action's own completion path, after
  // the server has said yes, rather than in an effect watching the state.
  const [state, formAction, pending] = useActionState(
    async (previous: UserActionState, formData: FormData): Promise<UserActionState> => {
      const result = await deleteUser(previous, formData);
      if (result.status === "success") {
        toast.success("Account deleted", { description: displayName });
        onDeleted();
      }
      return result;
    },
    IDLE_USER_ACTION,
  );

  const errorId = useId();
  const hasError = state.status === "error";

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (pending) event.preventDefault();
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} className="grid gap-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="userId" value={userId} />

      {hasError ? (
        <p
          id={errorId}
          role="alert"
          className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          {state.message}
        </p>
      ) : null}

      <DialogFooter>
        {/* First in DOM order, so it takes focus when the dialog opens: Enter on
            the initial focus must not complete a delete. */}
        <DialogClose asChild>
          <Button type="button" variant="outline" className={CONTROL_HEIGHT}>
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="submit"
          variant="destructive"
          aria-disabled={pending ? "true" : undefined}
          aria-describedby={hasError ? errorId : undefined}
          className={CONTROL_HEIGHT}
        >
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {pending ? "Deleting…" : "Delete account"}
        </Button>
      </DialogFooter>
    </form>
  );
}

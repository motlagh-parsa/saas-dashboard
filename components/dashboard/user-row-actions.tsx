"use client";

// Per-row controls on /dashboard/users: change role, edit, resend invite,
// suspend or unsuspend, and delete.
//
// What is OFFERED here is decided on the server (lib/user-permissions.ts) and
// arrives as props. Every action re-checks it in lib/user-actions.ts, which is
// the check that counts, so a prop that went stale is refused there rather than
// trusted.
//
// Feedback: role and suspension changes report through a toast, because the
// row they would otherwise annotate re-renders under them. Edit and delete
// report inside their dialogs, which stay open on a refusal so the reason is
// read in the same place the decision was made.
import { startTransition, useActionState, useId, useState } from "react";
import type { FormEvent } from "react";
import type { Role } from "@prisma/client";
import { ChevronDown, Loader2, Send, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatEnumLabel } from "@/lib/format";
import {
  deleteUser,
  resendInvite,
  suspendUser,
  unsuspendUser,
  updateUserRole,
} from "@/lib/user-actions";
import {
  IDLE_RESEND_INVITE,
  IDLE_USER_ACTION,
  type ResendInviteState,
  type UserActionState,
} from "@/lib/user-action-state";
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
import { EditUserDialog } from "@/components/dashboard/edit-user-dialog";
import { InviteLinkPanel } from "@/components/dashboard/invite-link-panel";
import { toast } from "@/components/dashboard/use-toast";

/** Touch first: 44px on a phone, tightened to the table's density on a pointer. */
const CONTROL_HEIGHT = "h-11 sm:h-8";

type Action = (previous: UserActionState, formData: FormData) => Promise<UserActionState>;

interface UserRowActionsProps {
  organizationId: string;
  userId: string;
  /** The stored name, possibly null — what the edit dialog starts from. */
  name: string | null;
  /** Already resolved through `formatPersonName` — used in labels and toasts. */
  displayName: string;
  role: Role;
  suspended: boolean;
  /** Invited and never accepted — decided on the server; offers "Resend invite". */
  invitePending: boolean;
  /** Roles the caller may set on this person. Empty means the role is out of reach. */
  assignableRoles: readonly Role[];
  /** Whether edit, suspend and delete are offered: the caller outranks them everywhere they belong. */
  canManageAccount: boolean;
}

export function UserRowActions({
  organizationId,
  userId,
  name,
  displayName,
  role,
  suspended,
  invitePending,
  assignableRoles,
  canManageAccount,
}: UserRowActionsProps) {
  const canChangeRole = assignableRoles.length > 0;
  // The new link, once the server has issued it. Its presence opens the dialog.
  const [resentToken, setResentToken] = useState<string | null>(null);
  const [resentTo, setResentTo] = useState<string | null>(null);

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

  // Not `reported`: success opens a dialog with the link rather than a toast,
  // and it is set here, in the action's completion path, not in an effect.
  const [, resendAction, resendPending] = useActionState(
    async (previous: ResendInviteState, formData: FormData): Promise<ResendInviteState> => {
      const result = await resendInvite(previous, formData);
      if (result.status === "success" && result.token !== null) {
        setResentToken(result.token);
        setResentTo(result.emailedTo);
      } else if (result.status === "error") {
        toast.error("Could not resend invite", { description: result.message ?? undefined });
      }
      return result;
    },
    IDLE_RESEND_INVITE,
  );

  const togglePending = suspendPending || unsuspendPending;
  const busy = rolePending || togglePending || resendPending;

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
            <EditUserDialog
              organizationId={organizationId}
              userId={userId}
              currentName={name}
              displayName={displayName}
              disabled={busy}
              className={CONTROL_HEIGHT}
            />

            {invitePending ? (
              <form action={resendAction} onSubmit={guard}>
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="userId" value={userId} />
                <Button
                  type="submit"
                  variant="outline"
                  aria-disabled={busy ? "true" : undefined}
                  aria-label={`Resend invite to ${displayName}`}
                  className={cn("px-2.5", CONTROL_HEIGHT)}
                >
                  {resendPending ? (
                    <Loader2 aria-hidden className="animate-spin" />
                  ) : (
                    <Send aria-hidden />
                  )}
                  <span className="hidden lg:inline">Resend invite</span>
                </Button>
              </form>
            ) : null}

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

      <Dialog
        open={resentToken !== null}
        onOpenChange={(next) => {
          if (!next) setResentToken(null);
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          {resentToken !== null ? (
            <InviteLinkPanel
              title={`New invite for ${displayName}`}
              description={
                resentTo !== null
                  ? `We've emailed a new invite to ${resentTo}. You can also share this link yourself. It expires in 7 days, and the previous link no longer works.`
                  : "Share this link with the user. It expires in 7 days, and the previous link no longer works."
              }
              token={resentToken}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {canChangeRole && !canManageAccount ? (
        <p className="max-w-56 text-right text-[0.6875rem] text-muted-foreground text-balance">
          Also in workspaces you don&apos;t manage, so edit, suspend and delete are unavailable.
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

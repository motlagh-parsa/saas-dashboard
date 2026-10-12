"use client";

// "Add user" — creates a new account in the workspace on screen.
//
// Two components on purpose, the add-subscription dialog's pattern: the dialog
// owns only `open`, and the form inside is remounted (fresh `key`) every time
// it opens, so a new attempt never inherits the last one's draft or errors.
//
// Validation runs twice with one schema (lib/user-form.ts): here on submit for
// instant feedback, and again in `createUser`, which is the check that counts.
// Fields are CONTROLLED because React resets uncontrolled inputs after every
// form action, including a rejected one.
//
// Two steps in one dialog. A successful add swaps the form for the invite link:
// the raw token exists only in that one response (the database keeps a hash),
// so this is the admin's only chance to copy it. Closing the dialog drops it,
// and reopening starts a fresh add.
import { useActionState, useId, useState } from "react";
import type { FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Role } from "@prisma/client";
import { Loader2, Plus, TriangleAlert } from "lucide-react";

import { formatEnumLabel } from "@/lib/format";
import { createUser } from "@/lib/user-actions";
import {
  IDLE_CREATE_USER_FORM,
  USER_NAME_MAX,
  createUserSchema,
  userFormFieldErrors,
  type CreateUserFormState,
  type UserFormField,
  type UserFormFieldErrors,
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
import { InviteLinkPanel } from "@/components/dashboard/invite-link-panel";
import { toast } from "@/components/dashboard/use-toast";

interface UserDraft {
  name: string;
  email: string;
  role: Role;
}

/** Order in which fields appear, so the first invalid one can take focus. */
const FIELD_ORDER: readonly UserFormField[] = ["name", "email", "role"];

/** Same native-select styling as the add-subscription and schedule dialogs. */
const SELECT_CLASS =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 sm:h-8 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

const ERROR_CLASS = "text-xs text-destructive";

interface CreateUserDialogProps {
  /** The workspace this page shows — the action re-checks the caller's role in it. */
  organizationId: string;
  /** Roles the caller may hand out: an admin cannot add an owner. */
  roles: readonly Role[];
  /**
   * Start open — the page passes this for `?action=add`, which is where the ⌘K
   * palette's "Add user" lands. Read once, on mount; the page keys the dialog on
   * it so a second arrival remounts it open.
   */
  openOnMount?: boolean;
}

export function CreateUserDialog({ organizationId, roles, openOnMount = false }: CreateUserDialogProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState<boolean>(openOnMount);
  // Bumped on every open, so the form below mounts fresh each time.
  const [attempt, setAttempt] = useState<number>(openOnMount ? 1 : 0);
  // Set by a successful add; its presence IS the second step.
  const [invite, setInvite] = useState<AddedUser | null>(null);

  function handleOpenChange(next: boolean): void {
    if (next) {
      setAttempt((previous) => previous + 1);
      setInvite(null);
    }
    setOpen(next);

    // Closing consumes `?action=add`, so a refresh or Back does not reopen a
    // dialog the admin already dismissed. Every other param is kept.
    if (!next && searchParams.has("action")) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("action");
      const search = params.toString();
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9"
        >
          <Plus aria-hidden />
          Add user
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        {invite === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Add a user</DialogTitle>
              <DialogDescription>
                Creates a new account in this workspace. You&apos;ll get an invite
                link to share, and they choose their own password with it.
              </DialogDescription>
            </DialogHeader>

            <CreateUserForm
              key={attempt}
              organizationId={organizationId}
              roles={roles}
              onAdded={setInvite}
            />
          </>
        ) : (
          <InviteLinkPanel
            title={`${invite.name} was added`}
            description={
              invite.emailedTo !== null
                ? `We've emailed an invite to ${invite.emailedTo}. You can also share this link yourself. It expires in 7 days.`
                : "Share this link with the user. It expires in 7 days."
            }
            token={invite.inviteToken}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface AddedUser {
  readonly name: string;
  readonly inviteToken: string;
  /** Where the invite email went, or null when this deployment sends none. */
  readonly emailedTo: string | null;
}

interface CreateUserFormProps {
  organizationId: string;
  roles: readonly Role[];
  onAdded: (added: AddedUser) => void;
}

function CreateUserForm({ organizationId, roles, onAdded }: CreateUserFormProps) {
  const [draft, setDraft] = useState<UserDraft>({
    name: "",
    email: "",
    role: roles.includes("MEMBER") ? "MEMBER" : (roles[0] ?? "MEMBER"),
  });
  const [clientErrors, setClientErrors] = useState<UserFormFieldErrors>({});

  // Closing and confirming happen in the action's own completion path — after
  // the server has said yes — rather than in an effect watching the state.
  const [state, formAction, pending] = useActionState(
    async (previous: CreateUserFormState, formData: FormData): Promise<CreateUserFormState> => {
      const result = await createUser(previous, formData);
      if (result.status === "success" && result.inviteToken !== null) {
        toast.success("User added", { description: draft.name.trim() });
        onAdded({ name: draft.name.trim(), inviteToken: result.inviteToken, emailedTo: result.emailedTo });
      }
      return result;
    },
    IDLE_CREATE_USER_FORM,
  );

  const baseId = useId();
  const fieldId = (field: UserFormField): string => `${baseId}-${field}`;
  const errorId = (field: UserFormField): string => `${baseId}-${field}-error`;

  const errors: UserFormFieldErrors = { ...clientErrors, ...state.fieldErrors };

  function update(field: UserFormField, value: string): void {
    setDraft((previous) => ({ ...previous, [field]: value }));
    if (clientErrors[field]) setClientErrors((previous) => ({ ...previous, [field]: undefined }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (pending) {
      event.preventDefault();
      return;
    }
    const result = createUserSchema.safeParse(draft);
    if (result.success) {
      setClientErrors({});
      return; // let the form action run
    }

    event.preventDefault();
    const nextErrors = userFormFieldErrors(result.error);
    setClientErrors(nextErrors);
    const firstInvalid = FIELD_ORDER.find((field) => nextErrors[field]);
    if (firstInvalid) {
      const control = event.currentTarget.elements.namedItem(firstInvalid);
      if (control instanceof HTMLElement) control.focus();
    }
  }

  function describedBy(field: UserFormField): string | undefined {
    return errors[field] ? errorId(field) : undefined;
  }

  function fieldError(field: UserFormField) {
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

      <div className="grid gap-2">
        <Label htmlFor={fieldId("name")}>Full name</Label>
        <Input
          id={fieldId("name")}
          name="name"
          type="text"
          autoComplete="off"
          maxLength={USER_NAME_MAX}
          value={draft.name}
          onChange={(event) => update("name", event.target.value)}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={describedBy("name")}
          className="h-11 sm:h-8"
        />
        {fieldError("name")}
      </div>

      <div className="grid gap-2">
        <Label htmlFor={fieldId("email")}>Email</Label>
        <Input
          id={fieldId("email")}
          name="email"
          type="email"
          autoComplete="off"
          spellCheck={false}
          value={draft.email}
          onChange={(event) => update("email", event.target.value)}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={describedBy("email")}
          className="h-11 sm:h-8"
        />
        {fieldError("email")}
      </div>

      <div className="grid gap-2">
        <Label htmlFor={fieldId("role")}>Role</Label>
        <select
          id={fieldId("role")}
          name="role"
          value={draft.role}
          onChange={(event) => update("role", event.target.value)}
          aria-invalid={errors.role ? true : undefined}
          aria-describedby={describedBy("role")}
          className={SELECT_CLASS}
        >
          {roles.map((role) => (
            <option key={role} value={role}>
              {formatEnumLabel(role)}
            </option>
          ))}
        </select>
        {fieldError("role")}
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
          {pending ? "Adding…" : "Add user"}
        </Button>
      </DialogFooter>
    </form>
  );
}


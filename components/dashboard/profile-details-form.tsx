"use client";

// The editable half of the Profile card: the name field, the read-only email,
// and the Save footer. Same shape as `WorkspaceDetailsForm` — the <form> is
// `display: contents`, so its two CardContent blocks stay direct children of the
// Card, and the name input is CONTROLLED so a rejected save keeps the typing.
import { useActionState, useState } from "react";
import type { FormEvent } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { updateProfile } from "@/lib/profile-actions";
import { IDLE_PROFILE_FORM, USER_NAME_MAX, profileFieldErrors, profileSchema } from "@/lib/profile-form";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Same mono caps as the Settings page's field labels. */
const FIELD_LABEL =
  "font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase";

/** Touch first: 44px on a phone, tightened to the app's 36px on a pointer. */
const CONTROL_HEIGHT = "h-11 sm:h-9";

const STATUS_ID = "profile-status";

interface ProfileDetailsFormProps {
  /** The stored name, possibly null — the field then starts empty. */
  name: string | null;
  email: string;
}

export function ProfileDetailsForm({ name, email }: ProfileDetailsFormProps) {
  const [state, formAction, isPending] = useActionState(updateProfile, IDLE_PROFILE_FORM);
  const [draft, setDraft] = useState<string>(name ?? "");
  const [clientError, setClientError] = useState<string | null>(null);

  const fieldError = clientError ?? state.fieldErrors.name ?? null;
  const isError = fieldError !== null || state.status === "error";

  let statusText = "Shown to everyone in the workspaces you belong to.";
  if (fieldError !== null) statusText = fieldError;
  else if (state.message !== null) statusText = state.message;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (isPending) {
      event.preventDefault();
      return;
    }
    const result = profileSchema.safeParse({ name: draft });
    if (result.success) {
      setClientError(null);
      return; // let the form action run
    }
    event.preventDefault();
    setClientError(profileFieldErrors(result.error).name ?? null);
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="contents">
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-name" className={FIELD_LABEL}>
            Full name
          </Label>
          <Input
            id="profile-name"
            name="name"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setClientError(null);
            }}
            maxLength={USER_NAME_MAX}
            autoComplete="name"
            aria-invalid={fieldError !== null ? true : undefined}
            aria-describedby={cn("profile-name-hint", fieldError !== null && STATUS_ID)}
            className={CONTROL_HEIGHT}
          />
          <p id="profile-name-hint" className="text-[0.6875rem] text-muted-foreground">
            In the account menu, member lists, and the audit log.
          </p>
        </div>

        {/* Read-only, so not an input — the Settings slug's treatment: a mono
            chip reads as a fact about the record, not a field being denied. */}
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Email</span>
          <div
            className={cn(
              "flex items-center overflow-hidden rounded-lg bg-muted px-2.5",
              CONTROL_HEIGHT,
            )}
          >
            <code className="truncate font-mono text-xs text-muted-foreground">{email}</code>
          </div>
          <p className="text-[0.6875rem] text-muted-foreground">
            Fixed. It&apos;s how you sign in.
          </p>
        </div>
      </CardContent>

      <CardContent className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        {/* One line that is the hint at rest and the result after a save. */}
        <p
          id={STATUS_ID}
          aria-live="polite"
          className={cn(
            "text-[0.6875rem]",
            isError
              ? "text-destructive"
              : state.status === "success"
                ? "text-positive"
                : "text-muted-foreground",
          )}
        >
          {statusText}
        </p>
        <Button
          type="submit"
          aria-disabled={isPending ? "true" : undefined}
          aria-describedby={STATUS_ID}
          className={cn("px-4", CONTROL_HEIGHT)}
        >
          {isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {isPending ? "Saving…" : "Save changes"}
        </Button>
      </CardContent>
    </form>
  );
}

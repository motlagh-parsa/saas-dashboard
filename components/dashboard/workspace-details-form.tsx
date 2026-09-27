"use client";

// The editable half of the Settings "Workspace" card: the name field, the
// read-only slug, and the Save footer. Client, because it owns the pending state
// and the result line of the `renameWorkspace` Server Action.
//
// The <form> is `display: contents`, so the two CardContent blocks it wraps stay
// direct flex children of the Card and keep the card's own spacing.
//
// The name input is CONTROLLED on purpose. React resets uncontrolled fields after
// every form action — including one that returns an error — so a rejected name
// would snap back to the old one and take the user's typing with it.
import { useActionState, useState } from "react";
import type { FormEvent } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { renameWorkspace } from "@/lib/workspace-actions";
import {
  IDLE_WORKSPACE_ACTION,
  WORKSPACE_NAME_MAX,
} from "@/lib/workspace-action-state";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Same mono caps as the page's field labels and column headers. */
const FIELD_LABEL =
  "font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase";

/** Touch first: 44px on a phone, tightened to the app's 36px on a pointer. */
const CONTROL_HEIGHT = "h-11 sm:h-9";

const STATUS_ID = "workspace-name-status";

interface WorkspaceDetailsFormProps {
  organizationId: string;
  name: string;
  slug: string;
  /** OWNER or ADMIN. The server re-checks; this only decides what the UI offers. */
  canEdit: boolean;
}

export function WorkspaceDetailsForm({
  organizationId,
  name,
  slug,
  canEdit,
}: WorkspaceDetailsFormProps) {
  const [state, formAction, isPending] = useActionState(renameWorkspace, IDLE_WORKSPACE_ACTION);
  const [draft, setDraft] = useState<string>(name);

  const isError = state.status === "error";
  const saveDisabled = !canEdit || isPending;

  let statusText = "Changes apply to everyone in this workspace.";
  if (!canEdit) statusText = "Only owners and admins can rename this workspace.";
  else if (state.message !== null) statusText = state.message;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    // `aria-disabled` keeps Save focusable, so a press or Enter still submits.
    // Stop it here rather than make a round trip the server would refuse.
    if (saveDisabled) event.preventDefault();
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} className="contents">
      <input type="hidden" name="organizationId" value={organizationId} />

      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="workspace-name" className={FIELD_LABEL}>
            Workspace name
          </Label>
          <Input
            id="workspace-name"
            name="name"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            readOnly={!canEdit}
            maxLength={WORKSPACE_NAME_MAX}
            autoComplete="off"
            aria-invalid={isError ? true : undefined}
            aria-describedby={cn("workspace-name-hint", isError && STATUS_ID)}
            className={CONTROL_HEIGHT}
          />
          <p id="workspace-name-hint" className="text-[0.6875rem] text-muted-foreground">
            Shown in the sidebar and on anything exported from this workspace.
          </p>
        </div>

        {/*
          The slug is READ-ONLY, so it is not an input.
          A disabled text field still looks like a thing you were supposed to
          be able to edit and are being denied; a mono chip on the muted
          surface reads as a fact about the record instead — the same way an
          invoice reference does elsewhere in the product.
        */}
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Workspace slug</span>
          <div
            className={cn(
              "flex items-center overflow-hidden rounded-lg bg-muted px-2.5",
              CONTROL_HEIGHT,
            )}
          >
            <code className="truncate font-mono text-xs text-muted-foreground">{slug}</code>
          </div>
          <p className="text-[0.6875rem] text-muted-foreground">
            Fixed. It identifies this workspace in URLs and API calls.
          </p>
        </div>
      </CardContent>

      <CardContent className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        {/* One line that is the hint at rest and the result after a save. Polite
            live region: it reports, it does not interrupt. */}
        <p
          id={STATUS_ID}
          aria-live="polite"
          className={cn(
            "text-[0.6875rem]",
            isError ? "text-destructive" : state.status === "success" ? "text-positive" : "text-muted-foreground",
          )}
        >
          {statusText}
        </p>
        {/* `aria-disabled`, not `disabled`: a keyboard user can still reach it and
            hear the reason in the line beside it. */}
        <Button
          type="submit"
          aria-disabled={saveDisabled ? "true" : undefined}
          aria-describedby={STATUS_ID}
          className={cn("px-4", CONTROL_HEIGHT, saveDisabled && "cursor-not-allowed opacity-50")}
        >
          {isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {isPending ? "Saving…" : "Save changes"}
        </Button>
      </CardContent>
    </form>
  );
}

"use client";

// "Leave workspace" in the Settings danger zone. Client, because it is two steps:
// the first press only ASKS, and nothing is sent until "Yes, leave" is pressed.
// Leaving cannot be undone from the leaver's side, so one stray click must not do
// it.
//
// Success never renders here: `leaveWorkspace` redirects to /dashboard. The only
// result this component shows is a refusal — most often "you're the last owner".
import { useActionState, useState } from "react";
import type { FormEvent } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { leaveWorkspace } from "@/lib/workspace-actions";
import { IDLE_WORKSPACE_ACTION } from "@/lib/workspace-action-state";
import { Button } from "@/components/ui/button";

/** Touch first: 44px on a phone, tightened to the app's 36px on a pointer. */
const CONTROL_HEIGHT = "h-11 sm:h-9";

const ERROR_ID = "leave-workspace-error";

interface LeaveWorkspaceControlProps {
  organizationId: string;
  workspaceName: string;
  /** The danger row's description, so the button is announced with its consequence. */
  describedBy: string;
}

export function LeaveWorkspaceControl({
  organizationId,
  workspaceName,
  describedBy,
}: LeaveWorkspaceControlProps) {
  const [state, formAction, isPending] = useActionState(leaveWorkspace, IDLE_WORKSPACE_ACTION);
  const [confirming, setConfirming] = useState<boolean>(false);

  const hasError = state.status === "error";

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (isPending) event.preventDefault();
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {confirming ? (
        <form
          action={formAction}
          onSubmit={handleSubmit}
          className="flex flex-wrap items-center justify-end gap-2"
        >
          <input type="hidden" name="organizationId" value={organizationId} />
          {/* Focus lands on the SAFE choice: the button that was pressed has just
              unmounted, and Enter on the new focus must not complete the leave. */}
          <Button
            type="button"
            variant="outline"
            autoFocus
            onClick={() => setConfirming(false)}
            className={cn("px-4", CONTROL_HEIGHT)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="destructive"
            aria-disabled={isPending ? "true" : undefined}
            aria-describedby={cn(describedBy, hasError && ERROR_ID)}
            className={cn("px-4", CONTROL_HEIGHT)}
          >
            {isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {isPending ? "Leaving…" : `Yes, leave ${workspaceName}`}
          </Button>
        </form>
      ) : (
        <Button
          type="button"
          variant="destructive"
          aria-describedby={cn(describedBy, hasError && ERROR_ID)}
          onClick={() => setConfirming(true)}
          className={cn("px-4", CONTROL_HEIGHT)}
        >
          Leave workspace
        </Button>
      )}

      {hasError ? (
        <p
          id={ERROR_ID}
          role="alert"
          className="max-w-xs text-right text-[0.6875rem] text-destructive text-balance"
        >
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

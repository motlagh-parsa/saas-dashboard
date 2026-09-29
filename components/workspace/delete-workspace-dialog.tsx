"use client";

// Delete workspace — OWNER only, from the Settings danger zone. Says exactly what
// goes, and will not submit until the workspace's name is typed exactly, which
// the Server Action re-checks against the stored name. On success the action
// redirects to /dashboard, which resolves the next workspace or /onboarding.
import { Trash2 } from "lucide-react";

import { deleteWorkspace } from "@/lib/workspace-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormDialog, INPUT_CLASS } from "@/components/billing/form-dialog";

interface DeleteWorkspaceDialogProps {
  organizationId: string;
  name: string;
  describedBy?: string;
}

export function DeleteWorkspaceDialog({ organizationId, name, describedBy }: DeleteWorkspaceDialogProps) {
  return (
    <FormDialog
      trigger={
        <Button type="button" variant="destructive" aria-describedby={describedBy} className="h-11 px-4 sm:h-9">
          <Trash2 aria-hidden />
          Delete workspace
        </Button>
      }
      destructive
      title={`Delete ${name}?`}
      description={
        <>
          This permanently deletes the workspace and everything in it: its customers, plans, subscriptions,
          invoices and metric snapshots, every member&apos;s access, its notifications, reports and audit log.
          Members keep their accounts. <strong className="font-medium text-foreground">It can&apos;t be undone.</strong>
        </>
      }
      action={deleteWorkspace}
      hidden={{ organizationId }}
      initial={{ confirmName: "" }}
      canSubmit={(draft) => draft.confirmName?.trim() === name}
      submitLabel="Delete workspace"
      pendingLabel="Deleting…"
      successTitle="Workspace deleted"
    >
      {(form) => (
        <Field form={form} field="confirmName" label={<>Type <strong>{name}</strong> to confirm</>}>
          <Input {...form.control("confirmName")} type="text" autoComplete="off" className={INPUT_CLASS} />
        </Field>
      )}
    </FormDialog>
  );
}

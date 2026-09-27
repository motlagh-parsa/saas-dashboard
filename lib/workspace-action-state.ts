// The serializable result shape of the workspace Server Actions in
// `lib/workspace-actions.ts`, plus the name limits both sides enforce.
//
// A separate plain module on purpose: a `"use server"` module publishes every
// export as an action endpoint, and a type or constant exported from one fails to
// resolve at build time (see the note in `lib/notifications.ts`). Client forms
// import from HERE; only the action functions come from the action module.

export interface WorkspaceActionState {
  readonly status: "idle" | "success" | "error";
  /** What to show beside the control. Null while idle. */
  readonly message: string | null;
}

export const IDLE_WORKSPACE_ACTION: WorkspaceActionState = { status: "idle", message: null };

/** Workspace name length, after trimming. Checked on the server; the input caps the max. */
export const WORKSPACE_NAME_MIN = 2;
export const WORKSPACE_NAME_MAX = 50;

// The serializable result shape of the user-management Server Actions in
// `lib/user-actions.ts`.
//
// A separate plain module for the same reason as `lib/workspace-action-state.ts`:
// a `"use server"` module publishes every export as an action endpoint, so
// client islands import the shape from HERE and only the functions from there.

export interface UserActionState {
  readonly status: "idle" | "success" | "error";
  /** What went wrong, or what happened. Null while idle. */
  readonly message: string | null;
}

export const IDLE_USER_ACTION: UserActionState = { status: "idle", message: null };

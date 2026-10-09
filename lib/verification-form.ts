// The "resend confirmation email" button's result shape — a plain module so the
// client banner can import it (a "use server" module cannot export a type's
// runtime companion, see lib/notifications.ts).
export interface ResendVerificationState {
  readonly status: "idle" | "sent" | "error";
  readonly message: string | null;
}

export const IDLE_RESEND_VERIFICATION: ResendVerificationState = { status: "idle", message: null };

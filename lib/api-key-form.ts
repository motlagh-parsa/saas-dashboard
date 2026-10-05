// The API key form's rules and result shape, shared by the create dialog (instant
// feedback) and the Server Action (the check that counts). A plain module: the
// client imports it, and a `"use server"` module cannot export a schema.
import { z } from "zod";

export const API_KEY_NAME_MAX = 60;

export const EXPIRY_OPTIONS = [
  { value: "never", label: "Never", days: null },
  { value: "30", label: "In 30 days", days: 30 },
  { value: "90", label: "In 90 days", days: 90 },
  { value: "365", label: "In 1 year", days: 365 },
] as const;

export type ExpiryValue = (typeof EXPIRY_OPTIONS)[number]["value"];

export const CREATE_API_KEY_FIELDS = ["name", "scope", "expiry"] as const;

export const createApiKeySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, { error: "Name the key after what uses it (at least 2 characters)." })
    .max(API_KEY_NAME_MAX, { error: `Use at most ${API_KEY_NAME_MAX} characters.` }),
  scope: z.enum(["READ", "WRITE"], { error: "Choose read or read and write." }),
  expiry: z.enum(["never", "30", "90", "365"], { error: "Choose when it expires." }),
});

export interface CreateApiKeyState {
  readonly status: "idle" | "success" | "error";
  readonly message: string | null;
  readonly fieldErrors: Readonly<Record<string, string>>;
  /** The new key — present in this one response and nowhere else, ever. */
  readonly key: string | null;
}

export const IDLE_CREATE_API_KEY: CreateApiKeyState = { status: "idle", message: null, fieldErrors: {}, key: null };

/** The URL of the public API documentation. */
export const API_DOCS_PATH = "/docs/api";

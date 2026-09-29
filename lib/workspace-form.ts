// The workspace forms' rules — create, rename, currency, delete — shared by the
// client forms (instant feedback) and the Server Actions in
// lib/workspace-actions.ts (the check that counts).
//
// A plain module: a `"use server"` module cannot export a schema.
import { z } from "zod";

import { SUPPORTED_CURRENCIES } from "@/lib/currencies";
import { WORKSPACE_NAME_MAX, WORKSPACE_NAME_MIN } from "@/lib/workspace-action-state";

export const workspaceNameSchema = z
  .string({ error: "Enter a workspace name." })
  .trim()
  .min(WORKSPACE_NAME_MIN, { error: `Use at least ${WORKSPACE_NAME_MIN} characters.` })
  .max(WORKSPACE_NAME_MAX, { error: `Use at most ${WORKSPACE_NAME_MAX} characters.` });

export const currencySchema = z.enum(SUPPORTED_CURRENCIES, { error: "Choose a currency from the list." });

export const CREATE_WORKSPACE_FIELDS = ["name", "currency"] as const;

export function createWorkspaceSchema() {
  return z.object({ name: workspaceNameSchema, currency: currencySchema });
}

export function workspaceCurrencySchema() {
  return z.object({ currency: currencySchema });
}

/** Deleting a workspace asks for its name, typed exactly. */
export const DELETE_WORKSPACE_FIELDS = ["confirmName"] as const;

/** Shown wherever the currency can no longer change. */
export const CURRENCY_LOCKED =
  "Currency is fixed once billing data exists, because stored amounts are in this currency.";

/** `Acme Analytics` -> `acme-analytics`. Never empty. */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base || "workspace";
}

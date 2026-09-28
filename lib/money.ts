// Money INPUT: what a founder types ("49.99") -> the integer minor units stored.
//
// A plain module: the dialogs parse on the client for instant feedback and the
// Server Actions parse again, with the same function, as the check that counts.
//
// No floating point anywhere on the way in. "49.99" is split into its digit
// strings and assembled as an integer, so no value is ever 4998.999…. The number
// of decimals allowed is the workspace currency's (lib/format.ts
// `currencyFractionDigits`): USD takes up to 2, JPY none, KWD up to 3.

import { currencyFractionDigits } from "@/lib/format";

/** Whole units allowed before the decimal point: up to 9,999,999. */
const MAX_WHOLE_DIGITS = 7;

/**
 * The largest amount a single money column may hold. Postgres `integer` tops out
 * at 2,147,483,647; staying well under it leaves room for amount × quantity.
 */
export const MAX_MINOR_UNITS = 2_000_000_000;

/**
 * `"49.99"` -> `4999` (USD), `"4999"` -> `4999` (JPY). Accepts thousands commas
 * and surrounding spaces; returns `null` for anything else — a sign, too many
 * decimals for the currency, letters, or an empty string.
 */
export function parseMoneyInput(raw: string, currency: string): number | null {
  const digits = currencyFractionDigits(currency);
  const text = raw.trim().replace(/,/g, "");
  const pattern =
    digits === 0
      ? new RegExp(`^(\\d{1,${MAX_WHOLE_DIGITS}})$`)
      : new RegExp(`^(\\d{1,${MAX_WHOLE_DIGITS}})(?:\\.(\\d{1,${digits}}))?$`);
  const match = pattern.exec(text);
  if (match === null) return null;

  const whole = Number(match[1]);
  const fraction = digits === 0 ? 0 : Number((match[2] ?? "").padEnd(digits, "0"));
  const minor = whole * 10 ** digits + fraction;
  return Number.isSafeInteger(minor) && minor <= MAX_MINOR_UNITS ? minor : null;
}

/** Minor units -> the plain `"49.00"` a price input holds (`"4900"` for JPY). */
export function minorToInput(minor: number, currency: string): string {
  const digits = currencyFractionDigits(currency);
  if (digits === 0) return String(minor);
  const scale = 10 ** digits;
  const whole = Math.trunc(minor / scale);
  const fraction = String(minor % scale).padStart(digits, "0");
  return `${whole}.${fraction}`;
}

/** The hint under a money input: `49.99` or `4999`. */
export function moneyInputExample(currency: string): string {
  const digits = currencyFractionDigits(currency);
  return digits === 0 ? "4999" : `49.${"9".repeat(digits)}`;
}

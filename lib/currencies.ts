// The currencies a workspace can report in — the one list the create form, the
// Settings currency field and the Server Actions all use, so a code the UI never
// offered is refused on the server.
//
// Labels come from Intl (DisplayNames for the name, NumberFormat for the symbol)
// and are built on the SERVER and handed to the client as props: two ICU builds
// (Node's and a browser's) can spell a currency name differently, and a label
// computed on both sides would be a hydration mismatch waiting to happen.

export const SUPPORTED_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "NZD",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "JPY",
  "INR",
  "BRL",
  "MXN",
  "SGD",
  "AED",
  "TRY",
  "PLN",
  "ZAR",
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const DEFAULT_CURRENCY: SupportedCurrency = "USD";

export function isSupportedCurrency(value: string): value is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export interface CurrencyOption {
  readonly code: SupportedCurrency;
  /** "US Dollar ($) — USD" */
  readonly label: string;
}

/** The currency's own symbol as Intl prints it in en-US: "$", "€", "CA$", "¥". */
function symbolOf(code: string): string {
  const part = new Intl.NumberFormat("en-US", { style: "currency", currency: code })
    .formatToParts(0)
    .find((entry) => entry.type === "currency");
  return part?.value ?? code;
}

/** Every supported currency with its display label. Call on the server; pass the result down. */
export function currencyOptions(): CurrencyOption[] {
  const names = new Intl.DisplayNames(["en"], { type: "currency" });
  return SUPPORTED_CURRENCIES.map((code) => ({
    code,
    label: `${names.of(code) ?? code} (${symbolOf(code)}) — ${code}`,
  }));
}

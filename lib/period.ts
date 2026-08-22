import type { Period, PeriodPreset } from "@/lib/metrics";

/**
 * The comparison window the overview is read against.
 *
 * This is the ONE control on the page, so it is deliberately small: three named
 * windows, encoded in the URL, resolved on the server. It governs the
 * period-over-period deltas and the retention cohort — not the MRR trend, which
 * always shows twelve months of history and says so.
 *
 * Type-only import: `lib/metrics.ts` is `server-only`, and `import type` is
 * erased at compile time, so this module stays safe to reach from anywhere.
 */
export type RangeKey = "30d" | "3m" | "12m";

export interface RangeOption {
  readonly key: RangeKey;
  /** Segmented-control label. */
  readonly label: string;
  /** Reads as the tail of "vs …" under every delta. */
  readonly comparison: string;
  readonly preset: PeriodPreset;
}

export const RANGE_OPTIONS: readonly RangeOption[] = [
  {
    key: "30d",
    label: "30 days",
    comparison: "previous 30 days",
    preset: "last_30_days",
  },
  {
    key: "3m",
    label: "3 months",
    comparison: "previous 3 months",
    preset: "last_3_months",
  },
  {
    key: "12m",
    label: "12 months",
    comparison: "previous 12 months",
    preset: "last_12_months",
  },
];

const DEFAULT_RANGE: RangeKey = "30d";

/**
 * Narrows an untrusted `?range=` param to a known key. Anything unrecognised —
 * including the repeated-param array form — falls back to the default rather
 * than erroring, because a mangled URL should still render the dashboard.
 */
export function parseRange(raw: string | string[] | undefined): RangeKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = RANGE_OPTIONS.find((option) => option.key === value);
  return match ? match.key : DEFAULT_RANGE;
}

export function rangeOption(key: RangeKey): RangeOption {
  return RANGE_OPTIONS.find((option) => option.key === key) ?? RANGE_OPTIONS[0];
}

/**
 * Builds the `Period` for a range key. `asOf` is left unset so `resolvePeriod`
 * anchors on "now" inside a single query, which is what keeps the current and
 * previous windows from overlapping (see `previousOfResolved` in lib/metrics.ts).
 */
export function periodFor(key: RangeKey): Period {
  return { kind: "preset", preset: rangeOption(key).preset };
}

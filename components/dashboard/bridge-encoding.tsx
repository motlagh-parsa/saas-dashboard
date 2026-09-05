import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/**
 * The revenue bridge's visual encoding.
 *
 * This module carries NO directive on purpose. The server section builds the data
 * and the client chart draws it, and both need the same fills; pulling a plain
 * constant out of a `"use client"` module into a Server Component would hand back
 * a client reference instead of the string.
 *
 * Why colour works this way is written up beside the tokens in app/globals.css.
 * The short version: a bridge is a DIVERGING form, so the hue follows direction,
 * and the two balance columns are separated by FORM — they alone sit on the zero
 * line and they alone are hatched — because no third hue survives the colour
 * vision check against steel.
 */

export type BridgeDirection = "up" | "down" | "flat" | "balance";

/** Fills keyed by the JOB the mark does, never by the movement's category. */
export const BRIDGE_FILL = {
  up: "var(--movement-up)",
  down: "var(--movement-down)",
  /** The trailing month is still open, so it is drawn at reduced strength. */
  upInProgress: "var(--movement-up-soft)",
  downInProgress: "var(--movement-down-soft)",
  /** A month that did not move: a hairline at the running level, never nothing. */
  flat: "var(--movement-flat)",
} as const;

/**
 * SVG pattern id for the hatched balance columns. Static, because exactly one
 * bridge renders per page — the same assumption the overview's gradient makes.
 */
export const BRIDGE_HATCH_ID = "revenue-bridge-balance-hatch";
export const BRIDGE_HATCH_FILL = `url(#${BRIDGE_HATCH_ID})`;

/** Mirrors the SVG pattern so a legend chip and a bar read as the same material. */
const BALANCE_SWATCH_STYLE: CSSProperties = {
  backgroundColor: "var(--balance-fill)",
  backgroundImage:
    "repeating-linear-gradient(45deg, var(--balance-rule) 0 1.5px, transparent 1.5px 6px)",
};

const SWATCH_CLASS: Record<Exclude<BridgeDirection, "balance">, string> = {
  up: "bg-movement-up",
  down: "bg-movement-down",
  flat: "bg-movement-flat",
};

interface BridgeSwatchProps {
  direction: BridgeDirection;
  className?: string;
}

/**
 * The small mark that carries series identity beside a label.
 *
 * It exists so the TEXT never has to wear the series colour: values and legend
 * labels stay in the foreground/muted tokens and this chip does the identifying.
 */
export function BridgeSwatch({ direction, className }: BridgeSwatchProps) {
  if (direction === "balance") {
    return (
      <span
        aria-hidden
        style={BALANCE_SWATCH_STYLE}
        className={cn("size-2 shrink-0 rounded-[1px]", className)}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-[1px]", SWATCH_CLASS[direction], className)}
    />
  );
}

/** One movement component of a month, pre-formatted server-side. */
export interface BridgeComponent {
  /** "New", "Expansion", … */
  label: string;
  /** Unsigned magnitude. The operator printed beside it carries the direction. */
  amount: string;
  direction: "up" | "down";
}

/**
 * One column of the bridge.
 *
 * Everything crossing to the client is a string or a number. `RevenueMovementPoint`
 * carries Dates, and Dates do not cross the server/client boundary, so all of the
 * formatting — money, months, days — has already happened by the time a datum
 * gets here.
 */
export interface BridgeDatum {
  /** Stable identity: React key and Cell key. Never the index. */
  key: string;
  /** x-axis tick. Month ticks come from `periodStart`; balances are named. */
  tick: string;
  /** Tooltip heading. */
  heading: string;
  /** One line of tooltip context, or null when there is nothing to add. */
  caption: string | null;
  direction: BridgeDirection;
  /** Resolved fill for this column, chosen by the section that owns the meaning. */
  fill: string;
  /** Invisible stacked segment that lifts the visible one to its baseline. */
  base: number;
  /** Visible segment height. Always >= 0, so the stack never goes negative. */
  span: number;
  /** Signed movement, or the balance itself. Pre-formatted. */
  amount: string;
  /** MRR at this column's right edge. Pre-formatted. */
  level: string;
  /** Direct label, or null for the columns that carry none. */
  labelText: string | null;
  components: BridgeComponent[];
}

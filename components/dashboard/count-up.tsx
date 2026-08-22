"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { formatCount, formatMoney, formatPercent } from "@/lib/format";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/**
 * Which formatter the counter runs each frame through. Passed as a discriminator
 * rather than a callback because functions cannot cross the server -> client
 * boundary, and the page that owns these numbers is a Server Component.
 */
export type CountUpFormat = "money" | "count" | "percent";

interface CountUpProps {
  /** Cents for `money`, a whole number for `count`, a 0-1 fraction for `percent`. */
  value: number;
  format: CountUpFormat;
  /** ISO-4217 code. Ignored unless `format` is "money". */
  currency?: string;
  /** Fraction digits. Ignored unless `format` is "percent". */
  digits?: number;
  durationMs?: number;
  className?: string;
}

function present(
  raw: number,
  format: CountUpFormat,
  currency: string,
  digits: number,
): string {
  switch (format) {
    case "money":
      return formatMoney(Math.round(raw), currency);
    case "count":
      return formatCount(Math.round(raw));
    case "percent":
      return formatPercent(raw, digits);
  }
}

/** easeOutQuart — fast arrival, long settle. Reads as a figure landing, not a slot machine. */
function ease(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

/**
 * Counts a metric up from zero on mount.
 *
 * Three things make this safe rather than decorative:
 *   - The final value is what renders on the server and on the first client
 *     paint, so there is no hydration mismatch and no-JS shows the real number.
 *   - The final string is reserved as an invisible sizing layer, so the digits
 *     growing from "$0" to "$52,480" never shift the layout around them.
 *   - Screen readers get the final value once, not sixty intermediate ones.
 */
export function CountUp({
  value,
  format,
  currency = "USD",
  digits = 1,
  durationMs = 750,
  className,
}: CountUpProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [displayed, setDisplayed] = useState(value);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    // Nothing to drive: the settled value is rendered directly below, so there
    // is no in-flight state to correct and no frame loop to start.
    if (prefersReducedMotion) return;

    let startedAt: number | null = null;

    const step = (now: number): void => {
      if (startedAt === null) startedAt = now;
      const progress = Math.min((now - startedAt) / durationMs, 1);
      setDisplayed(value * ease(progress));
      if (progress < 1) frame.current = requestAnimationFrame(step);
    };

    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [value, durationMs, prefersReducedMotion]);

  const settled = present(value, format, currency, digits);
  // Reduced motion reads the settled figure straight through, so `displayed`
  // is never consulted and cannot go stale behind a changing `value`.
  const inFlight = prefersReducedMotion
    ? settled
    : present(displayed, format, currency, digits);

  return (
    <span className={cn("inline-grid", className)}>
      <span className="sr-only">{settled}</span>
      <span aria-hidden className="invisible col-start-1 row-start-1">
        {settled}
      </span>
      <span aria-hidden className="col-start-1 row-start-1">
        {inFlight}
      </span>
    </span>
  );
}

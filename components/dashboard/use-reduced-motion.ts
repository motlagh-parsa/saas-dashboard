"use client";

import { useCallback, useSyncExternalStore } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Tracks the OS "reduce motion" preference.
 *
 * globals.css already neutralises CSS animation and transitions. This covers the
 * animation CSS cannot reach: the JS-driven metric count-up. (Recharts handles
 * itself — `isAnimationActive="auto"` is its default and already respects the
 * same preference.)
 *
 * `useSyncExternalStore` rather than useState + useEffect: matchMedia IS an
 * external store, and reading it as one means the FIRST client render already
 * has the true value. Correcting it in an effect instead would leave a frame
 * where the count-up is free to start on a machine that asked for no motion.
 * The third argument is the server snapshot — no matchMedia during SSR.
 */
export function usePrefersReducedMotion(): boolean {
  const subscribe = useCallback((onStoreChange: () => void): (() => void) => {
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    query.addEventListener("change", onStoreChange);
    return () => query.removeEventListener("change", onStoreChange);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

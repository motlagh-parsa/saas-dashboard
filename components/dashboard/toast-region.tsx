"use client";

// The single listener for `toast.*()` calls (see ./use-toast). Mounted once in
// the root layout so it exists on every route, and so its live region is already
// in the DOM before the first announcement — screen readers ignore live regions
// that appear at the same moment as their content.
//
// Bottom-right on desktop, full-width bottom on phones. Newest toast sits
// closest to the edge. Each toast auto-dismisses; the close button dismisses early.
import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { TOAST_EVENT } from "@/components/dashboard/use-toast";
import type { ToastPayload, ToastVariant } from "@/components/dashboard/use-toast";

/** Oldest toasts drop off beyond this, so a burst of clicks can't fill the screen. */
const MAX_VISIBLE = 3;

const VARIANT_ICON: Record<ToastVariant, LucideIcon> = {
  success: CircleCheck,
  error: CircleAlert,
  info: Info,
};

const VARIANT_ICON_CLASS: Record<ToastVariant, string> = {
  success: "text-positive",
  error: "text-negative",
  info: "text-muted-foreground",
};

export function ToastRegion() {
  const [toasts, setToasts] = useState<ToastPayload[]>([]);
  const timersRef = useRef<Map<number, number>>(new Map());

  function dismiss(id: number): void {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((previous) => previous.filter((item) => item.id !== id));
  }

  // Synchronizing with an external system: the window event bus and the timers.
  useEffect(() => {
    const timers = timersRef.current;

    function handleToast(event: Event): void {
      if (!(event instanceof CustomEvent)) return;
      const payload = event.detail as ToastPayload;

      setToasts((previous) => [...previous, payload].slice(-MAX_VISIBLE));
      timers.set(
        payload.id,
        window.setTimeout(() => {
          timers.delete(payload.id);
          setToasts((previous) => previous.filter((item) => item.id !== payload.id));
        }, payload.duration),
      );
    }

    window.addEventListener(TOAST_EVENT, handleToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, handleToast);
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return (
    <section
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[100] flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:w-80"
    >
      {toasts.map((item) => {
        const Icon = VARIANT_ICON[item.variant];
        return (
          <div
            key={item.id}
            className="pointer-events-auto flex items-start gap-2.5 rounded-xl bg-popover p-3 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 animate-in fade-in-0 slide-in-from-bottom-2 duration-200"
          >
            <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", VARIANT_ICON_CLASS[item.variant])} />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{item.title}</p>
              {item.description ? (
                <p className="mt-0.5 text-xs break-words text-muted-foreground">{item.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss notification"
              className="-m-1 rounded-md p-1 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
        );
      })}
    </section>
  );
}

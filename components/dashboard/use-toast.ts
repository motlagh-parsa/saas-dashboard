// Lightweight toast API — a stand-in for sonner, which cannot be installed while
// the npm registry is unreachable. The call site mirrors sonner's
// (`toast.success(title, { description })`) so swapping it back later is a
// one-line import change.
//
// Transport is a CustomEvent on `window`: any client code can raise a toast
// without a React context, and <ToastRegion /> (mounted once in the root layout)
// is the only listener. Calls made during SSR, or before the region mounts, are
// dropped — toasts only ever answer a user action, so neither case arises.

export type ToastVariant = "success" | "error" | "info";

export interface ToastOptions {
  description?: string;
  /** Milliseconds before auto-dismiss. Defaults to TOAST_DURATION_MS. */
  duration?: number;
}

export interface ToastPayload {
  id: number;
  variant: ToastVariant;
  title: string;
  description?: string;
  duration: number;
}

export const TOAST_EVENT = "app:toast";
export const TOAST_DURATION_MS = 4000;

let nextId = 0;

function emit(variant: ToastVariant, title: string, options: ToastOptions = {}): void {
  if (typeof window === "undefined") return;

  const payload: ToastPayload = {
    id: ++nextId,
    variant,
    title,
    description: options.description,
    duration: options.duration ?? TOAST_DURATION_MS,
  };
  window.dispatchEvent(new CustomEvent<ToastPayload>(TOAST_EVENT, { detail: payload }));
}

export const toast = {
  success: (title: string, options?: ToastOptions): void => emit("success", title, options),
  error: (title: string, options?: ToastOptions): void => emit("error", title, options),
  info: (title: string, options?: ToastOptions): void => emit("info", title, options),
};

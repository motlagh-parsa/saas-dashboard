"use client";

// Reports each page's Core Web Vitals to /api/vitals once, in production only.
// Paths are sent with dynamic segments (ids, tokens) replaced, so a reset link
// or a customer id never ends up in a log.
import { useReportWebVitals } from "next/web-vitals";

function scrub(path: string): string {
  return path
    .split("/")
    .map((segment) => (/^[A-Za-z0-9_-]{20,}$/.test(segment) || /\d/.test(segment) ? "[id]" : segment))
    .join("/");
}

export function WebVitals() {
  useReportWebVitals((metric) => {
    if (process.env.NODE_ENV !== "production") return;
    if (!["LCP", "INP", "CLS", "FCP", "TTFB"].includes(metric.name)) return;
    const body = JSON.stringify({
      name: metric.name,
      value: Math.round(metric.name === "CLS" ? metric.value * 1000 : metric.value) / (metric.name === "CLS" ? 1000 : 1),
      rating: metric.rating,
      path: scrub(window.location.pathname),
    });
    if (!navigator.sendBeacon?.("/api/vitals", new Blob([body], { type: "application/json" }))) {
      void fetch("/api/vitals", { method: "POST", body, keepalive: true });
    }
  });
  return null;
}

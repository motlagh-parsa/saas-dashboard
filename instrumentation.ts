// Server-side error reporting. Next calls `onRequestError` for every error
// thrown while rendering a page, a route handler or a Server Action; this
// writes ONE structured JSON line per error — what the hosting platform's log
// search (Vercel's, or any log drain) can filter on. Request headers are not
// logged: they carry session cookies.
//
// To forward errors to a service such as Sentry, this is the one place to add
// the call.
import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(
    JSON.stringify({
      level: "error",
      event: "request_error",
      message: err.message,
      digest: (err as Error & { digest?: string }).digest,
      method: request.method,
      path: request.path.split("?")[0],
      routePath: context.routePath,
      routeType: context.routeType,
      renderSource: context.renderSource,
      stack: err.stack?.split("\n").slice(0, 8).join("\n"),
    }),
  );
};

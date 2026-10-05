// The REST API's error envelope — one shape for every failure:
//
//   { "error": { "type": "...", "message": "...", "param": "...", "details": [...] } }
//
// Plain module (no server-only imports) so resource logic and tests can throw
// and inspect these without a request.
import type { z } from "zod";

export type ApiErrorType =
  | "invalid_request"
  | "authentication"
  | "permission"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

export const STATUS_OF: Record<ApiErrorType, number> = {
  invalid_request: 400,
  authentication: 401,
  permission: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

export interface ApiErrorDetail {
  readonly param: string;
  readonly message: string;
}

export class ApiError extends Error {
  constructor(
    readonly type: ApiErrorType,
    message: string,
    readonly param?: string,
    readonly details?: readonly ApiErrorDetail[],
  ) {
    super(message);
    this.name = "ApiError";
  }

  get status(): number {
    return STATUS_OF[this.type];
  }

  toJSON(): { error: { type: ApiErrorType; message: string; param?: string; details?: readonly ApiErrorDetail[] } } {
    return {
      error: {
        type: this.type,
        message: this.message,
        ...(this.param ? { param: this.param } : {}),
        ...(this.details && this.details.length > 0 ? { details: this.details } : {}),
      },
    };
  }
}

export const invalid = (message: string, param?: string, details?: readonly ApiErrorDetail[]) =>
  new ApiError("invalid_request", message, param, details);
export const notFound = (message: string, param?: string) => new ApiError("not_found", message, param);
export const conflict = (message: string, param?: string) => new ApiError("conflict", message, param);

/** Every invalid field of a failed body parse, with its dotted snake_case path. */
export function validationError(error: z.ZodError): ApiError {
  // The first message per field: one bad date need not be reported three ways.
  const details: ApiErrorDetail[] = [];
  for (const issue of error.issues) {
    const param = issue.path.map(String).join(".") || "body";
    if (!details.some((detail) => detail.param === param)) details.push({ param, message: issue.message });
  }
  const first = details[0];
  return invalid(
    details.length === 1 && first ? `${first.param}: ${first.message}` : `${details.length} fields are invalid.`,
    first?.param,
    details,
  );
}

/**
 * Parses a body, and on failure reports every invalid field at once: the
 * schema's issues plus `crossField` — checks that depend only on which fields
 * are present, run on the raw body, since zod skips an object's refinements
 * whenever one of its fields is already invalid.
 */
export function parseBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
  crossField: (raw: Readonly<Record<string, unknown>>) => ApiErrorDetail[] = () => [],
): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const error = validationError(parsed.error);
  const raw = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const known = new Set((error.details ?? []).map((detail) => detail.param));
  const extra = crossField(raw).filter((detail) => !known.has(detail.param));
  if (extra.length === 0) throw error;
  const details = [...(error.details ?? []), ...extra];
  throw invalid(`${details.length} fields are invalid.`, details[0]?.param, details);
}

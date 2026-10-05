import "server-only";

// The wrapper every /api/v1 route handler is built with.
//
// In order: a request id; the key (401 without a valid one); the key's rate
// limit (429 past it); the key's scope (403 for a READ key on a write); the
// handler; the JSON response with the id and rate-limit headers. Any ApiError
// becomes its envelope; anything else becomes a bare 500 envelope — the detail
// goes to the server log under the request id, never to the caller. The key
// itself is never logged.
//
// After the response, the writes' effects are flushed the way `finishWrite`
// flushes a form's: audit entries (with the key as the actor) and one coalesced
// snapshot recompute from the earliest affected day. They are flushed even when
// the handler fails part-way, so a write that did happen is still recorded.
import { randomBytes } from "node:crypto";
import { Prisma, type ApiScope } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { writeAudit } from "@/lib/audit-writer";
import { scheduleRecompute } from "@/lib/snapshots";

import { writeContext, type ApiWriteContext } from "./context";
import { ApiError, invalid, type ApiErrorType } from "./errors";
import { authenticateApiKey, scopeAllows, type ApiKeyContext } from "./keys";
import { consumeRateLimit, type RateLimitResult } from "./rate-limit";

export const MAX_BODY_BYTES = 1024 * 1024;

type RouteParams = Record<string, string>;

export interface ApiRequest<P extends RouteParams> {
  readonly request: Request;
  readonly query: URLSearchParams;
  readonly params: P;
  readonly key: ApiKeyContext;
  readonly ctx: ApiWriteContext;
  /** The JSON object body, or a 400. */
  readonly body: () => Promise<unknown>;
}

export interface ApiResult {
  readonly status?: number;
  readonly body: unknown;
}

function requestId(): string {
  return `req_${randomBytes(12).toString("base64url")}`;
}

function rateHeaders(rate: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(rate.limit),
    "X-RateLimit-Remaining": String(rate.remaining),
    "X-RateLimit-Reset": String(Math.ceil(rate.resetAt.getTime() / 1000)),
  };
}

function json(status: number, body: unknown, id: string, extra: Record<string, string>): Response {
  return Response.json(body, {
    status,
    headers: { "X-Request-Id": id, "Cache-Control": "no-store", ...extra },
  });
}

/** The envelope for a failure, logged with the request id. */
function failure(error: unknown, request: Request, id: string, extra: Record<string, string>): Response {
  const path = new URL(request.url).pathname;
  if (error instanceof ApiError) {
    console.warn("[api]", error.status, error.type, { requestId: id, method: request.method, path, message: error.message });
    return json(error.status, error.toJSON(), id, extra);
  }
  // Two requests creating the same external_id at once: the unique index lets
  // one through; the other is told to retry, which then finds the record.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return failure(new ApiError("conflict", "Another request changed this record at the same moment. Retry."), request, id, extra);
  }
  console.error("[api] 500", { requestId: id, method: request.method, path, error });
  const internal = new ApiError("internal", `Something went wrong on our side. Quote request ${id} if you contact support.`);
  return json(internal.status, internal.toJSON(), id, extra);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw invalid("Send the body as JSON with `Content-Type: application/json`.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw invalid("The body is larger than 1 MB.");

  // Counted as it streams: a missing or false Content-Length cannot get past it.
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw invalid("The body is larger than 1 MB.");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid("The body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("The body must be a JSON object.");
  }
  return parsed;
}

function flushEffects(key: ApiKeyContext, ctx: ApiWriteContext): void {
  const { audits, affectedFrom } = ctx.effects;
  if (audits.length === 0 && affectedFrom === null) return;
  const snapshot = [...audits];
  after(async () => {
    for (const audit of snapshot) {
      await writeAudit({ organizationId: key.organizationId, apiKeyId: key.id, ...audit });
    }
    if (affectedFrom !== null) await scheduleRecompute(key.organizationId, affectedFrom);
  });
  revalidatePath("/dashboard", "layout");
}

/**
 * A route handler: `export const PUT = apiRoute("WRITE", async ({ body, ctx }) => …)`.
 * `scope` is what the endpoint needs — a WRITE key also passes READ.
 */
export function apiRoute<P extends RouteParams = RouteParams>(
  scope: ApiScope,
  handler: (input: ApiRequest<P>) => Promise<ApiResult>,
): (request: Request, context: { params: Promise<P> }) => Promise<Response> {
  return async function route(request, context) {
    const id = requestId();
    let key: ApiKeyContext;
    let rate: RateLimitResult;
    try {
      const check = await authenticateApiKey(request.headers.get("authorization"));
      if (!check.ok) return failure(new ApiError("authentication", check.message), request, id, {});
      key = check.key;
      rate = await consumeRateLimit(key.id);
    } catch (error: unknown) {
      return failure(error, request, id, {});
    }
    const headers = rateHeaders(rate);
    if (!rate.allowed) {
      const retryAfter = Math.max(1, Math.ceil((rate.resetAt.getTime() - Date.now()) / 1000));
      return failure(
        new ApiError("rate_limited", `Too many requests: the limit is ${rate.limit} a minute per key. Retry in ${retryAfter}s.`),
        request,
        id,
        { ...headers, "Retry-After": String(retryAfter) },
      );
    }
    if (!scopeAllows(scope, key.scope)) {
      return failure(new ApiError("permission", "This key is read-only. Use a key with write access."), request, id, headers);
    }

    const ctx = writeContext(key.organizationId, key.currency);
    try {
      const result = await handler({
        request,
        query: new URL(request.url).searchParams,
        params: await context.params,
        key,
        ctx,
        body: () => readJsonBody(request),
      });
      return json(result.status ?? 200, result.body, id, headers);
    } catch (error: unknown) {
      return failure(error, request, id, headers);
    } finally {
      flushEffects(key, ctx);
    }
  };
}

/** For paths under /api/v1 that match no endpoint. */
export function notFoundRoute(): (request: Request) => Promise<Response> {
  return async function route(request) {
    const error: { type: ApiErrorType; message: string } = {
      type: "not_found",
      message: `No endpoint ${request.method} ${new URL(request.url).pathname}. See /docs/api.`,
    };
    return json(404, { error }, requestId(), {});
  };
}

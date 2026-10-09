import "server-only";

// A small read-only Stripe API client over `fetch` — no SDK to install. It
// lists and retrieves; it never writes to Stripe. Errors become StripeError
// with a message a person can act on (wrong key, missing permission).
import { env } from "@/lib/env";

const TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface StripeClient {
  get<T>(path: string, params?: Readonly<Record<string, string>>): Promise<T>;
  list<T extends { id: string }>(path: string, params?: Readonly<Record<string, string>>, maxPages?: number): AsyncGenerator<T>;
}

interface StripeList<T> {
  readonly data: T[];
  readonly has_more: boolean;
}

/** Which permission a path needs, for the error a restricted key gets without it. */
function resourceOf(path: string): string {
  const name = path.split("/")[2] ?? "this resource";
  return name.replace(/s$/, "") + "s";
}

export function stripeClient(apiKey: string, baseUrl: string = env.STRIPE_API_BASE): StripeClient {
  async function get<T>(path: string, params: Readonly<Record<string, string>> = {}): Promise<T> {
    const url = new URL(path, baseUrl);
    for (const [name, value] of Object.entries(params)) url.searchParams.append(name, value);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, "Stripe-Version": "2024-06-20" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new StripeError("Couldn't reach Stripe. Try again in a few minutes.", 0);
    }
    if (response.ok) return (await response.json()) as T;
    if (response.status === 401) throw new StripeError("Stripe didn't accept this key. Check that it was copied whole and hasn't been rolled.", 401);
    if (response.status === 403) {
      throw new StripeError(`This key can't read ${resourceOf(path)}. Give it Read access to ${resourceOf(path)} in Stripe.`, 403);
    }
    if (response.status === 429) throw new StripeError("Stripe is rate-limiting this key. The next sync will pick up where this one stopped.", 429);
    let detail = "";
    try {
      detail = ((await response.json()) as { error?: { message?: string } }).error?.message ?? "";
    } catch {
      // Not JSON.
    }
    throw new StripeError(`Stripe answered ${response.status}${detail ? `: ${detail}` : ""}.`, response.status);
  }

  async function* list<T extends { id: string }>(
    path: string,
    params: Readonly<Record<string, string>> = {},
    maxPages: number = 50,
  ): AsyncGenerator<T> {
    let startingAfter: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const body: StripeList<T> = await get<StripeList<T>>(path, {
        ...params,
        limit: String(PAGE_SIZE),
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const item of body.data) yield item;
      if (!body.has_more || body.data.length === 0) return;
      startingAfter = body.data[body.data.length - 1].id;
    }
  }

  return { get, list };
}

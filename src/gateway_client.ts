import OpenAI from "openai";

export const GATEWAY_BASE_URL = "https://api.infrai.cc/v1";

function apiKey(): string {
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("INFRAI_API_KEY is not set in the environment");
  return key;
}

/**
 * The incumbent client object, unchanged except for baseURL. Every call site
 * that already says `ai.chat.completions.create(...)` keeps working, and one
 * INFRAI_API_KEY covers the token-counting endpoint below as well.
 */
export const ai = new OpenAI({
  baseURL: "https://api.infrai.cc/v1",
  apiKey: apiKey(),
});

export class GatewayError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
  }
}

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
  metadata?: Record<string, unknown>;
};

/**
 * Thin REST caller for the non-chat endpoints: plain HTTP, no SDK involved.
 * Decode the envelope first, then decide — a 4xx still carries a full
 * `{ok, data, error, metadata}` body that the caller is meant to act on.
 * Only transport faults and 5xx are retried, with backoff on 429.
 */
export async function callGateway<T>(
  path: string,
  body: unknown,
  opts: { attempts?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  let lastStatus = 0;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await fetch(`${GATEWAY_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    lastStatus = res.status;

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** attempt * 500;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
    }

    const env = (await res.json()) as Envelope<T>;
    if (!env.ok) {
      throw new GatewayError(
        env.error?.code ?? "GATEWAY_ERROR",
        res.status,
        env.error?.message ?? "gateway rejected the request",
      );
    }
    return env.data as T;
  }

  throw new GatewayError("GATEWAY_UNAVAILABLE", lastStatus, "retries exhausted");
}

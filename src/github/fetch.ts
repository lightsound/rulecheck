import { Duration, Effect } from "effect";
import { GitHubError } from "./client.ts";
import {
  errorMessageOf,
  parseRateLimit,
  type RateLimit,
  retryAfterOf,
  type Transport,
  type TransportResponse,
} from "./transport.ts";

/**
 * `Transport` over `fetch` for runtimes that cannot spawn `gh`: the hosted App on workerd, a
 * GitHub Actions step without the CLI, a script with a token in hand (D26). Uses only `fetch`,
 * `Headers`, and `Effect`, so it runs on Bun, Node, and workerd alike.
 *
 * Rate limits (app-design §4): every response's quota headers are reported through
 * `onRateLimit`, so a job runner can delay itself below a floor instead of failing. A `403` or
 * `429` that GitHub marks as a secondary limit (a `retry-after` header, or a message naming the
 * secondary limit) is retried once after the advertised delay when that delay is within
 * `maxRetryDelaySeconds`; a primary limit (`x-ratelimit-remaining: 0`, reset up to an hour away)
 * is not retried and reaches the caller as a `GitHubError` whose `retryAfter` says how long to
 * wait. Every other status is a response for `makeGitHub` to map.
 */

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchTransportOptions {
  /**
   * Bearer token for each request, evaluated per request so the caller decides how it is minted
   * and refreshed: `Effect.succeed(pat)`, a `Config`, or `installationToken(...)`.
   */
  readonly token: Effect.Effect<string, GitHubError>;
  /** API root; default `https://api.github.com`. */
  readonly baseUrl?: string;
  /** Default `globalThis.fetch`; injected by tests. */
  readonly fetch?: Fetch;
  /** GitHub requires one; default `rulecheck`. */
  readonly userAgent?: string;
  /** Called with the quota headers of every response that carries them. */
  readonly onRateLimit?: (limit: RateLimit) => Effect.Effect<void>;
  /** How the retry waits; default `Effect.sleep`. Injected by tests. */
  readonly sleep?: (seconds: number) => Effect.Effect<void>;
  /** Longest secondary-limit delay the transport waits out itself; default 120. */
  readonly maxRetryDelaySeconds?: number;
}

export const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_SECONDARY_DELAY_SECONDS = 60;
const SECONDARY_LIMIT_MESSAGE = /secondary rate limit|abuse detection/i;

export const fetchTransport = (options: FetchTransportOptions): Transport => {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch: Fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const sleep = options.sleep ?? ((seconds: number) => Effect.sleep(Duration.seconds(seconds)));
  const maxRetryDelay = options.maxRetryDelaySeconds ?? 120;

  const once = (
    operation: string,
    method: string,
    path: string,
    body: unknown | null,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Effect.Effect<TransportResponse, GitHubError> =>
    Effect.gen(function* () {
      const token = yield* options.token;
      const init: RequestInit = {
        method,
        headers: {
          accept: "application/vnd.github+json",
          // The token is opaque here: any length, any prefix (GitHub's stateless `ghs_` JWTs
          // included); it is never inspected, logged, or stored by this module.
          authorization: `Bearer ${token}`,
          "user-agent": options.userAgent ?? "rulecheck",
          "x-github-api-version": "2022-11-28",
          ...(body === null ? {} : { "content-type": "application/json" }),
          ...extraHeaders,
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      };
      const response = yield* Effect.tryPromise({
        try: () => doFetch(`${baseUrl}/${path}`, init),
        catch: (cause) =>
          new GitHubError({
            operation,
            status: null,
            message: `could not reach ${baseUrl} (${describe(cause)})`,
          }),
      });
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          new GitHubError({
            operation,
            status: response.status,
            message: `could not read the response body (${describe(cause)})`,
          }),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      const limit = parseRateLimit(headers);
      if (limit !== null && options.onRateLimit) yield* options.onRateLimit(limit);
      return { status: response.status, headers, body: text };
    });

  return {
    request: ({ method, path, body, headers }) =>
      Effect.gen(function* () {
        const operation = `${method} ${path}`;
        const first = yield* once(operation, method, path, body, headers);
        const delay = secondaryLimitDelay(first);
        if (delay === null || delay > maxRetryDelay) return first;
        yield* sleep(delay);
        return yield* once(operation, method, path, body, headers);
      }),
  };
};

/**
 * Seconds to wait before the one retry, when the response is a secondary rate limit; null for
 * every other response, including an exhausted primary quota.
 */
export function secondaryLimitDelay(response: TransportResponse): number | null {
  if (response.status !== 403 && response.status !== 429) return null;
  const limit = parseRateLimit(response.headers);
  if (limit !== null && limit.remaining === 0) return null;
  const retryAfter = retryAfterOf(response.headers);
  if (retryAfter !== null) return retryAfter;
  const message = errorMessageOf(response.body);
  return message !== null && SECONDARY_LIMIT_MESSAGE.test(message)
    ? DEFAULT_SECONDARY_DELAY_SECONDS
    : null;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

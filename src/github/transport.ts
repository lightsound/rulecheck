import { Effect } from "effect";
import {
  GitHubError,
  type GitHubService,
  type PullRequest,
  type RepositoryRef,
  type TreeEntry,
} from "./client.ts";

/**
 * The seam between the GitHub client and the wire (D26). A `Transport` turns one REST request
 * into one HTTP response and knows nothing about repositories; `makeGitHub` turns the response
 * into the `GitHubService` operations and knows nothing about processes, sockets, or tokens.
 * Two transports exist: `ghTransport` (`gh.ts`) spawns the GitHub CLI for the command line, and
 * `fetchTransport` (`fetch.ts`) uses `fetch` for the hosted App, where no process can be spawned.
 * Both feed the same mapping, so the two fronts cannot disagree on what a response means.
 */

export type Method = "GET" | "POST" | "PATCH";

export interface TransportRequest {
  readonly method: Method;
  /** Path below the API root, without a leading slash: `repos/acme/r/git/trees/abc?recursive=1`. */
  readonly path: string;
  /** JSON body, or null for none. */
  readonly body: unknown | null;
  /** Extra request headers for this call only (a transport that has no headers ignores them). */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface TransportResponse {
  readonly status: number;
  /** Header names lowercased. A transport that cannot see headers returns an empty record. */
  readonly headers: Readonly<Record<string, string>>;
  /** Raw body text; empty for `204`. */
  readonly body: string;
}

export interface Transport {
  /**
   * Perform the request. Fails only when the API could not be reached or answered nothing
   * usable (status null); an HTTP error status is a response, which `makeGitHub` maps.
   */
  readonly request: (request: TransportRequest) => Effect.Effect<TransportResponse, GitHubError>;
}

/** Quota headers the API attaches to every response. */
export interface RateLimit {
  readonly limit: number;
  readonly remaining: number;
  /** Unix time in seconds at which `remaining` resets. */
  readonly reset: number;
  readonly resource: string | null;
}

export function parseRateLimit(headers: Readonly<Record<string, string>>): RateLimit | null {
  const limit = integer(headers["x-ratelimit-limit"]);
  const remaining = integer(headers["x-ratelimit-remaining"]);
  const reset = integer(headers["x-ratelimit-reset"]);
  if (limit === null || remaining === null || reset === null) return null;
  return { limit, remaining, reset, resource: headers["x-ratelimit-resource"] ?? null };
}

/**
 * Seconds to wait before retrying, as the response advertises it: `retry-after` when present,
 * otherwise the time to the quota reset when the quota is exhausted; null when the response
 * says nothing about waiting.
 */
export function retryAfterOf(
  headers: Readonly<Record<string, string>>,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number | null {
  const retryAfter = integer(headers["retry-after"]);
  if (retryAfter !== null) return Math.max(0, retryAfter);
  const limit = parseRateLimit(headers);
  if (limit !== null && limit.remaining === 0) return Math.max(0, limit.reset - nowSeconds);
  return null;
}

/** The `message` of a GitHub error body, when the body is one. */
export function errorMessageOf(body: string): string | null {
  try {
    return str(field(JSON.parse(body), "message"));
  } catch {
    return null;
  }
}

/** The `GitHubService` over any transport: paths, bodies, and the response mapping in one place. */
export function makeGitHub(transport: Transport): GitHubService {
  const api = (
    operation: string,
    method: Method,
    path: string,
    body: unknown = null,
  ): Effect.Effect<unknown, GitHubError> =>
    transport.request({ method, path, body }).pipe(
      // A transport names no operation; the CLI's failure line does (`GitHub getRef failed`).
      Effect.mapError(
        (error) =>
          new GitHubError({
            operation,
            status: error.status,
            message: error.message,
            ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
          }),
      ),
      Effect.flatMap((response) => {
        if (response.status >= 400) {
          const retryAfter = retryAfterOf(response.headers);
          return new GitHubError({
            operation,
            status: response.status,
            message: errorMessageOf(response.body) ?? `HTTP ${response.status}`,
            ...(retryAfter === null ? {} : { retryAfter }),
          });
        }
        if (response.body.trim().length === 0) return Effect.succeed(null);
        return Effect.try({
          try: () => JSON.parse(response.body) as unknown,
          catch: () =>
            new GitHubError({
              operation,
              status: response.status,
              message: "GitHub API returned non-JSON output",
            }),
        });
      }),
    );

  const notFoundAsNull = <A>(effect: Effect.Effect<A, GitHubError>) =>
    effect.pipe(
      Effect.catchIf(
        (e) => e.status === 404,
        () => Effect.succeed(null),
      ),
    );

  const repos = (repo: RepositoryRef) => `repos/${repo.owner}/${repo.name}`;

  return {
    getRepository: (repo) =>
      api("getRepository", "GET", repos(repo)).pipe(
        Effect.map((data) => {
          const size = field(data, "size");
          return {
            defaultBranch: str(field(data, "default_branch")) ?? "main",
            size: typeof size === "number" ? size : 0,
          };
        }),
      ),

    getRef: (repo, name) =>
      notFoundAsNull(api("getRef", "GET", `${repos(repo)}/git/ref/${name}`)).pipe(
        Effect.map((data) => (data === null ? null : str(field(field(data, "object"), "sha")))),
      ),

    getCommit: (repo, sha) =>
      api("getCommit", "GET", `${repos(repo)}/git/commits/${sha}`).pipe(
        Effect.flatMap((data) => {
          const tree = str(field(field(data, "tree"), "sha"));
          return tree === null
            ? new GitHubError({
                operation: "getCommit",
                status: null,
                message: "commit has no tree",
              })
            : Effect.succeed({ tree, message: str(field(data, "message")) ?? "" });
        }),
      ),

    getTree: (repo, treeSha, options) =>
      api(
        "getTree",
        "GET",
        `${repos(repo)}/git/trees/${treeSha}${options?.recursive === false ? "" : "?recursive=1"}`,
      ).pipe(
        Effect.map((data) => ({
          entries: (Array.isArray(field(data, "tree")) ? (field(data, "tree") as unknown[]) : [])
            .map(treeEntry)
            .filter((entry): entry is TreeEntry => entry !== null),
          truncated: field(data, "truncated") === true,
        })),
      ),

    getBlob: (repo, sha) =>
      api("getBlob", "GET", `${repos(repo)}/git/blobs/${sha}`).pipe(
        Effect.flatMap((data) => {
          const content = str(field(data, "content")) ?? "";
          const encoding = str(field(data, "encoding")) ?? "base64";
          if (encoding === "base64") {
            return Effect.try({
              try: () => decodeBase64(content),
              catch: () =>
                new GitHubError({
                  operation: "getBlob",
                  status: null,
                  message: `blob ${sha} is not valid base64`,
                }),
            });
          }
          if (encoding === "utf-8") return Effect.succeed(new TextEncoder().encode(content));
          return new GitHubError({
            operation: "getBlob",
            status: null,
            message: `blob ${sha} uses unsupported encoding \`${encoding}\``,
          });
        }),
      ),

    createTree: (repo, baseTree, changes) =>
      api("createTree", "POST", `${repos(repo)}/git/trees`, {
        base_tree: baseTree,
        tree: changes.map((change) =>
          change.content === null
            ? { path: change.path, mode: "100644", type: "blob", sha: null }
            : { path: change.path, mode: "100644", type: "blob", content: change.content },
        ),
      }).pipe(Effect.flatMap((data) => requireSha("createTree", data))),

    createCommit: (repo, input) =>
      api("createCommit", "POST", `${repos(repo)}/git/commits`, {
        message: input.message,
        tree: input.tree,
        parents: input.parents,
      }).pipe(Effect.flatMap((data) => requireSha("createCommit", data))),

    setRef: (repo, name, sha, options) =>
      (options.create
        ? api("setRef", "POST", `${repos(repo)}/git/refs`, { ref: `refs/${name}`, sha })
        : api("setRef", "PATCH", `${repos(repo)}/git/refs/${name}`, {
            sha,
            force: options.force ?? true,
          })
      ).pipe(Effect.asVoid),

    listOpenPullRequests: (repo, head) =>
      api(
        "listOpenPullRequests",
        "GET",
        `${repos(repo)}/pulls?state=open&head=${encodeURIComponent(head)}`,
      ).pipe(
        Effect.map((data) =>
          (Array.isArray(data) ? data : [])
            .map(pullRequest)
            .filter((pr): pr is PullRequest => pr !== null),
        ),
      ),

    createPullRequest: (repo, input) =>
      api("createPullRequest", "POST", `${repos(repo)}/pulls`, input).pipe(
        Effect.flatMap((data) => requirePullRequest("createPullRequest", data)),
      ),

    updatePullRequest: (repo, number, input) =>
      api("updatePullRequest", "PATCH", `${repos(repo)}/pulls/${number}`, input).pipe(
        Effect.flatMap((data) => requirePullRequest("updatePullRequest", data)),
      ),
  };
}

/** Base64 (the API wraps it in newlines) to bytes with `atob`, which every runtime has. */
function decodeBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function integer(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function field(data: unknown, key: string): unknown {
  if (typeof data !== "object" || data === null) return undefined;
  return (data as Record<string, unknown>)[key];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function treeEntry(raw: unknown): TreeEntry | null {
  const path = str(field(raw, "path"));
  const sha = str(field(raw, "sha"));
  const type = str(field(raw, "type"));
  if (path === null || sha === null) return null;
  if (type !== "blob" && type !== "tree" && type !== "commit") return null;
  return { path, sha, type, mode: str(field(raw, "mode")) ?? "100644" };
}

function pullRequest(raw: unknown): PullRequest | null {
  const number = field(raw, "number");
  const url = str(field(raw, "html_url"));
  if (typeof number !== "number" || url === null) return null;
  return {
    number,
    url,
    title: str(field(raw, "title")) ?? "",
    body: str(field(raw, "body")) ?? "",
  };
}

function requireSha(operation: string, data: unknown): Effect.Effect<string, GitHubError> {
  const sha = str(field(data, "sha"));
  return sha === null
    ? new GitHubError({ operation, status: null, message: "response has no sha" })
    : Effect.succeed(sha);
}

function requirePullRequest(
  operation: string,
  data: unknown,
): Effect.Effect<PullRequest, GitHubError> {
  const pr = pullRequest(data);
  return pr === null
    ? new GitHubError({ operation, status: null, message: "response is not a pull request" })
    : Effect.succeed(pr);
}

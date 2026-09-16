import { Context, Data, type Effect } from "effect";

/**
 * The GitHub client rulecheck talks to (D10). The interface is the handful of Git Data and pull
 * request operations the scan (read) and the sync (write) need, so tests provide an in-memory
 * implementation and never touch a real repository. The live implementation is
 * `makeGitHub(transport)` in `transport.ts` over a `Transport` (D26): `ghTransport` (`gh.ts`,
 * the CLI) or `fetchTransport` (`fetch.ts`, the hosted App).
 */

export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export function repositoryName(repo: RepositoryRef): string {
  return `${repo.owner}/${repo.name}`;
}

const REMOTE_SPEC = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:@(\S+))?$/;

/** `owner/repo` or `owner/repo@ref`; null when the text is not of that form. */
export function parseRepositorySpec(
  spec: string,
): { readonly repo: RepositoryRef; readonly ref: string | null } | null {
  const match = REMOTE_SPEC.exec(spec.trim());
  if (!match?.[1] || !match[2]) return null;
  return { repo: { owner: match[1], name: match[2] }, ref: match[3] ?? null };
}

export interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string;
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
}

/** One path in a new tree: `content` null deletes the path. */
export interface TreeChange {
  readonly path: string;
  readonly content: string | null;
}

export class GitHubError extends Data.TaggedError("GitHubError")<{
  readonly message: string;
  /** HTTP status when the API answered, null for transport problems (gh missing, not logged in). */
  readonly status: number | null;
  readonly operation: string;
  /**
   * Seconds the API asked the caller to wait before trying again (`retry-after`, or the time to
   * `x-ratelimit-reset` when the quota is exhausted). Absent when the API gave no such hint.
   */
  readonly retryAfter?: number;
}> {}

export interface GitHubService {
  readonly getRepository: (
    repo: RepositoryRef,
  ) => Effect.Effect<{ readonly defaultBranch: string }, GitHubError>;
  /** Sha of `refs/<name>` (`heads/main`), or null when the ref does not exist. */
  readonly getRef: (repo: RepositoryRef, name: string) => Effect.Effect<string | null, GitHubError>;
  readonly getCommit: (
    repo: RepositoryRef,
    sha: string,
  ) => Effect.Effect<{ readonly tree: string; readonly message: string }, GitHubError>;
  /**
   * Every entry below `treeSha`, recursively by default; with `recursive: false` only the
   * direct children (paths are then relative to that tree). `truncated` is true when the API
   * cut the recursive listing short (about 100,000 entries); `repositorySnapshot` then lists
   * subtrees one by one.
   */
  readonly getTree: (
    repo: RepositoryRef,
    treeSha: string,
    options?: { readonly recursive?: boolean },
  ) => Effect.Effect<
    { readonly entries: ReadonlyArray<TreeEntry>; readonly truncated: boolean },
    GitHubError
  >;
  readonly getBlob: (repo: RepositoryRef, sha: string) => Effect.Effect<Uint8Array, GitHubError>;
  readonly createTree: (
    repo: RepositoryRef,
    baseTree: string,
    changes: ReadonlyArray<TreeChange>,
  ) => Effect.Effect<string, GitHubError>;
  readonly createCommit: (
    repo: RepositoryRef,
    input: {
      readonly message: string;
      readonly tree: string;
      readonly parents: ReadonlyArray<string>;
    },
  ) => Effect.Effect<string, GitHubError>;
  /**
   * Create `refs/<name>` at `sha`, or move it there when it exists. The move is forced by
   * default; `force: false` asks for a fast-forward only, and a ref that moved in between
   * surfaces as a `GitHubError` with status 422.
   */
  readonly setRef: (
    repo: RepositoryRef,
    name: string,
    sha: string,
    options: { readonly create: boolean; readonly force?: boolean },
  ) => Effect.Effect<void, GitHubError>;
  /** Open pull requests whose head is `owner:branch`. */
  readonly listOpenPullRequests: (
    repo: RepositoryRef,
    head: string,
  ) => Effect.Effect<ReadonlyArray<PullRequest>, GitHubError>;
  readonly createPullRequest: (
    repo: RepositoryRef,
    input: {
      readonly title: string;
      readonly body: string;
      readonly head: string;
      readonly base: string;
    },
  ) => Effect.Effect<PullRequest, GitHubError>;
  readonly updatePullRequest: (
    repo: RepositoryRef,
    number: number,
    input: { readonly title: string; readonly body: string },
  ) => Effect.Effect<PullRequest, GitHubError>;
}

export class GitHub extends Context.Service<GitHub, GitHubService>()("rulecheck/GitHub") {}

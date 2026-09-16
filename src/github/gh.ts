import { Effect, Layer } from "effect";
import {
  GitHub,
  GitHubError,
  type GitHubService,
  type PullRequest,
  type RepositoryRef,
  type TreeEntry,
} from "./client.ts";

/**
 * `GitHub` implemented over the GitHub CLI: every operation is one `gh api` call, so
 * authentication, hosts, and tokens stay with `gh auth` and rulecheck never holds a credential.
 * `gh` is spawned with this process's environment, so a `GH_TOKEN` variable (the form GitHub
 * Actions uses, D23) authenticates it without any `gh auth login` state.
 */

export interface GhResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run `gh <args>` with `stdin` piped in. Injected so the layer can be tested without a process. */
export type GhRunner = (args: ReadonlyArray<string>, stdin: string | null) => Promise<GhResult>;

export const bunGhRunner: GhRunner = async (args, stdin) => {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

type Method = "GET" | "POST" | "PATCH";

interface ApiError {
  readonly status: number | null;
  readonly message: string;
}

export const layerGh = (run: GhRunner = bunGhRunner): Layer.Layer<GitHub> =>
  Layer.succeed(GitHub, makeGh(run));

export function makeGh(run: GhRunner): GitHubService {
  const api = (
    operation: string,
    method: Method,
    path: string,
    body: unknown = null,
  ): Effect.Effect<unknown, GitHubError> =>
    Effect.gen(function* () {
      const args = ["api", "-X", method, "-H", "Accept: application/vnd.github+json", path];
      if (body !== null) args.push("--input", "-");
      const result = yield* Effect.tryPromise({
        try: () => run(args, body === null ? null : JSON.stringify(body)),
        catch: (cause) =>
          new GitHubError({
            operation,
            status: null,
            message: `could not run gh (${String(cause)}); install the GitHub CLI and run \`gh auth login\` or set GH_TOKEN`,
          }),
      });
      if (result.exitCode !== 0) {
        const error = parseError(result);
        return yield* new GitHubError({ operation, status: error.status, message: error.message });
      }
      if (result.stdout.trim().length === 0) return null;
      return yield* Effect.try({
        try: () => JSON.parse(result.stdout) as unknown,
        catch: () =>
          new GitHubError({ operation, status: null, message: "gh api returned non-JSON output" }),
      });
    });

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
        Effect.map((data) => ({ defaultBranch: str(field(data, "default_branch")) ?? "main" })),
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

    getTree: (repo, treeSha) =>
      api("getTree", "GET", `${repos(repo)}/git/trees/${treeSha}?recursive=1`).pipe(
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
            return Effect.succeed(
              Uint8Array.from(Buffer.from(content.replace(/\n/g, ""), "base64")),
            );
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
        : api("setRef", "PATCH", `${repos(repo)}/git/refs/${name}`, { sha, force: true })
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

/** `gh api` prints the JSON error body on stdout and `gh: <message> (HTTP <status>)` on stderr. */
function parseError(result: GhResult): ApiError {
  const status = /HTTP (\d{3})/.exec(result.stderr)?.[1];
  let message: string | null = null;
  try {
    message = str(field(JSON.parse(result.stdout), "message"));
  } catch {
    message = null;
  }
  const stderr = result.stderr.trim();
  return {
    status: status === undefined ? null : Number(status),
    message: message ?? (stderr.length > 0 ? stderr : `gh exited with ${result.exitCode}`),
  };
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

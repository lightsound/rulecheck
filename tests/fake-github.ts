import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import {
  GitHub,
  GitHubError,
  type GitHubService,
  type PullRequest,
  type RepositoryRef,
  type TreeEntry,
} from "../src/github/client.ts";
import type { Fetch } from "../src/github/fetch.ts";
import type { GhResult, GhRunner } from "../src/github/gh.ts";

/**
 * In-memory GitHub for tests: a handful of repositories with a flat git object store. Write
 * operations are recorded in `calls` so a dry run can be shown to write nothing.
 */

export interface FakeRepoInput {
  readonly defaultBranch?: string;
  /** Reported by `getRepository` as the API's `size` (kilobytes); default 0. */
  readonly size?: number;
  readonly files: Readonly<Record<string, string>>;
}

interface StoredPull extends Omit<PullRequest, "title" | "body"> {
  title: string;
  body: string;
  head: string;
  base: string;
  state: "open" | "closed";
}

interface StoredRepo {
  defaultBranch: string;
  size: number;
  refs: Map<string, string>;
  pulls: StoredPull[];
}

type Obj =
  | { type: "blob"; content: Uint8Array }
  | { type: "tree"; entries: ReadonlyArray<TreeEntry> }
  | { type: "commit"; tree: string; parents: ReadonlyArray<string>; message: string };

export interface FakeGitHub {
  readonly layer: Layer.Layer<GitHub>;
  readonly service: GitHubService;
  readonly calls: string[];
  /**
   * Scheduling evidence: every call yields once, so concurrent fibers interleave here as they
   * would on a network. `maxInFlight` is the most distinct repositories with a call open at one
   * moment (not the most calls); `maxWriters` the most repositories that were between their
   * first write (`createTree`) and their pull request at one moment, which the write lock must
   * keep at 1. A write sequence that fails midway leaves the writer set with its error.
   */
  readonly maxInFlight: () => number;
  readonly maxWriters: () => number;
  /** Content of `path` at the tip of `refs/<ref>`, or null when absent. */
  readonly fileAt: (repo: string, ref: string, path: string) => string | null;
  readonly pathsAt: (repo: string, ref: string) => string[];
  readonly commitAt: (
    repo: string,
    ref: string,
  ) => { message: string; parents: ReadonlyArray<string> };
  readonly pulls: (repo: string) => ReadonlyArray<StoredPull>;
  readonly moveRef: (repo: string, ref: string, toRef: string) => void;
}

export interface FakeGitHubOptions {
  /**
   * Behave like the API on a huge repository: a recursive `getTree` with more entries than this
   * returns `truncated: true` and only the first entries. Non-recursive listings are never cut.
   */
  readonly truncateTreesAbove?: number;
}

export function fakeGitHub(
  input: Readonly<Record<string, FakeRepoInput>>,
  options: FakeGitHubOptions = {},
): FakeGitHub {
  const objects = new Map<string, Obj>();
  const repos = new Map<string, StoredRepo>();
  const calls: string[] = [];
  const encoder = new TextEncoder();

  const put = (obj: Obj): string => {
    const sha = createHash("sha1")
      .update(
        JSON.stringify(obj, (_, v) =>
          v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v,
        ),
      )
      .digest("hex");
    objects.set(sha, obj);
    return sha;
  };
  const blob = (content: string) => put({ type: "blob", content: encoder.encode(content) });

  for (const [name, repo] of Object.entries(input)) {
    const entries: TreeEntry[] = Object.entries(repo.files).map(([path, content]) => ({
      path,
      mode: "100644",
      type: "blob",
      sha: blob(content),
    }));
    const tree = put({ type: "tree", entries });
    const commit = put({ type: "commit", tree, parents: [], message: "initial" });
    const defaultBranch = repo.defaultBranch ?? "main";
    repos.set(name, {
      defaultBranch,
      size: repo.size ?? 0,
      refs: new Map([[`heads/${defaultBranch}`, commit]]),
      pulls: [],
    });
  }

  const key = (repo: RepositoryRef) => `${repo.owner}/${repo.name}`;
  const fail = (operation: string, status: number, message: string) =>
    new GitHubError({ operation, status, message });
  const repoOf = (
    operation: string,
    repo: RepositoryRef,
  ): Effect.Effect<StoredRepo, GitHubError> => {
    const stored = repos.get(key(repo));
    return stored ? Effect.succeed(stored) : fail(operation, 404, "Not Found");
  };
  const get = <T extends Obj["type"]>(
    operation: string,
    sha: string,
    type: T,
  ): Effect.Effect<Extract<Obj, { type: T }>, GitHubError> => {
    const obj = objects.get(sha);
    return obj && obj.type === type
      ? Effect.succeed(obj as Extract<Obj, { type: T }>)
      : fail(operation, 404, `no ${type} ${sha}`);
  };

  const inFlight = new Map<string, number>();
  let maxInFlight = 0;
  const writers = new Set<string>();
  let maxWriters = 0;
  /** Keep the call open across one scheduler yield, like a request on the wire. */
  const call = <A, E>(repo: RepositoryRef, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      const name = key(repo);
      inFlight.set(name, (inFlight.get(name) ?? 0) + 1);
      maxInFlight = Math.max(maxInFlight, inFlight.size);
      return Effect.yieldNow.pipe(
        Effect.andThen(effect),
        // A failed write call ends the repository's write sequence: the sync stops there.
        Effect.tapError(() => Effect.sync(() => writers.delete(name))),
        Effect.ensuring(
          Effect.sync(() => {
            const open = (inFlight.get(name) ?? 1) - 1;
            if (open === 0) inFlight.delete(name);
            else inFlight.set(name, open);
          }),
        ),
      );
    });
  const beginWrite = (repo: RepositoryRef) => {
    writers.add(key(repo));
    maxWriters = Math.max(maxWriters, writers.size);
  };
  const endWrite = (repo: RepositoryRef) => writers.delete(key(repo));

  const plain: GitHubService = {
    getRepository: (repo) =>
      repoOf("getRepository", repo).pipe(
        Effect.map((r) => ({ defaultBranch: r.defaultBranch, size: r.size })),
      ),
    getRef: (repo, name) =>
      repoOf("getRef", repo).pipe(Effect.map((r) => r.refs.get(name) ?? null)),
    getCommit: (repo, sha) =>
      repoOf("getCommit", repo).pipe(
        Effect.flatMap(() => get("getCommit", sha, "commit")),
        Effect.map((c) => ({ tree: c.tree, message: c.message })),
      ),
    getTree: (repo, treeSha, treeOptions) =>
      repoOf("getTree", repo).pipe(
        Effect.flatMap(() => get("getTree", treeSha, "tree")),
        Effect.map((t) => {
          if (treeOptions?.recursive === false) return { entries: children(t), truncated: false };
          const limit = options.truncateTreesAbove ?? Number.POSITIVE_INFINITY;
          return t.entries.length > limit
            ? { entries: t.entries.slice(0, limit), truncated: true }
            : { entries: t.entries, truncated: false };
        }),
      ),
    getBlob: (repo, sha) =>
      repoOf("getBlob", repo).pipe(
        Effect.flatMap(() => get("getBlob", sha, "blob")),
        Effect.map((b) => b.content),
      ),
    createTree: (repo, baseTree, changes) =>
      repoOf("createTree", repo).pipe(
        Effect.flatMap(() => get("createTree", baseTree, "tree")),
        Effect.map((base) => {
          beginWrite(repo);
          calls.push(`createTree ${key(repo)} ${changes.map((c) => c.path).join(",")}`);
          const entries = new Map(base.entries.map((e) => [e.path, e] as const));
          for (const change of changes) {
            if (change.content === null) entries.delete(change.path);
            else
              entries.set(change.path, {
                path: change.path,
                mode: "100644",
                type: "blob",
                sha: blob(change.content),
              });
          }
          return put({ type: "tree", entries: [...entries.values()] });
        }),
      ),
    createCommit: (repo, input) =>
      repoOf("createCommit", repo).pipe(
        Effect.map(() => {
          calls.push(`createCommit ${key(repo)}`);
          return put({ type: "commit", ...input });
        }),
      ),
    setRef: (repo, name, sha, options) =>
      repoOf("setRef", repo).pipe(
        Effect.flatMap((r) => {
          calls.push(`setRef ${key(repo)} ${name} ${options.create ? "create" : "force"}`);
          if (options.create && r.refs.has(name))
            return fail("setRef", 422, "Reference already exists");
          if (!options.create && !r.refs.has(name))
            return fail("setRef", 422, "Reference does not exist");
          const current = r.refs.get(name);
          if (!options.create && options.force === false && current !== undefined) {
            if (!descends(sha, current)) return fail("setRef", 422, "Update is not a fast forward");
          }
          r.refs.set(name, sha);
          return Effect.void;
        }),
      ),
    listOpenPullRequests: (repo, head) =>
      repoOf("listOpenPullRequests", repo).pipe(
        Effect.map((r) => r.pulls.filter((p) => p.state === "open" && p.head === head)),
      ),
    createPullRequest: (repo, input) =>
      repoOf("createPullRequest", repo).pipe(
        Effect.map((r) => {
          calls.push(`createPullRequest ${key(repo)} ${input.head} -> ${input.base}`);
          endWrite(repo);
          const number = r.pulls.length + 1;
          const pull: StoredPull = {
            number,
            url: `https://github.com/${key(repo)}/pull/${number}`,
            title: input.title,
            body: input.body,
            head: `${repo.owner}:${input.head}`,
            base: input.base,
            state: "open",
          };
          r.pulls.push(pull);
          return pull;
        }),
      ),
    updatePullRequest: (repo, number, input) =>
      repoOf("updatePullRequest", repo).pipe(
        Effect.flatMap((r) => {
          calls.push(`updatePullRequest ${key(repo)} #${number}`);
          endWrite(repo);
          const pull = r.pulls.find((p) => p.number === number);
          if (!pull) return fail("updatePullRequest", 404, "Not Found");
          pull.title = input.title;
          pull.body = input.body;
          return Effect.succeed(pull);
        }),
      ),
  };
  const service: GitHubService = {
    getRepository: (repo) => call(repo, plain.getRepository(repo)),
    getRef: (repo, name) => call(repo, plain.getRef(repo, name)),
    getCommit: (repo, sha) => call(repo, plain.getCommit(repo, sha)),
    getTree: (repo, treeSha, treeOptions) => call(repo, plain.getTree(repo, treeSha, treeOptions)),
    getBlob: (repo, sha) => call(repo, plain.getBlob(repo, sha)),
    createTree: (repo, baseTree, changes) => call(repo, plain.createTree(repo, baseTree, changes)),
    createCommit: (repo, input) => call(repo, plain.createCommit(repo, input)),
    setRef: (repo, name, sha, options) => call(repo, plain.setRef(repo, name, sha, options)),
    listOpenPullRequests: (repo, head) => call(repo, plain.listOpenPullRequests(repo, head)),
    createPullRequest: (repo, input) => call(repo, plain.createPullRequest(repo, input)),
    updatePullRequest: (repo, number, input) =>
      call(repo, plain.updatePullRequest(repo, number, input)),
  };

  /** Whether `ancestor` is `sha` or one of its parents, transitively. */
  const descends = (sha: string, ancestor: string): boolean => {
    const seen = new Set<string>();
    const queue = [sha];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (next === ancestor) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      const obj = objects.get(next);
      if (obj?.type === "commit") queue.push(...obj.parents);
    }
    return false;
  };

  /**
   * The direct children of a flat tree, as the API lists a tree without `recursive`: blobs at
   * the top level as they are, each first-level directory as one `tree` entry whose sha names a
   * stored subtree holding the entries below it with the prefix removed.
   */
  const children = (tree: Extract<Obj, { type: "tree" }>): ReadonlyArray<TreeEntry> => {
    const direct: TreeEntry[] = [];
    const nested = new Map<string, TreeEntry[]>();
    for (const entry of tree.entries) {
      const slash = entry.path.indexOf("/");
      if (slash === -1) {
        direct.push(entry);
        continue;
      }
      const dir = entry.path.slice(0, slash);
      const below = nested.get(dir) ?? [];
      below.push({ ...entry, path: entry.path.slice(slash + 1) });
      nested.set(dir, below);
    }
    for (const [dir, entries] of nested) {
      direct.push({ path: dir, mode: "040000", type: "tree", sha: put({ type: "tree", entries }) });
    }
    return direct.sort((a, b) => a.path.localeCompare(b.path));
  };

  const treeAt = (repo: string, ref: string) => {
    const sha = repos.get(repo)?.refs.get(ref);
    const commit = sha ? objects.get(sha) : undefined;
    if (commit?.type !== "commit") throw new Error(`no commit at ${repo} ${ref}`);
    const tree = objects.get(commit.tree);
    if (tree?.type !== "tree") throw new Error(`no tree for ${repo} ${ref}`);
    return { commit, tree };
  };

  return {
    layer: Layer.succeed(GitHub, service),
    service,
    calls,
    maxInFlight: () => maxInFlight,
    maxWriters: () => maxWriters,
    fileAt: (repo, ref, path) => {
      const entry = treeAt(repo, ref).tree.entries.find((e) => e.path === path);
      const obj = entry ? objects.get(entry.sha) : undefined;
      return obj?.type === "blob" ? new TextDecoder().decode(obj.content) : null;
    },
    pathsAt: (repo, ref) =>
      treeAt(repo, ref)
        .tree.entries.map((e) => e.path)
        .sort(),
    commitAt: (repo, ref) => {
      const { commit } = treeAt(repo, ref);
      return { message: commit.message, parents: commit.parents };
    },
    pulls: (repo) => repos.get(repo)?.pulls ?? [],
    moveRef: (repo, ref, toRef) => {
      const stored = repos.get(repo);
      const sha = stored?.refs.get(toRef);
      if (!stored || !sha) throw new Error(`no ref ${toRef} in ${repo}`);
      stored.refs.set(ref, sha);
    },
  };
}

/**
 * The same fake behind GitHub's REST surface: a `fetch` that answers the paths `makeGitHub`
 * requests with the JSON GitHub would return, so `fetchTransport` (and `ghTransport` through
 * `ghRunnerOver`) can be exercised end to end against one object store. Every response carries
 * quota headers; `remaining` counts down from `limit`.
 */
export function fakeRest(
  fake: FakeGitHub,
  options: { readonly baseUrl?: string; readonly limit?: number } = {},
): Fetch & { readonly requests: Array<{ method: string; path: string; body: unknown }> } {
  const baseUrl = options.baseUrl ?? "https://api.github.com";
  const limit = options.limit ?? 5000;
  let used = 0;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const service = fake.service;

  const reply = (status: number, body: unknown) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-limit": String(limit),
        "x-ratelimit-remaining": String(Math.max(0, limit - used)),
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      },
    });

  const route = (
    method: string,
    path: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
  ): Effect.Effect<{ status: number; body: unknown }, GitHubError> => {
    const m = /^repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!m?.[1] || !m[2]) return Effect.succeed({ status: 404, body: { message: "Not Found" } });
    const repo = { owner: m[1], name: m[2] };
    const rest = m[3] ?? "";
    const ok = (data: unknown) => ({ status: 200, body: data });

    if (rest === "" && method === "GET")
      return service
        .getRepository(repo)
        .pipe(Effect.map((r) => ok({ default_branch: r.defaultBranch, size: r.size })));
    if (rest.startsWith("git/ref/") && method === "GET")
      return service
        .getRef(repo, rest.slice("git/ref/".length))
        .pipe(
          Effect.map((sha) =>
            sha === null
              ? { status: 404, body: { message: "Not Found" } }
              : ok({ object: { sha } }),
          ),
        );
    if (rest.startsWith("git/commits/") && method === "GET")
      return service
        .getCommit(repo, rest.slice("git/commits/".length))
        .pipe(Effect.map((c) => ok({ tree: { sha: c.tree }, message: c.message })));
    if (rest === "git/commits" && method === "POST")
      return service
        .createCommit(repo, {
          message: String(body.message),
          tree: String(body.tree),
          parents: body.parents as string[],
        })
        .pipe(Effect.map((sha) => ({ status: 201, body: { sha } })));
    if (rest.startsWith("git/trees/") && method === "GET")
      return service
        .getTree(repo, rest.slice("git/trees/".length), {
          recursive: query.get("recursive") === "1",
        })
        .pipe(Effect.map((t) => ok({ tree: t.entries, truncated: t.truncated })));
    if (rest === "git/trees" && method === "POST")
      return service
        .createTree(
          repo,
          String(body.base_tree),
          (body.tree as Array<{ path: string; content?: string; sha?: null }>).map((e) => ({
            path: e.path,
            content: e.sha === null ? null : (e.content ?? ""),
          })),
        )
        .pipe(Effect.map((sha) => ({ status: 201, body: { sha } })));
    if (rest.startsWith("git/blobs/") && method === "GET")
      return service
        .getBlob(repo, rest.slice("git/blobs/".length))
        .pipe(
          Effect.map((bytes) =>
            ok({ content: `${Buffer.from(bytes).toString("base64")}\n`, encoding: "base64" }),
          ),
        );
    if (rest === "git/refs" && method === "POST")
      return service
        .setRef(repo, String(body.ref).replace(/^refs\//, ""), String(body.sha), { create: true })
        .pipe(Effect.map(() => ({ status: 201, body: { ref: body.ref } })));
    if (rest.startsWith("git/refs/") && method === "PATCH")
      return service
        .setRef(repo, rest.slice("git/refs/".length), String(body.sha), {
          create: false,
          force: body.force === true,
        })
        .pipe(Effect.map(() => ok({ ref: `refs/${rest.slice("git/refs/".length)}` })));
    if (rest === "pulls" && method === "GET")
      return service
        .listOpenPullRequests(repo, query.get("head") ?? "")
        .pipe(Effect.map((pulls) => ok(pulls.map(pullJson))));
    if (rest === "pulls" && method === "POST")
      return service
        .createPullRequest(repo, {
          title: String(body.title),
          body: String(body.body),
          head: String(body.head),
          base: String(body.base),
        })
        .pipe(Effect.map((pull) => ({ status: 201, body: pullJson(pull) })));
    const pull = /^pulls\/(\d+)$/.exec(rest);
    if (pull?.[1] && method === "PATCH")
      return service
        .updatePullRequest(repo, Number(pull[1]), {
          title: String(body.title),
          body: String(body.body),
        })
        .pipe(Effect.map((updated) => ok(pullJson(updated))));
    return Effect.succeed({ status: 404, body: { message: `no route ${method} ${path}` } });
  };

  const fetch: Fetch = async (url, init) => {
    if (!url.startsWith(`${baseUrl}/`)) return reply(404, { message: `unexpected host ${url}` });
    const parsed = new URL(url);
    const path = parsed.pathname.slice(1);
    const method = init.method ?? "GET";
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    requests.push({ method, path, body: typeof init.body === "string" ? body : null });
    used += 1;
    const result = await Effect.runPromise(
      route(method, path, parsed.searchParams, body).pipe(
        Effect.catchTag("GitHubError", (e) =>
          Effect.succeed({ status: e.status ?? 500, body: { message: e.message } }),
        ),
      ),
    );
    return reply(result.status, result.body);
  };
  return Object.assign(fetch, { requests });
}

function pullJson(pull: PullRequest) {
  return { number: pull.number, html_url: pull.url, title: pull.title, body: pull.body };
}

/** A `GhRunner` that answers like `gh api` would over the given `fetch`. */
export function ghRunnerOver(fetch: Fetch, baseUrl = "https://api.github.com"): GhRunner {
  return async (args, stdin): Promise<GhResult> => {
    const method = args[args.indexOf("-X") + 1] ?? "GET";
    const path = args[args.indexOf("Accept: application/vnd.github+json") + 1] ?? "";
    const response = await fetch(`${baseUrl}/${path}`, {
      method,
      ...(stdin === null ? {} : { body: stdin }),
    });
    const text = await response.text();
    if (response.ok) return { exitCode: 0, stdout: text, stderr: "" };
    let message = "";
    try {
      message = String((JSON.parse(text) as { message?: string }).message ?? "");
    } catch {
      message = text;
    }
    return { exitCode: 1, stdout: text, stderr: `gh: ${message} (HTTP ${response.status})` };
  };
}

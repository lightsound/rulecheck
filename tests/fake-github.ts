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

/**
 * In-memory GitHub for tests: a handful of repositories with a flat git object store. Write
 * operations are recorded in `calls` so a dry run can be shown to write nothing.
 */

export interface FakeRepoInput {
  readonly defaultBranch?: string;
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

export function fakeGitHub(input: Readonly<Record<string, FakeRepoInput>>): FakeGitHub {
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

  const service: GitHubService = {
    getRepository: (repo) =>
      repoOf("getRepository", repo).pipe(Effect.map((r) => ({ defaultBranch: r.defaultBranch }))),
    getRef: (repo, name) =>
      repoOf("getRef", repo).pipe(Effect.map((r) => r.refs.get(name) ?? null)),
    getCommit: (repo, sha) =>
      repoOf("getCommit", repo).pipe(
        Effect.flatMap(() => get("getCommit", sha, "commit")),
        Effect.map((c) => ({ tree: c.tree })),
      ),
    getTree: (repo, treeSha) =>
      repoOf("getTree", repo).pipe(
        Effect.flatMap(() => get("getTree", treeSha, "tree")),
        Effect.map((t) => ({ entries: t.entries, truncated: false })),
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
          const pull = r.pulls.find((p) => p.number === number);
          if (!pull) return fail("updatePullRequest", 404, "Not Found");
          pull.title = input.title;
          pull.body = input.body;
          return Effect.succeed(pull);
        }),
      ),
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

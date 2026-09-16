import { ByteSize, Effect, FileSystem, Option } from "effect";
import { type PlatformError, systemError } from "effect/PlatformError";
import { isIgnoredDirectory } from "../domain/classify.ts";
import type { FileChange } from "../domain/diff.ts";
import {
  GitHubError,
  type GitHubService,
  type RepositoryRef,
  repositoryName,
  type TreeEntry,
} from "./client.ts";

/**
 * A repository at one commit, presented as a read-only `FileSystem` (D10).
 *
 * The git tree gives every path up front; blob contents are fetched when a file is read. Mounted
 * at `/github.com/<owner>/<repo>` with a synthetic `.git/HEAD` that holds the commit sha, the
 * snapshot looks to `walk`, `scan`, and `loadPacks` exactly like a ghq-style local checkout, so
 * the read-only pipeline runs unchanged on remote data.
 */

export interface SnapshotEntry {
  readonly size: number;
  readonly read: Effect.Effect<Uint8Array, PlatformError>;
}

/** Absolute path → file. Directories are implied by the paths. */
export type Snapshot = ReadonlyMap<string, SnapshotEntry>;

const encoder = new TextEncoder();

export function textEntry(text: string): SnapshotEntry {
  const bytes = encoder.encode(text);
  return { size: bytes.length, read: Effect.succeed(bytes) };
}

export function mountPath(repo: RepositoryRef): string {
  return `/github.com/${repo.owner}/${repo.name}`;
}

/** Most tree listings one snapshot may spend when the recursive listing is truncated. */
export const MAX_TREE_LISTINGS = 200;

/** Fetch the tree of `sha` and lay it out under `mount`. */
export const repositorySnapshot = (
  github: GitHubService,
  repo: RepositoryRef,
  sha: string,
  mount: string = mountPath(repo),
): Effect.Effect<Snapshot, GitHubError> =>
  Effect.gen(function* () {
    const commit = yield* github.getCommit(repo, sha);
    const entries = yield* listTree(github, repo, commit.tree);
    const files = new Map<string, SnapshotEntry>();
    files.set(`${mount}/.git/HEAD`, textEntry(`${sha}\n`));
    for (const entry of entries) {
      if (entry.type !== "blob") continue;
      // Both scan passes and the plan read the same few files; fetch each blob once.
      const read = yield* Effect.cached(
        github.getBlob(repo, entry.sha).pipe(
          Effect.mapError((error) =>
            systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "readFile",
              pathOrDescriptor: `${mount}/${entry.path}`,
              description: error.message,
            }),
          ),
        ),
      );
      files.set(`${mount}/${entry.path}`, { size: 0, read });
    }
    return files;
  });

/**
 * Every blob below a tree. One recursive call answers for almost every repository; when the API
 * truncates it (about 100,000 entries), the tree is listed one level and each subtree is asked
 * for recursively in turn, so the cost is one call per subtree too large to list at once plus
 * its children, not one call per directory. Directories the scan never descends into
 * (`node_modules`, `.git`, build output; `isIgnoredDirectory`) are not listed. More than
 * `MAX_TREE_LISTINGS` calls is a `GitHubError`, so one repository cannot spend a run's quota.
 */
const listTree = (
  github: GitHubService,
  repo: RepositoryRef,
  treeSha: string,
): Effect.Effect<ReadonlyArray<TreeEntry>, GitHubError> => {
  let listings = 0;
  const overBudget = () =>
    new GitHubError({
      operation: "getTree",
      status: null,
      message: `the tree of ${repositoryName(repo)} needs more than ${MAX_TREE_LISTINGS} listings; it is too large to snapshot`,
    });
  const list = (
    sha: string,
    options?: { readonly recursive?: boolean },
  ): Effect.Effect<
    { readonly entries: ReadonlyArray<TreeEntry>; readonly truncated: boolean },
    GitHubError
  > => {
    if (listings >= MAX_TREE_LISTINGS) return overBudget();
    listings += 1;
    return github.getTree(repo, sha, options);
  };
  const below = (
    sha: string,
    dirName: string,
  ): Effect.Effect<ReadonlyArray<TreeEntry>, GitHubError> =>
    Effect.gen(function* () {
      const full = yield* list(sha);
      if (!full.truncated) return full.entries;
      const shallow = yield* list(sha, { recursive: false });
      const entries: TreeEntry[] = [];
      for (const entry of shallow.entries) {
        if (entry.type !== "tree") {
          entries.push(entry);
          continue;
        }
        if (isIgnoredDirectory(dirName, entry.path)) continue;
        for (const child of yield* below(entry.sha, entry.path)) {
          entries.push({ ...child, path: `${entry.path}/${child.path}` });
        }
      }
      return entries;
    });
  return below(treeSha, repo.name);
};

/** Apply planned changes (paths relative to `mount`) to a snapshot. */
export function withChanges(
  snapshot: Snapshot,
  mount: string,
  changes: ReadonlyArray<FileChange>,
): Snapshot {
  const next = new Map(snapshot);
  for (const change of changes) {
    const full = `${mount}/${change.path}`;
    if (change.after === null) next.delete(full);
    else next.set(full, textEntry(change.after));
  }
  return next;
}

/** A `FileSystem` over a snapshot. Only the read operations the scan uses are implemented. */
export function snapshotFileSystem(snapshot: Snapshot): FileSystem.FileSystem {
  const directories = new Set<string>(["/"]);
  for (const path of snapshot.keys()) {
    let dir = path;
    for (;;) {
      const slash = dir.lastIndexOf("/");
      if (slash <= 0) break;
      dir = dir.slice(0, slash);
      if (directories.has(dir)) break;
      directories.add(dir);
    }
  }

  const normalize = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
  const notFound = (method: string, path: string) =>
    systemError({ _tag: "NotFound", module: "FileSystem", method, pathOrDescriptor: path });

  const stat = (path: string): Effect.Effect<FileSystem.File.Info, PlatformError> => {
    const target = normalize(path);
    const file = snapshot.get(target);
    if (file) return Effect.succeed(info("File", file.size));
    if (directories.has(target)) return Effect.succeed(info("Directory", 0));
    return Effect.fail(notFound("stat", path));
  };

  return FileSystem.makeNoop({
    stat,
    exists: (path) => {
      const target = normalize(path);
      return Effect.succeed(snapshot.has(target) || directories.has(target));
    },
    realPath: (path) => stat(path).pipe(Effect.map(() => normalize(path))),
    readDirectory: (path) => {
      const target = normalize(path);
      if (!directories.has(target)) return Effect.fail(notFound("readDirectory", path));
      const prefix = target === "/" ? "/" : `${target}/`;
      const names = new Set<string>();
      for (const candidate of [...snapshot.keys(), ...directories]) {
        if (candidate === target || !candidate.startsWith(prefix)) continue;
        const rest = candidate.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) names.add(name);
      }
      return Effect.succeed([...names].sort());
    },
    readFile: (path) => {
      const file = snapshot.get(normalize(path));
      return file ? file.read : Effect.fail(notFound("readFile", path));
    },
    readFileString: (path) => {
      const file = snapshot.get(normalize(path));
      return file
        ? file.read.pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)))
        : Effect.fail(notFound("readFileString", path));
    },
  });
}

function info(type: FileSystem.File.Type, size: number): FileSystem.File.Info {
  return {
    type,
    mtime: Option.none(),
    atime: Option.none(),
    birthtime: Option.none(),
    dev: 0,
    ino: Option.none(),
    mode: type === "Directory" ? 0o755 : 0o644,
    nlink: Option.none(),
    uid: Option.none(),
    gid: Option.none(),
    rdev: Option.none(),
    size: ByteSize.bytes(size),
    blksize: Option.none(),
    blocks: Option.none(),
  };
}

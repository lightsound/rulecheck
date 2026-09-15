import { Data, Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import {
  findPackedRef,
  type PackSourceFile,
  packFromFiles,
  parseGitHead,
  parseSubscriptions,
} from "../domain/pack.ts";
import type { Pack } from "../domain/types.ts";
import { GitHub, type GitHubError, parseRepositorySpec, repositoryName } from "../github/client.ts";
import { repositorySnapshot, snapshotFileSystem } from "../github/fs.ts";

/**
 * Load every pack from a pack repository (`lightsound/agent-rules` layout): `packs/<id>/**` is the
 * pack's file set, `subscriptions.json` maps pack ids to `owner/repo`. The repository's HEAD
 * becomes each pack's `rev`. Read-only. Packs come back in `subscriptions.json` key order, which
 * is the block order in a target file (D7), followed by unsubscribed packs alphabetically.
 */
export interface LoadedPacks {
  /** Where the packs came from: a directory, or `owner/repo@<short sha>`. */
  readonly source: string;
  readonly packs: ReadonlyArray<Pack>;
  readonly warnings: ReadonlyArray<string>;
}

export class PackSourceError extends Data.TaggedError("PackSourceError")<{
  readonly message: string;
}> {}

/**
 * Resolve `--packs`: an existing directory is read from disk; `owner/repo[@ref]` is read from
 * GitHub at that ref (default branch when omitted) through the snapshot filesystem (D10).
 */
export const resolvePacks = (
  spec: string,
): Effect.Effect<
  LoadedPacks,
  PackSourceError | GitHubError | PlatformError,
  FileSystem.FileSystem | Path.Path | GitHub
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = path.resolve(spec);
    const local = yield* fs.stat(resolved).pipe(
      Effect.option,
      Effect.map((info) => info._tag === "Some" && info.value.type === "Directory"),
    );
    if (local) return yield* loadPacks(fs, path, resolved);

    const remote = parseRepositorySpec(spec);
    if (remote === null) {
      return yield* new PackSourceError({
        message: `--packs \`${spec}\` is neither a directory (${resolved}) nor owner/repo[@ref]`,
      });
    }
    const github = yield* GitHub;
    const ref = remote.ref ?? (yield* github.getRepository(remote.repo)).defaultBranch;
    const sha =
      (yield* github.getRef(remote.repo, `heads/${ref}`)) ??
      (yield* github.getRef(remote.repo, `tags/${ref}`)) ??
      (/^[0-9a-f]{40}$/.test(ref) ? ref : null);
    if (sha === null) {
      return yield* new PackSourceError({
        message: `ref \`${ref}\` not found in ${repositoryName(remote.repo)}`,
      });
    }
    const mount = "/packs";
    const snapshot = yield* repositorySnapshot(github, remote.repo, sha, mount);
    const label = `${repositoryName(remote.repo)}@${sha.slice(0, 7)}`;
    return yield* loadPacks(snapshotFileSystem(snapshot), path, mount, label);
  });

export const loadPacks = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  packsRoot: string,
  /** How the source is named in warnings and the report; the directory itself by default. */
  source: string = packsRoot,
): Effect.Effect<LoadedPacks> =>
  Effect.gen(function* () {
    const warnings: string[] = [];
    const readText = (target: string) =>
      fs
        .readFileString(target)
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed<string | null>(null)));
    const listDir = (target: string) =>
      fs
        .readDirectory(target)
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed<Array<string>>([])));

    const subscriptionsText = yield* readText(path.join(packsRoot, "subscriptions.json"));
    let subscriptions = new Map<string, string[]>();
    if (subscriptionsText === null) {
      warnings.push("subscriptions.json not found; every repository counts as not subscribed");
    } else {
      const parsed = parseSubscriptions(subscriptionsText);
      if (parsed === null) {
        warnings.push(
          'subscriptions.json is not a { "<pack-id>": ["owner/repo", ...] } object; every repository counts as not subscribed',
        );
      } else {
        subscriptions = parsed;
      }
    }
    const rev = yield* gitHead(fs, path, packsRoot);
    if (rev === null) warnings.push("not a git checkout; pack rev is unknown");

    const packsDir = path.join(packsRoot, "packs");
    const packs: Pack[] = [];
    for (const id of (yield* listDir(packsDir)).sort()) {
      const dir = path.join(packsDir, id);
      const info = yield* fs.stat(dir).pipe(Effect.option);
      if (info._tag === "None" || info.value.type !== "Directory") continue;
      const files = yield* collectSources(fs, path, dir, dir);
      if (files.length === 0) continue;
      packs.push(packFromFiles(id, rev, files, subscriptions.get(id) ?? []));
    }
    if (packs.length === 0) warnings.push(`no packs/<id>/ directories under ${source}`);
    for (const id of subscriptions.keys()) {
      if (!packs.some((pack) => pack.id === id)) {
        warnings.push(
          `subscriptions.json names pack \`${id}\`, which has no packs/${id}/ directory`,
        );
      }
    }
    const order = [...subscriptions.keys()];
    const rank = (id: string) => {
      const index = order.indexOf(id);
      return index === -1 ? order.length : index;
    };
    packs.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    return { source, packs, warnings };
  });

const collectSources = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  base: string,
  dir: string,
): Effect.Effect<PackSourceFile[]> =>
  Effect.gen(function* () {
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed<Array<string>>([])));
    const files: PackSourceFile[] = [];
    for (const name of entries) {
      if (name === ".git" || name === "node_modules") continue;
      const full = path.join(dir, name);
      const info = yield* fs.stat(full).pipe(Effect.option);
      if (info._tag === "None") continue;
      if (info.value.type === "Directory") {
        files.push(...(yield* collectSources(fs, path, base, full)));
        continue;
      }
      if (info.value.type !== "File") continue;
      const content = yield* fs
        .readFileString(full)
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")));
      files.push({ path: path.relative(base, full).split(path.sep).join("/"), content });
    }
    return files;
  });

/** Resolve HEAD of the checkout at `root` to a full sha, or null when it is not a git checkout. */
const gitHead = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const readText = (target: string) =>
      fs
        .readFileString(target)
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed<string | null>(null)));
    const gitDir = path.join(root, ".git");
    const headText = yield* readText(path.join(gitDir, "HEAD"));
    if (headText === null) return null;
    const head = parseGitHead(headText);
    if (head === null) return null;
    if ("sha" in head) return head.sha;

    const loose = yield* readText(path.join(gitDir, head.ref));
    if (loose !== null && /^[0-9a-f]{40}$/.test(loose.trim())) return loose.trim();
    const packed = yield* readText(path.join(gitDir, "packed-refs"));
    return packed === null ? null : findPackedRef(packed, head.ref);
  });

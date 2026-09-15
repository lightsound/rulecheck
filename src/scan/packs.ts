import { Effect, type FileSystem, type Path } from "effect";
import {
  findPackedRef,
  type PackSourceFile,
  packFromFiles,
  parseGitHead,
  parseSubscriptions,
} from "../domain/pack.ts";
import type { Pack } from "../domain/types.ts";

/**
 * Load every pack from a pack repository checkout (`lightsound/agent-rules` layout):
 * `packs/<id>/**` is the pack's file set, `subscriptions.json` maps pack ids to `owner/repo`.
 * The checkout's git HEAD becomes each pack's `rev`. Read-only.
 */
export interface LoadedPacks {
  readonly packs: ReadonlyArray<Pack>;
  readonly warnings: ReadonlyArray<string>;
}

export const loadPacks = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  packsRoot: string,
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
    if (packs.length === 0) warnings.push(`no packs/<id>/ directories under ${packsRoot}`);
    for (const id of subscriptions.keys()) {
      if (!packs.some((pack) => pack.id === id)) {
        warnings.push(
          `subscriptions.json names pack \`${id}\`, which has no packs/${id}/ directory`,
        );
      }
    }
    return { packs, warnings };
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

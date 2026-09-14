import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { detectKind, isIgnoredDirectory } from "../domain/classify.ts";
import type { FileKind } from "../domain/types.ts";

export interface DiscoveredFile {
  readonly repoRoot: string;
  readonly path: string;
  readonly relativePath: string;
  readonly kind: FileKind;
  readonly depth: number;
}

export interface DiscoveredRepo {
  readonly root: string;
  readonly files: ReadonlyArray<DiscoveredFile>;
  /** Absolute paths of every package.json in the repository, used to verify script references. */
  readonly packageJsonPaths: ReadonlyArray<string>;
}

export interface WalkOptions {
  /** Maximum directory depth below `root` to descend into. */
  readonly maxDepth: number;
}

const DEFAULT_OPTIONS: WalkOptions = { maxDepth: 12 };

/**
 * Walk `root`, find git repositories (directories containing `.git`), and collect
 * every instruction file inside each repository.
 *
 * Nested repositories (submodules, vendored checkouts) become their own entries;
 * files inside them are attributed to the innermost repository.
 * Directories rejected by {@link isIgnoredDirectory} and symbolic links are never followed.
 */
export const walk = (
  root: string,
  options: Partial<WalkOptions> = {},
): Effect.Effect<ReadonlyArray<DiscoveredRepo>, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { maxDepth } = { ...DEFAULT_OPTIONS, ...options };

    const repos = new Map<string, { files: DiscoveredFile[]; packageJsonPaths: string[] }>();

    const visit = (
      dir: string,
      depthFromRoot: number,
      repoRoot: string | null,
    ): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        if (depthFromRoot > maxDepth) return;

        const entries = yield* fs
          .readDirectory(dir)
          .pipe(Effect.catchTag("PlatformError", () => Effect.succeed<Array<string>>([])));

        const isRepo = entries.includes(".git");
        const currentRepo = isRepo ? dir : repoRoot;
        if (isRepo && !repos.has(dir)) repos.set(dir, { files: [], packageJsonPaths: [] });

        const dirName = path.basename(dir);
        for (const name of entries) {
          if (isIgnoredDirectory(dirName, name)) continue;
          const full = path.join(dir, name);
          const info = yield* fs.stat(full).pipe(Effect.option);
          if (info._tag === "None") continue;

          if (info.value.type === "Directory") {
            yield* visit(full, depthFromRoot + 1, currentRepo);
            continue;
          }
          if (info.value.type !== "File" || currentRepo === null) continue;

          const bucket = repos.get(currentRepo);
          if (!bucket) continue;

          if (name === "package.json") {
            bucket.packageJsonPaths.push(full);
            continue;
          }

          const relativePath = path.relative(currentRepo, full).split(path.sep).join("/");
          const kind = detectKind(relativePath);
          if (!kind) continue;

          bucket.files.push({
            repoRoot: currentRepo,
            path: full,
            relativePath,
            kind,
            depth: relativePath.split("/").length - 1,
          });
        }
      });

    yield* visit(path.resolve(root), 0, null);

    return [...repos.entries()]
      .map(([repoRoot, bucket]) => ({
        root: repoRoot,
        files: [...bucket.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
        packageJsonPaths: [...bucket.packageJsonPaths].sort(),
      }))
      .sort((a, b) => a.root.localeCompare(b.root));
  });

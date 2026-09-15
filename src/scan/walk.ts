import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { detectKind, isIgnoredDirectory } from "../domain/classify.ts";
import { detectSkill } from "../domain/skills.ts";
import type { FileKind, SkillAgentDir } from "../domain/types.ts";

export interface DiscoveredFile {
  readonly repoRoot: string;
  readonly path: string;
  readonly relativePath: string;
  readonly kind: FileKind;
  readonly depth: number;
}

export interface DiscoveredSkill {
  readonly name: string;
  readonly agentDir: SkillAgentDir;
  /** Absolute path of the skill directory. */
  readonly path: string;
  /** Repo-relative path of the skill directory. */
  readonly relativePath: string;
}

export interface DiscoveredRepo {
  readonly root: string;
  readonly files: ReadonlyArray<DiscoveredFile>;
  /** Absolute paths of every package.json in the repository, used to verify script references. */
  readonly packageJsonPaths: ReadonlyArray<string>;
  /** `<agentDir>/skills/<name>/` directories at the repository root that contain a SKILL.md. */
  readonly skills: ReadonlyArray<DiscoveredSkill>;
  /** Absolute path of the root `skills-lock.json`, when present. */
  readonly skillsLockPath: string | null;
}

interface Bucket {
  files: DiscoveredFile[];
  packageJsonPaths: string[];
  skills: DiscoveredSkill[];
  skillsLockPath: string | null;
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

    const repos = new Map<string, Bucket>();

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
        if (isRepo && !repos.has(dir)) {
          repos.set(dir, { files: [], packageJsonPaths: [], skills: [], skillsLockPath: null });
        }

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
          if (relativePath === "skills-lock.json") {
            bucket.skillsLockPath = full;
            continue;
          }
          const skill = detectSkill(relativePath);
          if (skill) {
            bucket.skills.push({
              name: skill.name,
              agentDir: skill.agentDir,
              path: path.dirname(full),
              relativePath: skill.dir,
            });
            continue;
          }
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
        skills: [...bucket.skills].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
        skillsLockPath: bucket.skillsLockPath,
      }))
      .sort((a, b) => a.root.localeCompare(b.root));
  });

import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { detectKind, isIgnoredDirectory } from "../domain/classify.ts";
import { classifyNestedRepo, parseGitmodulesPaths } from "../domain/nested.ts";
import { detectSkill } from "../domain/skills.ts";
import type { FileKind, NestedRepoKind, SkillAgentDir } from "../domain/types.ts";

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

/** A repository found inside another discovered repository and left out of the walk (D24). */
export interface NestedRepo {
  readonly root: string;
  /** Root of the nearest enclosing repository. */
  readonly parent: string;
  readonly kind: NestedRepoKind;
}

export interface WalkResult {
  readonly repos: ReadonlyArray<DiscoveredRepo>;
  /** Empty when `includeNested` is set. */
  readonly excludedNested: ReadonlyArray<NestedRepo>;
}

export interface WalkOptions {
  /** Maximum directory depth below `root` to descend into. */
  readonly maxDepth: number;
  /** Scan repositories nested inside other repositories as their own entries (D24). */
  readonly includeNested: boolean;
}

const DEFAULT_OPTIONS: WalkOptions = { maxDepth: 12, includeNested: false };

/**
 * Walk `root`, find git repositories (directories containing `.git`), and collect
 * every instruction file inside each repository.
 *
 * A repository inside another discovered repository (a submodule, a clone made inside a
 * checkout, a vendored checkout) is a different project (D24): by default its directory is not
 * descended into, so it is neither a scan target nor attributed to the enclosing repository, and
 * it is listed in `excludedNested` with its kind. With `includeNested` it becomes its own entry
 * and files inside it are attributed to the innermost repository. Directories that are not
 * repositories are walked as before; `maxDepth` counts from `root` either way.
 * Directories rejected by {@link isIgnoredDirectory} are never descended into. Symbolic links are
 * followed (`stat` resolves them), so a linked directory is visited under its link path; the
 * skills inventory folds such copies back together by real path.
 */
export const walk = (
  root: string,
  options: Partial<WalkOptions> = {},
): Effect.Effect<WalkResult, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { maxDepth, includeNested } = { ...DEFAULT_OPTIONS, ...options };

    const repos = new Map<string, Bucket>();
    const excludedNested: NestedRepo[] = [];
    const gitmodules = new Map<string, ReadonlySet<string>>();

    /** `path =` entries of the enclosing repository's `.gitmodules`, read once per repository. */
    const gitmodulesOf = (repoRoot: string): Effect.Effect<ReadonlySet<string>> =>
      Effect.gen(function* () {
        const cached = gitmodules.get(repoRoot);
        if (cached) return cached;
        const content = yield* fs
          .readFileString(path.join(repoRoot, ".gitmodules"))
          .pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")));
        const paths = new Set(parseGitmodulesPaths(content));
        gitmodules.set(repoRoot, paths);
        return paths;
      });

    const classifyNested = (dir: string, parent: string): Effect.Effect<NestedRepoKind> =>
      Effect.gen(function* () {
        const git = yield* fs.stat(path.join(dir, ".git")).pipe(Effect.option);
        const gitIsFile = git._tag === "Some" && git.value.type === "File";
        if (gitIsFile) return classifyNestedRepo(true, false);
        const listed = yield* gitmodulesOf(parent);
        const relative = path.relative(parent, dir).split(path.sep).join("/");
        return classifyNestedRepo(false, listed.has(relative));
      });

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
        if (isRepo && repoRoot !== null && !includeNested) {
          const kind = yield* classifyNested(dir, repoRoot);
          excludedNested.push({ root: dir, parent: repoRoot, kind });
          return;
        }
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

    return {
      repos: [...repos.entries()]
        .map(([repoRoot, bucket]) => ({
          root: repoRoot,
          files: [...bucket.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
          packageJsonPaths: [...bucket.packageJsonPaths].sort(),
          skills: [...bucket.skills].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
          skillsLockPath: bucket.skillsLockPath,
        }))
        .sort((a, b) => a.root.localeCompare(b.root)),
      excludedNested: [...excludedNested].sort((a, b) => a.root.localeCompare(b.root)),
    };
  });

import { Effect, type FileSystem, type Path } from "effect";
import ignore, { type Ignore } from "ignore";
import { extractReferences, parseManifest } from "../domain/references.ts";
import type { Finding } from "../domain/types.ts";
import type { AnalyzedFile } from "./analyze.ts";

/**
 * Verify the scripts and paths an instruction file references against the repository.
 *
 * Scripts are looked up in every package.json in the repo, so monorepo instructions that say
 * `bun run dev` for a workspace package are accepted. Bare `bun <name>` also runs dependency
 * binaries, so it is accepted when `<name>` is a dependency or exists in `node_modules/.bin`.
 *
 * A path is reported missing only when its first segment exists (filtering `owner/repo` style text)
 * and the path is not matched by the repository's root `.gitignore` (build output, auth state,
 * generated files that legitimately do not exist in a fresh checkout).
 */
export const verifyReferences = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repoRoot: string,
  packageJsonPaths: ReadonlyArray<string>,
  analyzed: ReadonlyArray<AnalyzedFile>,
): Effect.Effect<Finding[]> =>
  Effect.gen(function* () {
    const manifest = yield* collectManifests(fs, packageJsonPaths);
    const hasPackageJson = packageJsonPaths.length > 0;
    const gitignore = yield* loadGitignore(fs, path, repoRoot);
    const binDir = path.join(repoRoot, "node_modules", ".bin");
    const findings: Finding[] = [];

    for (const { file, content } of analyzed) {
      if (file.kind === "cursor-rule" && file.frontmatter?.alwaysApply !== true) {
        // Scoped rules often describe files that only exist in a sibling package; skip them.
        continue;
      }
      const fileDir = path.dirname(file.path);

      for (const ref of extractReferences(content)) {
        if (ref.kind === "script") {
          if (!hasPackageJson || manifest.scripts.has(ref.value)) continue;
          if (!ref.explicitRun) {
            if (manifest.dependencies.has(ref.value)) continue;
            if (yield* anyExists(fs, [path.join(binDir, ref.value)])) continue;
          }
          findings.push({
            kind: "unknown-script",
            file: file.relativePath,
            line: ref.line,
            value: ref.value,
            message: `script "${ref.value}" is not defined in any package.json (${ref.raw})`,
          });
          continue;
        }

        const candidates = [path.resolve(fileDir, ref.value), path.resolve(repoRoot, ref.value)];
        if (yield* anyExists(fs, candidates)) continue;

        const first = ref.value.replace(/^\.\.\//, "").split("/")[0] ?? "";
        const firstExists = yield* anyExists(fs, [
          path.resolve(fileDir, first),
          path.resolve(repoRoot, first),
        ]);
        if (!firstExists) continue;

        if (isGitignored(gitignore, path, repoRoot, candidates)) continue;

        findings.push({
          kind: "missing-path",
          file: file.relativePath,
          line: ref.line,
          value: ref.value,
          message: `path \`${ref.value}\` does not exist`,
        });
      }
    }

    return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  });

const collectManifests = (
  fs: FileSystem.FileSystem,
  packageJsonPaths: ReadonlyArray<string>,
): Effect.Effect<{ scripts: Set<string>; dependencies: Set<string> }> =>
  Effect.gen(function* () {
    const scripts = new Set<string>();
    const dependencies = new Set<string>();
    for (const pkgPath of packageJsonPaths) {
      const text = yield* fs
        .readFileString(pkgPath)
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed("{}")));
      const manifest = parseManifest(text);
      for (const name of manifest.scripts) scripts.add(name);
      for (const name of manifest.dependencies) dependencies.add(name);
    }
    return { scripts, dependencies };
  });

const loadGitignore = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repoRoot: string,
): Effect.Effect<Ignore | null> =>
  Effect.gen(function* () {
    const text = yield* fs
      .readFileString(path.join(repoRoot, ".gitignore"))
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed<string | null>(null)));
    if (text === null) return null;
    return ignore().add(text);
  });

/** True when any candidate, expressed relative to the repo root, is matched by .gitignore. */
function isGitignored(
  gitignore: Ignore | null,
  path: Path.Path,
  repoRoot: string,
  candidates: ReadonlyArray<string>,
): boolean {
  if (!gitignore) return false;
  for (const candidate of candidates) {
    const relative = path.relative(repoRoot, candidate).split(path.sep).join("/");
    if (relative.length === 0 || relative.startsWith("..")) continue;
    // Directory-only patterns (`dir/`) match only paths that end with a slash, so test both forms.
    const base = relative.replace(/\/$/, "");
    if (gitignore.ignores(base) || gitignore.ignores(`${base}/`)) return true;
  }
  return false;
}

const anyExists = (
  fs: FileSystem.FileSystem,
  paths: ReadonlyArray<string>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (const candidate of paths) {
      const exists = yield* fs
        .exists(candidate)
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)));
      if (exists) return true;
    }
    return false;
  });

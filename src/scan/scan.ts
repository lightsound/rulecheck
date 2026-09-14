import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { classifyShape, estimateBudget } from "../domain/classify.ts";
import type {
  CanonicalShape,
  DuplicateGroup,
  PersonalLayer,
  RepoReport,
  ScanReport,
  ScanTotals,
} from "../domain/types.ts";
import { analyzeFile } from "./analyze.ts";
import { scanPersonal } from "./personal.ts";
import { verifyReferences } from "./verify.ts";
import { type DiscoveredRepo, walk } from "./walk.ts";

export interface ScanOptions {
  readonly maxDepth?: number;
  /** Files with fewer non-empty lines than this are excluded from duplicate detection. */
  readonly minDuplicateLines?: number;
  /** Home directory whose `~/.claude` layer should be included, or `null` to skip it. */
  readonly home?: string | null;
}

const DEFAULT_MIN_DUPLICATE_LINES = 5;

/** Scan `root` and produce a full report. Never writes to disk. */
export const scan = (
  root: string,
  options: ScanOptions = {},
): Effect.Effect<ScanReport, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolvedRoot = path.resolve(root);

    const discovered = yield* walk(resolvedRoot, { maxDepth: options.maxDepth ?? 12 });

    const repos = yield* Effect.forEach(
      discovered,
      (repo) => analyzeRepo(repo, resolvedRoot, fs, path),
      { concurrency: 8 },
    );

    const duplicates = findDuplicates(
      repos,
      options.minDuplicateLines ?? DEFAULT_MIN_DUPLICATE_LINES,
    );

    const personal: PersonalLayer | null =
      options.home === null || options.home === undefined
        ? null
        : yield* scanPersonal(options.home);

    return {
      root: resolvedRoot,
      scannedAt: new Date().toISOString(),
      repos,
      duplicates,
      personal,
      totals: summarize(repos),
    } satisfies ScanReport;
  });

const analyzeRepo = (
  repo: DiscoveredRepo,
  scanRoot: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<RepoReport> =>
  Effect.gen(function* () {
    const analyzed = yield* Effect.forEach(repo.files, (file) => analyzeFile(fs, file), {
      concurrency: 4,
    });
    const files = analyzed.map((a) => a.file);
    const contents = new Map(analyzed.map((a) => [a.file.relativePath, a.content] as const));
    const findings = yield* verifyReferences(fs, path, repo.root, repo.packageJsonPaths, analyzed);

    return {
      root: repo.root,
      name: displayName(repo.root, scanRoot),
      shape: classifyShape(files),
      files,
      budget: estimateBudget(files, contents),
      findings,
    } satisfies RepoReport;
  });

/**
 * `~/ghq/github.com/owner/repo` → `owner/repo`; otherwise the path relative to the scan root,
 * or the basename when the repo is the scan root itself.
 */
export function displayName(repoRoot: string, scanRoot: string): string {
  const relative = repoRoot.startsWith(scanRoot)
    ? repoRoot.slice(scanRoot.length).replace(/^\/+/, "")
    : repoRoot;
  if (relative.length === 0) return repoRoot.split("/").filter(Boolean).at(-1) ?? repoRoot;
  const segments = relative.split("/").filter(Boolean);
  const hostIndex = segments.findIndex((segment) => segment.includes("."));
  if (hostIndex >= 0 && segments.length - hostIndex >= 3) {
    return segments.slice(hostIndex + 1).join("/");
  }
  return relative;
}

function findDuplicates(repos: ReadonlyArray<RepoReport>, minLines: number): DuplicateGroup[] {
  const groups = new Map<
    string,
    { tokens: number; lines: number; members: DuplicateGroup["members"][number][] }
  >();

  for (const repo of repos) {
    for (const file of repo.files) {
      if (file.lines < minLines || file.wrapperTarget !== null) continue;
      const group = groups.get(file.contentHash) ?? {
        tokens: file.tokens,
        lines: file.lines,
        members: [],
      };
      group.members.push({ repo: repo.name, relativePath: file.relativePath });
      groups.set(file.contentHash, group);
    }
  }

  return [...groups.entries()]
    .filter(([, group]) => group.members.length > 1)
    .map(([contentHash, group]) => ({ contentHash, ...group }))
    .sort((a, b) => b.members.length - a.members.length || b.tokens - a.tokens);
}

function summarize(repos: ReadonlyArray<RepoReport>): ScanTotals {
  const shapes: Record<CanonicalShape, number> = {
    "agents-canonical": 0,
    "claude-canonical": 0,
    "agents-only": 0,
    "claude-only": 0,
    "both-full": 0,
    none: 0,
  };
  let files = 0;
  let tokens = 0;
  let findings = 0;
  let reposWithInstructions = 0;

  for (const repo of repos) {
    shapes[repo.shape] += 1;
    files += repo.files.length;
    findings += repo.findings.length;
    if (repo.files.length > 0) reposWithInstructions += 1;
    for (const file of repo.files) tokens += file.tokens;
  }

  return { repos: repos.length, reposWithInstructions, files, tokens, findings, shapes };
}

import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { findForeignMarkers, parseBlocks } from "../domain/block.ts";
import { classifyNormalization, classifyShape, estimateBudget } from "../domain/classify.ts";
import { distribute } from "../domain/pack.ts";
import { assembleScanReport, DEFAULT_MIN_DUPLICATE_LINES } from "../domain/report.ts";
import type {
  BlockIssue,
  CanonicalShape,
  ExcludedNestedRepo,
  ForeignRegion,
  InstructionFile,
  ManagedBlock,
  Normalization,
  PackDistribution,
  PersonalLayer,
  RepoReport,
  ScanReport,
} from "../domain/types.ts";
import { type AnalyzedFile, analyzeFile } from "./analyze.ts";
import { type LoadedPacks, loadPacks } from "./packs.ts";
import { scanPersonal } from "./personal.ts";
import { inventorySkills } from "./skills.ts";
import { verifyReferences } from "./verify.ts";
import { type DiscoveredRepo, walk } from "./walk.ts";

export interface ScanOptions {
  readonly maxDepth?: number;
  /** Scan repositories nested inside other repositories as their own entries (D24). */
  readonly includeNested?: boolean;
  /** Files with fewer non-empty lines than this are excluded from duplicate detection. */
  readonly minDuplicateLines?: number;
  /** Home directory whose `~/.claude` layer should be included, or `null` to skip it. */
  readonly home?: string | null;
  /**
   * Checkout of the pack repository (`packs/<id>/`, `subscriptions.json`), packs already loaded
   * with `loadPacks` / `resolvePacks`, or `null` for no distribution report.
   */
  readonly packs?: string | LoadedPacks | null;
}

/** Scan `root` and produce a full report. Never writes to disk. */
export const scan = (
  root: string,
  options: ScanOptions = {},
): Effect.Effect<ScanReport, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolvedRoot = path.resolve(root);

    const discovered = yield* walk(resolvedRoot, {
      maxDepth: options.maxDepth ?? 12,
      includeNested: options.includeNested ?? false,
    });

    const repos = yield* Effect.forEach(
      discovered.repos,
      (repo) => analyzeRepo(repo, resolvedRoot, fs, path),
      { concurrency: 8 },
    );

    const personal: PersonalLayer | null =
      options.home === null || options.home === undefined
        ? null
        : yield* scanPersonal(options.home);

    let distribution: PackDistribution | null = null;
    if (options.packs) {
      const loaded =
        typeof options.packs === "string"
          ? yield* loadPacks(fs, path, path.resolve(options.packs))
          : options.packs;
      distribution = distribute(
        loaded.source,
        repos,
        loaded.packs,
        loaded.warnings,
        personal?.files ?? [],
      );
    }

    return assembleScanReport({
      root: resolvedRoot,
      scannedAt: new Date().toISOString(),
      repos,
      excludedNested: discovered.excludedNested.map(
        (nested): ExcludedNestedRepo => ({
          root: nested.root,
          name: displayName(nested.root, resolvedRoot),
          parent: displayName(nested.parent, resolvedRoot),
          kind: nested.kind,
        }),
      ),
      personal,
      distribution,
      minDuplicateLines: options.minDuplicateLines ?? DEFAULT_MIN_DUPLICATE_LINES,
    });
  });

const ROOT_PAIR = new Set(["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"]);

/**
 * Managed blocks in every AGENTS.md / CLAUDE.md of the repository. Foreign markers are only
 * looked for in the root pair, the files a sync would write.
 */
function detectBlocks(analyzed: ReadonlyArray<AnalyzedFile>): {
  blocks: ManagedBlock[];
  blockIssues: BlockIssue[];
  foreignRegions: ForeignRegion[];
} {
  const blocks: ManagedBlock[] = [];
  const blockIssues: BlockIssue[] = [];
  const foreignRegions: ForeignRegion[] = [];
  for (const { file, content } of analyzed) {
    if (file.kind !== "agents-md" && file.kind !== "claude-md") continue;
    const parsed = parseBlocks(file.relativePath, content);
    blocks.push(...parsed.blocks);
    blockIssues.push(...parsed.issues);
    if (ROOT_PAIR.has(file.relativePath)) {
      const foreign = findForeignMarkers(file.relativePath, content);
      blockIssues.push(...foreign.issues);
      foreignRegions.push(...foreign.regions);
    }
  }
  blockIssues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  foreignRegions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { blocks, blockIssues, foreignRegions };
}

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
    const { blocks, blockIssues, foreignRegions } = detectBlocks(analyzed);
    const skills = yield* inventorySkills(fs, path, repo);

    const shape = classifyShape(files);
    return {
      root: repo.root,
      name: displayName(repo.root, scanRoot),
      shape,
      normalization: normalizationOf(shape, files, contents),
      files,
      budget: estimateBudget(files, contents),
      findings,
      blocks,
      blockIssues,
      foreignRegions,
      skills,
    } satisfies RepoReport;
  });

/** What a sync would do to the root pair; `both-full` reads the root files' content (D12). */
function normalizationOf(
  shape: CanonicalShape,
  files: ReadonlyArray<InstructionFile>,
  contents: ReadonlyMap<string, string>,
): Normalization {
  const claude = files.find((f) => f.kind === "claude-md" && ROOT_PAIR.has(f.relativePath));
  return classifyNormalization(
    shape,
    contents.get("AGENTS.md") ?? "",
    claude ? (contents.get(claude.relativePath) ?? "") : "",
  );
}

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

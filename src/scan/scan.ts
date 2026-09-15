import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { findForeignMarkers, parseBlocks } from "../domain/block.ts";
import { classifyBothFull, classifyShape, estimateBudget } from "../domain/classify.ts";
import { distribute } from "../domain/pack.ts";
import type {
  BlockIssue,
  BothFullNormalization,
  CanonicalShape,
  DuplicateGroup,
  ForeignRegion,
  InstructionFile,
  ManagedBlock,
  PackDistribution,
  PersonalLayer,
  RepoReport,
  ScanReport,
  ScanTotals,
} from "../domain/types.ts";
import { type AnalyzedFile, analyzeFile } from "./analyze.ts";
import { type LoadedPacks, loadPacks } from "./packs.ts";
import { scanPersonal } from "./personal.ts";
import { inventorySkills } from "./skills.ts";
import { verifyReferences } from "./verify.ts";
import { type DiscoveredRepo, walk } from "./walk.ts";

export interface ScanOptions {
  readonly maxDepth?: number;
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

    return {
      root: resolvedRoot,
      scannedAt: new Date().toISOString(),
      repos,
      duplicates,
      personal,
      distribution,
      totals: summarize(repos),
    } satisfies ScanReport;
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
      bothFull: shape === "both-full" ? classifyBothFullPair(files, contents) : null,
      files,
      budget: estimateBudget(files, contents),
      findings,
      blocks,
      blockIssues,
      foreignRegions,
      skills,
    } satisfies RepoReport;
  });

/** D12: which normalization a sync applies to a `both-full` pair, from the root files' content. */
function classifyBothFullPair(
  files: ReadonlyArray<InstructionFile>,
  contents: ReadonlyMap<string, string>,
): BothFullNormalization {
  const claude = files.find((f) => f.kind === "claude-md" && ROOT_PAIR.has(f.relativePath));
  return classifyBothFull(
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
  let blocks = 0;
  let modifiedBlocks = 0;
  let malformedMarkers = 0;
  let skills = 0;
  let skillIssues = 0;

  for (const repo of repos) {
    shapes[repo.shape] += 1;
    files += repo.files.length;
    findings += repo.findings.length;
    if (repo.files.length > 0) reposWithInstructions += 1;
    for (const file of repo.files) tokens += file.tokens;
    blocks += repo.blocks.length;
    modifiedBlocks += repo.blocks.filter((b) => b.modified).length;
    malformedMarkers += repo.blockIssues.filter((i) => i.kind === "malformed-marker").length;
    skills += repo.skills.skills.length;
    skillIssues += repo.skills.issues.length;
  }

  return {
    repos: repos.length,
    reposWithInstructions,
    files,
    tokens,
    findings,
    shapes,
    blocks,
    modifiedBlocks,
    malformedMarkers,
    skills,
    skillIssues,
  };
}

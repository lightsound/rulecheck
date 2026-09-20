import {
  type CanonicalShape,
  type DuplicateGroup,
  type ExcludedNestedRepo,
  type PackDistribution,
  type PersonalLayer,
  type RepoReport,
  SCAN_SCHEMA_VERSION,
  type ScanReport,
  type ScanTotals,
} from "./types.ts";

/**
 * A `ScanReport` from its parts. `scan` calls this at the end of a walk; a host that stores one
 * `RepoReport` per repository (RuleFleet, app-design §4) calls it when a page is built, so
 * cross-repository duplicates and the totals come out of the same code either way.
 */

/** Files with fewer non-empty lines than this are excluded from duplicate detection. */
export const DEFAULT_MIN_DUPLICATE_LINES = 5;

export interface ScanReportParts {
  readonly root: string;
  readonly scannedAt: string;
  readonly repos: ReadonlyArray<RepoReport>;
  readonly excludedNested?: ReadonlyArray<ExcludedNestedRepo>;
  readonly personal?: PersonalLayer | null;
  readonly distribution?: PackDistribution | null;
  readonly minDuplicateLines?: number;
}

export function assembleScanReport(parts: ScanReportParts): ScanReport {
  return {
    schemaVersion: SCAN_SCHEMA_VERSION,
    root: parts.root,
    scannedAt: parts.scannedAt,
    repos: parts.repos,
    excludedNested: parts.excludedNested ?? [],
    duplicates: findDuplicates(parts.repos, parts.minDuplicateLines ?? DEFAULT_MIN_DUPLICATE_LINES),
    personal: parts.personal ?? null,
    distribution: parts.distribution ?? null,
    totals: summarize(parts.repos),
  };
}

export function findDuplicates(
  repos: ReadonlyArray<RepoReport>,
  minLines: number,
): DuplicateGroup[] {
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

export function summarize(repos: ReadonlyArray<RepoReport>): ScanTotals {
  const shapes: Record<CanonicalShape, number> = {
    "agents-canonical": 0,
    "agents-imported": 0,
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

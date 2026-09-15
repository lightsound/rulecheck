import { createHash } from "node:crypto";
import { hashBlockBody, parseBlocks } from "./block.ts";
import type {
  BlockIssue,
  BothFullNormalization,
  CanonicalShape,
  ForeignRegion,
  InstructionFile,
  ManagedBlock,
  Pack,
  PackDistribution,
  PackFile,
  PackStatus,
  PackStatusEntry,
  PersonalPackCopy,
} from "./types.ts";

/**
 * Packs and their distribution status (decisions D6, D7, D8).
 *
 * A pack is the set of files under `packs/<id>/` in the pack repository. `AGENTS.md` there is the
 * body of the managed block; every other file is a whole managed file. Subscriptions come from
 * `subscriptions.json` at the pack repository root: `{ "<pack-id>": ["owner/repo", ...] }`.
 */

export interface PackSourceFile {
  /** Path relative to `packs/<id>/`, `/` separated. */
  readonly path: string;
  readonly content: string;
}

export function packFromFiles(
  id: string,
  rev: string | null,
  files: ReadonlyArray<PackSourceFile>,
  subscribers: ReadonlyArray<string>,
): Pack {
  const packFiles: PackFile[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (file.path === "AGENTS.md") {
      // Pack sources are stored bare (D11); a wrapped file is still accepted and its first block is the body.
      const body = parseBlocks(file.path, file.content).blocks[0]?.body ?? file.content;
      packFiles.push({ kind: "agents-block", body, hash: hashBlockBody(body) });
      continue;
    }
    packFiles.push({
      kind: "file",
      path: file.path,
      hash: createHash("sha256").update(file.content).digest("hex"),
    });
  }
  return { id, rev, files: packFiles, subscribers: subscribers.map(normalizeRepoName) };
}

export function normalizeRepoName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "");
}

/** Parse `subscriptions.json`. Returns null when the text is not an object of string arrays. */
export function parseSubscriptions(text: string): Map<string, string[]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const result = new Map<string, string[]>();
  for (const [pack, repos] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(repos)) continue;
    result.set(
      pack,
      repos.filter((repo): repo is string => typeof repo === "string"),
    );
  }
  return result;
}

/** `ref: refs/heads/main` → the ref; a bare sha → the sha. */
export function parseGitHead(text: string): { ref: string } | { sha: string } | null {
  const trimmed = text.trim();
  const ref = /^ref:\s*(\S+)$/.exec(trimmed);
  if (ref?.[1]) return { ref: ref[1] };
  if (/^[0-9a-f]{40}$/.test(trimmed)) return { sha: trimmed };
  return null;
}

/** Look a ref up in `.git/packed-refs`. */
export function findPackedRef(packedRefs: string, ref: string): string | null {
  for (const line of packedRefs.split("\n")) {
    const match = /^([0-9a-f]{40})\s+(\S+)$/.exec(line.trim());
    if (match && match[2] === ref) return match[1] ?? null;
  }
  return null;
}

export interface RepoForDistribution {
  readonly name: string;
  readonly shape: CanonicalShape;
  /** Required when `shape` is `both-full`; decides the normalization named in the status (D12). */
  readonly bothFull: BothFullNormalization | null;
  readonly files: ReadonlyArray<InstructionFile>;
  readonly blocks: ReadonlyArray<ManagedBlock>;
  readonly blockIssues: ReadonlyArray<BlockIssue>;
  /** Well-formed regions of other tools in the root pair (D15). */
  readonly foreignRegions: ReadonlyArray<ForeignRegion>;
}

const ROOT_CLAUDE = new Set(["CLAUDE.md", ".claude/CLAUDE.md"]);

function isRootPairFile(relativePath: string): boolean {
  return relativePath === "AGENTS.md" || ROOT_CLAUDE.has(relativePath);
}

/** The root file a sync would insert the block into, given the current shape. */
function contentFile(repo: RepoForDistribution): string {
  if (repo.shape === "claude-only" || repo.shape === "claude-canonical") {
    return repo.files.find((f) => ROOT_CLAUDE.has(f.relativePath))?.relativePath ?? "CLAUDE.md";
  }
  return "AGENTS.md";
}

const ELIGIBLE_ACTION: Record<Exclude<CanonicalShape, "both-full">, string> = {
  "agents-canonical": "insert block into AGENTS.md",
  "agents-only": "insert block into AGENTS.md, add CLAUDE.md wrapper",
  "claude-only": "rename to AGENTS.md, add CLAUDE.md wrapper, insert block",
  "claude-canonical": "swap the pair so AGENTS.md is canonical, insert block",
  none: "create AGENTS.md with the block and a CLAUDE.md wrapper",
};

function eligibleAction(repo: RepoForDistribution): string {
  if (repo.shape !== "both-full") return ELIGIBLE_ACTION[repo.shape];
  const claude =
    repo.files.find((f) => ROOT_CLAUDE.has(f.relativePath))?.relativePath ?? "CLAUDE.md";
  return repo.bothFull === "wrapper"
    ? `${claude} repeats AGENTS.md: drop it, add CLAUDE.md wrapper, insert block into AGENTS.md`
    : `append ${claude} content to AGENTS.md under \`## Merged from CLAUDE.md\`, add CLAUDE.md wrapper, insert block`;
}

/** Status of one repository for one pack. */
export function classifyPackStatus(repo: RepoForDistribution, pack: Pack): PackStatusEntry {
  const base = { repo: repo.name, pack: pack.id };
  const packHash = pack.files.find((f) => f.kind === "agents-block")?.hash ?? null;

  const block = repo.blocks.find((b) => b.source === pack.id && isRootPairFile(b.file));
  if (block) {
    const at = { file: block.file, line: block.line };
    if (block.modified) {
      return { ...base, ...at, status: "modified", message: "body no longer matches its hash=" };
    }
    if (packHash === null || block.hash === packHash) {
      return { ...base, ...at, status: "current", message: null };
    }
    // Only an outdated block has a write pending. A malformed or foreign marker in its file makes
    // that rewrite unsafe: the block would be replaced inside a file another tool or a broken
    // marker owns. Current and modified rows need no write, so the marker stays a repo-level note.
    const pending = `block at line ${block.line} is outdated (${revChange(block, pack)})`;
    const issue = repo.blockIssues.find((i) => i.file === block.file);
    if (issue) {
      return {
        ...base,
        status: "blocked",
        file: issue.file,
        line: issue.line,
        message: `${pending}; ${issue.message}`,
      };
    }
    // Replacing a block that shares lines with another tool's region would write inside it (D15).
    const overlapping = repo.foreignRegions.find(
      (r) => r.file === block.file && r.line <= block.endLine && block.line <= r.endLine,
    );
    if (overlapping) {
      return {
        ...base,
        status: "blocked",
        file: overlapping.file,
        line: overlapping.line,
        message: `${pending}; it overlaps the region \`${overlapping.name}\` (lines ${overlapping.line}-${overlapping.endLine}) another tool owns`,
      };
    }
    return {
      ...base,
      ...at,
      status: "outdated",
      message: withRegions(revChange(block, pack), regionsIn(repo, block.file)),
    };
  }

  if (!pack.subscribers.includes(normalizeRepoName(repo.name))) {
    return { ...base, status: "not-subscribed", file: null, line: null, message: null };
  }

  // Files the sync would rewrite: only AGENTS.md when the pair is already canonical, else both
  // (a `both-full` pair is normalized in the same commit, D12).
  const touched =
    repo.shape === "agents-canonical" || repo.shape === "agents-only"
      ? new Set(["AGENTS.md"])
      : new Set(["AGENTS.md", ...ROOT_CLAUDE]);
  const issue = repo.blockIssues.find((i) => touched.has(i.file));
  if (issue) {
    return {
      ...base,
      status: "blocked",
      file: issue.file,
      line: issue.line,
      message: issue.message,
    };
  }

  // A region stays in the file it is in (D15). Only a content AGENTS.md that the plan keeps in
  // place may carry one; a file the plan moves, merges, drops, or replaces with the wrapper may not.
  const kept = KEEPS_AGENTS_IN_PLACE.has(repo.shape) ? "AGENTS.md" : null;
  const region = repo.foreignRegions.find((r) => touched.has(r.file) && r.file !== kept);
  if (region) {
    return {
      ...base,
      status: "blocked",
      file: region.file,
      line: region.line,
      message: `another tool owns lines ${region.line}-${region.endLine} of ${region.file} (region \`${region.name}\`); the sync would rewrite that file`,
    };
  }

  return {
    ...base,
    status: "eligible",
    file: contentFile(repo),
    line: null,
    message: withRegions(eligibleAction(repo), kept ? regionsIn(repo, kept) : 0),
  };
}

/** Shapes whose AGENTS.md keeps its text where it is; the block is appended or replaced there. */
const KEEPS_AGENTS_IN_PLACE: ReadonlySet<CanonicalShape> = new Set([
  "agents-canonical",
  "agents-only",
  "both-full",
]);

function regionsIn(repo: RepoForDistribution, file: string): number {
  return repo.foreignRegions.filter((r) => r.file === file).length;
}

function withRegions(message: string, regions: number): string {
  if (regions === 0) return message;
  return `${message}; ${regions} foreign region${regions === 1 ? "" : "s"} stay${regions === 1 ? "s" : ""} untouched`;
}

function shortRev(rev: string): string {
  return rev.slice(0, 7);
}

function revChange(block: ManagedBlock, pack: Pack): string {
  const from = block.rev ? shortRev(block.rev) : "?";
  const to = pack.rev ? shortRev(pack.rev) : "?";
  return `rev ${from} -> ${to}`;
}

const STATUS_ORDER: ReadonlyArray<PackStatus> = [
  "modified",
  "outdated",
  "blocked",
  "eligible",
  "current",
  "not-subscribed",
];

export function emptyStatusCounts(): Record<PackStatus, number> {
  return {
    current: 0,
    outdated: 0,
    modified: 0,
    eligible: 0,
    blocked: 0,
    "not-subscribed": 0,
  };
}

/** The root pair carries the pack's block, whatever its status: the repository loads the pack. */
function carriesBlock(repo: RepoForDistribution, packId: string): boolean {
  return repo.blocks.some((b) => b.source === packId && isRootPairFile(b.file));
}

/**
 * Pack bodies that also load from the personal layer (D13).
 *
 * Two precise signals, nothing fuzzier: a personal file whose content hash equals the pack's
 * body hash is a `current` copy (the import target, `~/AGENTS.md`, a rule file); a personal file
 * at the pack's own source path, `packs/<id>/AGENTS.md`, whose hash differs is `stale` (the
 * checkout the import points at is not the pack as loaded). `contentHash` is the sha256 of the
 * trimmed content and the block hash the sha256 of the CRLF-normalized, trimmed body, so they
 * agree for any file with `\n` line endings.
 *
 * Not detected, by design: a pack pasted inside a larger personal file, or wrapped in a managed
 * block there. An empty result is therefore necessary for removing the interim wiring, not
 * sufficient; the probe run in roadmap Step 4 confirms that nothing loads twice.
 */
export function findPersonalPackCopies(
  personal: ReadonlyArray<InstructionFile>,
  packs: ReadonlyArray<Pack>,
  repos: ReadonlyArray<RepoForDistribution>,
): PersonalPackCopy[] {
  const copies: PersonalPackCopy[] = [];
  for (const pack of packs) {
    const packHash = pack.files.find((f) => f.kind === "agents-block")?.hash;
    if (packHash === undefined) continue;
    const doubleLoaded = repos
      .filter((repo) => carriesBlock(repo, pack.id))
      .map((repo) => repo.name)
      .sort();
    const sourcePath = `/packs/${pack.id}/AGENTS.md`;
    for (const file of personal) {
      const state =
        file.contentHash === packHash
          ? "current"
          : file.relativePath.endsWith(sourcePath)
            ? "stale"
            : null;
      if (state === null) continue;
      copies.push({ pack: pack.id, file: file.relativePath, kind: file.kind, state, doubleLoaded });
    }
  }
  return copies;
}

/** Every repository against every pack, sorted by pack, then by how urgently a human should look. */
export function distribute(
  root: string,
  repos: ReadonlyArray<RepoForDistribution>,
  packs: ReadonlyArray<Pack>,
  warnings: ReadonlyArray<string> = [],
  personal: ReadonlyArray<InstructionFile> = [],
): PackDistribution {
  const entries: PackStatusEntry[] = [];
  const counts = emptyStatusCounts();
  for (const pack of packs) {
    for (const repo of repos) {
      const entry = classifyPackStatus(repo, pack);
      counts[entry.status] += 1;
      entries.push(entry);
    }
  }
  entries.sort(
    (a, b) =>
      a.pack.localeCompare(b.pack) ||
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      a.repo.localeCompare(b.repo),
  );
  const personalCopies = findPersonalPackCopies(personal, packs, repos);
  return { root, packs, entries, counts, personalCopies, warnings };
}

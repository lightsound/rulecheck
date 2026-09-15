/**
 * Kinds of instruction files rulecheck understands.
 *
 * - `agents-md`       AGENTS.md (read by Cursor, Codex, and others)
 * - `claude-md`       CLAUDE.md or .claude/CLAUDE.md (read by Claude Code; Cursor reads root CLAUDE.md too)
 * - `claude-local-md` CLAUDE.local.md (personal, gitignored)
 * - `claude-rule`     .claude/rules/*.md
 * - `cursor-rule`     .cursor/rules/**\/*.mdc
 * - `cursorrules`     .cursorrules (legacy Cursor)
 */
export type FileKind =
  | "agents-md"
  | "claude-md"
  | "claude-local-md"
  | "claude-rule"
  | "cursor-rule"
  | "cursorrules"
  /** A markdown file pulled in through a Claude Code `@import`. */
  | "imported-md";

export type WrapperTarget = "AGENTS.md" | "CLAUDE.md";

export interface RuleFrontmatter {
  readonly alwaysApply: boolean | null;
  readonly globs: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
  readonly description: string | null;
}

export interface InstructionFile {
  /** Absolute path. */
  readonly path: string;
  /** Path relative to the repository root, using `/` separators. */
  readonly relativePath: string;
  readonly kind: FileKind;
  /** Directory depth from the repository root. 0 means the file lives at the root. */
  readonly depth: number;
  readonly bytes: number;
  readonly lines: number;
  readonly tokens: number;
  /** sha256 of the trimmed content. */
  readonly contentHash: string;
  /** Non-null when the file is only a pointer to another instruction file. */
  readonly wrapperTarget: WrapperTarget | null;
  /**
   * True when the pointer is a Claude Code `@import`, so Claude Code actually loads the target.
   * A prose pointer ("see AGENTS.md") is not loaded automatically.
   */
  readonly wrapperUsesImport: boolean;
  readonly frontmatter: RuleFrontmatter | null;
}

/**
 * How a repository arranges its root-level AGENTS.md / CLAUDE.md pair.
 *
 * - `agents-canonical` AGENTS.md carries the content, CLAUDE.md is a wrapper pointing at it
 * - `claude-canonical` CLAUDE.md carries the content, AGENTS.md is a wrapper pointing at it
 * - `agents-only`      only AGENTS.md exists (Claude Code will not read it)
 * - `claude-only`      only CLAUDE.md exists (Codex and most non-Cursor tools will not read it)
 * - `both-full`        both files carry content; tools that read both load them twice
 * - `none`             neither exists at the root
 */
export type CanonicalShape =
  | "agents-canonical"
  | "claude-canonical"
  | "agents-only"
  | "claude-only"
  | "both-full"
  | "none";

export interface ContextBudget {
  /** Approximate tokens Cursor loads for every conversation at the repo root. */
  readonly cursor: number;
  /** Approximate tokens Claude Code loads for every session at the repo root. */
  readonly claudeCode: number;
}

export type FindingKind =
  /** An instruction tells the agent to run a package script that no package.json in the repo defines. */
  | "unknown-script"
  /** An instruction points at a repository path that does not exist. */
  | "missing-path";

export interface Finding {
  readonly kind: FindingKind;
  /** Repo-relative path of the instruction file. */
  readonly file: string;
  readonly line: number;
  /** The script name or path as written. */
  readonly value: string;
  readonly message: string;
}

/**
 * A managed block inside an instruction file (decisions D4, D7):
 *
 *     <!-- agent-rules:begin source=<pack-id> rev=<git sha> hash=<sha256 of body> -->
 *     ...
 *     <!-- agent-rules:end -->
 *
 * `hash` is what the marker records; `bodyHash` is recomputed from the body found in the file.
 * They differ when a human edited the block after it was distributed.
 */
export interface ManagedBlock {
  /** Repo-relative path of the file that carries the block. */
  readonly file: string;
  /** Pack id from `source=`. */
  readonly source: string;
  /** Git sha of the pack repository from `rev=`, or null when the marker omits it. */
  readonly rev: string | null;
  readonly hash: string;
  readonly bodyHash: string;
  /** 1-based line of the begin marker. */
  readonly line: number;
  /** 1-based line of the end marker. */
  readonly endLine: number;
  readonly body: string;
  readonly modified: boolean;
}

export type BlockIssueKind =
  /** An `agent-rules` marker that could not be paired or parsed. */
  | "malformed-marker"
  /** A managed-region marker written by another tool, which a sync must not overwrite. */
  | "foreign-marker";

export interface BlockIssue {
  readonly kind: BlockIssueKind;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/**
 * One file that a pack distributes (D8: a pack is a set of files).
 *
 * - `agents-block` a fragment inserted into the target repository's root `AGENTS.md` as a managed block
 * - `file`         a whole managed file, e.g. `.cursor/skills/<name>/SKILL.md`, at the same repo-relative path
 */
export type PackFile =
  | {
      readonly kind: "agents-block";
      readonly body: string;
      /** sha256 of the normalized body, the value a fresh block would carry in `hash=`. */
      readonly hash: string;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly hash: string;
    };

export interface Pack {
  readonly id: string;
  /** Git HEAD of the pack repository, or null when it is not a git checkout. */
  readonly rev: string | null;
  readonly files: ReadonlyArray<PackFile>;
  /** Repositories subscribed to this pack, as `owner/repo`, lowercased. */
  readonly subscribers: ReadonlyArray<string>;
}

/**
 * Status of one repository with respect to one pack's `AGENTS.md` block (D6).
 *
 * - `current`        block present, body untouched, hash equals the pack's current hash
 * - `outdated`       block present, body untouched, pack has moved on
 * - `modified`       block present but its body no longer matches the hash it carries
 * - `eligible`       subscribed, no block, and the shape allows a deterministic insertion
 * - `blocked`        subscribed, no block, and a human must act first (`both have content`, foreign or malformed markers)
 * - `not-subscribed` no block and the repository is not in the pack's subscription list
 */
export type PackStatus =
  | "current"
  | "outdated"
  | "modified"
  | "eligible"
  | "blocked"
  | "not-subscribed";

export interface PackStatusEntry {
  readonly repo: string;
  readonly pack: string;
  readonly status: PackStatus;
  /** Repo-relative file the status refers to (the block, or the file that blocks insertion). */
  readonly file: string | null;
  readonly line: number | null;
  readonly message: string | null;
}

export interface PackDistribution {
  /** Directory the packs were loaded from. */
  readonly root: string;
  readonly packs: ReadonlyArray<Pack>;
  readonly entries: ReadonlyArray<PackStatusEntry>;
  readonly counts: Readonly<Record<PackStatus, number>>;
}

/**
 * Skill directories rulecheck understands: `<agentDir>/skills/<name>/SKILL.md`.
 * `.agents/skills` is the canonical location `npx skills` installs into and symlinks from.
 */
export type SkillAgentDir = ".agents" | ".claude" | ".cursor";

export type SkillIssueKind =
  /** SKILL.md does not start with frontmatter, or `name` / `description` fail skills-ref validation. */
  | "invalid-frontmatter"
  /** `skills-lock.json` lists a skill whose directory is missing. */
  | "missing";

/**
 * How an installed skill relates to `skills-lock.json`.
 *
 * - `unlocked` no entry: authored locally or installed without the lock
 * - `match`    the directory hashes to the entry's `computedHash`: unchanged since install
 * - `differs`  the hash differs. Not reported as a finding: `npx skills` may record a server-side
 *              snapshot hash instead of the folder hash, so a difference does not prove an edit
 * - `locked`   an entry without a hash
 */
export type SkillLockState = "unlocked" | "match" | "differs" | "locked";

export interface SkillIssue {
  readonly kind: SkillIssueKind;
  /** Repo-relative path: the SKILL.md, or `skills-lock.json` for missing entries. */
  readonly file: string;
  readonly line: number;
  readonly skill: string;
  readonly message: string;
}

export interface InstalledSkill {
  readonly name: string;
  readonly agentDir: SkillAgentDir;
  /** Repo-relative path of the skill directory. */
  readonly relativePath: string;
  /** Frontmatter `name`, or null when absent. */
  readonly frontmatterName: string | null;
  /** sha256 over every file in the directory, in the `skills-lock.json` `computedHash` format. */
  readonly hash: string;
  readonly files: number;
  /** Other agent directories that symlink to this one (`npx skills` links `.claude/skills/x` to `.agents/skills/x`). */
  readonly links: ReadonlyArray<string>;
  /** Null when the repository has no `skills-lock.json`. */
  readonly lockState: SkillLockState | null;
}

export interface SkillLockEntry {
  readonly name: string;
  readonly source: string;
  readonly sourceType: string;
  readonly computedHash: string | null;
  /** 1-based line of the entry key in `skills-lock.json`. */
  readonly line: number;
}

export interface SkillsInventory {
  readonly skills: ReadonlyArray<InstalledSkill>;
  /** Null when the repository has no `skills-lock.json`. */
  readonly lock: ReadonlyArray<SkillLockEntry> | null;
  readonly issues: ReadonlyArray<SkillIssue>;
}

export interface RepoReport {
  readonly root: string;
  /** Short display name, e.g. `owner/repo` when the root lives under a ghq-style tree. */
  readonly name: string;
  readonly shape: CanonicalShape;
  readonly files: ReadonlyArray<InstructionFile>;
  readonly budget: ContextBudget;
  readonly findings: ReadonlyArray<Finding>;
  readonly blocks: ReadonlyArray<ManagedBlock>;
  readonly blockIssues: ReadonlyArray<BlockIssue>;
  readonly skills: SkillsInventory;
}

/**
 * Instruction files that load in every session regardless of repository.
 *
 * Claude Code: `~/.claude/CLAUDE.md`, its imports, `~/.claude/rules/*.md`, the managed policy file,
 * and `~/CLAUDE.md` (the home directory is an ancestor of every project, and Claude Code reads
 * `CLAUDE.md` in ancestors).
 *
 * Cursor: `~/AGENTS.md`, `~/CLAUDE.md`, and always-apply `~/.cursor/rules/*.mdc`. Cursor's rule
 * loader walks from the workspace up through every ancestor directory (verified against the app's
 * `LocalCursorRulesService`; the ancestor walk is not documented). Cursor's User Rules live in
 * application settings, not on disk, and are not measured.
 */
export interface PersonalLayer {
  readonly home: string;
  readonly files: ReadonlyArray<InstructionFile>;
  /** Approximate tokens Claude Code adds to every session from this layer. */
  readonly claudeCodeTokens: number;
  /** Approximate tokens Cursor adds to every session from this layer, for workspaces under home. */
  readonly cursorTokens: number;
  readonly managedPolicyPath: string | null;
}

export interface DuplicateMember {
  readonly repo: string;
  readonly relativePath: string;
}

export interface DuplicateGroup {
  readonly contentHash: string;
  readonly tokens: number;
  readonly lines: number;
  readonly members: ReadonlyArray<DuplicateMember>;
}

export interface ScanTotals {
  readonly repos: number;
  readonly reposWithInstructions: number;
  readonly files: number;
  readonly tokens: number;
  readonly findings: number;
  readonly shapes: Readonly<Record<CanonicalShape, number>>;
  /** Managed blocks found across all repositories, and how many of them were edited in place. */
  readonly blocks: number;
  readonly modifiedBlocks: number;
  readonly skills: number;
  readonly skillIssues: number;
}

export interface ScanReport {
  readonly root: string;
  readonly scannedAt: string;
  readonly repos: ReadonlyArray<RepoReport>;
  readonly duplicates: ReadonlyArray<DuplicateGroup>;
  readonly personal: PersonalLayer | null;
  /** Null unless a pack directory was given. */
  readonly distribution: PackDistribution | null;
  readonly totals: ScanTotals;
}

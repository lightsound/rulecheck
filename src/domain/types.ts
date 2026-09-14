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
  | "cursorrules";

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

export interface RepoReport {
  readonly root: string;
  /** Short display name, e.g. `owner/repo` when the root lives under a ghq-style tree. */
  readonly name: string;
  readonly shape: CanonicalShape;
  readonly files: ReadonlyArray<InstructionFile>;
  readonly budget: ContextBudget;
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
  readonly shapes: Readonly<Record<CanonicalShape, number>>;
}

export interface ScanReport {
  readonly root: string;
  readonly scannedAt: string;
  readonly repos: ReadonlyArray<RepoReport>;
  readonly duplicates: ReadonlyArray<DuplicateGroup>;
  readonly totals: ScanTotals;
}

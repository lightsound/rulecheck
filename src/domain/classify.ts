import { findForeignMarkers, parseBlocks } from "./block.ts";
import type {
  CanonicalShape,
  ContextBudget,
  FileKind,
  InstructionFile,
  Normalization,
  RuleFrontmatter,
  WrapperTarget,
} from "./types.ts";

/**
 * Map a repo-relative path to an instruction file kind, or `null` when the file is not one.
 * Paths must use `/` separators.
 */
export function detectKind(relativePath: string): FileKind | null {
  const segments = relativePath.split("/");
  const name = segments.at(-1) ?? "";
  const parent = segments.at(-2) ?? "";
  const grandparent = segments.at(-3) ?? "";

  if (name === "AGENTS.md") return "agents-md";
  if (name === "CLAUDE.local.md") return "claude-local-md";
  if (name === "CLAUDE.md") return "claude-md";
  if (name === ".cursorrules") return "cursorrules";
  if (name.endsWith(".md") && parent === "rules" && grandparent === ".claude") return "claude-rule";
  if (name.endsWith(".mdc") && segments.includes(".cursor")) {
    const idx = segments.indexOf(".cursor");
    if (segments[idx + 1] === "rules") return "cursor-rule";
  }
  return null;
}

/** Directory names that are never descended into. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  "vendor",
  "target",
  ".venv",
  "venv",
  "__pycache__",
]);

/**
 * Directories skipped only when they sit directly under the given parent.
 * `.claude/worktrees` holds Claude Code's throwaway checkouts, which duplicate the parent repo.
 */
export const IGNORED_CHILD_DIRECTORIES: ReadonlyArray<readonly [parent: string, child: string]> = [
  [".claude", "worktrees"],
  [".cursor", "worktrees"],
];

export function isIgnoredDirectory(parentName: string, name: string): boolean {
  if (IGNORED_DIRECTORIES.has(name)) return true;
  return IGNORED_CHILD_DIRECTORIES.some(
    ([parent, child]) => parent === parentName && child === name,
  );
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const MAX_WRAPPER_LINES = 4;

/** True when the content contains a Claude Code `@AGENTS.md` / `@CLAUDE.md` style import. */
export function usesClaudeImport(content: string, target: WrapperTarget): boolean {
  const pattern = new RegExp(`(?:^|\\s)@(?:\\./)?${target.replace(".", "\\.")}(?:\\s|$)`, "m");
  return pattern.test(content.replace(HTML_COMMENT, ""));
}

/**
 * Decide whether the content is merely a pointer to another instruction file.
 *
 * A wrapper is at most a few non-empty lines (after stripping HTML comments)
 * that mention AGENTS.md or CLAUDE.md. Examples:
 *
 *   `@AGENTS.md`
 *   `look at AGENTS.md for your instructions`
 */
export function detectWrapperTarget(content: string): WrapperTarget | null {
  const lines = content
    .replace(HTML_COMMENT, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0 || lines.length > MAX_WRAPPER_LINES) return null;

  const text = lines.join(" ");
  const mentionsAgents = /\bAGENTS\.md\b/.test(text);
  const mentionsClaude = /\bCLAUDE\.md\b/.test(text);
  if (mentionsAgents && !mentionsClaude) return "AGENTS.md";
  if (mentionsClaude && !mentionsAgents) return "CLAUDE.md";
  // Mentions both or neither: ambiguous, treat as real content.
  return null;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Parse the minimal YAML-ish frontmatter used by Cursor `.mdc` and Claude `.claude/rules/*.md`.
 * Only the keys rulecheck cares about are extracted; everything else is ignored.
 */
export function parseFrontmatter(content: string): RuleFrontmatter | null {
  const match = FRONTMATTER.exec(content);
  if (!match) return null;
  const body = match[1] ?? "";

  let alwaysApply: boolean | null = null;
  let description: string | null = null;
  const globs: string[] = [];
  const paths: string[] = [];

  let listTarget: string[] | null = null;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trimEnd();
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && listTarget) {
      listTarget.push(unquote(listItem[1] ?? ""));
      continue;
    }
    listTarget = null;

    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] ?? "";
    const value = (kv[2] ?? "").trim();

    switch (key) {
      case "alwaysApply":
        alwaysApply = value === "true" ? true : value === "false" ? false : null;
        break;
      case "description":
        description = value.length > 0 ? unquote(value) : null;
        break;
      case "globs":
        if (value.length === 0) listTarget = globs;
        else globs.push(...splitInlineList(value));
        break;
      case "paths":
        if (value.length === 0) listTarget = paths;
        else paths.push(...splitInlineList(value));
        break;
      default:
        break;
    }
  }

  return { alwaysApply, description, globs, paths };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Split `a, b` / `[a, b]` / `"a, b"` into items. Cursor accepts all three spellings.
 */
function splitInlineList(value: string): string[] {
  const unquoted = unquote(value);
  const inner =
    unquoted.startsWith("[") && unquoted.endsWith("]") ? unquoted.slice(1, -1) : unquoted;
  return inner
    .split(",")
    .map((item) => unquote(item))
    .filter((item) => item.length > 0);
}

/** Root-level AGENTS.md / CLAUDE.md pair, if present. */
function rootPair(files: ReadonlyArray<InstructionFile>) {
  const agents = files.find((f) => f.depth === 0 && f.kind === "agents-md");
  const claude = files.find(
    (f) =>
      f.kind === "claude-md" &&
      (f.relativePath === "CLAUDE.md" || f.relativePath === ".claude/CLAUDE.md"),
  );
  return { agents, claude };
}

/** Decide how a repository arranges its root AGENTS.md / CLAUDE.md. */
export function classifyShape(files: ReadonlyArray<InstructionFile>): CanonicalShape {
  const { agents, claude } = rootPair(files);
  if (!agents && !claude) return "none";
  if (agents && !claude) return "agents-only";
  if (!agents && claude) return "claude-only";
  if (!agents || !claude) return "none";

  const claudeIsWrapper = claude.wrapperTarget === "AGENTS.md";
  const agentsIsWrapper = agents.wrapperTarget === "CLAUDE.md";
  if (claudeIsWrapper && !agentsIsWrapper) return "agents-canonical";
  if (agentsIsWrapper && !claudeIsWrapper) return "claude-canonical";
  // D16: Claude Code loads AGENTS.md through the import line wherever it sits in CLAUDE.md, so
  // the pair is canonical in effect; the text around the line is CLAUDE.md's own and stays there.
  if (claude.importsAgentsMd && !agentsIsWrapper) return "agents-imported";
  return "both-full";
}

const AGENTS_IMPORT_LINE = /^\s*@(?:\.\/)?AGENTS\.md\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

interface ClassifiedLine {
  readonly line: string;
  /**
   * True where Claude Code does not parse imports: inside a fenced code block (fence lines
   * included) or inside an HTML comment that spans several lines (its opening and closing lines
   * included). Single-line comments, such as another tool's region markers, are not spans.
   */
  readonly inert: boolean;
}

/**
 * The lines of `content` with `\r\n` normalized, each flagged when it sits where Claude Code skips
 * import parsing: fenced code ("Import parsing skips Markdown code spans and fenced code blocks";
 * a file that documents the wrapper convention shows the import line in a fence) and multi-line
 * HTML comments, which are stripped before injection. A fence closes on a fence of the same
 * character at least as long.
 */
function classifyLines(content: string): ClassifiedLine[] {
  const lines: ClassifiedLine[] = [];
  let fence: string | null = null;
  let comment = false;
  // A line leaves a comment open when its last `<!--` comes after its last `-->`.
  const opensComment = (line: string) => line.lastIndexOf("<!--") > line.lastIndexOf("-->");
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    if (comment) {
      lines.push({ line, inert: true });
      if (line.includes("-->")) comment = opensComment(line);
      continue;
    }
    const marker = FENCE.exec(line)?.[1];
    if (fence === null) {
      if (marker) fence = marker;
      else if (opensComment(line)) comment = true;
      lines.push({ line, inert: fence !== null || comment });
      continue;
    }
    lines.push({ line, inert: true });
    if (
      marker &&
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      line.trim() === marker
    ) {
      fence = null;
    }
  }
  return lines;
}

/**
 * Whether `claudeContent` holds a line that is exactly an `@AGENTS.md` (or `@./AGENTS.md`) import
 * where Claude Code parses imports (D16). Surrounding whitespace is allowed; a line that says
 * anything more is prose. Where the line sits does not matter otherwise: between another tool's
 * region markers counts too, because Claude Code resolves it there like anywhere else.
 */
export function importsAgentsMd(claudeContent: string): boolean {
  return classifyLines(claudeContent).some(
    ({ line, inert }) => !inert && AGENTS_IMPORT_LINE.test(line),
  );
}

/**
 * What CLAUDE.md says beyond importing AGENTS.md: the content with every line that is exactly an
 * `@AGENTS.md` import (where Claude Code parses imports) removed, line endings normalized to
 * `\n`, surrounding blank lines trimmed.
 */
export function claudeContentBeyondImport(claudeContent: string): string {
  return classifyLines(claudeContent)
    .filter(({ line, inert }) => inert || !AGENTS_IMPORT_LINE.test(line))
    .map(({ line }) => line)
    .join("\n")
    .trim();
}

/**
 * Decide how a `both-full` pair is normalized (D12). `drop` only when the text CLAUDE.md adds
 * appears verbatim in AGENTS.md (a byte-level substring after line-ending normalization), so no
 * sentence is dropped on a guess; every other pair is merged and left for review. Managed blocks
 * and other tools' regions in AGENTS.md do not count as a place where the text survives: a block
 * body belongs to a pack and a region to its generator, and both are replaced whole on their next
 * update (D15).
 */
export function classifyBothFull(
  agentsContent: string,
  claudeContent: string,
): Extract<Normalization, "drop" | "merge"> {
  const extra = claudeContentBeyondImport(claudeContent);
  if (extra.length === 0) return "drop";
  return contentOutsideBlocks(agentsContent).includes(extra) ? "drop" : "merge";
}

/**
 * What a sync does to the root pair besides inserting the block. Every shape maps to exactly one
 * normalization; only `both-full` needs the files' content to choose between `drop` and `merge`.
 */
export function classifyNormalization(
  shape: CanonicalShape,
  agentsContent: string,
  claudeContent: string,
): Normalization {
  switch (shape) {
    case "agents-canonical":
    case "agents-imported":
      return "keep";
    case "agents-only":
      return "add-wrapper";
    case "none":
      return "create";
    case "claude-only":
    case "claude-canonical":
      return "move";
    case "both-full":
      return classifyBothFull(agentsContent, claudeContent);
  }
}

/** `content` with the lines of every managed block and foreign region (markers included) blanked, line count preserved. */
function contentOutsideBlocks(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const owned = [
    ...parseBlocks("", normalized).blocks,
    ...findForeignMarkers("", normalized).regions,
  ];
  if (owned.length === 0) return normalized;
  const lines = normalized.split("\n");
  for (const span of owned) {
    for (let index = span.line - 1; index < span.endLine; index += 1) lines[index] = "";
  }
  return lines.join("\n");
}

/** Extract `@file` imports (Claude Code syntax) that point to local markdown files. */
export function extractClaudeImports(content: string): string[] {
  const imports: string[] = [];
  for (const line of content.split("\n")) {
    const match = /(?:^|\s)@([A-Za-z0-9_./~-]+\.md)\b/.exec(line);
    if (match?.[1]) imports.push(match[1]);
  }
  return imports;
}

/**
 * Approximate the tokens each tool loads unconditionally at the repository root.
 *
 * Cursor: root AGENTS.md, root CLAUDE.md, .cursorrules, and `.cursor/rules` with `alwaysApply: true`.
 * Claude Code: root CLAUDE.md (+ .claude/CLAUDE.md), CLAUDE.local.md, `.claude/rules` without `paths`,
 *   plus one level of `@AGENTS.md` / `@CLAUDE.md` style imports resolved among the scanned files.
 */
export function estimateBudget(
  files: ReadonlyArray<InstructionFile>,
  contents: ReadonlyMap<string, string>,
): ContextBudget {
  const byRelative = new Map(files.map((f) => [f.relativePath, f] as const));

  let cursor = 0;
  let claudeCode = 0;

  for (const file of files) {
    switch (file.kind) {
      case "agents-md":
        if (file.depth === 0) cursor += file.tokens;
        break;
      case "cursorrules":
        if (file.depth === 0) cursor += file.tokens;
        break;
      case "cursor-rule":
        if (file.frontmatter?.alwaysApply === true) cursor += file.tokens;
        break;
      case "claude-md":
        if (file.relativePath === "CLAUDE.md") {
          cursor += file.tokens;
          claudeCode += file.tokens;
        } else if (file.relativePath === ".claude/CLAUDE.md") {
          claudeCode += file.tokens;
        }
        break;
      case "claude-local-md":
        if (file.depth === 0) claudeCode += file.tokens;
        break;
      case "claude-rule":
        if ((file.frontmatter?.paths.length ?? 0) === 0) claudeCode += file.tokens;
        break;
      default:
        break;
    }
  }

  // Resolve one level of Claude imports from the root CLAUDE.md files.
  for (const entry of ["CLAUDE.md", ".claude/CLAUDE.md"]) {
    const content = contents.get(entry);
    if (!content) continue;
    for (const target of extractClaudeImports(content)) {
      const normalized = target.replace(/^\.\//, "");
      const imported = byRelative.get(normalized);
      if (imported && imported.relativePath !== entry) claudeCode += imported.tokens;
    }
  }

  return { cursor, claudeCode };
}

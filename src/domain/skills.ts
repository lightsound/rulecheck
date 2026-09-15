import { createHash } from "node:crypto";
import type {
  InstalledSkill,
  SkillAgentDir,
  SkillIssue,
  SkillLockEntry,
  SkillsInventory,
} from "./types.ts";

/**
 * Skills inventory (decision D8). rulecheck lists `SKILL.md` directories, mirrors the
 * `skills-ref` frontmatter checks, and reads the `skills-lock.json` that `npx skills` writes;
 * it defines no manifest or rules of its own.
 */

export const SKILL_AGENT_DIRS: ReadonlyArray<SkillAgentDir> = [".agents", ".claude", ".cursor"];

export interface DetectedSkill {
  readonly name: string;
  readonly agentDir: SkillAgentDir;
  /** Repo-relative path of the skill directory. */
  readonly dir: string;
}

/** Recognize `<agentDir>/skills/<name>/SKILL.md` at the repository root. */
export function detectSkill(relativePath: string): DetectedSkill | null {
  const segments = relativePath.split("/");
  if (segments.length !== 4 || segments[1] !== "skills" || segments[3] !== "SKILL.md") return null;
  const agentDir = SKILL_AGENT_DIRS.find((dir) => dir === segments[0]);
  const name = segments[2] ?? "";
  if (!agentDir || name.length === 0) return null;
  return { name, agentDir, dir: segments.slice(0, 3).join("/") };
}

export interface SkillFileContent {
  /** Path relative to the skill directory, `/` separated. */
  readonly relativePath: string;
  readonly content: Uint8Array;
}

/** Directories `npx skills` leaves out of the hash. */
export const SKILL_HASH_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
]);

/**
 * `computedHash` as `skills-lock.json` records it: sha256 over every file, sorted by relative path,
 * feeding the path and then the bytes of each file.
 */
export function computeSkillHash(files: ReadonlyArray<SkillFileContent>): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

/**
 * Read the project-scoped lock (`skills-lock.json`, version 1) into entries. Returns null when the
 * text is not a lock file of that shape, so the caller can tell "no lock" from "empty lock".
 */
export function parseSkillsLock(text: string): SkillLockEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.version !== "number" || !isRecord(parsed.skills)) {
    return null;
  }

  const lines = text.split("\n");
  const skillsLine = lines.findIndex((line) => /^\s*"skills"\s*:/.test(line));

  const entries: SkillLockEntry[] = [];
  for (const [name, value] of Object.entries(parsed.skills)) {
    if (!isRecord(value)) continue;
    const keyPattern = new RegExp(
      `^\\s*${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`,
    );
    const line = lines.findIndex((text, index) => index > skillsLine && keyPattern.test(text));
    entries.push({
      name,
      source: typeof value.source === "string" ? value.source : "",
      sourceType: typeof value.sourceType === "string" ? value.sourceType : "",
      computedHash: typeof value.computedHash === "string" ? value.computedHash : null,
      line: line >= 0 ? line + 1 : Math.max(skillsLine + 1, 1),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export interface SkillFrontmatterCheck {
  readonly name: string | null;
  /** Empty when the frontmatter passes the `skills-ref` checks. */
  readonly errors: ReadonlyArray<string>;
}

/**
 * Top-level frontmatter fields as raw strings. Block scalars (`>` / `|`) and nested mappings are
 * flattened to the joined indented lines, which is enough to judge presence and length.
 */
function parseTopLevelFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  let current: string | null = null;
  const continuation: string[] = [];
  const flush = () => {
    if (current !== null && continuation.length > 0) {
      fields.set(current, `${fields.get(current) ?? ""} ${continuation.join(" ")}`.trim());
    }
    continuation.length = 0;
  };

  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) {
      flush();
      current = kv[1] ?? "";
      const value = (kv[2] ?? "").trim();
      fields.set(current, /^[>|][+-]?$/.test(value) ? "" : value);
      continue;
    }
    if (current !== null && /^\s+\S/.test(line)) continuation.push(line.trim());
  }
  flush();
  return fields;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * The `skills-ref validate` checks that decide whether a client can load the skill: frontmatter
 * present, `name` well-formed and equal to the directory name, `description` present and bounded.
 *
 * skills-ref also rejects fields outside the spec list. Clients add their own (`argument-hint`,
 * `disable-model-invocation`, `user-invocable` in Claude Code) and load such skills fine, so that
 * check is deliberately not mirrored: it would ask humans to remove fields their tool needs.
 */
export function checkSkillFrontmatter(content: string, dirName: string): SkillFrontmatterCheck {
  const match = FRONTMATTER.exec(content);
  if (!match) return { name: null, errors: ["SKILL.md must start with YAML frontmatter"] };

  const fields = parseTopLevelFields(match[1] ?? "");
  const errors: string[] = [];

  const name = fields.has("name") ? unquote(fields.get("name") ?? "").normalize("NFKC") : null;
  if (name === null || name.trim().length === 0) {
    errors.push("field `name` must be a non-empty string");
  } else {
    if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters`);
    if (name !== name.toLowerCase()) errors.push("name must be lowercase");
    if (name.startsWith("-") || name.endsWith("-"))
      errors.push("name cannot start or end with a hyphen");
    if (name.includes("--")) errors.push("name cannot contain consecutive hyphens");
    if (!/^[\p{L}\p{N}-]+$/u.test(name))
      errors.push("name may only contain letters, digits, and hyphens");
    if (dirName.normalize("NFKC") !== name)
      errors.push(`directory \`${dirName}\` must match name \`${name}\``);
  }

  const description = fields.has("description") ? unquote(fields.get("description") ?? "") : null;
  if (description === null || description.trim().length === 0) {
    errors.push("field `description` must be a non-empty string");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  return { name: name === null || name.length === 0 ? null : name, errors };
}

/**
 * Relate installed skill directories to `skills-lock.json`.
 *
 * A lock entry whose directory is gone is a finding. The other direction is a per-skill state,
 * not a finding: a directory without an entry is usually authored in the repository, and a hash
 * that differs from `computedHash` does not prove an edit (see {@link SkillLockState}).
 * Without a lock file the inventory is reported and nothing is judged.
 */
export function reconcileSkills(
  skills: ReadonlyArray<Omit<InstalledSkill, "lockState">>,
  lock: ReadonlyArray<SkillLockEntry> | null,
  frontmatterIssues: ReadonlyArray<SkillIssue> = [],
): SkillsInventory {
  const issues: SkillIssue[] = [...frontmatterIssues];
  const entries = new Map(lock?.map((entry) => [entry.name, entry] as const) ?? []);

  const withState: InstalledSkill[] = skills.map((skill) => {
    if (lock === null) return { ...skill, lockState: null };
    const entry = entries.get(skill.name);
    if (!entry) return { ...skill, lockState: "unlocked" };
    if (entry.computedHash === null) return { ...skill, lockState: "locked" };
    return { ...skill, lockState: entry.computedHash === skill.hash ? "match" : "differs" };
  });

  const installed = new Set(skills.map((skill) => skill.name));
  for (const entry of lock ?? []) {
    if (installed.has(entry.name)) continue;
    issues.push({
      kind: "missing",
      file: "skills-lock.json",
      line: entry.line,
      skill: entry.name,
      message: `skills-lock.json lists \`${entry.name}\` (${entry.source}) but no skill directory exists`,
    });
  }

  return {
    skills: withState,
    lock,
    issues: issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  };
}

/**
 * Extract things an instruction file claims about the repository so they can be verified:
 * package scripts it tells the agent to run, and repository paths it points at.
 *
 * Precision matters more than recall here. Every reference that fails verification becomes a
 * finding a human is asked to act on, so ambiguous text is skipped rather than guessed at.
 *
 * Scripts come from shell lines in fenced blocks and from inline code: `bun run x`, `pnpm x`,
 * `yarn x`, `npm run x`. Manager builtins (`bun install`, `pnpm dlx`) are not scripts.
 * Paths come from inline code spans containing a `/`. URLs, absolute and `~` paths, globs,
 * placeholders, scoped package names, and `owner/repo` pairs are ignored. Lines that assert
 * absence ("has no `src/main.tsx`", "は存在しない") are skipped entirely. Known gap: paths the
 * agent is expected to create are extracted like any other and are reported as missing.
 * Verification of the extracted references is in `src/scan/verify.ts`.
 */

export type ReferenceKind = "script" | "path";

export interface Reference {
  readonly kind: ReferenceKind;
  /** Script name or repo-relative path as written. */
  readonly value: string;
  /** 1-based line number in the source file. */
  readonly line: number;
  /** The command or span the reference was extracted from. */
  readonly raw: string;
  /**
   * For scripts: true when written as `<manager> run <name>`. Bare `bun <name>` also resolves
   * to dependency binaries, so it needs a wider check before being called unknown.
   */
  readonly explicitRun?: boolean;
}

const FENCE = /^\s*(```|~~~)/;
const INLINE_CODE = /`([^`\n]+)`/g;

/** Subcommands of each package manager that are not user scripts. */
const BUILTINS: Readonly<Record<string, ReadonlySet<string>>> = {
  bun: new Set([
    "add",
    "audit",
    "build",
    "create",
    "exec",
    "info",
    "init",
    "install",
    "i",
    "link",
    "unlink",
    "outdated",
    "patch",
    "pm",
    "publish",
    "remove",
    "rm",
    "repl",
    "run",
    "test",
    "update",
    "upgrade",
    "why",
    "x",
  ]),
  npm: new Set([
    "access",
    "adduser",
    "audit",
    "bugs",
    "cache",
    "ci",
    "config",
    "dedupe",
    "deprecate",
    "diff",
    "dist-tag",
    "docs",
    "doctor",
    "edit",
    "exec",
    "explain",
    "explore",
    "find-dupes",
    "fund",
    "help",
    "hook",
    "init",
    "install",
    "i",
    "install-ci-test",
    "install-test",
    "link",
    "ll",
    "login",
    "logout",
    "ls",
    "org",
    "outdated",
    "owner",
    "pack",
    "ping",
    "pkg",
    "prefix",
    "profile",
    "prune",
    "publish",
    "query",
    "rebuild",
    "repo",
    "restart",
    "root",
    "run",
    "run-script",
    "search",
    "set",
    "shrinkwrap",
    "star",
    "stars",
    "start",
    "stop",
    "team",
    "test",
    "token",
    "uninstall",
    "unpublish",
    "unstar",
    "update",
    "version",
    "view",
    "whoami",
  ]),
  pnpm: new Set([
    "add",
    "install",
    "i",
    "update",
    "up",
    "remove",
    "rm",
    "link",
    "unlink",
    "import",
    "rebuild",
    "prune",
    "fetch",
    "dedupe",
    "run",
    "exec",
    "dlx",
    "create",
    "test",
    "start",
    "publish",
    "pack",
    "list",
    "ls",
    "outdated",
    "why",
    "audit",
    "licenses",
    "store",
    "env",
    "setup",
    "init",
    "patch",
    "patch-commit",
    "patch-remove",
    "config",
    "approve-builds",
    "self-update",
  ]),
  yarn: new Set([
    "add",
    "install",
    "remove",
    "up",
    "upgrade",
    "upgrade-interactive",
    "run",
    "exec",
    "dlx",
    "init",
    "info",
    "why",
    "workspaces",
    "workspace",
    "config",
    "cache",
    "bin",
    "dedupe",
    "explain",
    "link",
    "unlink",
    "node",
    "npm",
    "pack",
    "patch",
    "patch-commit",
    "plugin",
    "rebuild",
    "set",
    "stage",
    "test",
    "start",
    "version",
    "constraints",
    "publish",
  ]),
};

const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;

/**
 * Match `<manager> [run] <name>` at the start of a shell segment. Group 1 is the manager,
 * group 2 is `run` when present, group 3 is the candidate script.
 */
const COMMAND = /^(?:\$\s+)?(bun|npm|pnpm|yarn)\s+(?:(run)\s+)?([^\s]+)/;

/** Segment a shell line on common operators so `cd x && bun run y` still yields `bun run y`. */
function shellSegments(line: string): string[] {
  return line
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function scriptFromCommand(segment: string): { name: string; explicitRun: boolean } | null {
  const match = COMMAND.exec(segment);
  if (!match) return null;
  const manager = match[1] ?? "";
  const explicitRun = match[2] !== undefined;
  const candidate = match[3] ?? "";

  if (!SCRIPT_NAME.test(candidate)) return null;
  if (candidate.includes("/") || /\.[cm]?[jt]sx?$/.test(candidate)) return null;
  if (!explicitRun && BUILTINS[manager]?.has(candidate)) return null;
  // `npm <name>` without `run` only runs a handful of lifecycle scripts; skip the rest.
  if (!explicitRun && manager === "npm") return null;
  return { name: candidate, explicitRun };
}

/**
 * A line that states something is absent ("has no `src/main.tsx`", "`x/` は存在しない") is describing
 * reality, not pointing at it. Path references on such lines are skipped.
 */
const NEGATION =
  /\b(?:no|not|never|without|removed|deleted|deprecated|missing|doesn't|does not|don't|isn't|is not|aren't|are not)\b|ない|しない|削除|廃止|存在しません/i;

const PATH_LIKE = /^\.{0,2}\/?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+\/?$/;
const DOMAIN_LIKE = /^[a-z0-9-]+\.[a-z]{2,}$/i;

/**
 * Accept only spans that look like a repository-relative path with at least one `/`.
 * Rejects URLs, absolute and home paths, globs, placeholders, scoped package names, and
 * `owner/repo` style pairs whose first segment is a domain.
 */
function pathFromSpan(span: string): string | null {
  const text = span.trim();
  if (!PATH_LIKE.test(text)) return null;
  if (text.startsWith("/") || text.startsWith("~") || text.startsWith("@")) return null;
  if (/^https?:/.test(text) || text.includes("node_modules")) return null;
  const first = text.replace(/^\.\.?\//, "").split("/")[0] ?? "";
  if (DOMAIN_LIKE.test(first)) return null;
  return text.replace(/^\.\//, "");
}

export function extractReferences(content: string): Reference[] {
  const references: Reference[] = [];
  const lines = content.split("\n");
  let inFence = false;

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    if (FENCE.test(rawLine)) {
      inFence = !inFence;
      return;
    }

    const pushScripts = (text: string) => {
      for (const segment of shellSegments(text)) {
        const script = scriptFromCommand(segment);
        if (!script) continue;
        references.push({
          kind: "script",
          value: script.name,
          line: lineNumber,
          raw: segment,
          explicitRun: script.explicitRun,
        });
      }
    };

    if (inFence) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) return;
      pushScripts(trimmed);
      return;
    }

    const negated = NEGATION.test(rawLine.replace(INLINE_CODE, ""));
    for (const match of rawLine.matchAll(INLINE_CODE)) {
      const span = match[1] ?? "";
      pushScripts(span);
      if (negated) continue;
      const path = pathFromSpan(span);
      if (path) references.push({ kind: "path", value: path, line: lineNumber, raw: span });
    }
  });

  return dedupe(references);
}

function dedupe(references: Reference[]): Reference[] {
  const seen = new Set<string>();
  return references.filter((ref) => {
    const key = `${ref.kind}:${ref.value}:${ref.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface PackageManifest {
  readonly scripts: ReadonlySet<string>;
  /** Names of dependencies of every kind; a bare `bun <name>` may be one of their binaries. */
  readonly dependencies: ReadonlySet<string>;
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Read script and dependency names out of a package.json, tolerating malformed input. */
export function parseManifest(packageJson: string): PackageManifest {
  const scripts = new Set<string>();
  const dependencies = new Set<string>();
  try {
    const parsed = JSON.parse(packageJson) as Record<string, unknown>;
    if (parsed.scripts && typeof parsed.scripts === "object") {
      for (const name of Object.keys(parsed.scripts)) scripts.add(name);
    }
    for (const field of DEPENDENCY_FIELDS) {
      const deps = parsed[field];
      if (deps && typeof deps === "object") {
        for (const name of Object.keys(deps)) dependencies.add(name.split("/").at(-1) ?? name);
      }
    }
  } catch {
    // malformed package.json: treat as empty
  }
  return { scripts, dependencies };
}

/** Read the `scripts` keys out of a package.json, tolerating malformed input. */
export function scriptsOf(packageJson: string): ReadonlySet<string> {
  return parseManifest(packageJson).scripts;
}

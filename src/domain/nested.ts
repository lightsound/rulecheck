import type { NestedRepoKind } from "./types.ts";

/**
 * A repository found inside another discovered repository is a different project (D24). What
 * kind it is decides only how the report names it:
 *
 * - `submodule`    `.git` is a file (`gitdir: ../.git/modules/<name>`, how git checks out a
 *                  submodule), or the enclosing repository's `.gitmodules` lists the path
 *                  (submodules checked out by older git versions carry a `.git` directory)
 * - `nested-clone` `.git` is a directory and no `.gitmodules` entry claims the path: a clone
 *                  made inside a checkout (`owner/repo/repo`), a vendored checkout
 */
export function classifyNestedRepo(
  gitIsFile: boolean,
  listedInGitmodules: boolean,
): NestedRepoKind {
  return gitIsFile || listedInGitmodules ? "submodule" : "nested-clone";
}

const SECTION = /^\s*\[/;
const PATH_LINE = /^\s*path\s*=\s*(.*)$/;

/**
 * The `path = <dir>` values of a `.gitmodules` file (relative to the repository root, `/`
 * separators). Only `path` keys are read; `url`, `branch`, and unknown keys are skipped. Values
 * follow git-config syntax: a `#` or `;` starts a comment, and a value that holds spaces or
 * special characters is written in double quotes with `\` escapes.
 */
export function parseGitmodulesPaths(content: string): ReadonlyArray<string> {
  const paths: string[] = [];
  let inSection = false;
  for (const line of content.split("\n")) {
    if (SECTION.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    const match = PATH_LINE.exec(line);
    if (!match) continue;
    const value = configValue(match[1] ?? "")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    if (value.length > 0) paths.push(value);
  }
  return paths;
}

/** A git-config value: quotes removed, `\` escapes resolved, a trailing comment cut. */
function configValue(raw: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i] as string;
    if (char === "\\" && i + 1 < raw.length) {
      out += raw[++i];
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (char === "#" || char === ";")) break;
    out += char;
  }
  return out.trim();
}

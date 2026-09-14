import type { CanonicalShape, PersonalLayer, RepoReport, ScanReport } from "../domain/types.ts";

const SHAPE_LABEL: Record<CanonicalShape, string> = {
  "agents-canonical": "AGENTS.md canonical",
  "claude-canonical": "CLAUDE.md canonical",
  "agents-only": "AGENTS.md only",
  "claude-only": "CLAUDE.md only",
  "both-full": "both have content",
  none: "none",
};

const SHAPE_NOTE: Record<CanonicalShape, string | null> = {
  "agents-canonical": null,
  "claude-canonical": "Cursor and Codex read AGENTS.md; consider making it the canonical file",
  "agents-only": "Claude Code does not read AGENTS.md; add a CLAUDE.md wrapper (`@AGENTS.md`)",
  "claude-only": "Codex and most non-Cursor tools do not read CLAUDE.md",
  "both-full": "Cursor loads both files; content is likely duplicated or conflicting",
  none: null,
};

export function renderText(report: ScanReport, options: { readonly all?: boolean } = {}): string {
  const out: string[] = [];
  const repos = options.all ? report.repos : report.repos.filter((r) => r.files.length > 0);

  out.push(`rulecheck scan of ${report.root}`);
  out.push(
    `${report.totals.repos} repositories, ${report.totals.reposWithInstructions} with instruction files, ${report.totals.files} files, ~${fmt(report.totals.tokens)} tokens total, ${report.totals.findings} findings`,
  );
  out.push("");

  if (report.personal) {
    out.push(...renderPersonal(report.personal));
    out.push("");
  }

  out.push("Shapes");
  for (const shape of Object.keys(SHAPE_LABEL) as CanonicalShape[]) {
    const count = report.totals.shapes[shape];
    if (count === 0 && shape !== "agents-canonical") continue;
    out.push(`  ${pad(SHAPE_LABEL[shape], 22)} ${String(count).padStart(3)}`);
  }
  out.push("");

  out.push("Repositories");
  for (const repo of repos) out.push(...renderRepo(repo));
  out.push("");

  if (report.duplicates.length > 0) {
    out.push(`Duplicates (${report.duplicates.length} groups of identical content)`);
    for (const group of report.duplicates) {
      out.push(`  ${group.members.length}x  ${group.lines} lines, ~${fmt(group.tokens)} tokens`);
      for (const member of group.members) out.push(`      ${member.repo}/${member.relativePath}`);
    }
    out.push("");
  }

  return out.join("\n");
}

function renderRepo(repo: RepoReport): string[] {
  const lines: string[] = [];
  const budget = `cursor ~${fmt(repo.budget.cursor)}  claude ~${fmt(repo.budget.claudeCode)}`;
  lines.push(`  ${pad(repo.name, 44)} ${pad(SHAPE_LABEL[repo.shape], 22)} ${budget}`);

  const note = SHAPE_NOTE[repo.shape];
  if (note) lines.push(`      ! ${note}`);

  const proseWrapper = repo.files.find(
    (f) =>
      f.kind === "claude-md" &&
      f.depth === 0 &&
      f.wrapperTarget === "AGENTS.md" &&
      !f.wrapperUsesImport,
  );
  if (proseWrapper) {
    lines.push(
      `      ! ${proseWrapper.relativePath} points at AGENTS.md in prose; use \`@AGENTS.md\` so Claude Code loads it automatically`,
    );
  }

  for (const finding of repo.findings) {
    lines.push(`      ! ${finding.file}:${finding.line}  ${finding.message}`);
  }

  for (const file of repo.files) lines.push(renderFile(file));
  return lines;
}

function renderFile(file: RepoReport["files"][number]): string {
  const marker = file.wrapperTarget
    ? ` -> ${file.wrapperTarget}${file.wrapperUsesImport ? "" : " (prose)"}`
    : "";
  const scope = describeScope(file);
  return `      ${pad(file.relativePath, 52)} ${String(file.lines).padStart(4)} lines ${String(file.tokens).padStart(6)} tok${scope}${marker}`;
}

function renderPersonal(personal: PersonalLayer): string[] {
  const lines: string[] = [];
  lines.push(
    `Personal layer (home: ${personal.home}, added to every session)   cursor ~${fmt(personal.cursorTokens)}  claude ~${fmt(personal.claudeCodeTokens)}`,
  );
  if (personal.files.length === 0) {
    lines.push("      (no ~/.claude/CLAUDE.md, ~/.claude/rules, ~/AGENTS.md, or ~/.cursor/rules)");
  }
  for (const file of personal.files) lines.push(renderFile(file));
  if (personal.managedPolicyPath) {
    lines.push(
      `      managed policy present at ${personal.managedPolicyPath} (cannot be excluded)`,
    );
  }
  lines.push(
    "      Cursor loads ~/AGENTS.md and ~/.cursor/rules/*.mdc for workspaces under home (ancestor walk, undocumented). User Rules in Cursor settings are not on disk and are not measured.",
  );
  return lines;
}

function describeScope(file: RepoReport["files"][number]): string {
  if (file.kind === "cursor-rule" && file.frontmatter) {
    if (file.frontmatter.alwaysApply === true) return "  [always]";
    if (file.frontmatter.globs.length > 0) return `  [globs: ${file.frontmatter.globs.join(", ")}]`;
    if (file.frontmatter.description) return "  [intelligent]";
    return "  [manual]";
  }
  if (file.kind === "claude-rule" && file.frontmatter && file.frontmatter.paths.length > 0) {
    return `  [paths: ${file.frontmatter.paths.join(", ")}]`;
  }
  if (file.kind === "imported-md") return "  [imported]";
  if (file.kind === "claude-local-md") return "  [personal, gitignored]";
  if (file.depth > 0 && (file.kind === "agents-md" || file.kind === "claude-md"))
    return "  [nested]";
  return "";
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

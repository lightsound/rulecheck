import type {
  CanonicalShape,
  PackDistribution,
  PackStatus,
  PersonalLayer,
  PersonalPackCopy,
  RepoReport,
  ScanReport,
} from "../domain/types.ts";
import { LOCK_STATE_LABEL, SHAPE_LABEL, STATUS_LABEL } from "./labels.ts";

/** Advice printed under a repository whose shape is not the convention; null where nothing is to do. */
export const SHAPE_NOTE: Record<CanonicalShape, string | null> = {
  "agents-canonical": null,
  "agents-imported":
    "CLAUDE.md imports AGENTS.md and carries content of its own; not the strict one-line wrapper (Claude Code loads both), a sync leaves it untouched",
  "claude-canonical": "Cursor and Codex read AGENTS.md; consider making it the canonical file",
  "agents-only": "Claude Code does not read AGENTS.md; add a CLAUDE.md wrapper (`@AGENTS.md`)",
  "claude-only": "Codex and most non-Cursor tools do not read CLAUDE.md",
  "both-full":
    "Cursor loads both files; content is likely duplicated or conflicting (a sync merges CLAUDE.md into AGENTS.md, or drops it when AGENTS.md already contains it, and leaves the wrapper)",
  none: null,
};

export function renderText(report: ScanReport, options: { readonly all?: boolean } = {}): string {
  const out: string[] = [];
  const repos = options.all
    ? report.repos
    : report.repos.filter((r) => r.files.length > 0 || r.skills.skills.length > 0);

  out.push(`rulecheck scan of ${report.root}`);
  out.push(
    `${report.totals.repos} repositories, ${report.totals.reposWithInstructions} with instruction files, ${report.totals.files} files, ~${fmt(report.totals.tokens)} tokens total, ${report.totals.findings} findings`,
  );
  out.push(
    `${report.totals.blocks} managed blocks (${report.totals.modifiedBlocks} modified, ${report.totals.malformedMarkers} malformed markers), ${report.totals.skills} skills (${report.totals.skillIssues} issues)`,
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

  if (report.distribution) {
    out.push(...renderDistribution(report.distribution));
    out.push("");
  }

  return out.join("\n");
}

function renderDistribution(distribution: PackDistribution): string[] {
  const lines: string[] = [];
  lines.push(
    `Pack distribution (packs from ${distribution.root}, ${distribution.packs.length} packs)`,
  );
  for (const warning of distribution.warnings) lines.push(`      ! ${warning}`);

  for (const pack of distribution.packs) {
    const block = pack.files.find((f) => f.kind === "agents-block");
    const managedFiles = pack.files.filter((f) => f.kind === "file").length;
    const parts = [
      pack.rev ? `rev ${pack.rev.slice(0, 7)}` : "rev unknown",
      block ? "AGENTS.md block" : "no AGENTS.md block",
      `${managedFiles} managed files`,
      `${pack.subscribers.length} subscribed`,
    ];
    lines.push(`  ${pad(pack.id, 22)} ${parts.join(", ")}`);

    const entries = distribution.entries.filter((e) => e.pack === pack.id);
    const counts = (Object.keys(STATUS_LABEL) as PackStatus[])
      .map((status) => [status, entries.filter((e) => e.status === status).length] as const)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${STATUS_LABEL[status]} ${count}`);
    lines.push(`      ${counts.join(", ")}`);

    for (const entry of entries) {
      const where =
        entry.file === null ? "" : entry.line === null ? entry.file : `${entry.file}:${entry.line}`;
      const message = entry.message ? `  ${entry.message}` : "";
      lines.push(
        `      ${pad(entry.repo, 44)} ${pad(STATUS_LABEL[entry.status], 15)} ${where}${message}`.trimEnd(),
      );
    }

    for (const copy of distribution.personalCopies.filter((c) => c.pack === pack.id)) {
      lines.push(`      ! ${describePersonalCopy(copy)}`);
    }
  }
  return lines;
}

/**
 * D13: the personal layer still carries the pack. Name where, and how many repositories now load
 * it twice, so the interim wiring is removed once the block covers the daily repositories.
 */
export function describePersonalCopy(copy: PersonalPackCopy): string {
  const state =
    copy.state === "current"
      ? "equals the pack body"
      : "is the pack source but differs from the pack as loaded (checkout behind or ahead)";
  const count = copy.doubleLoaded.length;
  const twice =
    count === 0
      ? "no scanned repository carries the block yet"
      : `${copy.state === "current" ? "loads twice" : "loads a second, divergent copy"} in ${count} ${plural(count, "repository", "repositories")} carrying the block (${copy.doubleLoaded.join(", ")})`;
  return `personal layer ${copy.file} ${state}; ${twice}. Remove the personal copy once the block covers the repositories used daily`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
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
  for (const issue of repo.blockIssues) {
    if (issue.kind !== "malformed-marker") continue;
    lines.push(`      ! ${issue.file}:${issue.line}  ${issue.message}`);
  }
  for (const issue of repo.skills.issues) {
    lines.push(`      ! ${issue.file}:${issue.line}  ${issue.message}`);
  }

  for (const file of repo.files) lines.push(renderFile(file));
  for (const block of repo.blocks) {
    const rev = block.rev ? ` rev ${block.rev.slice(0, 7)}` : "";
    const state = block.modified ? "  MODIFIED" : "";
    lines.push(
      `      ${pad(`${block.file}:${block.line}-${block.endLine}`, 52)} block ${block.source}${rev}${state}`,
    );
  }
  for (const region of repo.foreignRegions) {
    lines.push(
      `      ${pad(`${region.file}:${region.line}-${region.endLine}`, 52)} region ${region.name} (another tool; left untouched)`,
    );
  }
  for (const skill of repo.skills.skills) {
    const lock = skill.lockState === null ? "" : `  [${LOCK_STATE_LABEL[skill.lockState]}]`;
    const links =
      skill.links.length > 0
        ? `  (also ${skill.links.map((l) => l.split("/")[0] ?? l).join(", ")})`
        : "";
    lines.push(
      `      ${pad(skill.relativePath, 52)} skill ${String(skill.files).padStart(3)} files${lock}${links}`,
    );
  }
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
    "      Cursor loads ~/AGENTS.md and ~/.cursor/rules/*.mdc for workspaces under home (ancestor walk, undocumented). User Rules live in the Cursor account, not on disk, and have no headless write path: they are not measured, and a pack is distributed through its block, not through a User Rule copy (D13).",
  );
  return lines;
}

export function describeScope(file: RepoReport["files"][number]): string {
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

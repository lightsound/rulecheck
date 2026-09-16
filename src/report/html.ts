import type {
  CanonicalShape,
  InstructionFile,
  PackDistribution,
  PackStatus,
  PersonalLayer,
  RepoReport,
  ScanReport,
} from "../domain/types.ts";
import type { SyncAllResult } from "../sync/all.ts";
import {
  LOCK_STATE_LABEL,
  OUTCOME_LABEL,
  OUTCOME_ORDER,
  SHAPE_LABEL,
  STATUS_LABEL,
  type SyncOutcomeKind,
  UNMEASURED,
} from "./labels.ts";
import { describePersonalCopy, describeScope, SHAPE_NOTE } from "./render.ts";
import { describeOutcome } from "./sync.ts";

/**
 * A single self-contained HTML file of the same `ScanReport` (or `SyncAllResult`) the text
 * report prints: inline CSS, no external assets, no script. Meant to be opened in a browser or
 * printed by someone who does not run the CLI. Labels come from `labels.ts`, so every word here
 * is one `docs/status-model.md` defines; nothing is detected or computed that the report does
 * not already carry.
 */

export interface HtmlOptions {
  /** rulecheck's own version, printed in the footer. */
  readonly version: string;
  /** Include repositories that have no instruction files (as `--all` does for the text report). */
  readonly all?: boolean;
}

export const GLOSSARY_URL =
  "https://github.com/lightsound/rulecheck/blob/main/docs/status-model.md";

export function renderHtml(report: ScanReport, options: HtmlOptions): string {
  const repos = options.all
    ? report.repos
    : report.repos.filter((r) => r.files.length > 0 || r.skills.skills.length > 0);

  const sections: string[] = [];
  sections.push(headline(report));
  if (report.distribution) sections.push(distribution(report.distribution, report.repos));
  sections.push(repoCards(repos, report.repos.length));
  if (report.duplicates.length > 0) sections.push(duplicates(report));
  if (report.personal) sections.push(personalLayer(report.personal));

  return document({
    title: `rulecheck scan of ${report.root}`,
    subtitle: `${report.totals.repos} repositories under <code>${esc(report.root)}</code>, scanned ${esc(report.scannedAt)}`,
    body: sections.join("\n"),
    version: options.version,
    generatedAt: report.scannedAt,
  });
}

/** The `sync --all --dry-run` table (the remote distribution report, D14) as a page. */
export function renderSyncAllHtml(
  result: SyncAllResult,
  options: HtmlOptions & { readonly generatedAt: string },
): string {
  const counts = OUTCOME_ORDER.map(
    (kind) => [kind, result.rows.filter((row) => row.outcome.kind === kind).length] as const,
  ).filter(([, count]) => count > 0);

  const chips = counts
    .map(([kind, count]) => chip(`${count} ${OUTCOME_LABEL[kind]}`, `outcome-${kind}`))
    .join(" ");

  const rows = result.rows
    .map((row) => {
      const status = row.outcome.status;
      const statusCell =
        status === null ? `<span class="muted">${UNMEASURED}</span>` : statusChip(status.status);
      const [first, ...rest] = describeOutcome(row.outcome).split("\n");
      const detail = rest.length > 0 ? `<div class="detail">${esc(rest.join("\n"))}</div>` : "";
      return `<tr><td class="mono">${esc(row.target.repo)}</td><td class="mono">${esc(row.target.pack)}</td><td>${statusCell}</td><td>${outcomeChip(row.outcome.kind)} ${esc(first ?? "")}${detail}</td></tr>`;
    })
    .join("\n");

  const body = `
<section>
  <h2>Headline</h2>
  <div class="cards">
    ${stat("Targets", String(result.rows.length), `from ${esc(result.source)}`)}
    ${stat("Mode", result.dryRun ? "dry run" : "live", result.dryRun ? "measured, nothing written" : "pull requests opened or updated")}
    ${stat("Failed", String(result.failed), "targets GitHub could not answer for")}
  </div>
  <p class="chips">${chips || '<span class="muted">no targets</span>'}</p>
</section>
<section>
  <h2>Targets</h2>
  <p class="note">Status is the pack status measured on each repository's default branch; the outcome is what the sync did about it. <code>${UNMEASURED}</code> means the target was never measured.</p>
  <table>
    <thead><tr><th>repository</th><th>pack</th><th>status</th><th>outcome</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</section>`;

  return document({
    title: `rulecheck sync${result.dryRun ? " (dry run)" : ""}: ${result.rows.length} targets`,
    subtitle: `packs from <code>${esc(result.source)}</code>${result.dryRun ? ", nothing written" : ""}`,
    body,
    version: options.version,
    generatedAt: options.generatedAt,
  });
}

// ---------------------------------------------------------------------------------------------
// Sections of the scan page

function headline(report: ScanReport): string {
  const t = report.totals;
  const cursor = report.repos.reduce((sum, r) => sum + r.budget.cursor, 0);
  const claude = report.repos.reduce((sum, r) => sum + r.budget.claudeCode, 0);
  const personal = report.personal
    ? `personal layer adds ~${fmt(report.personal.cursorTokens)} / ~${fmt(report.personal.claudeCodeTokens)} to every session`
    : "personal layer not scanned";

  const cards = [
    stat("Repositories", fmt(t.repos), `${fmt(t.reposWithInstructions)} with instruction files`),
    stat("Instruction files", fmt(t.files), `~${fmt(t.tokens)} tokens in total`),
    stat(
      "Tokens loaded per tool",
      `Cursor ~${fmt(cursor)}<br>Claude Code ~${fmt(claude)}`,
      `sum of every repository's root budget; ${personal}`,
    ),
    stat(
      "Findings",
      fmt(t.findings),
      `${fmt(t.blocks)} managed blocks (${fmt(t.modifiedBlocks)} modified, ${fmt(t.malformedMarkers)} malformed markers), ${fmt(t.skills)} skills (${fmt(t.skillIssues)} issues)`,
      t.findings > 0 ? "attention" : "",
    ),
  ];

  const shapes = (Object.keys(SHAPE_LABEL) as CanonicalShape[])
    .filter((shape) => t.shapes[shape] > 0)
    .map((shape) => `${shapeChip(shape)} <b>${fmt(t.shapes[shape])}</b>`)
    .join(" ");

  const dist = report.distribution
    ? (Object.keys(STATUS_LABEL) as PackStatus[])
        .map(
          (status) =>
            `${statusChip(status)} <b>${fmt(report.distribution?.counts[status] ?? 0)}</b>`,
        )
        .join(" ")
    : '<span class="muted">no pack repository given (<code>--packs</code>); distribution status not measured</span>';

  return `
<section>
  <h2>Headline</h2>
  <div class="cards">
    ${cards.join("\n    ")}
  </div>
  <dl class="kv">
    <dt>Shapes</dt><dd class="chips">${shapes}</dd>
    <dt>Pack distribution</dt><dd class="chips">${dist}</dd>
  </dl>
</section>`;
}

/** Repo × pack matrix: one row per repository, one column per pack, status and action per cell. */
function distribution(dist: PackDistribution, allRepos: ReadonlyArray<RepoReport>): string {
  const packHeaders = dist.packs
    .map((pack) => {
      const block = pack.files.find((f) => f.kind === "agents-block");
      const managedFiles = pack.files.filter((f) => f.kind === "file").length;
      const meta = [
        pack.rev ? `rev ${pack.rev.slice(0, 7)}` : "rev unknown",
        block ? "AGENTS.md block" : "no AGENTS.md block",
        `${managedFiles} managed files`,
        `${pack.subscribers.length} subscribed`,
      ].join(", ");
      const counts = (Object.keys(STATUS_LABEL) as PackStatus[])
        .map(
          (status) =>
            [
              status,
              dist.entries.filter((e) => e.pack === pack.id && e.status === status).length,
            ] as const,
        )
        .filter(([, count]) => count > 0)
        .map(([status, count]) => `${statusChip(status)} ${count}`)
        .join(" ");
      return `<th><div class="mono">${esc(pack.id)}</div><div class="meta">${esc(meta)}</div><div class="chips">${counts}</div></th>`;
    })
    .join("");

  const repoNames = [
    ...new Set([...allRepos.map((r) => r.name), ...dist.entries.map((e) => e.repo)]),
  ].filter((name) => dist.entries.some((e) => e.repo === name));

  const rows = repoNames
    .map((name) => {
      const cells = dist.packs
        .map((pack) => {
          const entry = dist.entries.find((e) => e.repo === name && e.pack === pack.id);
          if (!entry) return `<td class="muted">${UNMEASURED}</td>`;
          const where =
            entry.file === null
              ? ""
              : `<span class="mono">${esc(entry.line === null ? entry.file : `${entry.file}:${entry.line}`)}</span>`;
          const message = entry.message ? esc(entry.message) : "";
          const action = [where, message].filter((s) => s.length > 0).join(" ");
          return `<td>${statusChip(entry.status)}${action ? `<div class="detail">${action}</div>` : ""}</td>`;
        })
        .join("");
      const quiet = dist.packs.every(
        (pack) =>
          dist.entries.find((e) => e.repo === name && e.pack === pack.id)?.status ===
          "not-subscribed",
      );
      return `<tr${quiet ? ' class="quiet"' : ""}><td class="mono">${esc(name)}</td>${cells}</tr>`;
    })
    .join("\n");

  const warnings = [
    ...dist.warnings.map((w) => `<li class="warn">${esc(w)}</li>`),
    ...dist.personalCopies.map(
      (copy) => `<li class="warn">${esc(describePersonalCopy(copy))}</li>`,
    ),
  ];

  return `
<section>
  <h2>Pack distribution</h2>
  <p class="note">Packs from <code>${esc(dist.root)}</code>, ${dist.packs.length} ${dist.packs.length === 1 ? "pack" : "packs"}. Status per repository per pack as measured on the local checkout under the scanned directory; the default-branch status on GitHub comes from <code>sync --all --dry-run</code>. Words are defined in the <a href="${GLOSSARY_URL}">glossary</a>.</p>
  ${warnings.length > 0 ? `<ul class="issues">${warnings.join("")}</ul>` : ""}
  <table class="matrix">
    <thead><tr><th>repository</th>${packHeaders}</tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</section>`;
}

function repoCards(repos: ReadonlyArray<RepoReport>, total: number): string {
  const hidden = total - repos.length;
  const cards = repos.map(repoCard).join("\n");
  return `
<section>
  <h2>Repositories</h2>
  <p class="note">${repos.length} shown${hidden > 0 ? `, ${hidden} without instruction files hidden (<code>--all</code> includes them)` : ""}. Click a header to collapse a card.</p>
  ${cards}
</section>`;
}

function repoCard(repo: RepoReport): string {
  const issues: string[] = [];
  const note = SHAPE_NOTE[repo.shape];
  if (note) issues.push(`<li class="info">${esc(note)}</li>`);
  const proseWrapper = repo.files.find(
    (f) =>
      f.kind === "claude-md" &&
      f.depth === 0 &&
      f.wrapperTarget === "AGENTS.md" &&
      !f.wrapperUsesImport,
  );
  if (proseWrapper) {
    issues.push(
      `<li class="info">${esc(proseWrapper.relativePath)} points at AGENTS.md in prose; use <code>@AGENTS.md</code> so Claude Code loads it automatically</li>`,
    );
  }
  for (const finding of repo.findings) {
    issues.push(
      `<li class="warn"><span class="mono">${esc(`${finding.file}:${finding.line}`)}</span> ${esc(finding.message)}</li>`,
    );
  }
  for (const issue of repo.blockIssues) {
    if (issue.kind !== "malformed-marker") continue;
    issues.push(
      `<li class="warn"><span class="mono">${esc(`${issue.file}:${issue.line}`)}</span> ${esc(issue.message)}</li>`,
    );
  }
  for (const issue of repo.skills.issues) {
    issues.push(
      `<li class="warn"><span class="mono">${esc(`${issue.file}:${issue.line}`)}</span> ${esc(issue.message)}</li>`,
    );
  }

  const files =
    repo.files.length > 0
      ? `<table class="files">
      <thead><tr><th>file</th><th>scope</th><th class="num">lines</th><th class="num">tokens</th></tr></thead>
      <tbody>${repo.files.map(fileRow).join("")}</tbody>
    </table>`
      : '<p class="muted">no instruction files</p>';

  const blocks = [
    ...repo.blocks.map((block) => {
      const rev = block.rev ? ` rev ${block.rev.slice(0, 7)}` : "";
      return `<li><span class="mono">${esc(`${block.file}:${block.line}-${block.endLine}`)}</span> block <code>${esc(block.source)}</code>${esc(rev)}${block.modified ? ' <span class="tag tag-modified">MODIFIED</span>' : ""}</li>`;
    }),
    ...repo.foreignRegions.map(
      (region) =>
        `<li><span class="mono">${esc(`${region.file}:${region.line}-${region.endLine}`)}</span> region <code>${esc(region.name)}</code> (another tool; left untouched)</li>`,
    ),
  ];

  const skills =
    repo.skills.skills.length > 0
      ? `<h4>Skills</h4>
    <table class="files">
      <thead><tr><th>skill</th><th class="num">files</th><th>lock</th><th>also linked from</th></tr></thead>
      <tbody>${repo.skills.skills
        .map(
          (skill) =>
            `<tr><td class="mono">${esc(skill.relativePath)}</td><td class="num">${skill.files}</td><td>${skill.lockState === null ? '<span class="muted">no skills-lock.json</span>' : esc(LOCK_STATE_LABEL[skill.lockState])}</td><td>${esc(skill.links.map((l) => l.split("/")[0] ?? l).join(", "))}</td></tr>`,
        )
        .join("")}</tbody>
    </table>`
      : "";

  const count = repo.findings.length + repo.skills.issues.length;
  return `
<details class="repo" open>
  <summary>
    <span class="mono name">${esc(repo.name)}</span>
    ${shapeChip(repo.shape)}
    <span class="budget">Cursor ~${fmt(repo.budget.cursor)} · Claude Code ~${fmt(repo.budget.claudeCode)}</span>
    ${count > 0 ? `<span class="tag tag-attention">${count} ${count === 1 ? "finding" : "findings"}</span>` : ""}
  </summary>
  <div class="card-body">
    ${issues.length > 0 ? `<ul class="issues">${issues.join("")}</ul>` : ""}
    ${files}
    ${blocks.length > 0 ? `<ul class="plain">${blocks.join("")}</ul>` : ""}
    ${skills}
  </div>
</details>`;
}

function fileRow(file: InstructionFile): string {
  const marker = file.wrapperTarget
    ? `→ ${file.wrapperTarget}${file.wrapperUsesImport ? "" : " (prose)"}`
    : "";
  const scope = [
    describeScope(file)
      .trim()
      .replace(/^\[|\]$/g, ""),
    marker,
  ]
    .filter((s) => s.length > 0)
    .join(" ");
  return `<tr><td class="mono">${esc(file.relativePath)}</td><td class="muted">${esc(scope)}</td><td class="num">${fmt(file.lines)}</td><td class="num">${fmt(file.tokens)}</td></tr>`;
}

function duplicates(report: ScanReport): string {
  const groups = report.duplicates
    .map(
      (group) =>
        `<li><b>${group.members.length}×</b> ${group.lines} lines, ~${fmt(group.tokens)} tokens<ul class="plain">${group.members
          .map((m) => `<li class="mono">${esc(`${m.repo}/${m.relativePath}`)}</li>`)
          .join("")}</ul></li>`,
    )
    .join("");
  return `
<section>
  <h2>Duplicates</h2>
  <p class="note">${report.duplicates.length} ${report.duplicates.length === 1 ? "group" : "groups"} of identical content across repositories.</p>
  <ul class="plain">${groups}</ul>
</section>`;
}

function personalLayer(personal: PersonalLayer): string {
  const files =
    personal.files.length > 0
      ? `<table class="files">
    <thead><tr><th>file</th><th>scope</th><th class="num">lines</th><th class="num">tokens</th></tr></thead>
    <tbody>${personal.files.map(fileRow).join("")}</tbody>
  </table>`
      : '<p class="muted">no ~/.claude/CLAUDE.md, ~/.claude/rules, ~/AGENTS.md, or ~/.cursor/rules</p>';
  return `
<section>
  <h2>Personal layer</h2>
  <p class="note">Home <code>${esc(personal.home)}</code>; added to every session on this machine. Cursor ~${fmt(personal.cursorTokens)} · Claude Code ~${fmt(personal.claudeCodeTokens)} tokens.</p>
  ${files}
  ${personal.managedPolicyPath ? `<p class="warn">managed policy present at <code>${esc(personal.managedPolicyPath)}</code> (cannot be excluded)</p>` : ""}
  <p class="note">Cursor loads <code>~/AGENTS.md</code> and <code>~/.cursor/rules/*.mdc</code> for workspaces under home (ancestor walk, undocumented). User Rules live in the Cursor account, not on disk, and have no headless write path: they are not measured, and a pack is distributed through its block, not through a User Rule copy (D13).</p>
</section>`;
}

// ---------------------------------------------------------------------------------------------
// Building blocks

function stat(label: string, value: string, sub: string, extraClass = ""): string {
  return `<div class="stat ${extraClass}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

function chip(text: string, cls: string): string {
  return `<span class="chip ${cls}">${esc(text)}</span>`;
}

function statusChip(status: PackStatus): string {
  return chip(STATUS_LABEL[status], `status-${status}`);
}

function shapeChip(shape: CanonicalShape): string {
  return chip(SHAPE_LABEL[shape], `shape-${shape}`);
}

function outcomeChip(kind: SyncOutcomeKind): string {
  return chip(OUTCOME_LABEL[kind], `outcome-${kind}`);
}

interface Document {
  readonly title: string;
  /** Already-escaped HTML. */
  readonly subtitle: string;
  /** Already-escaped HTML. */
  readonly body: string;
  readonly version: string;
  readonly generatedAt: string;
}

function document(doc: Document): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(doc.title)}</title>
<style>
${CSS}
</style>
</head>
<body>
<header>
  <h1>${esc(doc.title)}</h1>
  <p class="subtitle">${doc.subtitle}</p>
</header>
<main>
${doc.body}
</main>
<footer>
  rulecheck v${esc(doc.version)} · generated ${esc(doc.generatedAt)} · <a href="${GLOSSARY_URL}">status-model glossary</a>
</footer>
</body>
</html>
`;
}

export function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --card: #f6f8fa; --link: #0969da;
  --c-current: #1a7f37; --c-outdated: #9a6700; --c-modified: #8250df; --c-eligible: #0969da;
  --c-blocked: #cf222e; --c-not-subscribed: #656d76; --c-attention: #cf222e; --c-info: #0969da;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --line: #30363d; --card: #161b22; --link: #58a6ff;
    --c-current: #3fb950; --c-outdated: #d29922; --c-modified: #a371f7; --c-eligible: #58a6ff;
    --c-blocked: #f85149; --c-not-subscribed: #8b949e; --c-attention: #f85149; --c-info: #58a6ff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
header, main, footer { max-width: 1100px; margin: 0 auto; padding: 0 24px; }
header { padding-top: 32px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 32px 0 8px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
h4 { font-size: 13px; margin: 16px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
a { color: var(--link); }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
code { background: var(--card); padding: 1px 4px; border-radius: 4px; }
.subtitle, .note, .muted, .meta, .sub, .detail { color: var(--muted); }
.note { margin: 4px 0 12px; }
.detail { font-size: 12.5px; margin-top: 2px; white-space: pre-wrap; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 12px 0; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.stat .label { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.stat .value { font-size: 24px; font-weight: 600; line-height: 1.2; margin: 4px 0; }
.stat .sub { font-size: 12px; }
.stat.attention .value { color: var(--c-attention); }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 8px 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; }
.chips > * { margin-right: 6px; }
.chip { display: inline-block; padding: 0 8px; border-radius: 999px; border: 1px solid var(--c, var(--line)); color: var(--c, var(--fg)); background: color-mix(in srgb, var(--c, var(--line)) 12%, transparent); font-size: 12px; line-height: 20px; white-space: nowrap; }
.status-current { --c: var(--c-current); }
.status-outdated { --c: var(--c-outdated); }
.status-modified { --c: var(--c-modified); }
.status-eligible { --c: var(--c-eligible); }
.status-blocked { --c: var(--c-blocked); }
.status-not-subscribed { --c: var(--c-not-subscribed); }
.outcome-nothing-to-do, .outcome-up-to-date { --c: var(--c-current); }
.outcome-planned { --c: var(--c-eligible); }
.outcome-opened, .outcome-updated { --c: var(--c-eligible); }
.outcome-refused { --c: var(--c-outdated); }
.outcome-failed { --c: var(--c-blocked); }
.shape-agents-canonical, .shape-agents-imported { --c: var(--c-current); }
.shape-agents-only, .shape-claude-only, .shape-claude-canonical { --c: var(--c-outdated); }
.shape-both-full { --c: var(--c-blocked); }
.shape-none { --c: var(--c-not-subscribed); }
.tag { display: inline-block; font-size: 11px; font-weight: 600; padding: 0 6px; border-radius: 4px; line-height: 18px; }
.tag-modified { background: var(--c-modified); color: #fff; }
.tag-attention { background: var(--c-attention); color: #fff; }
table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { font-size: 12px; color: var(--muted); font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.quiet { opacity: .6; }
.matrix th .meta { font-weight: 400; font-size: 11.5px; margin: 2px 0; }
.matrix td:first-child { white-space: nowrap; }
.issues { list-style: none; padding: 0; margin: 8px 0; }
.issues li { padding: 6px 10px; margin: 4px 0; border-left: 3px solid var(--c, var(--line)); background: var(--card); border-radius: 0 6px 6px 0; }
.issues li.warn { --c: var(--c-attention); }
.issues li.info { --c: var(--c-info); }
p.warn { color: var(--c-attention); }
.plain { list-style: none; padding-left: 0; margin: 6px 0; }
.plain li { padding: 2px 0; }
.plain ul { padding-left: 16px; }
details.repo { border: 1px solid var(--line); border-radius: 8px; margin: 10px 0; background: var(--bg); }
details.repo summary { cursor: pointer; padding: 10px 14px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; list-style: none; }
details.repo summary::-webkit-details-marker { display: none; }
details.repo summary::before { content: "▸"; color: var(--muted); }
details.repo[open] summary::before { content: "▾"; }
details.repo summary .name { font-weight: 600; font-size: 14px; }
details.repo summary .budget { color: var(--muted); margin-left: auto; font-size: 12.5px; }
.card-body { padding: 0 14px 12px; border-top: 1px solid var(--line); }
footer { margin: 40px auto 32px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12.5px; }
@media print {
  body { font-size: 11px; }
  header, main, footer { max-width: none; padding: 0; }
  details.repo { break-inside: avoid; }
  .stat, .chip, .issues li { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  a { color: inherit; text-decoration: none; }
  footer a::after { content: " (" attr(href) ")"; }
}
`;

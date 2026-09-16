import { classifyIfSubscribed, STATUS_ORDER } from "../domain/pack.ts";
import type {
  CanonicalShape,
  InstructionFile,
  PackDistribution,
  PackStatus,
  PackStatusEntry,
  PersonalLayer,
  RepoReport,
  ScanReport,
  SkillLockState,
} from "../domain/types.ts";
import type { SyncAllResult } from "../sync/all.ts";
import {
  LOCK_STATE_LABEL,
  NESTED_KIND_LABEL,
  OUTCOME_LABEL,
  OUTCOME_ORDER,
  SHAPE_LABEL,
  STATUS_ACTION,
  STATUS_LABEL,
  type SyncOutcomeKind,
  UNMEASURED,
} from "./labels.ts";
import {
  describeExcludedNested,
  describePersonalCopy,
  describeScope,
  SHAPE_NOTE,
} from "./render.ts";
import { outcomeDetail } from "./sync.ts";

/**
 * A single self-contained HTML file of the same `ScanReport` (or `SyncAllResult`) the text
 * report prints: inline CSS, no external assets, no script. Meant to be opened in a browser or
 * printed by someone who does not run the CLI. Labels come from `labels.ts`, so every word here
 * is one `docs/status-model.md` defines; nothing is detected here that the report does not
 * already carry (the one classification the page adds, what a sync would do to a
 * `not-subscribed` repository, is the domain classifier with the subscription assumed).
 *
 * Layout (D20, D21): each section answers one question, in reading order. Overview: how big is
 * the estate and how healthy (at most five cards, one number each). Next actions: what must a
 * human or a sync do, most urgent first. Pack distribution: where each pack stands, one line per
 * pack and a repo × pack matrix of the subscribed repositories, grouped by owner; repositories
 * subscribed to no pack sit in a closed candidate list. Repositories: what each one loads and
 * where its issues are, grouped by owner under sticky headers, one collapsed row per repository
 * that opens only when it has an issue. Every repository of the report has a row, including
 * those without instruction files (a closed one-line row costs nothing), so every repository
 * name printed anywhere on the page links to one place (D22). Design tokens follow GitHub Primer
 * (D21). Print gets what is open.
 */

export interface HtmlOptions {
  /** rulecheck's own version, printed in the footer. */
  readonly version: string;
}

export const GLOSSARY_URL =
  "https://github.com/lightsound/rulecheck/blob/main/docs/status-model.md";

export function renderHtml(report: ScanReport, options: HtmlOptions): string {
  const sections: string[] = [];
  sections.push(overview(report));
  sections.push(nextActions(report));
  if (report.distribution) {
    sections.push(distribution(report.distribution, report.repos));
  }
  sections.push(repoCards(report.repos, report.totals.shapes));
  if (report.duplicates.length > 0) sections.push(duplicates(report));
  if (report.personal) sections.push(personalLayer(report.personal));

  return document({
    title: "rulecheck scan",
    subtitle: `<code>${esc(report.root)}</code> · ${fmt(report.totals.repos)} ${plural(report.totals.repos, "repository", "repositories")} · scanned ${esc(report.scannedAt)}`,
    body: sections.join("\n"),
    version: options.version,
    generatedAt: report.scannedAt,
    footnote:
      report.excludedNested.length > 0
        ? `${esc(describeExcludedNested(report.excludedNested))}: ${report.excludedNested.map((n) => `<span class="mono">${esc(n.name)}</span> (${esc(NESTED_KIND_LABEL[n.kind])} in <span class="mono">${esc(n.parent)}</span>)`).join(", ")}`
        : null,
  });
}

/** The `sync --all --dry-run` table (the remote distribution report, D14) as a page. */
export function renderSyncAllHtml(
  result: SyncAllResult,
  options: HtmlOptions & { readonly generatedAt: string },
): string {
  const count = (kind: SyncOutcomeKind): number =>
    result.rows.filter((row) => row.outcome.kind === kind).length;
  const counts = OUTCOME_ORDER.map((kind) => [kind, count(kind)] as const).filter(([, n]) => n > 0);
  const writes = count("planned") + count("opened") + count("updated");
  const quiet = count("nothing-to-do") + count("up-to-date");

  const cards = [
    stat("Targets", fmt(result.rows.length), `from <code>${esc(result.source)}</code>`),
    stat(
      result.dryRun ? "Planned" : "Written",
      fmt(writes),
      result.dryRun
        ? "pull requests a live run would open or update"
        : "pull requests opened or updated",
    ),
    stat(
      "Refused",
      fmt(count("refused")),
      "a human must look first",
      count("refused") > 0 ? "attention" : "",
    ),
    stat(
      "Failed",
      fmt(result.failed),
      "GitHub could not answer",
      result.failed > 0 ? "danger" : "",
    ),
    stat("Quiet", fmt(quiet), "nothing to do or up to date"),
  ];

  const rows = result.rows
    .map((row) => {
      const status = row.outcome.status;
      const statusCell =
        status === null ? `<span class="muted">${UNMEASURED}</span>` : statusChip(status.status);
      const [first, ...rest] = outcomeDetail(row.outcome).split("\n");
      const detail = rest.length > 0 ? `<div class="detail">${esc(rest.join("\n"))}</div>` : "";
      return `<tr><td class="mono">${esc(row.target.repo)}</td><td class="mono">${esc(row.target.pack)}</td><td>${statusCell}</td><td>${outcomeChip(row.outcome.kind)} ${esc(first ?? "")}${detail}</td></tr>`;
    })
    .join("\n");

  const body = `
<section id="overview">
  <h2>Overview</h2>
  <div class="cards">
    ${cards.join("\n    ")}
  </div>
  <p class="meta">${counts.map(([kind, n]) => `${dot(`outcome-${kind}`)} ${fmt(n)} ${OUTCOME_LABEL[kind]}`).join(" · ") || "no targets"}${result.dryRun ? " · dry run, nothing written" : ""}</p>
</section>
<section id="targets">
  <h2>Targets</h2>
  <p class="note">Status is the pack status measured on each repository's default branch; the outcome is what the sync did about it. <code>${UNMEASURED}</code> means the target was never measured.</p>
  <table>
    <thead><tr><th>Repository</th><th>Pack</th><th>Status</th><th>Outcome</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</section>`;

  return document({
    title: `rulecheck sync${result.dryRun ? " (dry run)" : ""}`,
    subtitle: `${fmt(result.rows.length)} ${plural(result.rows.length, "target", "targets")} · packs from <code>${esc(result.source)}</code>${result.dryRun ? " · nothing written" : ""}`,
    body,
    version: options.version,
    generatedAt: options.generatedAt,
  });
}

// ---------------------------------------------------------------------------------------------
// Sections of the scan page

/** Entries with a status that asks for an action, most urgent first, then by repository. */
function actionable(dist: PackDistribution): PackStatusEntry[] {
  return dist.entries
    .filter((e) => STATUS_ACTION[e.status] !== null)
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        a.repo.localeCompare(b.repo) ||
        a.pack.localeCompare(b.pack),
    );
}

function overview(report: ScanReport): string {
  const t = report.totals;
  const cursor = report.repos.reduce((sum, r) => sum + r.budget.cursor, 0);
  const claude = report.repos.reduce((sum, r) => sum + r.budget.claudeCode, 0);
  const issues = t.findings + t.malformedMarkers + t.skillIssues;
  const dist = report.distribution;

  const cards = [
    stat("Repositories", fmt(t.repos), `${fmt(t.reposWithInstructions)} with instruction files`),
  ];
  if (dist) {
    const todo = actionable(dist);
    // The card counts repositories, so the breakdown does too: each repository once, under its
    // most urgent status against any pack (`actionable` is worst first, so the first entry wins).
    const worst = new Map<string, PackStatus>();
    for (const e of todo) if (!worst.has(e.repo)) worst.set(e.repo, e.status);
    const repos = worst.size;
    const breakdown = STATUS_ORDER.map(
      (status) => [status, [...worst.values()].filter((s) => s === status).length] as const,
    )
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${fmt(count)} ${STATUS_LABEL[status]}`)
      .join(" · ");
    // Every entry that is not `not-subscribed`: the repository carries the pack's block or is
    // subscribed (`classifyPackStatus` decides by the block first, then by the subscription).
    const measured = dist.entries.filter((e) => e.status !== "not-subscribed").length;
    cards.push(
      stat(
        "Action needed",
        fmt(repos),
        repos > 0
          ? `${plural(repos, "repository", "repositories")} by worst status · ${breakdown}`
          : "every block is current",
        repos > 0 ? "danger" : "success",
      ),
      stat(
        "Current",
        fmt(dist.counts.current),
        `of ${fmt(measured)} with a block or a subscription`,
      ),
    );
  }
  cards.push(
    stat(
      "Issues",
      fmt(issues),
      `${fmt(t.findings)} ${plural(t.findings, "finding", "findings")} · ${fmt(t.malformedMarkers)} malformed ${plural(t.malformedMarkers, "marker", "markers")} · ${fmt(t.skillIssues)} skill ${plural(t.skillIssues, "issue", "issues")}`,
      issues > 0 ? "danger" : "",
    ),
    stat("Instruction files", fmt(t.files), `~${fmt(t.tokens)} tokens in total`),
  );

  const heaviest = report.repos.reduce<RepoReport | null>(
    (best, r) => (best === null || weight(r) > weight(best) ? r : best),
    null,
  );
  const meta = [
    `Root budgets summed over every repository: Cursor ~${fmt(cursor)} · Claude Code ~${fmt(claude)} tokens (no single session loads this much).`,
    heaviest && weight(heaviest) > 0
      ? `Heaviest repository <span class="mono">${esc(heaviest.name)}</span>: Cursor ~${fmt(heaviest.budget.cursor)} · Claude Code ~${fmt(heaviest.budget.claudeCode)}.`
      : "",
    report.personal
      ? `The personal layer adds ~${fmt(report.personal.cursorTokens)} / ~${fmt(report.personal.claudeCodeTokens)} to every session.`
      : "The personal layer was not scanned.",
    dist
      ? ""
      : "No pack repository given (<code>--packs</code>): distribution status not measured.",
  ]
    .filter((s) => s.length > 0)
    .join(" ");

  return `
<section id="overview">
  <h2>Overview</h2>
  <div class="cards">
    ${cards.join("\n    ")}
  </div>
  <p class="meta">${meta}</p>
</section>`;
}

function weight(repo: RepoReport): number {
  return Math.max(repo.budget.cursor, repo.budget.claudeCode);
}

/**
 * What to do next: one row per repository × pack whose status asks a human or a sync to act,
 * most urgent first (`STATUS_ORDER`), with the file the status refers to and the action
 * (`STATUS_ACTION` completed by the status message); then one row per repository with issues.
 */
function nextActions(report: ScanReport): string {
  const dist = report.distribution;
  const todo = dist ? actionable(dist) : [];
  const withIssues = [...report.repos]
    .filter((r) => issueCount(r) > 0)
    .sort((a, b) => issueCount(b) - issueCount(a) || a.name.localeCompare(b.name));

  const parts: string[] = [];
  if (todo.length > 0) {
    const rows = todo
      .map(
        (e) =>
          `<tr><td>${statusChip(e.status)}</td><td class="mono">${repoName(e.repo)}</td><td class="mono">${esc(e.pack)}</td><td>${action(e)}</td></tr>`,
      )
      .join("\n");
    parts.push(`<table class="actions">
    <thead><tr><th>Status</th><th>Repository</th><th>Pack</th><th>Action</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>`);
  }
  if (withIssues.length > 0) {
    const rows = withIssues
      .map((r) => {
        const n = issueCount(r);
        return `<tr><td><span class="mono">${repoName(r.name)}</span><div class="detail">${fmt(n)} ${plural(n, "issue", "issues")}</div></td><td class="lines">${issueLines(r).join("<br>")}</td></tr>`;
      })
      .join("\n");
    parts.push(`<h3>Issues to fix</h3>
  <table class="actions issues-table">
    <thead><tr><th>Repository</th><th>What</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>`);
  }

  const note =
    parts.length === 0
      ? `<p class="empty">Nothing to do${dist ? ": every block is current and no repository has an issue" : ": no repository has an issue (distribution status not measured, no <code>--packs</code> given)"}.</p>`
      : `<p class="note">Most urgent first. A <em>sync</em> action is what <code>rulecheck sync</code> does as a pull request; a <em>by hand</em> action needs a human before any sync.${dist ? "" : " Distribution status not measured (no <code>--packs</code> given), so only issues are listed."}</p>`;

  return `
<section id="next">
  <h2>Next actions</h2>
  ${note}
  ${parts.join("\n  ")}
</section>`;
}

/** The verb (`Run sync`), then the status message and the file it refers to on a detail line. */
function action(entry: PackStatusEntry): string {
  const verb = STATUS_ACTION[entry.status] ?? "";
  const where = location(entry);
  const detail = [
    entry.message ? esc(entry.message) : "",
    where ? `<span class="mono">${where}</span>` : "",
  ]
    .filter((s) => s.length > 0)
    .join(" · ");
  return `<b>${esc(verb)}</b>${detail ? `<div class="detail">${detail}</div>` : ""}`;
}

function location(entry: PackStatusEntry): string {
  if (entry.file === null) return "";
  return esc(entry.line === null ? entry.file : `${entry.file}:${entry.line}`);
}

/** Status counts, worst first and nonzero only, in urgency order. */
function statusCounts(entries: ReadonlyArray<PackStatusEntry>): Array<[PackStatus, number]> {
  return STATUS_ORDER.map(
    (status) => [status, entries.filter((e) => e.status === status).length] as [PackStatus, number],
  ).filter(([, count]) => count > 0);
}

/** One horizontal stacked bar over the entries' statuses; the legend is the counts line. */
function statusBar(entries: ReadonlyArray<PackStatusEntry>): string {
  const counts = statusCounts(entries);
  if (counts.length === 0) return "";
  const segments = counts
    .map(
      ([status, count]) =>
        `<span class="seg status-${status}" style="flex-grow:${count}" title="${STATUS_LABEL[status]} ${count}"></span>`,
    )
    .join("");
  return `<span class="bar">${segments}</span>`;
}

/** `● 2 blocked · ● 1 modified`: a colored dot, the number, the glossary label. */
function countLine(counts: ReadonlyArray<readonly [PackStatus, number]>): string {
  return counts
    .map(([status, count]) => `${dot(`status-${status}`)} ${fmt(count)} ${STATUS_LABEL[status]}`)
    .join(" · ");
}

/** `owner/repo` and `owner/repo/nested` share the owner `owner`. */
function ownerOf(name: string): string {
  return name.split("/")[0] ?? name;
}

interface Group<T> {
  readonly owner: string;
  readonly members: ReadonlyArray<T>;
}

/** Split into owner groups, keeping the members' order; groups ordered by `compare`. */
function groupByOwner<T>(
  items: ReadonlyArray<T>,
  nameOf: (item: T) => string,
  compare: (a: Group<T>, b: Group<T>) => number,
): Group<T>[] {
  const byOwner = new Map<string, T[]>();
  for (const item of items) {
    const owner = ownerOf(nameOf(item));
    const list = byOwner.get(owner);
    if (list) list.push(item);
    else byOwner.set(owner, [item]);
  }
  return [...byOwner.entries()]
    .map(([owner, members]) => ({ owner, members }))
    .sort((a, b) => compare(a, b) || a.owner.localeCompare(b.owner));
}

/**
 * One line per pack (rev, subscribers, stacked bar, counts), then the repo × pack matrix: one
 * row per repository that is subscribed to or carries a block of any pack, one column per pack,
 * status and `file:line` per cell. Owners and repositories are ordered by the most urgent status
 * against any pack. Repositories subscribed to no pack are listed under the matrix in a closed
 * `<details>`, grouped by owner, each with its shape and what a sync would do if it were
 * subscribed. Every repository name links to its row in Repositories.
 */
function distribution(dist: PackDistribution, allRepos: ReadonlyArray<RepoReport>): string {
  const packLines = dist.packs
    .map((pack) => {
      const entries = dist.entries.filter((e) => e.pack === pack.id);
      const block = pack.files.find((f) => f.kind === "agents-block");
      const meta = [
        pack.rev ? `rev ${pack.rev.slice(0, 7)}` : "rev unknown",
        `${fmt(pack.subscribers.length)} subscribed`,
        block ? "" : "no AGENTS.md block",
      ]
        .filter((s) => s.length > 0)
        .join(" · ");
      return `<div class="pack"><div class="pack-name"><span class="mono">${esc(pack.id)}</span><span class="meta">${esc(meta)}</span></div>${statusBar(entries)}<div class="meta">${countLine(statusCounts(entries)) || "no repositories"}</div></div>`;
    })
    .join("\n  ");
  const packHeaders = dist.packs
    .map(
      (pack) =>
        `<th><span class="mono">${esc(pack.id)}</span> <span class="meta">${pack.rev ? `rev ${esc(pack.rev.slice(0, 7))}` : "rev unknown"}</span></th>`,
    )
    .join("");

  // A repository's rank is its most urgent status against any pack (`STATUS_ORDER`).
  const urgency = new Map<string, number>();
  for (const entry of dist.entries) {
    const rank = STATUS_ORDER.indexOf(entry.status);
    urgency.set(entry.repo, Math.min(urgency.get(entry.repo) ?? Number.MAX_SAFE_INTEGER, rank));
  }
  const rankOf = (name: string): number => urgency.get(name) ?? Number.MAX_SAFE_INTEGER;
  const repoNames = [...urgency.keys()].sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b));
  const quietRank = STATUS_ORDER.indexOf("not-subscribed");
  const active = repoNames.filter((name) => rankOf(name) !== quietRank);
  const quiet = repoNames.filter((name) => rankOf(name) === quietRank);

  const cell = (name: string, packId: string): string => {
    const entry = dist.entries.find((e) => e.repo === name && e.pack === packId);
    if (!entry) return `<td class="muted">${UNMEASURED}</td>`;
    if (entry.status === "not-subscribed") return `<td>${statusChip(entry.status)}</td>`;
    const where = location(entry);
    return `<td>${statusChip(entry.status)}${where ? ` <span class="where mono">${where}</span>` : ""}</td>`;
  };
  const groups = groupByOwner(
    active,
    (name) => name,
    (a, b) =>
      rankOf(a.members[0] ?? "") - rankOf(b.members[0] ?? "") ||
      b.members.length - a.members.length,
  );
  const bodies = groups
    .map((group) => {
      const rows = group.members
        .map(
          (name) =>
            `<tr><td class="mono">${repoName(name)}</td>${dist.packs.map((pack) => cell(name, pack.id)).join("")}</tr>`,
        )
        .join("\n");
      return `<tbody class="owner">
<tr class="owner"><th colspan="${dist.packs.length + 1}"><span class="mono">${esc(group.owner)}</span> <span class="meta">${fmt(group.members.length)} ${plural(group.members.length, "repository", "repositories")}</span></th></tr>
${rows}
</tbody>`;
    })
    .join("\n");

  const warnings = [
    ...dist.warnings.map((w) => `<li class="warn">${esc(w)}</li>`),
    ...dist.personalCopies.map(
      (copy) => `<li class="warn">${esc(describePersonalCopy(copy))}</li>`,
    ),
  ];

  const table =
    active.length > 0
      ? `<table class="matrix">
    <thead><tr><th>Repository</th>${packHeaders}</tr></thead>
${bodies}
  </table>`
      : '<p class="empty">No repository is subscribed to or carries a block of any pack.</p>';

  return `
<section id="distribution">
  <h2>Pack distribution</h2>
  <p class="note">${dist.packs.length} ${plural(dist.packs.length, "pack", "packs")} from <code>${esc(dist.root)}</code>. Status per repository per pack as measured on the local checkout under the scanned directory; the default-branch status on GitHub comes from <code>sync --all --dry-run</code>. Words are defined in the <a href="${GLOSSARY_URL}">glossary</a>.</p>
  ${warnings.length > 0 ? `<ul class="issues">${warnings.join("")}</ul>` : ""}
  <div class="packs">
  ${packLines}
  </div>
  ${table}
  ${candidates(quiet, dist, allRepos)}
</section>`;
}

/**
 * Repositories subscribed to no pack, as a candidate list: shape, and what a sync would do if the
 * repository were subscribed (the `eligible` normalization, or the `blocked` obstacle), from the
 * domain classifier with the subscription assumed. Closed by default; the count is in the summary.
 */
function candidates(
  quiet: ReadonlyArray<string>,
  dist: PackDistribution,
  allRepos: ReadonlyArray<RepoReport>,
): string {
  if (quiet.length === 0) return "";
  // One pack is enough: a repository `not-subscribed` to every pack carries no block (the block
  // check precedes the subscription check in `classifyPackStatus`), and every branch after the
  // subscription check reads the repository alone. `tests/pack.test.ts` pins that the answer is
  // the same for a second pack.
  const pack = dist.packs[0];
  const repoByName = new Map(allRepos.map((r) => [r.name, r] as const));
  const would = new Map<string, PackStatusEntry | null>();
  for (const name of quiet) {
    const repo = repoByName.get(name);
    would.set(name, repo && pack ? classifyIfSubscribed(repo, pack) : null);
  }
  const rankOf = (name: string): number => {
    const entry = would.get(name);
    return entry ? STATUS_ORDER.indexOf(entry.status) : Number.MAX_SAFE_INTEGER;
  };
  const sorted = [...quiet].sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b));
  const groups = groupByOwner(
    sorted,
    (name) => name,
    (a, b) => b.members.length - a.members.length,
  );
  const bodies = groups
    .map((group) => {
      const rows = group.members
        .map((name) => {
          const repo = repoByName.get(name);
          const entry = would.get(name);
          const shape = repo ? esc(SHAPE_LABEL[repo.shape]) : "";
          const would_ = entry
            ? `${statusChip(entry.status)} <span class="detail">${esc(entry.message ?? "")}</span>`
            : "";
          return `<tr><td class="mono">${repoName(name)}</td><td class="muted">${shape}</td><td>${would_}</td></tr>`;
        })
        .join("\n");
      return `<tbody class="owner">
<tr class="owner"><th colspan="3"><span class="mono">${esc(group.owner)}</span> <span class="meta">${fmt(group.members.length)}</span></th></tr>
${rows}
</tbody>`;
    })
    .join("\n");
  return `<details class="fold">
    <summary><b>Not subscribed to any pack (${fmt(quiet.length)})</b> <span class="muted">what a sync would do if the repository were subscribed</span></summary>
    <table class="candidates">
    <thead><tr><th>Repository</th><th>Shape</th><th>If subscribed</th></tr></thead>
${bodies}
    </table>
  </details>`;
}

/** The repository name, linked to its row in Repositories (every repository has one). */
function repoName(name: string): string {
  return `<a href="#${cardId(name)}">${esc(name)}</a>`;
}

function cardId(name: string): string {
  return `repo-${encodeURIComponent(name)}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Findings, malformed `agent-rules` markers, and skill issues: what the card badge counts. */
function issueCount(repo: RepoReport): number {
  return (
    repo.findings.length +
    repo.blockIssues.filter((issue) => issue.kind === "malformed-marker").length +
    repo.skills.issues.length
  );
}

/** Every issue of a repository as `file:line message`, in the order the card lists them. */
function issueLines(repo: RepoReport): string[] {
  const lines: string[] = [];
  for (const finding of repo.findings) {
    lines.push(
      `<span class="mono">${esc(`${finding.file}:${finding.line}`)}</span> ${esc(finding.message)}`,
    );
  }
  for (const issue of repo.blockIssues) {
    if (issue.kind !== "malformed-marker") continue;
    lines.push(
      `<span class="mono">${esc(`${issue.file}:${issue.line}`)}</span> ${esc(issue.message)}`,
    );
  }
  for (const issue of repo.skills.issues) {
    lines.push(
      `<span class="mono">${esc(`${issue.file}:${issue.line}`)}</span> ${esc(issue.message)}`,
    );
  }
  return lines;
}

/** One row per repository, grouped by owner; owners and repositories with the most issues first. */
function repoCards(
  repos: ReadonlyArray<RepoReport>,
  shapes: Readonly<Record<CanonicalShape, number>>,
): string {
  const sorted = [...repos].sort(
    (a, b) => issueCount(b) - issueCount(a) || a.name.localeCompare(b.name),
  );
  const issuesIn = (group: Group<RepoReport>): number =>
    group.members.reduce((sum, r) => sum + issueCount(r), 0);
  const groups = groupByOwner(
    sorted,
    (repo) => repo.name,
    (a, b) => issuesIn(b) - issuesIn(a) || b.members.length - a.members.length,
  );
  const shapeLine = (Object.keys(SHAPE_LABEL) as CanonicalShape[])
    .filter((shape) => shapes[shape] > 0)
    .map((shape) => `${fmt(shapes[shape])} ${esc(SHAPE_LABEL[shape])}`)
    .join(" · ");
  // The same predicate as `totals.reposWithInstructions`, so the two lines agree.
  const empty = repos.filter((r) => r.files.length === 0).length;
  const cards = groups
    .map((group) => {
      const issues = issuesIn(group);
      return `<h3 class="owner"><span class="who"><span class="mono">${esc(group.owner)}</span> <span class="meta">${fmt(group.members.length)} ${plural(group.members.length, "repository", "repositories")}${issues > 0 ? ` · ${fmt(issues)} ${plural(issues, "issue", "issues")}` : ""}</span></span><span class="col shape">Shape</span><span class="col num">Cursor</span><span class="col num">Claude Code</span></h3>
${group.members.map(repoCard).join("\n")}`;
    })
    .join("\n");
  return `
<section id="repositories">
  <h2>Repositories</h2>
  <p class="note">${fmt(repos.length)} ${plural(repos.length, "repository", "repositories")}${empty > 0 ? `, ${fmt(empty)} without instruction files` : ""}. Most issues first; a repository with an issue starts open, the rest closed. Click a row to open it.</p>
  <p class="meta">Shapes: ${shapeLine}</p>
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
  for (const line of issueLines(repo)) issues.push(`<li class="warn">${line}</li>`);

  const files =
    repo.files.length > 0
      ? `<table class="files">
      <thead><tr><th>File</th><th>Scope</th><th class="num">Lines</th><th class="num">Tokens</th></tr></thead>
      <tbody>${repo.files.map(fileRow).join("")}</tbody>
    </table>`
      : '<p class="empty">No instruction files.</p>';

  const blocks = [
    ...repo.blocks.map((block) => {
      const rev = block.rev ? ` rev ${block.rev.slice(0, 7)}` : "";
      return `<li><span class="mono">${esc(`${block.file}:${block.line}-${block.endLine}`)}</span> block <code>${esc(block.source)}</code>${esc(rev)}${block.modified ? ' <span class="tag tag-modified">modified</span>' : ""}</li>`;
    }),
    ...repo.foreignRegions.map(
      (region) =>
        `<li><span class="mono">${esc(`${region.file}:${region.line}-${region.endLine}`)}</span> region <code>${esc(region.name)}</code> (another tool; left untouched)</li>`,
    ),
  ];

  const count = issueCount(repo);
  return `
<details class="repo" id="${cardId(repo.name)}"${count > 0 ? " open" : ""}>
  <summary>
    <span class="who"><span class="mono name">${esc(repo.name)}</span>${count > 0 ? ` <span class="tag tag-attention">${fmt(count)} ${plural(count, "issue", "issues")}</span>` : ""}</span>
    <span class="col shape muted">${esc(SHAPE_LABEL[repo.shape])}</span>
    <span class="col num">~${fmt(repo.budget.cursor)}</span>
    <span class="col num">~${fmt(repo.budget.claudeCode)}</span>
  </summary>
  <div class="card-body">
    ${issues.length > 0 ? `<ul class="issues">${issues.join("")}</ul>` : ""}
    ${files}
    ${blocks.length > 0 ? `<ul class="plain">${blocks.join("")}</ul>` : ""}
    ${skillsTable(repo)}
  </div>
</details>`;
}

/** The skill inventory, closed by default; the summary carries the count per lock state. */
function skillsTable(repo: RepoReport): string {
  const skills = repo.skills.skills;
  if (skills.length === 0) return "";
  const states: Array<SkillLockState | null> = [
    ...(Object.keys(LOCK_STATE_LABEL) as SkillLockState[]),
    null,
  ];
  const counts = states
    .map((state) => [state, skills.filter((s) => s.lockState === state).length] as const)
    .filter(([, count]) => count > 0)
    .map(
      ([state, count]) =>
        `${fmt(count)} ${state === null ? "no skills-lock.json" : LOCK_STATE_LABEL[state]}`,
    )
    .join(", ");
  const rows = skills
    .map(
      (skill) =>
        `<tr><td class="mono">${esc(skill.relativePath)}</td><td class="num">${skill.files}</td><td>${skill.lockState === null ? '<span class="muted">no skills-lock.json</span>' : esc(LOCK_STATE_LABEL[skill.lockState])}</td><td>${esc(skill.links.map((l) => l.split("/")[0] ?? l).join(", "))}</td></tr>`,
    )
    .join("");
  return `<details class="fold skills">
      <summary><b>${fmt(skills.length)} ${plural(skills.length, "skill", "skills")}</b> <span class="muted">${esc(counts)}</span></summary>
      <table class="files">
        <thead><tr><th>Skill</th><th class="num">Files</th><th>Lock</th><th>Also linked from</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
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
<section id="duplicates">
  <h2>Duplicates</h2>
  <p class="note">${report.duplicates.length} ${report.duplicates.length === 1 ? "group" : "groups"} of identical content across repositories.</p>
  <ul class="plain">${groups}</ul>
</section>`;
}

function personalLayer(personal: PersonalLayer): string {
  const files =
    personal.files.length > 0
      ? `<table class="files">
    <thead><tr><th>File</th><th>Scope</th><th class="num">Lines</th><th class="num">Tokens</th></tr></thead>
    <tbody>${personal.files.map(fileRow).join("")}</tbody>
  </table>`
      : '<p class="empty">No ~/.claude/CLAUDE.md, ~/.claude/rules, ~/AGENTS.md, or ~/.cursor/rules.</p>';
  return `
<section id="personal">
  <h2>Personal layer</h2>
  <p class="note">Home <code>${esc(personal.home)}</code>; added to every session on this machine. Cursor ~${fmt(personal.cursorTokens)} · Claude Code ~${fmt(personal.claudeCodeTokens)} tokens.</p>
  ${files}
  ${personal.managedPolicyPath ? `<p class="warn">managed policy present at <code>${esc(personal.managedPolicyPath)}</code> (cannot be excluded)</p>` : ""}
  <p class="meta">Cursor loads <code>~/AGENTS.md</code> and <code>~/.cursor/rules/*.mdc</code> for workspaces under home (ancestor walk, undocumented). User Rules live in the Cursor account, not on disk, and have no headless write path: they are not measured, and a pack is distributed through its block, not through a User Rule copy (D13).</p>
</section>`;
}

// ---------------------------------------------------------------------------------------------
// Building blocks

function stat(label: string, value: string, sub: string, extraClass = ""): string {
  return `<div class="stat${extraClass ? ` ${extraClass}` : ""}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

function chip(text: string, cls: string): string {
  return `<span class="chip ${cls}">${esc(text)}</span>`;
}

function dot(cls: string): string {
  return `<span class="dot ${cls}"></span>`;
}

function statusChip(status: PackStatus): string {
  return chip(STATUS_LABEL[status], `status-${status}`);
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
  /** Already-escaped HTML printed above the footer line, or null for none (D24). */
  readonly footnote?: string | null;
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
${doc.footnote ? `  <p class="footnote">${doc.footnote}</p>\n` : ""}  rulecheck v${esc(doc.version)} · generated ${esc(doc.generatedAt)} · <a href="${GLOSSARY_URL}">status-model glossary</a>
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

/**
 * Design tokens after GitHub Primer (D21): type scale 12 / 14 / 16 / 20 / 28, spacing on a 4 px
 * grid (4 / 8 / 16 / 24), neutral grays, one accent (blue), semantic colors only where a status
 * is the content. Light and dark through `prefers-color-scheme`; print keeps what is open.
 */
const CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --line-soft: #e6eaef; --subtle: #f6f8fa;
  --accent: #0969da; --success: #1a7f37; --attention: #9a6700; --danger: #d1242f; --done: #8250df; --neutral: #59636e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #f0f6fc; --muted: #9198a1; --line: #3d444d; --line-soft: #262c36; --subtle: #151b23;
    --accent: #4493f8; --success: #3fb950; --attention: #d29922; --danger: #f85149; --done: #ab7df8; --neutral: #9198a1;
  }
}
* { box-sizing: border-box; }
html { scroll-padding-top: 48px; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
header, main, footer { max-width: 1100px; margin: 0 auto; padding: 0 24px; }
header { padding-top: 40px; padding-bottom: 8px; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
h2 { font-size: 16px; font-weight: 600; margin: 48px 0 8px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
h3 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; }
h3.owner { position: sticky; top: 0; z-index: 1; margin: 32px 0 0; padding: 12px 0 8px 20px; background: var(--bg); border-bottom: 1px solid var(--line); }
h3.owner .col { font-size: 12px; font-weight: 600; color: var(--muted); }
.who { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; }
.col { flex: 0 0 auto; }
.col.shape { width: 160px; }
.col.num, h3.owner .col.num { width: 96px; text-align: right; font-variant-numeric: tabular-nums; }
h3.owner, details.repo summary { display: flex; align-items: center; gap: 16px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
code { background: var(--subtle); padding: 1px 4px; border-radius: 4px; }
b { font-weight: 600; }
.subtitle, .note, .muted, .meta, .sub, .detail, .empty { color: var(--muted); }
.subtitle { margin: 0; }
.note { margin: 0 0 16px; }
.meta { font-size: 12px; margin: 8px 0; }
.empty { margin: 8px 0; }
.detail { font-size: 12px; margin-top: 2px; white-space: pre-wrap; }
.where { color: var(--muted); margin-left: 4px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin: 16px 0 8px; }
.stat { border: 1px solid var(--line); border-radius: 6px; padding: 16px; }
.stat .label { font-size: 12px; color: var(--muted); }
.stat .value { font-size: 28px; font-weight: 600; line-height: 1.25; margin: 4px 0; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.stat .sub { font-size: 12px; line-height: 1.4; }
.stat.attention .value { color: var(--attention); }
.stat.danger .value { color: var(--danger); }
.stat.success .value { color: var(--success); }
.chip { display: inline-block; padding: 0 7px; border-radius: 2em; border: 1px solid var(--c, var(--line)); color: var(--c, var(--fg)); font-size: 12px; font-weight: 500; line-height: 18px; white-space: nowrap; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--c, var(--line)); vertical-align: 0; }
.status-current { --c: var(--success); }
.status-outdated { --c: var(--attention); }
.status-modified { --c: var(--done); }
.status-eligible { --c: var(--accent); }
.status-blocked { --c: var(--danger); }
.status-not-subscribed { --c: var(--neutral); }
.outcome-nothing-to-do, .outcome-up-to-date { --c: var(--success); }
.outcome-planned, .outcome-opened, .outcome-updated { --c: var(--accent); }
.outcome-refused { --c: var(--attention); }
.outcome-failed { --c: var(--danger); }
.packs { display: grid; gap: 16px; margin: 0 0 24px; }
.pack { display: grid; grid-template-columns: 240px 1fr; gap: 4px 16px; align-items: center; }
.pack-name { display: flex; flex-direction: column; }
.pack-name .mono { font-size: 14px; font-weight: 600; }
.pack .meta { margin: 0; }
.pack > .meta { grid-column: 2; }
.bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--subtle); }
.seg { display: block; flex-basis: 0; min-width: 2px; background: var(--c); }
.seg.status-not-subscribed { opacity: .3; }
.tag { display: inline-block; font-size: 12px; font-weight: 500; padding: 0 7px; border-radius: 2em; line-height: 18px; white-space: nowrap; }
.tag-modified { color: var(--done); border: 1px solid var(--done); }
.tag-attention { color: #fff; background: var(--danger); }
table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
th, td { text-align: left; vertical-align: top; padding: 8px; border-bottom: 1px solid var(--line-soft); }
th { font-size: 12px; font-weight: 600; color: var(--muted); }
thead th { border-bottom: 1px solid var(--line); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.owner th { font-size: 14px; color: var(--fg); padding-top: 16px; border-bottom: 1px solid var(--line); }
tr.owner th .mono { font-size: 14px; font-weight: 600; }
tr.owner th .meta { font-weight: 400; margin-left: 4px; }
.actions td:first-child { white-space: nowrap; }
.actions th:last-child, .actions td:last-child { width: 55%; }
.actions td .detail { margin-top: 0; }
.issues-table th:last-child, .issues-table td:last-child { width: 70%; }
td.lines { line-height: 1.6; }
.matrix td:first-child, .candidates td:first-child { white-space: nowrap; }
.matrix th .meta { font-weight: 400; margin-left: 4px; }
.issues { list-style: none; padding: 0; margin: 8px 0; }
.issues li { padding: 4px 12px; margin: 4px 0; border-left: 3px solid var(--c, var(--line)); }
.issues li.warn { --c: var(--danger); }
.issues li.info { --c: var(--accent); color: var(--muted); }
p.warn { color: var(--danger); }
.plain { list-style: none; padding-left: 0; margin: 8px 0; }
.plain li { padding: 2px 0; }
.plain ul { padding-left: 16px; }
details.fold { margin: 8px 0; }
details.fold summary { cursor: pointer; padding: 8px 0; color: var(--muted); }
details.fold summary b { color: var(--fg); }
details.fold[open] summary { border-bottom: 1px solid var(--line-soft); margin-bottom: 4px; }
details.repo { border-bottom: 1px solid var(--line-soft); }
details.repo summary { cursor: pointer; padding: 8px 0 8px 20px; list-style: none; position: relative; }
details.repo summary::-webkit-details-marker { display: none; }
details.repo summary::before { content: ""; position: absolute; left: 4px; top: 14px; width: 6px; height: 6px; border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted); transform: rotate(-45deg); }
details.repo[open] summary::before { transform: rotate(45deg); top: 12px; }
details.repo summary .name { font-size: 14px; font-weight: 600; }
details.repo summary .shape { font-size: 12px; }
details.repo summary .col.num { color: var(--muted); font-size: 12px; }
details.repo:target summary { box-shadow: inset 3px 0 0 var(--accent); }
.card-body { padding: 0 0 16px 20px; }
.card-body table { margin-top: 0; }
footer { margin: 64px auto 40px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
footer .footnote { margin: 0 0 8px; }
@media print {
  body { font-size: 11px; }
  header, main, footer { max-width: none; padding: 0; }
  h3.owner { position: static; }
  details.repo summary::before { display: none; }
  details.repo, tbody.owner, .stat { break-inside: avoid; }
  .stat, .chip, .dot, .seg, .tag, .issues li { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  a { color: inherit; text-decoration: none; }
  footer a::after { content: " (" attr(href) ")"; }
}
`;

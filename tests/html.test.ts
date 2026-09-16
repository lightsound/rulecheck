import { describe, expect, test } from "bun:test";
import type {
  InstructionFile,
  PackStatus,
  RepoReport,
  ScanReport,
  SkillsInventory,
} from "../src/domain/types.ts";
import { GitHubError } from "../src/github/client.ts";
import { esc, GLOSSARY_URL, renderHtml, renderSyncAllHtml } from "../src/report/html.ts";
import { OUTCOME_LABEL, SHAPE_LABEL, STATUS_LABEL } from "../src/report/labels.ts";
import type { SyncAllResult } from "../src/sync/all.ts";

/**
 * The HTML report is a rendering of the same `ScanReport` the text report prints. These tests
 * pin its structure (sections in the required order), that every label it prints is a glossary
 * label, and that anything taken from a scanned tree (paths, messages, marker text) is escaped.
 */

function file(
  overrides: Partial<InstructionFile> & Pick<InstructionFile, "relativePath">,
): InstructionFile {
  return {
    path: `/repo/${overrides.relativePath}`,
    kind: "agents-md",
    depth: 0,
    bytes: 100,
    lines: 12,
    tokens: 34,
    contentHash: "0",
    wrapperTarget: null,
    wrapperUsesImport: false,
    importsAgentsMd: false,
    frontmatter: null,
    ...overrides,
  };
}

const NO_SKILLS: SkillsInventory = { skills: [], lock: null, issues: [] };

function repo(overrides: Partial<RepoReport> & Pick<RepoReport, "name">): RepoReport {
  return {
    root: `/tree/github.com/${overrides.name}`,
    shape: "agents-canonical",
    normalization: "keep",
    files: [],
    budget: { cursor: 0, claudeCode: 0 },
    findings: [],
    blocks: [],
    blockIssues: [],
    foreignRegions: [],
    skills: NO_SKILLS,
    ...overrides,
  };
}

/** A repository whose scanned text carries HTML-significant characters everywhere the report quotes it. */
const HOSTILE = repo({
  name: "acme/<hostile>",
  shape: "both-full",
  normalization: "merge",
  files: [
    file({ relativePath: "AGENTS.md", lines: 3, tokens: 1234 }),
    file({
      relativePath: "CLAUDE.md",
      kind: "claude-md",
      wrapperTarget: "AGENTS.md",
      wrapperUsesImport: false,
    }),
    file({
      relativePath: ".cursor/rules/a&b.mdc",
      kind: "cursor-rule",
      frontmatter: { alwaysApply: false, globs: ["src/**/*.ts"], paths: [], description: null },
    }),
  ],
  budget: { cursor: 1300, claudeCode: 40 },
  findings: [
    {
      kind: "missing-path",
      file: "AGENTS.md",
      line: 7,
      value: "<script>",
      message: 'path "<script>alert(1)</script>" does not exist',
    },
  ],
  blockIssues: [
    {
      kind: "malformed-marker",
      file: "AGENTS.md",
      line: 9,
      message: "`agent-rules:begin` is missing hash=",
    },
  ],
  blocks: [
    {
      file: "AGENTS.md",
      source: "base",
      rev: "0123456789abcdef",
      hash: "h",
      bodyHash: "h2",
      line: 1,
      endLine: 3,
      body: "",
      modified: true,
    },
  ],
  foreignRegions: [{ file: "AGENTS.md", name: "gen<x>", line: 20, endLine: 30 }],
  skills: {
    skills: [
      {
        name: "review",
        agentDir: ".agents",
        relativePath: ".agents/skills/review",
        frontmatterName: "review",
        hash: "0",
        files: 2,
        links: [".claude/skills/review"],
        lockState: "differs",
      },
    ],
    lock: [],
    issues: [
      {
        kind: "missing",
        file: "skills-lock.json",
        line: 4,
        skill: "gone",
        message: "skills-lock.json lists `gone` but no skill directory exists",
      },
    ],
  },
});

const QUIET = repo({
  name: "acme/quiet",
  files: [
    file({ relativePath: "AGENTS.md" }),
    file({
      relativePath: "CLAUDE.md",
      kind: "claude-md",
      wrapperTarget: "AGENTS.md",
      wrapperUsesImport: true,
    }),
  ],
  budget: { cursor: 34, claudeCode: 34 },
});

const EMPTY = repo({ name: "acme/empty", shape: "none", normalization: "create" });

/** Subscribed to no pack: its distribution row is dimmed. */
const OTHER = repo({
  name: "acme/other",
  files: [file({ relativePath: "AGENTS.md" })],
  budget: { cursor: 34, claudeCode: 0 },
  blockIssues: [
    { kind: "malformed-marker", file: "AGENTS.md", line: 2, message: "unpaired `agent-rules:end`" },
  ],
});

const STATUSES: ReadonlyArray<PackStatus> = [
  "current",
  "outdated",
  "modified",
  "eligible",
  "blocked",
  "not-subscribed",
];

const REPORT: ScanReport = {
  schemaVersion: 1,
  root: "/tree",
  scannedAt: "2026-09-16T00:00:00.000Z",
  repos: [HOSTILE, QUIET, EMPTY, OTHER],
  excludedNested: [],
  duplicates: [
    {
      contentHash: "d",
      tokens: 34,
      lines: 12,
      members: [
        { repo: "acme/<hostile>", relativePath: "AGENTS.md" },
        { repo: "acme/quiet", relativePath: "AGENTS.md" },
      ],
    },
  ],
  personal: {
    home: "/home/<me>",
    files: [file({ relativePath: "~/.claude/CLAUDE.md", kind: "claude-md", lines: 2, tokens: 18 })],
    claudeCodeTokens: 18,
    cursorTokens: 0,
    managedPolicyPath: null,
  },
  distribution: {
    root: "/packs",
    packs: [
      {
        id: "base",
        rev: "0123456789abcdef0123456789abcdef01234567",
        files: [{ kind: "agents-block", body: "x", hash: "h" }],
        subscribers: ["acme/<hostile>", "acme/quiet", "acme/empty"],
      },
      { id: "frontend", rev: null, files: [], subscribers: [] },
    ],
    entries: [
      {
        repo: "acme/<hostile>",
        pack: "base",
        status: "modified",
        file: "AGENTS.md",
        line: 1,
        message: "body no longer matches its hash=",
      },
      {
        repo: "acme/quiet",
        pack: "base",
        status: "current",
        file: "AGENTS.md",
        line: 3,
        message: null,
      },
      {
        repo: "acme/empty",
        pack: "base",
        status: "eligible",
        file: null,
        line: null,
        message: "create AGENTS.md with the block and a CLAUDE.md wrapper",
      },
      {
        repo: "acme/<hostile>",
        pack: "frontend",
        status: "blocked",
        file: "AGENTS.md",
        line: 9,
        message: "<!-- marker --> in the way",
      },
      {
        repo: "acme/quiet",
        pack: "frontend",
        status: "outdated",
        file: "AGENTS.md",
        line: 3,
        message: null,
      },
      {
        repo: "acme/empty",
        pack: "frontend",
        status: "not-subscribed",
        file: null,
        line: null,
        message: null,
      },
      {
        repo: "acme/other",
        pack: "base",
        status: "not-subscribed",
        file: null,
        line: null,
        message: null,
      },
      {
        repo: "acme/other",
        pack: "frontend",
        status: "not-subscribed",
        file: null,
        line: null,
        message: null,
      },
    ],
    counts: { current: 1, outdated: 1, modified: 1, eligible: 1, blocked: 1, "not-subscribed": 3 },
    personalCopies: [
      {
        pack: "base",
        file: "~/pack/<copy>.md",
        kind: "imported-md",
        state: "current",
        doubleLoaded: ["acme/quiet"],
      },
    ],
    warnings: ["subscriptions.json: <bad> entry"],
  },
  totals: {
    repos: 4,
    reposWithInstructions: 3,
    files: 6,
    tokens: 1400,
    findings: 1,
    shapes: {
      "agents-canonical": 1,
      "agents-imported": 0,
      "claude-canonical": 0,
      "agents-only": 0,
      "claude-only": 0,
      "both-full": 1,
      none: 1,
    },
    blocks: 1,
    modifiedBlocks: 1,
    malformedMarkers: 1,
    skills: 1,
    skillIssues: 1,
  },
};

const html = renderHtml(REPORT, { version: "0.0.1" });

describe("renderHtml", () => {
  test("is one self-contained document: inline CSS, no script, no external asset", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/\bsrc=|href="http(?!s:\/\/github\.com\/lightsound\/rulecheck)/);
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain("@media print");
  });

  test("sections appear in the required order", () => {
    const order = [
      "<h2>Overview</h2>",
      "<h2>Next actions</h2>",
      "<h2>Pack distribution</h2>",
      "<h2>Repositories</h2>",
      "<h2>Duplicates</h2>",
      "<h2>Personal layer</h2>",
      "<footer>",
    ];
    const positions = order.map((marker) => html.indexOf(marker));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("overview is at most five cards with one number each; token sums are a footnote", () => {
    const cards = html.slice(html.indexOf('<div class="cards">'), html.indexOf("</section>"));
    expect(cards.match(/<div class="stat/g)?.length).toBe(5);
    expect(cards).toContain(
      '<div class="stat"><div class="label">Repositories</div><div class="value">4</div><div class="sub">3 with instruction files</div></div>',
    );
    // Action needed counts repositories, and so does its breakdown: <hostile> is `modified` on
    // `base` and `blocked` on `frontend` but is one repository, counted once under the worse
    // status; the breakdown sums to the headline number.
    expect(cards).toContain(
      '<div class="stat danger"><div class="label">Action needed</div><div class="value">3</div><div class="sub">repositories by worst status · 1 modified · 1 outdated · 1 eligible</div></div>',
    );
    // The denominator is every measured pair: a block decides before the subscription list does,
    // so a non-subscriber carrying a block counts (the `frontend` pack line says `0 subscribed`).
    expect(cards).toContain(
      '<div class="stat"><div class="label">Current</div><div class="value">1</div><div class="sub">of 5 with a block or a subscription</div></div>',
    );
    // Issues = findings + malformed markers + skill issues, the same sum the card badges show.
    expect(cards).toContain(
      '<div class="stat danger"><div class="label">Issues</div><div class="value">3</div><div class="sub">1 finding · 1 malformed marker · 1 skill issue</div></div>',
    );
    expect(cards).toContain(
      '<div class="stat"><div class="label">Instruction files</div><div class="value">6</div><div class="sub">~1,400 tokens in total</div></div>',
    );
    expect(html).toContain(
      '<p class="meta">Root budgets summed over every repository: Cursor ~1,368 · Claude Code ~74 tokens (no single session loads this much). Heaviest repository <span class="mono">acme/&lt;hostile&gt;</span>: Cursor ~1,300 · Claude Code ~40. The personal layer adds ~0 / ~18 to every session.</p>',
    );
    // No all-caps labels: the card label is printed as written.
    expect(html).not.toContain("text-transform: uppercase");
  });

  test("next actions list every actionable repo × pack, most urgent first, with the verb and the file", () => {
    const section = html.slice(
      html.indexOf('<section id="next">'),
      html.indexOf('<section id="distribution">'),
    );
    const rows = [
      '<tr><td><span class="chip status-modified">modified</span></td><td class="mono"><a href="#repo-acme%2F%3Chostile%3E">acme/&lt;hostile&gt;</a></td><td class="mono">base</td><td><b>Review by hand</b><div class="detail">body no longer matches its hash= · <span class="mono">AGENTS.md:1</span></div></td></tr>',
      '<tr><td><span class="chip status-outdated">outdated</span></td><td class="mono"><a href="#repo-acme%2Fquiet">acme/quiet</a></td><td class="mono">frontend</td><td><b>Run sync to update the block</b><div class="detail"><span class="mono">AGENTS.md:3</span></div></td></tr>',
      '<tr><td><span class="chip status-blocked">blocked</span></td><td class="mono"><a href="#repo-acme%2F%3Chostile%3E">acme/&lt;hostile&gt;</a></td><td class="mono">frontend</td><td><b>Fix by hand, then sync</b><div class="detail">&lt;!-- marker --&gt; in the way · <span class="mono">AGENTS.md:9</span></div></td></tr>',
      '<tr><td><span class="chip status-eligible">eligible</span></td><td class="mono"><a href="#repo-acme%2Fempty">acme/empty</a></td><td class="mono">base</td><td><b>Run sync</b><div class="detail">create AGENTS.md with the block and a CLAUDE.md wrapper</div></td></tr>',
    ];
    const positions = rows.map((row) => section.indexOf(row));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // `current` and `not subscribed` ask for nothing and are not listed.
    expect(section).not.toContain("status-current");
    expect(section).not.toContain("status-not-subscribed");
    // Then the repositories with issues, most first, each issue with file:line.
    expect(section).toContain("<h3>Issues to fix</h3>");
    expect(section).toContain(
      '<tr><td><span class="mono"><a href="#repo-acme%2F%3Chostile%3E">acme/&lt;hostile&gt;</a></span><div class="detail">3 issues</div></td><td class="lines"><span class="mono">AGENTS.md:7</span> path &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot; does not exist<br><span class="mono">AGENTS.md:9</span> `agent-rules:begin` is missing hash=<br><span class="mono">skills-lock.json:4</span> skills-lock.json lists `gone` but no skill directory exists</td></tr>',
    );
    expect(section).toContain(
      '<tr><td><span class="mono"><a href="#repo-acme%2Fother">acme/other</a></span><div class="detail">1 issue</div></td><td class="lines"><span class="mono">AGENTS.md:2</span> unpaired `agent-rules:end`</td></tr>',
    );
  });

  test("next actions say so when there is nothing to do", () => {
    const clean = renderHtml(
      {
        ...REPORT,
        repos: [QUIET],
        duplicates: [],
        distribution: REPORT.distribution && {
          ...REPORT.distribution,
          entries: REPORT.distribution.entries.filter(
            (e) => e.repo === "acme/quiet" && e.pack === "base",
          ),
        },
      },
      { version: "0.0.1" },
    );
    expect(clean).toContain(
      '<p class="empty">Nothing to do: every block is current and no repository has an issue.</p>',
    );
    expect(clean).toContain(
      '<div class="stat success"><div class="label">Action needed</div><div class="value">0</div><div class="sub">every block is current</div></div>',
    );
  });

  test("prints every pack status with its glossary label as a chip, and every used shape as text", () => {
    for (const status of STATUSES) {
      expect(html).toContain(`<span class="chip status-${status}">${STATUS_LABEL[status]}</span>`);
    }
    // The shape breakdown sits in the Repositories section, as plain text, not chips.
    const shapes = html.indexOf(
      '<p class="meta">Shapes: 1 AGENTS.md canonical · 1 both have content · 1 none</p>',
    );
    expect(shapes).toBeGreaterThan(html.indexOf("<h2>Repositories</h2>"));
    expect(html).not.toMatch(/class="chip shape-/);
    expect(html).not.toContain(`>${SHAPE_LABEL["claude-only"]}<`);
  });

  test("distribution has one line per pack with a stacked bar and counts, then the repo × pack matrix grouped by owner, most urgent first", () => {
    expect(html).toContain(
      '<div class="pack"><div class="pack-name"><span class="mono">base</span><span class="meta">rev 0123456 · 3 subscribed</span></div><span class="bar"><span class="seg status-modified" style="flex-grow:1" title="modified 1"></span><span class="seg status-eligible" style="flex-grow:1" title="eligible 1"></span><span class="seg status-current" style="flex-grow:1" title="current 1"></span><span class="seg status-not-subscribed" style="flex-grow:1" title="not subscribed 1"></span></span><div class="meta"><span class="dot status-modified"></span> 1 modified · <span class="dot status-eligible"></span> 1 eligible · <span class="dot status-current"></span> 1 current · <span class="dot status-not-subscribed"></span> 1 not subscribed</div></div>',
    );
    expect(html).toContain(
      '<span class="meta">rev unknown · 0 subscribed · no AGENTS.md block</span></div><span class="bar"><span class="seg status-outdated" style="flex-grow:1" title="outdated 1"></span><span class="seg status-blocked" style="flex-grow:1" title="blocked 1"></span><span class="seg status-not-subscribed" style="flex-grow:2" title="not subscribed 2"></span></span>',
    );
    // Pack headers carry name and short rev only.
    expect(html).toContain(
      '<thead><tr><th>Repository</th><th><span class="mono">base</span> <span class="meta">rev 0123456</span></th><th><span class="mono">frontend</span> <span class="meta">rev unknown</span></th></tr></thead>',
    );
    // One owner group row; no chip soup in it, the counts live on the pack lines.
    expect(html).toContain(
      '<tr class="owner"><th colspan="3"><span class="mono">acme</span> <span class="meta">3 repositories</span></th></tr>',
    );
    // Rows: modified (<hostile>) before outdated (quiet) before eligible (empty); every name links
    // to the repository's row, including one without instruction files. Cells carry the status
    // and file:line only; the message is in Next actions.
    const hostile = html.indexOf(
      '<tr><td class="mono"><a href="#repo-acme%2F%3Chostile%3E">acme/&lt;hostile&gt;</a></td><td><span class="chip status-modified">modified</span> <span class="where mono">AGENTS.md:1</span></td><td><span class="chip status-blocked">blocked</span> <span class="where mono">AGENTS.md:9</span></td></tr>',
    );
    const quiet = html.indexOf(
      '<tr><td class="mono"><a href="#repo-acme%2Fquiet">acme/quiet</a></td><td><span class="chip status-current">current</span> <span class="where mono">AGENTS.md:3</span></td>',
    );
    const empty = html.indexOf(
      '<tr><td class="mono"><a href="#repo-acme%2Fempty">acme/empty</a></td><td><span class="chip status-eligible">eligible</span></td><td><span class="chip status-not-subscribed">not subscribed</span></td></tr>',
    );
    expect(hostile).toBeGreaterThan(0);
    expect(quiet).toBeGreaterThan(hostile);
    expect(empty).toBeGreaterThan(quiet);
    expect(html).toContain('<li class="warn">subscriptions.json: &lt;bad&gt; entry</li>');
    expect(html).toContain(
      "personal layer ~/pack/&lt;copy&gt;.md equals the pack body; loads twice in 1 repository carrying the block (acme/quiet)",
    );
  });

  test("repositories subscribed to no pack leave the matrix for a closed candidate list", () => {
    expect(html).not.toContain(
      '<td class="mono"><a href="#repo-acme%2Fother">acme/other</a></td><td><span class="chip',
    );
    expect(html).toContain("<summary><b>Not subscribed to any pack (1)</b>");
    // Shape, then what a sync would do if the repository were subscribed: here its malformed
    // marker blocks the write, with the same message the status model gives a subscriber.
    expect(html).toContain(
      '<tr><td class="mono"><a href="#repo-acme%2Fother">acme/other</a></td><td class="muted">AGENTS.md canonical</td><td><span class="chip status-blocked">blocked</span> <span class="detail">unpaired `agent-rules:end`</span></td></tr>',
    );
    const withCandidate = renderHtml(
      {
        ...REPORT,
        repos: [
          ...REPORT.repos,
          repo({ name: "zeta/fresh", shape: "none", normalization: "create" }),
        ],
        distribution: REPORT.distribution && {
          ...REPORT.distribution,
          entries: [
            ...REPORT.distribution.entries,
            ...(["base", "frontend"] as const).map((pack) => ({
              repo: "zeta/fresh",
              pack,
              status: "not-subscribed" as const,
              file: null,
              line: null,
              message: null,
            })),
          ],
        },
      },
      { version: "0.0.1" },
    );
    expect(withCandidate).toContain("<summary><b>Not subscribed to any pack (2)</b>");
    expect(withCandidate).toContain(
      '<tr><td class="mono"><a href="#repo-zeta%2Ffresh">zeta/fresh</a></td><td class="muted">none</td><td><span class="chip status-eligible">eligible</span> <span class="detail">create AGENTS.md with the block and a CLAUDE.md wrapper</span></td></tr>',
    );
    // Grouped by owner, larger owners first.
    const candidates = withCandidate.slice(withCandidate.indexOf('<table class="candidates">'));
    expect(
      candidates.indexOf('<tr class="owner"><th colspan="3"><span class="mono">acme</span>'),
    ).toBeLessThan(
      candidates.indexOf('<tr class="owner"><th colspan="3"><span class="mono">zeta</span>'),
    );
  });

  test("repository rows are grouped by owner under a sticky header that carries the column labels, most issues first", () => {
    expect(html).toContain(
      '<h3 class="owner"><span class="who"><span class="mono">acme</span> <span class="meta">4 repositories · 4 issues</span></span><span class="col shape">Shape</span><span class="col num">Cursor</span><span class="col num">Claude Code</span></h3>',
    );
    expect(html).toContain("h3.owner { position: sticky;");
    // A repository with an issue starts open, one without starts closed.
    const hostile = html.indexOf('<details class="repo" id="repo-acme%2F%3Chostile%3E" open>');
    const other = html.indexOf('<details class="repo" id="repo-acme%2Fother" open>');
    const empty = html.indexOf('<details class="repo" id="repo-acme%2Fempty">');
    const quiet = html.indexOf('<details class="repo" id="repo-acme%2Fquiet">');
    expect(hostile).toBeGreaterThan(0);
    expect(other).toBeGreaterThan(hostile);
    expect(empty).toBeGreaterThan(other);
    expect(quiet).toBeGreaterThan(empty);
  });

  test("repository rows carry name, issue badge, shape, and the two budgets as right-aligned numbers", () => {
    expect(html).toContain(
      '<span class="who"><span class="mono name">acme/&lt;hostile&gt;</span> <span class="tag tag-attention">3 issues</span></span>\n    <span class="col shape muted">both have content</span>\n    <span class="col num">~1,300</span>\n    <span class="col num">~40</span>',
    );
    expect(html).toContain(
      '<span class="who"><span class="mono name">acme/quiet</span></span>\n    <span class="col shape muted">AGENTS.md canonical</span>\n    <span class="col num">~34</span>\n    <span class="col num">~34</span>',
    );
  });

  test("repository cards carry files with counts, findings with file:line, blocks, regions, and skills", () => {
    expect(html).toContain(
      '<td class="mono">AGENTS.md</td><td class="muted"></td><td class="num">3</td><td class="num">1,234</td>',
    );
    expect(html).toContain(
      '<td class="mono">.cursor/rules/a&amp;b.mdc</td><td class="muted">globs: src/**/*.ts</td>',
    );
    expect(html).toContain("→ AGENTS.md (prose)");
    expect(html).toContain(
      '<li class="warn"><span class="mono">AGENTS.md:7</span> path &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot; does not exist</li>',
    );
    expect(html).toContain(
      '<li class="warn"><span class="mono">AGENTS.md:9</span> `agent-rules:begin` is missing hash=</li>',
    );
    expect(html).toContain('<li class="warn"><span class="mono">skills-lock.json:4</span>');
    expect(html).toContain(
      'block <code>base</code> rev 0123456 <span class="tag tag-modified">modified</span>',
    );
    expect(html).toContain("region <code>gen&lt;x&gt;</code> (another tool; left untouched)");
    // Skills sit in a closed fold whose summary carries the count per lock state.
    expect(html).toContain(
      '<details class="fold skills">\n      <summary><b>1 skill</b> <span class="muted">1 lock hash differs</span></summary>',
    );
    expect(html).toContain(
      '<td class="mono">.agents/skills/review</td><td class="num">2</td><td>lock hash differs</td><td>.claude</td>',
    );
    // The badge counts findings, malformed markers, and skill issues ("issues", since the glossary
    // keeps `Finding` and `BlockIssue` apart); the shape note is advice and does not count.
    expect(html).toContain('<span class="tag tag-attention">1 issue</span>');
  });

  test("every repository has a row, so every repository name on the page links to one", () => {
    // Unlike the text report (`--all`), a repository without instruction files is not hidden: it
    // is the target of the links in Next actions, the matrix, and the candidate list.
    expect(html).toContain(
      '<span class="who"><span class="mono name">acme/empty</span></span>\n    <span class="col shape muted">none</span>\n    <span class="col num">~0</span>\n    <span class="col num">~0</span>',
    );
    expect(html).toContain('<p class="empty">No instruction files.</p>');
    expect(html).toContain("4 repositories, 1 without instruction files. Most issues first;");
    const ids = new Set([...html.matchAll(/<details class="repo" id="([^"]+)"/g)].map((m) => m[1]));
    const hrefs = [...html.matchAll(/href="#(repo-[^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(ids.has(href)).toBe(true);
    expect(ids.size).toBe(REPORT.repos.length);
  });

  test("personal layer and footer", () => {
    expect(html).toContain("Home <code>/home/&lt;me&gt;</code>");
    expect(html).toContain('<td class="mono">~/.claude/CLAUDE.md</td>');
    expect(html).toContain("Cursor ~0 · Claude Code ~18 tokens");
    expect(html).toContain(
      `rulecheck v0.0.1 · generated 2026-09-16T00:00:00.000Z · <a href="${GLOSSARY_URL}">status-model glossary</a>`,
    );
    expect(html).not.toContain('class="footnote"');
  });

  test("excluded nested repositories are a footnote, escaped (D24)", () => {
    const nested = renderHtml(
      {
        ...REPORT,
        excludedNested: [
          {
            root: "/tree/github.com/acme/quiet/<vendor>",
            name: "acme/quiet/<vendor>",
            parent: "acme/quiet",
            kind: "submodule",
          },
        ],
      },
      { version: "0.0.1" },
    );
    expect(nested).toContain(
      '<p class="footnote">1 nested repository excluded (1 submodule): a repository inside another repository is a different project; --include-nested scans them as their own: <span class="mono">acme/quiet/&lt;vendor&gt;</span> (submodule in <span class="mono">acme/quiet</span>)</p>',
    );
    expect(nested).not.toContain("<vendor>");
  });

  test("nothing taken from the scanned tree reaches the page unescaped", () => {
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<hostile>");
    expect(html).not.toContain("<!-- marker -->");
    expect(html).toContain("&lt;!-- marker --&gt; in the way");
    expect(esc(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });

  test("without a pack repository or personal layer the sections are absent and the headline says so", () => {
    const bare = renderHtml(
      { ...REPORT, distribution: null, personal: null, duplicates: [] },
      { version: "0.0.1" },
    );
    expect(bare).not.toContain("<h2>Pack distribution</h2>");
    expect(bare).not.toContain("<h2>Personal layer</h2>");
    expect(bare).not.toContain("<h2>Duplicates</h2>");
    expect(bare).toContain(
      "No pack repository given (<code>--packs</code>): distribution status not measured.",
    );
    expect(bare).toContain("The personal layer was not scanned.");
    // Next actions still lists the issues, and says why nothing else is there.
    expect(bare).toContain("<h2>Next actions</h2>");
    expect(bare).toContain("<h3>Issues to fix</h3>");
    expect(bare).toContain("so only issues are listed.");
    expect(
      bare.slice(bare.indexOf('<div class="cards">'), bare.indexOf("</section>")),
    ).not.toContain("Action needed");
  });
});

describe("renderSyncAllHtml", () => {
  const result: SyncAllResult = {
    source: "acme/agent-rules@0123456",
    dryRun: true,
    failed: 1,
    rows: [
      {
        target: { repo: "acme/current", pack: "base" },
        outcome: {
          kind: "nothing-to-do",
          repo: "acme/current",
          status: {
            repo: "acme/current",
            pack: "base",
            status: "current",
            file: "AGENTS.md",
            line: 3,
            message: null,
          },
        },
      },
      {
        target: { repo: "acme/<modified>", pack: "base" },
        outcome: {
          kind: "refused",
          message: "block `base` is modified (AGENTS.md:3); <edit> by a human",
          status: {
            repo: "acme/<modified>",
            pack: "base",
            status: "modified",
            file: "AGENTS.md",
            line: 3,
            message: null,
          },
        },
      },
      {
        target: { repo: "acme/gone", pack: "base" },
        outcome: {
          kind: "failed",
          error: new GitHubError({ message: "Not Found", status: 404, operation: "getRepository" }),
          status: null,
        },
      },
    ],
  };
  const page = renderSyncAllHtml(result, {
    version: "0.0.1",
    generatedAt: "2026-09-16T00:00:00.000Z",
  });

  test("one row per target with the measured status, the outcome label once, and its detail", () => {
    expect(page).not.toMatch(/<\/span> (nothing to do|refused:|failed:)/);
    expect(page).toContain("<title>rulecheck sync (dry run)</title>");
    expect(page).toContain(
      '<p class="subtitle">3 targets · packs from <code>acme/agent-rules@0123456</code> · nothing written</p>',
    );
    expect(page).toContain(
      '<td class="mono">acme/current</td><td class="mono">base</td><td><span class="chip status-current">current</span></td><td><span class="chip outcome-nothing-to-do">nothing to do</span> block at AGENTS.md:3</td>',
    );
    expect(page).toContain('<td class="mono">acme/&lt;modified&gt;</td>');
    expect(page).toContain(
      '<span class="chip outcome-refused">refused</span> block `base` is modified (AGENTS.md:3); &lt;edit&gt; by a human',
    );
    expect(page).toContain(
      '<td><span class="muted">-</span></td><td><span class="chip outcome-failed">failed</span> GitHub getRepository failed (HTTP 404): Not Found</td>',
    );
    for (const kind of ["nothing-to-do", "refused", "failed"] as const) {
      expect(page).toContain(`<span class="dot outcome-${kind}"></span> 1 ${OUTCOME_LABEL[kind]}`);
    }
    expect(page).toContain(
      '<div class="stat"><div class="label">Planned</div><div class="value">0</div><div class="sub">pull requests a live run would open or update</div></div>',
    );
    expect(page).toContain(
      '<div class="stat attention"><div class="label">Refused</div><div class="value">1</div><div class="sub">a human must look first</div></div>',
    );
    expect(page).toContain(
      '<div class="stat danger"><div class="label">Failed</div><div class="value">1</div><div class="sub">GitHub could not answer</div></div>',
    );
    expect(page).toContain(
      '<div class="stat"><div class="label">Quiet</div><div class="value">1</div><div class="sub">nothing to do or up to date</div></div>',
    );
    expect(page).toContain(`<a href="${GLOSSARY_URL}">status-model glossary</a>`);
    expect(page).not.toContain("<edit>");
  });
});

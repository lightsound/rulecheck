import { describe, expect, test } from "bun:test";
import { hashBlockBody } from "../src/domain/block.ts";
import {
  classifyPackStatus,
  distribute,
  findPackedRef,
  findPersonalPackCopies,
  packFromFiles,
  parseGitHead,
  parseSubscriptions,
  type RepoForDistribution,
} from "../src/domain/pack.ts";
import type { InstructionFile, ManagedBlock } from "../src/domain/types.ts";

const BODY = "- Respond in Japanese.\n- Use Bun.";
const OLD_BODY = "- Respond in Japanese.";
const PACK_REV = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const base = packFromFiles(
  "base",
  PACK_REV,
  [
    { path: "AGENTS.md", content: `${BODY}\n` },
    { path: ".cursor/skills/review/SKILL.md", content: "---\nname: review\n---\n" },
  ],
  ["Acme/Canonical", "acme/both", "acme/empty", "acme/claude", "acme/foreign", "acme/swap"],
);

describe("packFromFiles", () => {
  test("AGENTS.md becomes the block body, other files are whole managed files", () => {
    expect(base.files).toEqual([
      { kind: "file", path: ".cursor/skills/review/SKILL.md", hash: expect.any(String) },
      { kind: "agents-block", body: `${BODY}\n`, hash: hashBlockBody(BODY) },
    ]);
    expect(base.subscribers).toContain("acme/canonical");
  });

  test("a pack AGENTS.md already wrapped in markers contributes only its body", () => {
    const wrapped = `<!-- agent-rules:begin source=base rev=x hash=${hashBlockBody(BODY)} -->\n${BODY}\n<!-- agent-rules:end -->\n`;
    const pack = packFromFiles("base", null, [{ path: "AGENTS.md", content: wrapped }], []);
    expect(pack.files[0]).toMatchObject({ kind: "agents-block", hash: hashBlockBody(BODY) });
  });
});

describe("parseSubscriptions", () => {
  test("reads the pack -> repos map and drops junk", () => {
    const map = parseSubscriptions('{"base":["a/b","c/d",1],"frontend":"nope"}');
    expect(map?.get("base")).toEqual(["a/b", "c/d"]);
    expect(map?.has("frontend")).toBe(false);
    expect(parseSubscriptions("[]")).toBeNull();
    expect(parseSubscriptions("x")).toBeNull();
  });
});

describe("git helpers", () => {
  test("parseGitHead and findPackedRef", () => {
    expect(parseGitHead("ref: refs/heads/main\n")).toEqual({ ref: "refs/heads/main" });
    expect(parseGitHead(`${PACK_REV}\n`)).toEqual({ sha: PACK_REV });
    expect(parseGitHead("garbage")).toBeNull();
    const packed = `# pack-refs with: peeled\n${PACK_REV} refs/heads/main\n^deadbeef\n`;
    expect(findPackedRef(packed, "refs/heads/main")).toBe(PACK_REV);
    expect(findPackedRef(packed, "refs/heads/dev")).toBeNull();
  });
});

function file(relativePath: string, overrides: Partial<InstructionFile> = {}): InstructionFile {
  return {
    path: `/repo/${relativePath}`,
    relativePath,
    kind: relativePath.endsWith("AGENTS.md") ? "agents-md" : "claude-md",
    depth: relativePath.split("/").length - 1,
    bytes: 10,
    lines: 3,
    tokens: 10,
    contentHash: relativePath,
    wrapperTarget: null,
    wrapperUsesImport: false,
    frontmatter: null,
    ...overrides,
  };
}

function block(source: string, body: string, overrides: Partial<ManagedBlock> = {}): ManagedBlock {
  const hash = hashBlockBody(body);
  return {
    file: "AGENTS.md",
    source,
    rev: "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    hash,
    bodyHash: hash,
    line: 3,
    endLine: 6,
    body,
    modified: false,
    ...overrides,
  };
}

function repo(
  name: string,
  shape: RepoForDistribution["shape"],
  overrides: Partial<RepoForDistribution> = {},
): RepoForDistribution {
  return {
    name,
    shape,
    bothFull: shape === "both-full" ? "merge" : null,
    files: [],
    blocks: [],
    blockIssues: [],
    foreignRegions: [],
    ...overrides,
  };
}

const REGION = {
  file: "AGENTS.md",
  name: "generated:task-matrix",
  line: 89,
  endLine: 105,
} as const;

describe("classifyPackStatus", () => {
  test("current, outdated, modified from the block in the root file", () => {
    const current = repo("acme/canonical", "agents-canonical", { blocks: [block("base", BODY)] });
    expect(classifyPackStatus(current, base)).toMatchObject({
      status: "current",
      file: "AGENTS.md",
      line: 3,
    });

    const outdated = repo("acme/canonical", "agents-canonical", {
      blocks: [block("base", OLD_BODY)],
    });
    expect(classifyPackStatus(outdated, base)).toMatchObject({
      status: "outdated",
      message: "rev 2222222 -> 1111111",
    });

    const modified = repo("acme/canonical", "agents-canonical", {
      blocks: [block("base", BODY, { bodyHash: "different", modified: true })],
    });
    expect(classifyPackStatus(modified, base).status).toBe("modified");
  });

  test("a marker problem in the file carrying an outdated block blocks the update too", () => {
    const issues = [
      { kind: "malformed-marker", file: "AGENTS.md", line: 11, message: "unpaired begin" },
      { kind: "foreign-marker", file: "CLAUDE.md", line: 1, message: "other file" },
    ] as const;
    const stale = repo("acme/canonical", "agents-canonical", {
      blocks: [block("base", OLD_BODY)],
      blockIssues: issues,
    });
    expect(classifyPackStatus(stale, base)).toEqual({
      repo: "acme/canonical",
      pack: "base",
      status: "blocked",
      file: "AGENTS.md",
      line: 11,
      message: "block at line 3 is outdated (rev 2222222 -> 1111111); unpaired begin",
    });

    // No write is pending for a current or a modified block, so the marker stays a repo note.
    const current = repo("acme/canonical", "agents-canonical", {
      blocks: [block("base", BODY)],
      blockIssues: issues,
    });
    expect(classifyPackStatus(current, base).status).toBe("current");
    const modified = repo("acme/canonical", "agents-canonical", {
      blocks: [block("base", BODY, { bodyHash: "different", modified: true })],
      blockIssues: issues,
    });
    expect(classifyPackStatus(modified, base).status).toBe("modified");
  });

  test("a block for the pack counts even when the repo is not subscribed", () => {
    const stray = repo("other/repo", "agents-only", { blocks: [block("base", BODY)] });
    expect(classifyPackStatus(stray, base).status).toBe("current");
  });

  test("blocks of other packs or in nested files do not count", () => {
    const other = repo("acme/canonical", "agents-canonical", {
      blocks: [block("frontend", BODY), block("base", BODY, { file: "apps/web/AGENTS.md" })],
    });
    expect(classifyPackStatus(other, base)).toMatchObject({
      status: "eligible",
      file: "AGENTS.md",
    });
  });

  test("eligible shapes carry the action a sync would take", () => {
    expect(classifyPackStatus(repo("acme/empty", "none"), base)).toMatchObject({
      status: "eligible",
      file: "AGENTS.md",
      line: null,
      message: "create AGENTS.md with the block and a CLAUDE.md wrapper",
    });
    const claudeOnly = repo("acme/claude", "claude-only", { files: [file(".claude/CLAUDE.md")] });
    expect(classifyPackStatus(claudeOnly, base)).toMatchObject({
      status: "eligible",
      file: ".claude/CLAUDE.md",
    });
    expect(classifyPackStatus(repo("acme/swap", "claude-canonical"), base).status).toBe("eligible");
  });

  test("both have content: eligible, and the message names the D12 normalization", () => {
    expect(classifyPackStatus(repo("acme/both", "both-full", { bothFull: "merge" }), base)).toEqual(
      {
        repo: "acme/both",
        pack: "base",
        status: "eligible",
        file: "AGENTS.md",
        line: null,
        message:
          "append CLAUDE.md content to AGENTS.md under `## Merged from CLAUDE.md`, add CLAUDE.md wrapper, insert block",
      },
    );
    expect(
      classifyPackStatus(repo("acme/both", "both-full", { bothFull: "wrapper" }), base),
    ).toMatchObject({
      status: "eligible",
      message:
        "CLAUDE.md repeats AGENTS.md: drop it, add CLAUDE.md wrapper, insert block into AGENTS.md",
    });
    // The message names the file that actually carries the content.
    const nested = repo("acme/both", "both-full", {
      bothFull: "wrapper",
      files: [file("AGENTS.md"), file(".claude/CLAUDE.md")],
    });
    expect(classifyPackStatus(nested, base).message).toStartWith(
      ".claude/CLAUDE.md repeats AGENTS.md: drop it, add CLAUDE.md wrapper",
    );
    // Both files are rewritten, so a marker in either one blocks.
    const marked = repo("acme/both", "both-full", {
      blockIssues: [{ kind: "foreign-marker", file: "CLAUDE.md", line: 2, message: "m" }],
    });
    expect(classifyPackStatus(marked, base)).toMatchObject({
      status: "blocked",
      file: "CLAUDE.md",
      line: 2,
    });
  });

  test("blocked: foreign or malformed markers in a file the sync would write", () => {
    const foreign = repo("acme/foreign", "agents-canonical", {
      blockIssues: [
        {
          kind: "foreign-marker",
          file: "AGENTS.md",
          line: 7,
          message: "another tool marks this file: <!-- generated -->",
        },
      ],
    });
    expect(classifyPackStatus(foreign, base)).toMatchObject({
      status: "blocked",
      file: "AGENTS.md",
      line: 7,
    });

    // A foreign marker in the wrapper is harmless when only AGENTS.md is written...
    const wrapperMarked = repo("acme/canonical", "agents-canonical", {
      blockIssues: [{ kind: "foreign-marker", file: "CLAUDE.md", line: 1, message: "m" }],
    });
    expect(classifyPackStatus(wrapperMarked, base).status).toBe("eligible");
    // ...but blocks a shape change that rewrites the pair.
    const swapMarked = repo("acme/swap", "claude-canonical", {
      blockIssues: [{ kind: "foreign-marker", file: "CLAUDE.md", line: 1, message: "m" }],
    });
    expect(classifyPackStatus(swapMarked, base)).toMatchObject({
      status: "blocked",
      file: "CLAUDE.md",
    });
  });

  test("not subscribed", () => {
    expect(classifyPackStatus(repo("other/repo", "none"), base)).toMatchObject({
      status: "not-subscribed",
      file: null,
    });
  });

  test("D15: well-formed regions in a kept AGENTS.md leave the row eligible or outdated", () => {
    const regions = [REGION, { ...REGION, name: "convex-ai", line: 173, endLine: 185 }];
    expect(
      classifyPackStatus(
        repo("acme/canonical", "agents-canonical", { foreignRegions: regions }),
        base,
      ),
    ).toEqual({
      repo: "acme/canonical",
      pack: "base",
      status: "eligible",
      file: "AGENTS.md",
      line: null,
      message: "insert block into AGENTS.md; 2 foreign regions stay untouched",
    });
    expect(
      classifyPackStatus(repo("acme/both", "both-full", { foreignRegions: [REGION] }), base)
        .message,
    ).toEndWith("insert block; 1 foreign region stays untouched");
    // An outdated block outside the regions is replaced in place.
    const outdated = repo("acme/canonical", "agents-canonical", {
      blocks: [block("base", OLD_BODY)],
      foreignRegions: regions,
    });
    expect(classifyPackStatus(outdated, base)).toMatchObject({
      status: "outdated",
      message: "rev 2222222 -> 1111111; 2 foreign regions stay untouched",
    });
  });

  test("D15: a region in a file the plan moves, drops, or replaces blocks", () => {
    const claudeRegion = { ...REGION, file: "CLAUDE.md", name: "convex-ai", line: 3, endLine: 9 };
    const message =
      "another tool owns lines 3-9 of CLAUDE.md (region `convex-ai`); the sync would rewrite that file";
    // both-full: CLAUDE.md becomes the wrapper, so its region would be merged or dropped.
    expect(
      classifyPackStatus(repo("acme/both", "both-full", { foreignRegions: [claudeRegion] }), base),
    ).toEqual({
      repo: "acme/both",
      pack: "base",
      status: "blocked",
      file: "CLAUDE.md",
      line: 3,
      message,
    });
    // claude-only / claude-canonical move the content file; a region in either root file blocks.
    expect(
      classifyPackStatus(
        repo("acme/claude", "claude-only", { foreignRegions: [claudeRegion] }),
        base,
      ).status,
    ).toBe("blocked");
    expect(
      classifyPackStatus(repo("acme/swap", "claude-canonical", { foreignRegions: [REGION] }), base),
    ).toMatchObject({ status: "blocked", file: "AGENTS.md", line: 89 });
    // The untouched wrapper may carry a region.
    expect(
      classifyPackStatus(
        repo("acme/canonical", "agents-canonical", { foreignRegions: [claudeRegion] }),
        base,
      ).status,
    ).toBe("eligible");
  });

  test("D15: an outdated block inside a region blocks at the region", () => {
    const inside = repo("acme/canonical", "agents-canonical", {
      blocks: [block("base", OLD_BODY, { line: 92, endLine: 95 })],
      foreignRegions: [REGION],
    });
    expect(classifyPackStatus(inside, base)).toEqual({
      repo: "acme/canonical",
      pack: "base",
      status: "blocked",
      file: "AGENTS.md",
      line: 89,
      message:
        "block at line 92 is outdated (rev 2222222 -> 1111111); it overlaps the region `generated:task-matrix` (lines 89-105) another tool owns",
    });
    // A block that starts inside the region and ends outside it is blocked the same way.
    const straddling = repo("acme/canonical", "agents-canonical", {
      blocks: [block("base", OLD_BODY, { line: 104, endLine: 108 })],
      foreignRegions: [REGION],
    });
    expect(classifyPackStatus(straddling, base)).toMatchObject({ status: "blocked", line: 89 });
    // Current and modified blocks inside a region need no write: no block.
    const current = repo("acme/canonical", "agents-canonical", {
      blocks: [block("base", BODY, { line: 92, endLine: 95 })],
      foreignRegions: [REGION],
    });
    expect(classifyPackStatus(current, base).status).toBe("current");
  });
});

describe("distribute", () => {
  test("every repo appears once per pack, most urgent first, with counts", () => {
    const frontend = packFromFiles(
      "frontend",
      null,
      [{ path: "AGENTS.md", content: "React." }],
      [],
    );
    const repos = [
      repo("acme/canonical", "agents-canonical", { blocks: [block("base", OLD_BODY)] }),
      repo("acme/foreign", "agents-canonical", {
        blockIssues: [{ kind: "foreign-marker", file: "AGENTS.md", line: 1, message: "m" }],
      }),
      repo("acme/both", "both-full"),
      repo("acme/empty", "none"),
      repo("other/repo", "none"),
    ];
    const distribution = distribute("/packs", repos, [base, frontend]);
    expect(distribution.entries.map((e) => `${e.pack}:${e.repo}=${e.status}`)).toEqual([
      "base:acme/canonical=outdated",
      "base:acme/foreign=blocked",
      "base:acme/both=eligible",
      "base:acme/empty=eligible",
      "base:other/repo=not-subscribed",
      "frontend:acme/both=not-subscribed",
      "frontend:acme/canonical=not-subscribed",
      "frontend:acme/empty=not-subscribed",
      "frontend:acme/foreign=not-subscribed",
      "frontend:other/repo=not-subscribed",
    ]);
    expect(distribution.counts).toEqual({
      current: 0,
      outdated: 1,
      modified: 0,
      eligible: 2,
      blocked: 1,
      "not-subscribed": 6,
    });
    expect(distribution.warnings).toEqual([]);
    expect(distribution.personalCopies).toEqual([]);
    expect(distribute("/packs", [], [], ["bad subscriptions"]).warnings).toEqual([
      "bad subscriptions",
    ]);
  });
});

describe("findPersonalPackCopies", () => {
  const personalFile = (relativePath: string, contentHash: string, kind = "imported-md") =>
    file(relativePath, { kind: kind as InstructionFile["kind"], contentHash, depth: 0 });
  const repos = [
    repo("acme/current", "agents-canonical", { blocks: [block("base", BODY)] }),
    repo("acme/outdated", "agents-canonical", {
      blocks: [block("base", OLD_BODY)],
      blockIssues: [{ kind: "malformed-marker", file: "AGENTS.md", line: 9, message: "m" }],
    }),
    repo("acme/nested", "agents-canonical", {
      blocks: [{ ...block("base", BODY), file: "packages/x/AGENTS.md" }],
    }),
    repo("acme/none", "none"),
  ];

  test("a personal file equal to the pack body is a current copy, wherever it lives", () => {
    const personal = [
      personalFile("~/.claude/CLAUDE.md", "other", "claude-md"),
      personalFile("~/notes/pack-copy.md", hashBlockBody(BODY)),
      personalFile("~/AGENTS.md", hashBlockBody(BODY), "agents-md"),
    ];
    expect(findPersonalPackCopies(personal, [base], repos)).toEqual([
      {
        pack: "base",
        file: "~/notes/pack-copy.md",
        kind: "imported-md",
        state: "current",
        doubleLoaded: ["acme/current", "acme/outdated"],
      },
      {
        pack: "base",
        file: "~/AGENTS.md",
        kind: "agents-md",
        state: "current",
        doubleLoaded: ["acme/current", "acme/outdated"],
      },
    ]);
  });

  test("the pack's own source path with another hash is stale; other files are not guessed", () => {
    const personal = [
      personalFile(
        "~/ghq/github.com/acme/agent-rules/packs/base/AGENTS.md",
        hashBlockBody(OLD_BODY),
      ),
      personalFile(
        "~/ghq/github.com/acme/agent-rules/packs/other/AGENTS.md",
        hashBlockBody(OLD_BODY),
      ),
      personalFile("~/notes/global.md", "unrelated"),
    ];
    expect(findPersonalPackCopies(personal, [base], repos)).toEqual([
      {
        pack: "base",
        file: "~/ghq/github.com/acme/agent-rules/packs/base/AGENTS.md",
        kind: "imported-md",
        state: "stale",
        doubleLoaded: ["acme/current", "acme/outdated"],
      },
    ]);
  });

  test("a pack without an AGENTS.md block has nothing to copy", () => {
    const filesOnly = packFromFiles("skills", null, [{ path: "x/SKILL.md", content: "s" }], []);
    const personal = [personalFile("~/x", hashBlockBody(BODY))];
    expect(findPersonalPackCopies(personal, [filesOnly], repos)).toEqual([]);
    expect(distribute("/packs", repos, [base], [], personal).personalCopies).toHaveLength(1);
  });
});

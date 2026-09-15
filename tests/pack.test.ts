import { describe, expect, test } from "bun:test";
import { hashBlockBody } from "../src/domain/block.ts";
import {
  classifyPackStatus,
  distribute,
  findPackedRef,
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
  return { name, shape, files: [], blocks: [], blockIssues: [], ...overrides };
}

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

  test("blocked: both have content, foreign or malformed markers in a file the sync would write", () => {
    expect(classifyPackStatus(repo("acme/both", "both-full"), base)).toMatchObject({
      status: "blocked",
      file: "AGENTS.md",
      line: 1,
    });

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
      repo("acme/both", "both-full"),
      repo("acme/empty", "none"),
      repo("other/repo", "none"),
    ];
    const distribution = distribute("/packs", repos, [base, frontend]);
    expect(distribution.entries.map((e) => `${e.pack}:${e.repo}=${e.status}`)).toEqual([
      "base:acme/canonical=outdated",
      "base:acme/both=blocked",
      "base:acme/empty=eligible",
      "base:other/repo=not-subscribed",
      "frontend:acme/both=not-subscribed",
      "frontend:acme/canonical=not-subscribed",
      "frontend:acme/empty=not-subscribed",
      "frontend:other/repo=not-subscribed",
    ]);
    expect(distribution.counts).toEqual({
      current: 0,
      outdated: 1,
      modified: 0,
      eligible: 1,
      blocked: 1,
      "not-subscribed": 5,
    });
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  findForeignMarkers,
  foreignRegionDrift,
  hashBlockBody,
  parseBlocks,
} from "../src/domain/block.ts";

const BODY = "- Respond in Japanese.\n- Use Bun.";
const HASH = hashBlockBody(BODY);

function block(source: string, body: string, extra = ` rev=abc1234 hash=${hashBlockBody(body)}`) {
  return `<!-- agent-rules:begin source=${source}${extra} -->\n${body}\n<!-- agent-rules:end -->`;
}

describe("hashBlockBody", () => {
  test("ignores line endings and surrounding blank lines", () => {
    expect(hashBlockBody(`\n\n${BODY.replace(/\n/g, "\r\n")}\n`)).toBe(HASH);
  });

  test("changes when the text changes", () => {
    expect(hashBlockBody(`${BODY} `)).toBe(HASH);
    expect(hashBlockBody(`${BODY}!`)).not.toBe(HASH);
  });
});

describe("parseBlocks", () => {
  test("parses a well-formed block and its attributes", () => {
    const content = `# Repo\n\n${block("base", BODY)}\n\n## Own section\n`;
    const { blocks, issues } = parseBlocks("AGENTS.md", content);
    expect(issues).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      file: "AGENTS.md",
      source: "base",
      rev: "abc1234",
      hash: HASH,
      bodyHash: HASH,
      line: 3,
      endLine: 6,
      body: BODY,
      modified: false,
    });
  });

  test("multiple blocks in one file keep their order", () => {
    const content = `${block("base", BODY)}\n\n${block("frontend", "React rules.")}\n`;
    const { blocks } = parseBlocks("AGENTS.md", content);
    expect(blocks.map((b) => b.source)).toEqual(["base", "frontend"]);
    expect(blocks.map((b) => b.line)).toEqual([1, 6]);
  });

  test("flags an edited body as modified", () => {
    const content = block("base", `${BODY}\n- Added by hand.`, ` hash=${HASH}`);
    const { blocks } = parseBlocks("AGENTS.md", content);
    expect(blocks[0]?.modified).toBe(true);
    expect(blocks[0]?.rev).toBeNull();
  });

  test("accepts quoted values and unknown attributes", () => {
    const content = block("base", BODY, ` extra=1 hash="${HASH}" rev='deadbeef'`);
    const { blocks, issues } = parseBlocks("AGENTS.md", content);
    expect(issues).toEqual([]);
    expect(blocks[0]).toMatchObject({ source: "base", rev: "deadbeef", modified: false });
  });

  test("reports unpaired and nested markers with file:line", () => {
    const content = [
      "<!-- agent-rules:end -->",
      `<!-- agent-rules:begin source=base hash=${HASH} -->`,
      "body",
      `<!-- agent-rules:begin source=other hash=${HASH} -->`,
      "body",
      "<!-- agent-rules:end -->",
      "<!-- agent-rules:begin source=late -->",
      `<!-- agent-rules:begin source=open hash=${HASH} -->`,
      "never closed",
    ].join("\n");
    const { blocks, issues } = parseBlocks("AGENTS.md", content);
    expect(blocks.map((b) => b.source)).toEqual(["other"]);
    expect(issues.map((i) => `${i.line}:${i.message}`)).toEqual([
      "1:`agent-rules:end` without a matching `agent-rules:begin`",
      "4:`agent-rules:begin` inside the block opened at line 2; blocks do not nest",
      "7:`agent-rules:begin` is missing hash=",
      "8:`agent-rules:begin` without a matching `agent-rules:end`",
    ]);
  });

  test("unknown agent-rules markers are malformed", () => {
    const { issues } = parseBlocks("AGENTS.md", "<!-- agent-rules:start source=x -->");
    expect(issues.map((i) => i.kind)).toEqual(["malformed-marker"]);
  });

  test("plain comments and text are not blocks", () => {
    const { blocks, issues } = parseBlocks("AGENTS.md", "<!-- note -->\nagent-rules:begin\n");
    expect(blocks).toEqual([]);
    expect(issues).toEqual([]);
  });
});

const COBRACKET = readFileSync(new URL("./fixtures/cobracket-AGENTS.md", import.meta.url), "utf8");

describe("findForeignMarkers", () => {
  test("well-formed pairs are regions, not issues; both vocabularies pair by name", () => {
    const content = [
      "<!-- stripe-projects-cli managed:claude-md:start -->",
      "look at AGENTS.md",
      "<!-- stripe-projects-cli managed:claude-md:end -->",
      "<!-- BEGIN_TF_DOCS -->",
      "terraform docs",
      "<!-- END_TF_DOCS -->",
      "<!-- BEGIN: toc -->",
      "<!-- END: toc -->",
      "<!-- convex-ai-start -->",
      "<!-- Convex-AI-END -->",
    ].join("\n");
    const { regions, issues } = findForeignMarkers("CLAUDE.md", content);
    expect(issues).toEqual([]);
    expect(regions).toEqual([
      { file: "CLAUDE.md", name: "stripe-projects-cli managed:claude-md", line: 1, endLine: 3 },
      { file: "CLAUDE.md", name: "TF_DOCS", line: 4, endLine: 6 },
      { file: "CLAUDE.md", name: "toc", line: 7, endLine: 8 },
      { file: "CLAUDE.md", name: "convex-ai", line: 9, endLine: 10 },
    ]);
  });

  test("the real cobracket AGENTS.md: four regions, no issue, the inner do-not-edit line is opaque", () => {
    const { regions, issues } = findForeignMarkers("AGENTS.md", COBRACKET);
    expect(issues).toEqual([]);
    expect(regions.map((r) => `${r.name}@${r.line}-${r.endLine}`)).toEqual([
      "generated:task-matrix@89-105",
      "solid2-agent-kit:agents-section@127-139",
      "fallow:setup-hooks@143-171",
      "convex-ai@173-185",
    ]);
    expect(COBRACKET.split("\n")[127]).toStartWith("<!-- Managed by solid2-agent-kit");
  });

  test("a file-level marker blocks the whole file", () => {
    const content =
      "<!-- Generated by Skiller -->\n# Rules\n<!-- This file is auto-generated. Do not edit. -->\n";
    const { regions, issues } = findForeignMarkers("AGENTS.md", content);
    expect(regions).toEqual([]);
    expect(issues.map((i) => `${i.line}:${i.message}`)).toEqual([
      "1:another tool marks the whole file (no closing marker): <!-- Generated by Skiller -->",
      "3:another tool marks the whole file (no closing marker): <!-- This file is auto-generated. Do not edit. -->",
    ]);
    expect(issues[0]?.kind).toBe("foreign-marker");
  });

  test("unpaired markers are issues with file:line", () => {
    const { regions, issues } = findForeignMarkers(
      "AGENTS.md",
      "<!-- END: tail -->\n# P\n<!-- generated:task-matrix:start -->\n| a | b |\n",
    );
    expect(regions).toEqual([]);
    expect(issues.map((i) => `${i.line}:${i.message}`)).toEqual([
      "1:unpaired region marker <!-- END: tail --> has no opening marker",
      "3:unpaired region marker <!-- generated:task-matrix:start --> has no closing marker; the region it opens cannot be told from the rest of the file",
    ]);
  });

  test("nested and mismatched markers are issues; the outer pair still closes", () => {
    const content = [
      "<!-- a:start -->",
      "<!-- b:start -->",
      "inner",
      "<!-- b:end -->",
      "<!-- a:end -->",
      "<!-- c:start -->",
      "<!-- d:end -->",
      "<!-- c:end -->",
    ].join("\n");
    const { regions, issues } = findForeignMarkers("AGENTS.md", content);
    expect(regions.map((r) => `${r.name}@${r.line}-${r.endLine}`)).toEqual(["a@1-5", "c@6-8"]);
    expect(issues.map((i) => `${i.line}:${i.message}`)).toEqual([
      "2:region marker <!-- b:start --> opens inside the region started at line 1; nested regions are not supported",
      "4:region marker <!-- b:end --> does not close the region started at line 1 (<!-- a:start -->)",
      "7:region marker <!-- d:end --> does not close the region started at line 6 (<!-- c:start -->)",
    ]);
  });

  test("separators and case do not matter for pairing", () => {
    const { regions, issues } = findForeignMarkers(
      "AGENTS.md",
      "<!-- BEGIN_TF_DOCS -->\nx\n<!-- END TF-DOCS -->\n<!-- Fallow:Setup Hooks:start -->\n<!-- fallow-setup-hooks-end -->",
    );
    expect(issues).toEqual([]);
    expect(regions.map((r) => r.name)).toEqual(["TF_DOCS", "Fallow:Setup Hooks"]);
  });

  test("a file-level marker inside a region is opaque only when it names the region's owner", () => {
    const owned = [
      "<!-- solid2-agent-kit:agents-section:start -->",
      "<!-- Managed by solid2-agent-kit v0.11.1. Do not edit inside this block. -->",
      "<!-- solid2-agent-kit:agents-section:end -->",
      "<!-- BEGIN_TF_DOCS -->",
      "<!-- This file is generated by terraform-docs. Do not edit. -->",
      "<!-- END_TF_DOCS -->",
    ].join("\n");
    expect(findForeignMarkers("AGENTS.md", owned).issues).toEqual([]);

    const third = [
      "<!-- Setup Hooks:start -->",
      "<!-- Generated by CoolGen. Do not edit. -->",
      "some content",
      "<!-- setup_hooks-end -->",
    ].join("\n");
    const { regions, issues } = findForeignMarkers("AGENTS.md", third);
    expect(regions).toHaveLength(1);
    expect(issues.map((i) => `${i.line}:${i.message}`)).toEqual([
      "2:marker inside the region `Setup Hooks` (line 1) does not name that region's owner, so it may mark the whole file: <!-- Generated by CoolGen. Do not edit. -->",
    ]);

    // Sharing only the file-marker vocabulary, or a fragment of a longer word, names nothing.
    const generic = [
      "<!-- generated:task-matrix:start -->",
      "<!-- Generated by Skiller. Do not edit. -->",
      "<!-- generated:task-matrix:end -->",
      "<!-- stripe-projects-cli managed:agents-md:start -->",
      "<!-- Managed by ruler; do not edit -->",
      "<!-- stripe-projects-cli managed:agents-md:end -->",
      "<!-- kit:start -->",
      "<!-- Generated by toolkit -->",
      "<!-- kit:end -->",
    ].join("\n");
    expect(findForeignMarkers("AGENTS.md", generic).issues.map((i) => i.line)).toEqual([2, 5, 8]);
  });

  test("formatter and linter skip directives are not regions and hide nothing", () => {
    const content = [
      "# Rules",
      "<!-- prettier-ignore-start -->",
      "<!-- Generated by Skiller -->",
      "| a | b |",
      "<!-- prettier-ignore-end -->",
      "<!-- markdownlint-disable-start -->",
      "<!-- markdownlint-disable-end -->",
    ].join("\n");
    const { regions, issues } = findForeignMarkers("AGENTS.md", content);
    expect(regions).toEqual([]);
    expect(issues.map((i) => i.line)).toEqual([3]);
  });

  test("the body of our own block is never read as a foreign marker", () => {
    const body =
      "Docs say:\n<!-- toc:start -->\nold toc\n<!-- toc:end -->\n<!-- generated by hand -->";
    const before = `# P\n\n${block("base", body)}\n`;
    expect(findForeignMarkers("AGENTS.md", before)).toEqual({ regions: [], issues: [] });
    const after = before.replace("old toc", "new toc");
    expect(foreignRegionDrift("AGENTS.md", before, after)).toBeNull();
    // A region wrapped around our block by another tool is still a region.
    const wrapped = `<!-- x:start -->\n${block("base", body)}\n<!-- x:end -->\n`;
    expect(findForeignMarkers("AGENTS.md", wrapped).regions).toHaveLength(1);
  });

  test("ignores our own markers, prose comments, and lowercase begin", () => {
    const content = [
      `<!-- agent-rules:begin source=base hash=${HASH} -->`,
      "<!-- agent-rules:end -->",
      "<!-- TODO: expand this section -->",
      "<!-- begin with the build step -->",
      "<!-- the end -->",
      "<!-- this is not",
      "a single-line comment -->",
    ].join("\n");
    expect(findForeignMarkers("AGENTS.md", content)).toEqual({ regions: [], issues: [] });
  });
});

describe("foreignRegionDrift", () => {
  const region = "<!-- x:start -->\nowned\n<!-- x:end -->";

  test("null when regions are untouched, wherever the rest of the file changes", () => {
    expect(foreignRegionDrift("AGENTS.md", null, "anything")).toBeNull();
    expect(foreignRegionDrift("AGENTS.md", "# P\n", "# Q\n")).toBeNull();
    expect(
      foreignRegionDrift("AGENTS.md", `# P\n${region}\n`, `# Q\n\n${region}\n\nblock\n`),
    ).toBeNull();
  });

  test("names the region that would change, be removed, or be miscounted", () => {
    expect(
      foreignRegionDrift("AGENTS.md", `${region}\n`, `${region.replace("owned", "edited")}\n`),
    ).toBe("AGENTS.md: the region `x` another tool owns would change");
    expect(foreignRegionDrift("CLAUDE.md", `${region}\n`, null)).toBe(
      "CLAUDE.md would be removed together with the region `x` another tool owns",
    );
    expect(foreignRegionDrift("CLAUDE.md", `${region}\n`, "@AGENTS.md\n")).toBe(
      "CLAUDE.md would carry 0 foreign region(s) instead of 1",
    );
    // A block inserted inside the region changes its bytes.
    expect(
      foreignRegionDrift(
        "AGENTS.md",
        `${region}\n`,
        "<!-- x:start -->\nowned\nblock\n<!-- x:end -->\n",
      ),
    ).toBe("AGENTS.md: the region `x` another tool owns would change");
  });
});

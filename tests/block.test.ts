import { describe, expect, test } from "bun:test";
import { findForeignMarkers, hashBlockBody, parseBlocks } from "../src/domain/block.ts";

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

describe("findForeignMarkers", () => {
  test("recognizes managed regions of other tools", () => {
    const content = [
      "<!-- stripe-projects-cli managed:claude-md:start -->",
      "look at AGENTS.md",
      "<!-- stripe-projects-cli managed:claude-md:end -->",
      "<!-- BEGIN_TF_DOCS -->",
      "<!-- This file is auto-generated. Do not edit. -->",
    ].join("\n");
    expect(findForeignMarkers("CLAUDE.md", content).map((i) => i.line)).toEqual([1, 3, 4, 5]);
  });

  test("ignores our own markers, prose comments, and lowercase begin", () => {
    const content = [
      `<!-- agent-rules:begin source=base hash=${HASH} -->`,
      "<!-- agent-rules:end -->",
      "<!-- TODO: expand this section -->",
      "<!-- begin with the build step -->",
      "<!-- this is not",
      "a single-line comment -->",
    ].join("\n");
    expect(findForeignMarkers("AGENTS.md", content)).toEqual([]);
  });
});

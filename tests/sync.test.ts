import { describe, expect, test } from "bun:test";
import { hashBlockBody, parseBlocks } from "../src/domain/block.ts";
import { diffStats, unifiedDiff } from "../src/domain/diff.ts";
import { packFromFiles } from "../src/domain/pack.ts";
import {
  MERGED_HEADING,
  mergeClaudeContent,
  planSync,
  pullRequestText,
  renderBlock,
  type SyncPlanInput,
  WRAPPER_CONTENT,
} from "../src/domain/sync.ts";
import type { InstructionFile, ManagedBlock, PackStatusEntry } from "../src/domain/types.ts";

const BODY = "- Respond in Japanese.\n- Use Bun.";
const OLD_BODY = "- Respond in Japanese.";
const REV = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = packFromFiles("base", REV, [{ path: "AGENTS.md", content: `${BODY}\n` }], ["acme/x"]);
const frontend = packFromFiles("frontend", REV, [{ path: "AGENTS.md", content: "React.\n" }], []);
const BLOCK = `<!-- agent-rules:begin source=base rev=${REV} hash=${hashBlockBody(BODY)} -->\n${BODY}\n<!-- agent-rules:end -->`;

function file(relativePath: string, overrides: Partial<InstructionFile> = {}): InstructionFile {
  return {
    path: `/repo/${relativePath}`,
    relativePath,
    kind: relativePath.endsWith("AGENTS.md") ? "agents-md" : "claude-md",
    depth: relativePath.split("/").length - 1,
    bytes: 1,
    lines: 1,
    tokens: 1,
    contentHash: relativePath,
    wrapperTarget: null,
    wrapperUsesImport: false,
    frontmatter: null,
    ...overrides,
  };
}

function status(kind: PackStatusEntry["status"], file = "AGENTS.md"): PackStatusEntry {
  return { repo: "acme/x", pack: "base", status: kind, file, line: null, message: "m" };
}

function input(
  shape: SyncPlanInput["shape"],
  contents: Record<string, string>,
  overrides: Partial<SyncPlanInput> = {},
): SyncPlanInput {
  const files = Object.keys(contents).map((path) => file(path));
  const blocks: ManagedBlock[] = [];
  for (const [path, content] of Object.entries(contents)) {
    blocks.push(...parseBlocks(path, content).blocks);
  }
  return {
    shape,
    files,
    contents: new Map(Object.entries(contents)),
    blocks,
    status: status("eligible"),
    pack: base,
    packOrder: ["base", "frontend"],
    ...overrides,
  };
}

function plan(i: SyncPlanInput) {
  const result = planSync(i);
  if ("reason" in result) throw new Error(`refused: ${result.reason}`);
  return result;
}

describe("renderBlock", () => {
  test("writes D9 markers around the normalized body; the reader accepts it as current", () => {
    expect(renderBlock(base)).toBe(BLOCK);
    const parsed = parseBlocks("AGENTS.md", `${renderBlock(base)}\n`);
    expect(parsed.blocks[0]).toMatchObject({ source: "base", rev: REV, modified: false });
    expect(
      renderBlock(packFromFiles("base", null, [{ path: "AGENTS.md", content: BODY }], [])),
    ).not.toContain("rev=");
    expect(
      renderBlock(packFromFiles("empty", null, [{ path: "x.md", content: "" }], [])),
    ).toBeNull();
  });
});

describe("planSync", () => {
  test("none: creates AGENTS.md with the block and the CLAUDE.md wrapper", () => {
    const p = plan(input("none", {}));
    expect(p.changes).toEqual([
      { path: "AGENTS.md", before: null, after: `${BLOCK}\n` },
      { path: "CLAUDE.md", before: null, after: WRAPPER_CONTENT },
    ]);
    expect(p.blockFile).toBe("AGENTS.md");
    expect(p.blockLine).toBe(1);
  });

  test("agents-only: appends the block after the project content and adds the wrapper", () => {
    const p = plan(input("agents-only", { "AGENTS.md": "# Project\n\nOwn rules.\n\n\n" }));
    expect(p.changes[0]?.after).toBe(`# Project\n\nOwn rules.\n\n${BLOCK}\n`);
    expect(p.changes[1]).toEqual({ path: "CLAUDE.md", before: null, after: WRAPPER_CONTENT });
    expect(p.blockLine).toBe(5);
    expect(p.actions).toEqual([
      "insert block `base` into AGENTS.md",
      "create CLAUDE.md wrapper (`@AGENTS.md`)",
    ]);
  });

  test("agents-canonical: touches only AGENTS.md", () => {
    const p = plan(
      input("agents-canonical", { "AGENTS.md": "# P\n", "CLAUDE.md": "@AGENTS.md\n" }),
    );
    expect(p.changes.map((c) => c.path)).toEqual(["AGENTS.md"]);
  });

  test("claude-only: moves CLAUDE.md content into AGENTS.md and leaves the wrapper behind", () => {
    const p = plan(input("claude-only", { "CLAUDE.md": "# From Claude\n" }));
    expect(p.changes).toEqual([
      { path: "AGENTS.md", before: null, after: `# From Claude\n\n${BLOCK}\n` },
      { path: "CLAUDE.md", before: "# From Claude\n", after: WRAPPER_CONTENT },
    ]);
    expect(p.actions[0]).toBe("move CLAUDE.md content to AGENTS.md");
  });

  test("claude-only with .claude/CLAUDE.md: removes it and creates the root wrapper", () => {
    const p = plan(input("claude-only", { ".claude/CLAUDE.md": "# Nested\n" }));
    expect(p.changes).toEqual([
      { path: "AGENTS.md", before: null, after: `# Nested\n\n${BLOCK}\n` },
      { path: ".claude/CLAUDE.md", before: "# Nested\n", after: null },
      { path: "CLAUDE.md", before: null, after: WRAPPER_CONTENT },
    ]);
  });

  test("claude-canonical: swaps the pair", () => {
    const i = input("claude-canonical", {
      "AGENTS.md": "see CLAUDE.md\n",
      "CLAUDE.md": "# Real\n",
    });
    const files = i.files.map((f) =>
      f.relativePath === "AGENTS.md" ? { ...f, wrapperTarget: "CLAUDE.md" as const } : f,
    );
    const p = plan({ ...i, files });
    expect(p.changes).toEqual([
      { path: "AGENTS.md", before: "see CLAUDE.md\n", after: `# Real\n\n${BLOCK}\n` },
      { path: "CLAUDE.md", before: "# Real\n", after: WRAPPER_CONTENT },
    ]);
    // Without the wrapper evidence the shape does not match the files; refuse rather than overwrite.
    expect(planSync(i)).toEqual({
      reason: "root files do not match shape `claude-canonical`; rescan the repository",
    });
  });

  test("both-full, CLAUDE.md repeats AGENTS.md: the wrapper replaces it, nothing is merged", () => {
    const agents = "# P\n\n- Use Bun.\n";
    const p = plan(
      input("both-full", { "AGENTS.md": agents, "CLAUDE.md": "@AGENTS.md\n\n- Use Bun.\n" }),
    );
    expect(p.changes).toEqual([
      { path: "AGENTS.md", before: agents, after: `# P\n\n- Use Bun.\n\n${BLOCK}\n` },
      { path: "CLAUDE.md", before: "@AGENTS.md\n\n- Use Bun.\n", after: WRAPPER_CONTENT },
    ]);
    expect(p.actions).toEqual([
      "drop CLAUDE.md content, which AGENTS.md already contains",
      "insert block `base` into AGENTS.md",
      "replace CLAUDE.md with the wrapper (`@AGENTS.md`)",
    ]);
    expect(p.blockLine).toBe(5);
  });

  test("both-full, CLAUDE.md differs: its text lands under the merge heading, before any block", () => {
    const frontendBlock = renderBlock(frontend) ?? "";
    const agents = `# P\n\n- Use Bun.\n${frontendBlock}\n`;
    const claude = "@AGENTS.md\n\n# Claude notes\n\n- Use npm.\n";
    const p = plan(input("both-full", { "AGENTS.md": agents, "CLAUDE.md": claude }));
    expect(p.changes[0]?.after).toBe(
      `# P\n\n- Use Bun.\n\n## Merged from CLAUDE.md\n\n# Claude notes\n\n- Use npm.\n\n${BLOCK}\n\n${frontendBlock}\n`,
    );
    expect(p.changes[1]).toEqual({ path: "CLAUDE.md", before: claude, after: WRAPPER_CONTENT });
    expect(p.actions[0]).toBe(
      "append CLAUDE.md content to AGENTS.md under `## Merged from CLAUDE.md` (verbatim, before any managed block; duplicates or conflicts with the text above it are left for review)",
    );
    expect(p.blockLine).toBe(11);
    const sources = parseBlocks("AGENTS.md", p.changes[0]?.after ?? "").blocks.map((b) => b.source);
    expect(sources).toEqual(["base", "frontend"]);

    // Without blocks the merged text goes to the end; a nested CLAUDE.md is removed instead.
    const q = plan(input("both-full", { "AGENTS.md": "# P\n", ".claude/CLAUDE.md": "Own.\n" }));
    expect(q.changes).toEqual([
      {
        path: "AGENTS.md",
        before: "# P\n",
        after: `# P\n\n${MERGED_HEADING}\n\nOwn.\n\n${BLOCK}\n`,
      },
      { path: ".claude/CLAUDE.md", before: "Own.\n", after: null },
      { path: "CLAUDE.md", before: null, after: WRAPPER_CONTENT },
    ]);
    expect(pullRequestText(q, base, status("eligible")).body).toContain(
      "- append .claude/CLAUDE.md content to AGENTS.md under `## Merged from CLAUDE.md`",
    );
  });

  test("mergeClaudeContent keeps a blank line before the heading and before a following block", () => {
    expect(mergeClaudeContent("", "X")).toBe(`${MERGED_HEADING}\n\nX\n`);
    expect(mergeClaudeContent("# P\n\n\n", "X")).toBe(`# P\n\n${MERGED_HEADING}\n\nX\n`);
    expect(mergeClaudeContent(`# P\n${BLOCK}\n`, "X")).toBe(
      `# P\n\n${MERGED_HEADING}\n\nX\n\n${BLOCK}\n`,
    );
  });

  test("refuses both CLAUDE.md files and files that contradict the shape", () => {
    expect(
      planSync(input("claude-only", { "CLAUDE.md": "a\n", ".claude/CLAUDE.md": "b\n" })),
    ).toEqual({
      reason: "both CLAUDE.md and .claude/CLAUDE.md exist; keep one before syncing",
    });
    expect(
      planSync(
        input("both-full", { "AGENTS.md": "a\n", "CLAUDE.md": "b\n", ".claude/CLAUDE.md": "c\n" }),
      ),
    ).toEqual({
      reason: "both CLAUDE.md and .claude/CLAUDE.md exist; keep one before syncing",
    });
    expect("reason" in planSync(input("both-full", { "CLAUDE.md": "b\n" }))).toBe(true);
    expect("reason" in planSync(input("none", { "AGENTS.md": "a\n" }))).toBe(true);
    expect(
      "reason" in planSync(input("agents-only", { "AGENTS.md": "a\n", "CLAUDE.md": "b\n" })),
    ).toBe(true);
    expect(planSync(input("none", {}, { status: status("blocked") }))).toEqual({
      reason: "status is blocked; only eligible and outdated repositories are written",
    });
  });

  test("a new block goes before existing blocks of later packs, after earlier ones", () => {
    const frontendBlock = renderBlock(frontend) ?? "";
    const content = `# P\n\n${frontendBlock}\n`;
    const p = plan(
      input("agents-canonical", { "AGENTS.md": content, "CLAUDE.md": "@AGENTS.md\n" }),
    );
    expect(p.changes[0]?.after).toBe(`# P\n\n${BLOCK}\n\n${frontendBlock}\n`);
    expect(p.blockLine).toBe(3);
    const sources = parseBlocks("AGENTS.md", p.changes[0]?.after ?? "").blocks.map((b) => b.source);
    expect(sources).toEqual(["base", "frontend"]);

    // frontend arriving after base is appended.
    const baseFirst = `# P\n\n${BLOCK}\n`;
    const q = plan(
      input(
        "agents-canonical",
        { "AGENTS.md": baseFirst, "CLAUDE.md": "@AGENTS.md\n" },
        { pack: frontend },
      ),
    );
    expect(q.changes[0]?.after).toBe(`# P\n\n${BLOCK}\n\n${frontendBlock}\n`);
  });

  test("outdated: replaces the block in place and keeps everything around it", () => {
    const oldBlock = `<!-- agent-rules:begin source=base rev=old hash=${hashBlockBody(OLD_BODY)} -->\n${OLD_BODY}\n<!-- agent-rules:end -->`;
    const content = `# P\n\n${oldBlock}\n\n## After\n`;
    const p = plan(
      input(
        "agents-canonical",
        { "AGENTS.md": content, "CLAUDE.md": "@AGENTS.md\n" },
        { status: status("outdated") },
      ),
    );
    expect(p.changes).toEqual([
      { path: "AGENTS.md", before: content, after: `# P\n\n${BLOCK}\n\n## After\n` },
    ]);
    expect(p.actions).toEqual(["update block `base` in AGENTS.md"]);
    expect(p.blockLine).toBe(3);
  });
});

describe("pullRequestText", () => {
  test("names the pack, rev, hash, and the actions", () => {
    const p = plan(input("none", {}));
    const text = pullRequestText(p, base, status("eligible"));
    expect(text.title).toBe("chore(agent-rules): add `base` instruction block");
    expect(text.body).toContain(`- rev: \`${REV}\``);
    expect(text.body).toContain(`- hash: \`${hashBlockBody(BODY)}\``);
    expect(text.body).toContain("- create AGENTS.md with block `base`");
    expect(text.body).toContain(
      "its root pair is `AGENTS.md` canonical (already, or by the changes above)",
    );
    const update = pullRequestText(p, base, status("outdated"));
    expect(update.title).toContain("update");
    // An update never normalizes the pair, so the body must not claim a canonical shape.
    expect(update.body).toContain("replaced in place (the shape of the root pair is unchanged)");
    expect(update.body).not.toContain("canonical");
  });
});

describe("unifiedDiff", () => {
  test("new file, deleted file, and a change with context", () => {
    expect(unifiedDiff({ path: "CLAUDE.md", before: null, after: "@AGENTS.md\n" })).toBe(
      "--- /dev/null\n+++ b/CLAUDE.md\n@@ -1,0 +1,1 @@\n+@AGENTS.md",
    );
    expect(unifiedDiff({ path: "x.md", before: "a\n", after: null })).toBe(
      "--- a/x.md\n+++ /dev/null\n@@ -1,1 +1,0 @@\n-a",
    );
    const diff = unifiedDiff(
      { path: "A.md", before: "1\n2\n3\n4\n5\n6\n7\n8\n9\n", after: "1\n2\n3\n4\nX\n6\n7\n8\n9\n" },
      1,
    );
    expect(diff.split("\n")).toEqual([
      "--- a/A.md",
      "+++ b/A.md",
      "@@ -4,3 +4,3 @@",
      " 4",
      "-5",
      "+X",
      " 6",
    ]);
  });

  test("diffStats counts added and removed lines", () => {
    expect(diffStats({ path: "a", before: null, after: "1\n2\n" })).toEqual({
      added: 2,
      removed: 0,
    });
    expect(diffStats({ path: "a", before: "1\n2\n", after: null })).toEqual({
      added: 0,
      removed: 2,
    });
    expect(diffStats({ path: "a", before: "1\n2\n3\n", after: "1\nX\n3\n4\n" })).toEqual({
      added: 2,
      removed: 1,
    });
    expect(diffStats({ path: "a", before: "same\n", after: "same\n" })).toEqual({
      added: 0,
      removed: 0,
    });
  });
});

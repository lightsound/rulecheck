import { describe, expect, test } from "bun:test";
import {
  classifyShape,
  detectKind,
  detectWrapperTarget,
  estimateBudget,
  extractClaudeImports,
  isIgnoredDirectory,
  parseFrontmatter,
  usesClaudeImport,
} from "../src/domain/classify.ts";
import type { InstructionFile } from "../src/domain/types.ts";

describe("detectKind", () => {
  test("recognises every supported file", () => {
    expect(detectKind("AGENTS.md")).toBe("agents-md");
    expect(detectKind("apps/web/AGENTS.md")).toBe("agents-md");
    expect(detectKind("CLAUDE.md")).toBe("claude-md");
    expect(detectKind(".claude/CLAUDE.md")).toBe("claude-md");
    expect(detectKind("CLAUDE.local.md")).toBe("claude-local-md");
    expect(detectKind(".claude/rules/db.md")).toBe("claude-rule");
    expect(detectKind(".cursor/rules/a.mdc")).toBe("cursor-rule");
    expect(detectKind(".cursor/rules/nested/b.mdc")).toBe("cursor-rule");
    expect(detectKind(".cursorrules")).toBe("cursorrules");
  });

  test("ignores unrelated files", () => {
    expect(detectKind("README.md")).toBeNull();
    expect(detectKind(".cursor/rules/notes.md")).toBeNull();
    expect(detectKind(".cursor/agents/x.mdc")).toBeNull();
    expect(detectKind("docs/CLAUDE.txt")).toBeNull();
    expect(detectKind("rules/db.md")).toBeNull();
  });
});

describe("isIgnoredDirectory", () => {
  test("skips build output and dependency folders anywhere", () => {
    expect(isIgnoredDirectory("src", "node_modules")).toBe(true);
    expect(isIgnoredDirectory("repo", ".git")).toBe(true);
  });

  test("skips Claude Code worktrees only under .claude", () => {
    expect(isIgnoredDirectory(".claude", "worktrees")).toBe(true);
    expect(isIgnoredDirectory("src", "worktrees")).toBe(false);
  });
});

describe("detectWrapperTarget", () => {
  test("one-line import is a wrapper", () => {
    expect(detectWrapperTarget("@AGENTS.md\n")).toBe("AGENTS.md");
  });

  test("prose pointer with html comments is a wrapper", () => {
    const content = [
      "<!-- stripe-projects-cli managed:claude-md:start -->",
      "look at AGENTS.md for your instructions",
      "<!-- stripe-projects-cli managed:claude-md:end -->",
    ].join("\n");
    expect(detectWrapperTarget(content)).toBe("AGENTS.md");
  });

  test("pointer back to CLAUDE.md is a wrapper the other way", () => {
    expect(detectWrapperTarget("# AGENTS\n\nSee CLAUDE.md for the full guide.")).toBe("CLAUDE.md");
  });

  test("real content is not a wrapper even if it imports", () => {
    const content = [
      "# Project",
      "@AGENTS.md",
      "",
      "## Build",
      "- bun run build",
      "- bun test",
    ].join("\n");
    expect(detectWrapperTarget(content)).toBeNull();
  });

  test("mentioning both files is ambiguous", () => {
    expect(detectWrapperTarget("AGENTS.md and CLAUDE.md are both here")).toBeNull();
  });

  test("empty file is not a wrapper", () => {
    expect(detectWrapperTarget("")).toBeNull();
  });
});

describe("usesClaudeImport", () => {
  test("detects @AGENTS.md and @./AGENTS.md", () => {
    expect(usesClaudeImport("@AGENTS.md", "AGENTS.md")).toBe(true);
    expect(usesClaudeImport("@./AGENTS.md\n", "AGENTS.md")).toBe(true);
  });

  test("prose mention is not an import", () => {
    expect(usesClaudeImport("look at AGENTS.md", "AGENTS.md")).toBe(false);
    expect(usesClaudeImport("email me@AGENTS.md", "AGENTS.md")).toBe(false);
  });
});

describe("parseFrontmatter", () => {
  test("cursor mdc with inline quoted globs", () => {
    const fm = parseFrontmatter(
      '---\ndescription: Use Bun\nglobs: "*.ts, *.tsx, package.json"\nalwaysApply: false\n---\nbody',
    );
    expect(fm).toEqual({
      alwaysApply: false,
      description: "Use Bun",
      globs: ["*.ts", "*.tsx", "package.json"],
      paths: [],
    });
  });

  test("bracket list and yaml list", () => {
    expect(parseFrontmatter("---\nglobs: [src/**, e2e/**]\n---\n")?.globs).toEqual([
      "src/**",
      "e2e/**",
    ]);
    expect(parseFrontmatter("---\npaths:\n  - src/**\n  - 'tests/**'\n---\n")?.paths).toEqual([
      "src/**",
      "tests/**",
    ]);
  });

  test("alwaysApply true", () => {
    expect(parseFrontmatter("---\nalwaysApply: true\n---\n")?.alwaysApply).toBe(true);
  });

  test("no frontmatter", () => {
    expect(parseFrontmatter("# just markdown")).toBeNull();
  });
});

describe("extractClaudeImports", () => {
  test("collects local markdown imports", () => {
    expect(extractClaudeImports("@AGENTS.md\nSee @docs/style.md and @~/.claude/x.md")).toEqual([
      "AGENTS.md",
      "docs/style.md",
    ]);
  });
});

function file(
  overrides: Partial<InstructionFile> & Pick<InstructionFile, "relativePath" | "kind">,
): InstructionFile {
  return {
    path: `/repo/${overrides.relativePath}`,
    depth: overrides.relativePath.split("/").length - 1,
    bytes: 100,
    lines: 10,
    tokens: 100,
    contentHash: overrides.relativePath,
    wrapperTarget: null,
    wrapperUsesImport: false,
    frontmatter: null,
    ...overrides,
  };
}

describe("classifyShape", () => {
  test("agents canonical", () => {
    const files = [
      file({ relativePath: "AGENTS.md", kind: "agents-md" }),
      file({ relativePath: "CLAUDE.md", kind: "claude-md", wrapperTarget: "AGENTS.md", lines: 1 }),
    ];
    expect(classifyShape(files)).toBe("agents-canonical");
  });

  test("claude canonical via .claude/CLAUDE.md", () => {
    const files = [
      file({ relativePath: "AGENTS.md", kind: "agents-md", wrapperTarget: "CLAUDE.md", lines: 2 }),
      file({ relativePath: ".claude/CLAUDE.md", kind: "claude-md" }),
    ];
    expect(classifyShape(files)).toBe("claude-canonical");
  });

  test("both full", () => {
    const files = [
      file({ relativePath: "AGENTS.md", kind: "agents-md" }),
      file({ relativePath: "CLAUDE.md", kind: "claude-md" }),
    ];
    expect(classifyShape(files)).toBe("both-full");
  });

  test("one side only and none", () => {
    expect(classifyShape([file({ relativePath: "AGENTS.md", kind: "agents-md" })])).toBe(
      "agents-only",
    );
    expect(classifyShape([file({ relativePath: "CLAUDE.md", kind: "claude-md" })])).toBe(
      "claude-only",
    );
    expect(classifyShape([file({ relativePath: "apps/web/AGENTS.md", kind: "agents-md" })])).toBe(
      "none",
    );
    expect(classifyShape([])).toBe("none");
  });
});

describe("estimateBudget", () => {
  test("cursor loads root pair and always-on rules; claude loads CLAUDE.md plus imports", () => {
    const files = [
      file({ relativePath: "AGENTS.md", kind: "agents-md", tokens: 1000 }),
      file({
        relativePath: "CLAUDE.md",
        kind: "claude-md",
        tokens: 5,
        wrapperTarget: "AGENTS.md",
        wrapperUsesImport: true,
      }),
      file({
        relativePath: ".cursor/rules/always.mdc",
        kind: "cursor-rule",
        tokens: 300,
        frontmatter: { alwaysApply: true, globs: [], paths: [], description: null },
      }),
      file({
        relativePath: ".cursor/rules/scoped.mdc",
        kind: "cursor-rule",
        tokens: 700,
        frontmatter: { alwaysApply: false, globs: ["src/**"], paths: [], description: null },
      }),
      file({
        relativePath: ".claude/rules/global.md",
        kind: "claude-rule",
        tokens: 50,
        frontmatter: { alwaysApply: null, globs: [], paths: [], description: null },
      }),
      file({
        relativePath: ".claude/rules/scoped.md",
        kind: "claude-rule",
        tokens: 60,
        frontmatter: { alwaysApply: null, globs: [], paths: ["db/**"], description: null },
      }),
      file({ relativePath: "apps/web/AGENTS.md", kind: "agents-md", tokens: 400 }),
    ];
    const contents = new Map([["CLAUDE.md", "@AGENTS.md\n"]]);
    expect(estimateBudget(files, contents)).toEqual({ cursor: 1305, claudeCode: 1055 });
  });

  test("prose pointer does not pull AGENTS.md into the claude budget", () => {
    const files = [
      file({ relativePath: "AGENTS.md", kind: "agents-md", tokens: 1000 }),
      file({
        relativePath: "CLAUDE.md",
        kind: "claude-md",
        tokens: 20,
        wrapperTarget: "AGENTS.md",
      }),
    ];
    const contents = new Map([["CLAUDE.md", "look at AGENTS.md"]]);
    expect(estimateBudget(files, contents).claudeCode).toBe(20);
  });
});

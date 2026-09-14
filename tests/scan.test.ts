import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { displayName, scan } from "../src/scan/scan.ts";
import { walk } from "../src/scan/walk.ts";

let root: string;

async function put(relative: string, content: string) {
  const full = join(root, relative);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

const CANONICAL_AGENTS = [
  "# Canonical",
  "",
  "- build: `bun run build`",
  "- lint: `bun run lint`",
  "- tool: `bun biome check`",
  "- auth state: `src/.auth/`",
  "- entry: `src/main.ts`",
  "- old: `src/legacy/old.ts`",
  "- external: `acme/other-repo`",
  "",
].join("\n");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rulecheck-"));

  // github.com/acme/canonical: AGENTS.md canonical with an @import wrapper and a scoped cursor rule.
  // Its AGENTS.md references one real script, one unknown script, one real path, and one missing path.
  await mkdir(join(root, "github.com/acme/canonical/.git"), { recursive: true });
  await put("github.com/acme/canonical/AGENTS.md", CANONICAL_AGENTS);
  await put(
    "github.com/acme/canonical/package.json",
    '{"scripts":{"build":"x"},"devDependencies":{"@biomejs/biome":"1"}}',
  );
  await put("github.com/acme/canonical/.gitignore", "node_modules\n.auth/\n");
  await put("github.com/acme/canonical/src/main.ts", "export {};\n");
  await put("github.com/acme/canonical/CLAUDE.md", "@AGENTS.md\n");
  await put(
    "github.com/acme/canonical/.cursor/rules/ui.mdc",
    "---\nglobs: src/**/*.tsx\nalwaysApply: false\n---\nUse named exports.\n",
  );
  await put("github.com/acme/canonical/node_modules/dep/CLAUDE.md", "should be ignored\n");
  await put("github.com/acme/canonical/.claude/worktrees/wt1/CLAUDE.md", "should be ignored too\n");

  // github.com/acme/both: both files carry content, and a duplicate of canonical's AGENTS.md lives nested
  await mkdir(join(root, "github.com/acme/both/.git"), { recursive: true });
  await put("github.com/acme/both/AGENTS.md", "# Both\n\nline\nline\nline\nline\n");
  await put("github.com/acme/both/CLAUDE.md", "# Both claude\n\nline\nline\nline\nline\n");
  await put("github.com/acme/both/packages/x/AGENTS.md", CANONICAL_AGENTS);

  // a fake home with a personal layer
  await put(".home/.claude/CLAUDE.md", "@RTK.md\n@~/notes/global.md\n");
  await put(".home/.claude/RTK.md", "# RTK\n\nUse rtk.\n");
  await put(".home/notes/global.md", "Always respond in Japanese.\n");
  await put(".home/.claude/rules/style.md", "---\npaths:\n  - src/**\n---\nscoped\n");
  await put(".home/.claude/rules/always.md", "unscoped rule\n");

  // github.com/acme/empty: a repo with no instruction files
  await mkdir(join(root, "github.com/acme/empty/.git"), { recursive: true });
  await put("github.com/acme/empty/README.md", "hi\n");

  // a directory that is not a repo but contains an AGENTS.md: must not be attributed to anything
  await put("github.com/acme/not-a-repo/AGENTS.md", "orphan\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

describe("walk", () => {
  test("finds repositories and their instruction files, skipping ignored trees", async () => {
    const repos = await run(walk(root));
    const byName = new Map(
      repos.map((r) => [r.root.slice(root.length + 1), r.files.map((f) => f.relativePath)]),
    );

    expect([...byName.keys()].sort()).toEqual([
      "github.com/acme/both",
      "github.com/acme/canonical",
      "github.com/acme/empty",
    ]);
    expect(byName.get("github.com/acme/canonical")).toEqual([
      ".cursor/rules/ui.mdc",
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(byName.get("github.com/acme/both")).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "packages/x/AGENTS.md",
    ]);
    expect(byName.get("github.com/acme/empty")).toEqual([]);
  });
});

describe("scan", () => {
  test("classifies shapes, finds cross-repo duplicates, and estimates budgets", async () => {
    const report = await run(scan(root));

    const canonical = report.repos.find((r) => r.name === "acme/canonical");
    const both = report.repos.find((r) => r.name === "acme/both");
    const empty = report.repos.find((r) => r.name === "acme/empty");

    expect(canonical?.shape).toBe("agents-canonical");
    expect(both?.shape).toBe("both-full");
    expect(empty?.shape).toBe("none");

    const wrapper = canonical?.files.find((f) => f.relativePath === "CLAUDE.md");
    expect(wrapper?.wrapperTarget).toBe("AGENTS.md");
    expect(wrapper?.wrapperUsesImport).toBe(true);

    const agents = canonical?.files.find((f) => f.relativePath === "AGENTS.md");
    expect(agents?.tokens).toBeGreaterThan(0);
    // Cursor loads AGENTS.md + CLAUDE.md (scoped .mdc excluded); Claude loads CLAUDE.md + imported AGENTS.md.
    expect(canonical?.budget.cursor).toBe((agents?.tokens ?? 0) + (wrapper?.tokens ?? 0));
    expect(canonical?.budget.claudeCode).toBe((wrapper?.tokens ?? 0) + (agents?.tokens ?? 0));

    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0]?.members.map((m) => `${m.repo}/${m.relativePath}`).sort()).toEqual([
      "acme/both/packages/x/AGENTS.md",
      "acme/canonical/AGENTS.md",
    ]);

    expect(report.totals.repos).toBe(3);
    expect(report.totals.reposWithInstructions).toBe(2);
    expect(report.totals.shapes["agents-canonical"]).toBe(1);
    expect(report.totals.shapes["both-full"]).toBe(1);
    expect(report.totals.shapes.none).toBe(1);
    expect(report.personal).toBeNull();
  });

  test("verifies script and path references against the repository", async () => {
    const report = await run(scan(root));
    const canonical = report.repos.find((r) => r.name === "acme/canonical");
    const both = report.repos.find((r) => r.name === "acme/both");

    // `bun biome` resolves to a dependency binary; `src/.auth/` is gitignored. Neither is reported.
    expect(canonical?.findings.map((f) => `${f.kind}:${f.value}@${f.file}:${f.line}`)).toEqual([
      "unknown-script:lint@AGENTS.md:4",
      "missing-path:src/legacy/old.ts@AGENTS.md:8",
    ]);

    // `both` has no package.json, so scripts cannot be judged; `src/` does not exist there either,
    // so the path is not judged. Nothing is reported rather than guessing.
    expect(both?.findings).toEqual([]);
    expect(report.totals.findings).toBe(2);
  });

  test("includes the personal layer when a home is given", async () => {
    const report = await run(scan(root, { home: join(root, ".home") }));
    const personal = report.personal;
    expect(personal).not.toBeNull();

    expect(personal?.files.map((f) => `${f.kind}:${f.relativePath}`)).toEqual([
      "claude-md:CLAUDE.md",
      "imported-md:RTK.md",
      "imported-md:~/notes/global.md",
      "claude-rule:rules/always.md",
      "claude-rule:rules/style.md",
    ]);

    const tokensOf = (rel: string) =>
      personal?.files.find((f) => f.relativePath === rel)?.tokens ?? 0;
    // Everything except the path-scoped rule counts toward every session.
    expect(personal?.claudeCodeTokens).toBe(
      tokensOf("CLAUDE.md") +
        tokensOf("RTK.md") +
        tokensOf("~/notes/global.md") +
        tokensOf("rules/always.md"),
    );
    expect(personal?.managedPolicyPath).toBeNull();
  });
});

describe("displayName", () => {
  test("strips ghq-style host prefix", () => {
    expect(displayName("/x/ghq/github.com/acme/repo", "/x/ghq")).toBe("acme/repo");
  });

  test("falls back to relative path or basename", () => {
    expect(displayName("/x/projects/repo", "/x/projects")).toBe("repo");
    expect(displayName("/x/projects/repo", "/x/projects/repo")).toBe("repo");
    expect(displayName("/x/projects/group/repo", "/x/projects")).toBe("group/repo");
  });
});

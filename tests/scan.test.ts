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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rulecheck-"));

  // github.com/acme/canonical: AGENTS.md canonical with an @import wrapper and a scoped cursor rule
  await mkdir(join(root, "github.com/acme/canonical/.git"), { recursive: true });
  await put(
    "github.com/acme/canonical/AGENTS.md",
    "# Canonical\n\n- build: bun run build\n- test: bun test\n- lint: biome\n",
  );
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
  await put(
    "github.com/acme/both/packages/x/AGENTS.md",
    "# Canonical\n\n- build: bun run build\n- test: bun test\n- lint: biome\n",
  );

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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer } from "effect";
import { hashBlockBody } from "../src/domain/block.ts";
import { type GitHub, GitHubError, parseRepositorySpec } from "../src/github/client.ts";
import {
  repositorySnapshot,
  snapshotFileSystem,
  textEntry,
  withChanges,
} from "../src/github/fs.ts";
import { type GhResult, ghTransport } from "../src/github/gh.ts";
import { makeGitHub } from "../src/github/transport.ts";
import { renderSync } from "../src/report/sync.ts";
import { resolvePacks } from "../src/scan/packs.ts";
import { scan } from "../src/scan/scan.ts";
import { type SyncOptions, sync } from "../src/sync/sync.ts";
import { type FakeRepoInput, fakeGitHub } from "./fake-github.ts";

const BODY = "- Respond in Japanese.\n- Use Bun, never npm.";
const OLD_BODY = "- Respond in Japanese.";
const ROTTEN_BODY = "- Lint with `bun run lint`.\n- Entry point: `src/main.ts`.";
// Long enough that the scanner does not take the file for a wrapper.
const BOTH_CLAUDE_EXTRA = "# C\n\n- legacy: `src/gone.ts`\n- one\n- two\n- three";
const REPEATED = "- Use Bun.\n- one\n- two\n- three\n- four";
const COBRACKET = readFileSync(new URL("./fixtures/cobracket-AGENTS.md", import.meta.url), "utf8");
const COBRACKET_CLAUDE = readFileSync(
  new URL("./fixtures/cobracket-CLAUDE.md", import.meta.url),
  "utf8",
);

function block(source: string, body: string, rev = "aaaaaaa") {
  return `<!-- agent-rules:begin source=${source} rev=${rev} hash=${hashBlockBody(body)} -->\n${body}\n<!-- agent-rules:end -->`;
}

const PACK_REPO: FakeRepoInput = {
  files: {
    "packs/base/AGENTS.md": `${BODY}\n`,
    "packs/frontend/AGENTS.md": "React rules.\n",
    "packs/rotten/AGENTS.md": `${ROTTEN_BODY}\n`,
    "subscriptions.json": JSON.stringify({
      base: [
        "acme/canonical",
        "acme/empty",
        "acme/agents-only",
        "acme/claude-only",
        "acme/both",
        "acme/both-repeat",
        "acme/foreign",
        "acme/regions",
        "acme/cobracket",
        "acme/outdated",
        "acme/modified",
        "acme/ordered",
      ],
      frontend: ["acme/ordered"],
      rotten: ["acme/canonical", "acme/empty", "acme/stale-rule"],
    }),
  },
};

const TARGETS: Record<string, FakeRepoInput> = {
  "acme/canonical": {
    files: {
      "AGENTS.md": "# Canonical\n\n- build: `bun run build`\n- entry: `src/main.ts`\n",
      "CLAUDE.md": "@AGENTS.md\n",
      "package.json": '{"scripts":{"build":"x"}}',
      "src/main.ts": "export {};\n",
      "node_modules/dep/CLAUDE.md": "ignored\n",
    },
  },
  "acme/empty": { defaultBranch: "develop", files: { "README.md": "hi\n" } },
  "acme/agents-only": { files: { "AGENTS.md": "# Only agents\n" } },
  "acme/claude-only": { files: { ".claude/CLAUDE.md": "# Nested claude\n" } },
  // A CLAUDE.md with its own text and no `@AGENTS.md` line (one would make the pair canonical by
  // import, D16, and leave the file alone); D12 merges or drops it.
  "acme/both": {
    files: {
      "AGENTS.md": "# A\n\n- entry: `src/main.ts`\n",
      // Own text plus rot that already exists on main (`src/gone.ts`); the merge must not read it as new.
      "CLAUDE.md": `${BOTH_CLAUDE_EXTRA}\n`,
      "src/main.ts": "export {};\n",
    },
  },
  "acme/both-repeat": {
    files: {
      "AGENTS.md": `# A\n\n${REPEATED}\n<!-- END: tail -->\n`,
      "CLAUDE.md": `${REPEATED}\n`,
    },
  },
  "acme/foreign": {
    files: {
      "AGENTS.md": "<!-- managed by ruler; do not edit -->\n# F\n",
      "CLAUDE.md": "@AGENTS.md\n",
    },
  },
  // `lightsound/cobracket` AGENTS.md: four regions other tools own, the last one ends the file (D15).
  "acme/regions": { files: { "AGENTS.md": COBRACKET, "CLAUDE.md": "@AGENTS.md\n" } },
  // The real pair: CLAUDE.md is 420 lines, three regions, `@AGENTS.md` inside the second (D16).
  "acme/cobracket": { files: { "AGENTS.md": COBRACKET, "CLAUDE.md": COBRACKET_CLAUDE } },
  "acme/outdated": {
    files: {
      "AGENTS.md": `# O\n\n${block("base", OLD_BODY)}\n\n## Own\n`,
      "CLAUDE.md": "@AGENTS.md\n",
    },
  },
  "acme/modified": {
    files: {
      "AGENTS.md": `# M\n\n${block("base", BODY).replace("never npm", "never yarn")}\n`,
      "CLAUDE.md": "@AGENTS.md\n",
    },
  },
  "acme/ordered": {
    files: {
      "AGENTS.md": `# Ordered\n\n${block("frontend", "React rules.")}\n`,
      "CLAUDE.md": "@AGENTS.md\n",
    },
  },
  "acme/unsubscribed": { files: { "AGENTS.md": "# U\n" } },
  "acme/stale-rule": {
    files: {
      "AGENTS.md": "# S\n",
      "CLAUDE.md": "@AGENTS.md\n",
      "package.json": '{"scripts":{"build":"x"}}',
      // Rot already present outside the root pair; the same reference in a block is still new.
      ".cursor/rules/style.mdc": "---\nalwaysApply: true\n---\nRun `bun run lint` first.\n",
    },
  },
  "acme/stale-both": {
    files: {
      // An outdated `rotten` block next to a CLAUDE.md that already has the stale `bun run lint`.
      // The update rewrites only AGENTS.md; nothing moves, so CLAUDE.md's rot excuses nothing.
      "AGENTS.md": `# S\n\n${block("rotten", OLD_BODY)}\n`,
      "CLAUDE.md": "# C\n\n- Lint: `bun run lint`\n- one\n- two\n- three\n",
      "package.json": '{"scripts":{"build":"x"}}',
      "src/main.ts": "export {};\n",
    },
  },
};

function world() {
  const github = fakeGitHub({ "acme/agent-rules": PACK_REPO, ...TARGETS });
  const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | GitHub>) =>
    Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, github.layer))));
  const runSync = (options: Partial<SyncOptions> & { repo: string }) =>
    run(
      sync({ pack: "base", packs: "acme/agent-rules", dryRun: false, ...options }).pipe(
        Effect.catchTag("SyncRefused", (e) =>
          Effect.succeed({
            kind: "refused" as const,
            message: e.message,
            status: e.status,
          }),
        ),
      ),
    );
  return { github, run, runSync };
}

describe("parseRepositorySpec", () => {
  test("owner/repo with optional ref", () => {
    expect(parseRepositorySpec("acme/rules")).toEqual({
      repo: { owner: "acme", name: "rules" },
      ref: null,
    });
    expect(parseRepositorySpec("acme/rules.git@v1")).toEqual({
      repo: { owner: "acme", name: "rules" },
      ref: "v1",
    });
    expect(parseRepositorySpec("/tmp/x")).toBeNull();
    expect(parseRepositorySpec("a/b/c")).toBeNull();
    expect(parseRepositorySpec("just-a-name")).toBeNull();
  });
});

describe("snapshotFileSystem", () => {
  const snapshot = new Map([
    ["/github.com/acme/r/.git/HEAD", textEntry("abc\n")],
    ["/github.com/acme/r/AGENTS.md", textEntry("# R\n")],
    ["/github.com/acme/r/src/main.ts", textEntry("")],
  ]);
  const fs = snapshotFileSystem(snapshot);
  const runFs = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  test("lists implied directories and reads files; missing paths fail with NotFound", async () => {
    expect(await runFs(fs.readDirectory("/"))).toEqual(["github.com"]);
    expect(await runFs(fs.readDirectory("/github.com/acme/r"))).toEqual([
      ".git",
      "AGENTS.md",
      "src",
    ]);
    expect(await runFs(fs.readFileString("/github.com/acme/r/AGENTS.md"))).toBe("# R\n");
    expect((await runFs(fs.stat("/github.com/acme/r/src"))).type).toBe("Directory");
    expect((await runFs(fs.stat("/github.com/acme/r/AGENTS.md"))).type).toBe("File");
    expect(await runFs(fs.exists("/github.com/acme/r/nope"))).toBe(false);
    expect(await runFs(fs.realPath("/github.com/acme/r/src/"))).toBe("/github.com/acme/r/src");
    const failure = await runFs(fs.readFileString("/github.com/acme/r/nope").pipe(Effect.flip));
    expect(failure.reason._tag).toBe("NotFound");
    const dirFailure = await runFs(fs.readDirectory("/elsewhere").pipe(Effect.flip));
    expect(dirFailure.reason._tag).toBe("NotFound");
  });

  test("withChanges overlays writes and deletions", async () => {
    const changed = snapshotFileSystem(
      withChanges(snapshot, "/github.com/acme/r", [
        { path: "AGENTS.md", before: "# R\n", after: "# R2\n" },
        { path: "src/main.ts", before: "", after: null },
        { path: "CLAUDE.md", before: null, after: "@AGENTS.md\n" },
      ]),
    );
    expect(await runFs(changed.readDirectory("/github.com/acme/r"))).toEqual([
      ".git",
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(await runFs(changed.readFileString("/github.com/acme/r/AGENTS.md"))).toBe("# R2\n");
    // The original is untouched.
    expect(await runFs(fs.exists("/github.com/acme/r/src/main.ts"))).toBe(true);
  });

  test("the read-only scan runs unchanged on a repository snapshot", async () => {
    const { github, run } = world();
    const repo = { owner: "acme", name: "canonical" };
    const sha = await run(github.service.getRef(repo, "heads/main"));
    const snapshot = await run(repositorySnapshot(github.service, repo, sha ?? ""));
    const report = await run(
      scan("/", { home: null }).pipe(
        Effect.provideService(FileSystem.FileSystem, snapshotFileSystem(snapshot)),
      ),
    );
    expect(report.repos.map((r) => `${r.name}:${r.shape}`)).toEqual([
      "acme/canonical:agents-canonical",
    ]);
    // `src/main.ts` exists in the tree, `bun run build` is in package.json, node_modules is skipped.
    expect(report.repos[0]?.findings).toEqual([]);
    expect(report.repos[0]?.files.map((f) => f.relativePath)).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });
});

describe("resolvePacks", () => {
  test("reads the pack repository from GitHub with the commit sha as rev", async () => {
    const { github, run } = world();
    const sha = await run(
      github.service.getRef({ owner: "acme", name: "agent-rules" }, "heads/main"),
    );
    const loaded = await run(resolvePacks("acme/agent-rules"));
    expect(loaded.source).toBe(`acme/agent-rules@${(sha ?? "").slice(0, 7)}`);
    expect(loaded.packs.map((p) => `${p.id}:${p.rev === sha}:${p.subscribers.length}`)).toEqual([
      "base:true:12",
      "frontend:true:1",
      "rotten:true:3",
    ]);
    expect(loaded.warnings).toEqual([]);
    expect(
      await run(resolvePacks("acme/agent-rules@main").pipe(Effect.map((l) => l.packs.length))),
    ).toBe(3);
  });

  test("rejects a spec that is neither a directory nor owner/repo, and unknown refs", async () => {
    const { run } = world();
    const bad = await run(resolvePacks("nope").pipe(Effect.flip));
    expect(bad._tag).toBe("PackSourceError");
    const missingRef = await run(resolvePacks("acme/agent-rules@nope").pipe(Effect.flip));
    expect(missingRef).toMatchObject({
      _tag: "PackSourceError",
      message: "ref `nope` not found in acme/agent-rules",
    });
    const missingRepo = await run(resolvePacks("acme/missing").pipe(Effect.flip));
    expect(missingRepo).toBeInstanceOf(GitHubError);
  });
});

describe("sync", () => {
  test("eligible agents-canonical: one commit, one branch, one pull request; a rerun is idempotent until main moves", async () => {
    const { github, run, runSync } = world();
    const repo = { owner: "acme", name: "canonical" };
    const result = await runSync({ repo: "acme/canonical" });
    expect(result.kind).toBe("opened");
    if (result.kind !== "opened") return;
    expect(result.branch).toBe("agent-rules/base");
    expect(result.base).toBe("main");
    expect(result.pullRequest.url).toBe("https://github.com/acme/canonical/pull/1");
    expect(github.fileAt("acme/canonical", "heads/agent-rules/base", "AGENTS.md")).toBe(
      `# Canonical\n\n- build: \`bun run build\`\n- entry: \`src/main.ts\`\n\n${block("base", BODY, await revOf(github))}\n`,
    );
    expect(github.fileAt("acme/canonical", "heads/agent-rules/base", "CLAUDE.md")).toBe(
      "@AGENTS.md\n",
    );
    // main is untouched
    expect(github.fileAt("acme/canonical", "heads/main", "AGENTS.md")).not.toContain(
      "agent-rules:begin",
    );
    expect(github.commitAt("acme/canonical", "heads/agent-rules/base").message).toContain(
      "chore(agent-rules): add `base` instruction block",
    );
    expect(github.calls).toEqual([
      "createTree acme/canonical AGENTS.md",
      "createCommit acme/canonical",
      "setRef acme/canonical heads/agent-rules/base create",
      "createPullRequest acme/canonical agent-rules/base -> main",
    ]);
    expect(renderSync(result)).toContain(
      "acme/canonical: eligible -> opened pull request https://github.com/acme/canonical/pull/1",
    );

    // Rerun before merge: the branch already carries the planned content and the PR is open, so
    // nothing is pushed (D14). A dry run says the same.
    github.calls.length = 0;
    const again = await runSync({ repo: "acme/canonical" });
    expect(again.kind).toBe("up-to-date");
    if (again.kind !== "up-to-date") return;
    expect(again.pullRequest.number).toBe(1);
    expect(again.commit).toBe(result.commit);
    expect(github.calls).toEqual([]);
    expect(renderSync(again)).toContain(
      "acme/canonical: eligible -> up to date; pull request https://github.com/acme/canonical/pull/1",
    );
    expect((await runSync({ repo: "acme/canonical", dryRun: true })).kind).toBe("up-to-date");

    // main moved in the file the plan rewrites: the branch is stale, force-updated, the PR reused.
    const edited = await commitOnMain(github, run, repo, {
      "AGENTS.md": "# Canonical, edited\n\n- build: `bun run build`\n- entry: `src/main.ts`\n",
    });
    await run(github.service.setRef(repo, "heads/main", edited, { create: false }));
    github.calls.length = 0;
    const rebased = await runSync({ repo: "acme/canonical" });
    expect(rebased.kind).toBe("updated");
    if (rebased.kind !== "updated") return;
    expect(rebased.pullRequest.number).toBe(1);
    expect(github.calls).toEqual([
      "createTree acme/canonical AGENTS.md",
      "createCommit acme/canonical",
      "setRef acme/canonical heads/agent-rules/base force",
      "updatePullRequest acme/canonical #1",
    ]);
    expect(github.pulls("acme/canonical")).toHaveLength(1);
    expect(github.fileAt("acme/canonical", "heads/agent-rules/base", "AGENTS.md")).toStartWith(
      "# Canonical, edited\n",
    );

    // After the merge the next sync is a no-op.
    github.moveRef("acme/canonical", "heads/main", "heads/agent-rules/base");
    github.calls.length = 0;
    const merged = await runSync({ repo: "acme/canonical" });
    expect(merged.kind).toBe("nothing-to-do");
    expect(github.calls).toEqual([]);
    if (merged.kind === "nothing-to-do") {
      expect(renderSync(merged)).toContain("is current (AGENTS.md:6); nothing to do");
    }
  });

  test("dry run measures and plans but writes nothing", async () => {
    const { github, runSync } = world();
    const result = await runSync({ repo: "acme/empty", dryRun: true });
    expect(result.kind).toBe("planned");
    if (result.kind !== "planned") return;
    expect(result.base).toBe("develop");
    expect(result.plan.changes.map((c) => c.path)).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(github.calls).toEqual([]);
    const text = renderSync(result);
    expect(text).toContain("dry run, nothing written");
    expect(text).toContain("+++ b/AGENTS.md");
    expect(text).toContain("+@AGENTS.md");
  });

  test("normalizes deterministic shapes in the same commit", async () => {
    const { github, runSync } = world();
    expect((await runSync({ repo: "acme/empty" })).kind).toBe("opened");
    expect(github.pathsAt("acme/empty", "heads/agent-rules/base")).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
    ]);

    expect((await runSync({ repo: "acme/agents-only" })).kind).toBe("opened");
    expect(github.fileAt("acme/agents-only", "heads/agent-rules/base", "CLAUDE.md")).toBe(
      "@AGENTS.md\n",
    );
    expect(github.fileAt("acme/agents-only", "heads/agent-rules/base", "AGENTS.md")).toStartWith(
      "# Only agents\n\n<!-- agent-rules:begin",
    );

    expect((await runSync({ repo: "acme/claude-only" })).kind).toBe("opened");
    expect(github.pathsAt("acme/claude-only", "heads/agent-rules/base")).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(github.fileAt("acme/claude-only", "heads/agent-rules/base", "AGENTS.md")).toStartWith(
      "# Nested claude\n\n",
    );

    expect((await runSync({ repo: "acme/outdated" })).kind).toBe("opened");
    const updated = github.fileAt("acme/outdated", "heads/agent-rules/base", "AGENTS.md") ?? "";
    expect(updated).toStartWith("# O\n\n<!-- agent-rules:begin source=base");
    expect(updated).toContain(BODY);
    expect(updated).toEndWith("<!-- agent-rules:end -->\n\n## Own\n");
    expect(github.pulls("acme/outdated")[0]?.title).toBe(
      "chore(agent-rules): update `base` instruction block",
    );

    // `base` precedes `frontend` in subscriptions.json, so its block goes first.
    expect((await runSync({ repo: "acme/ordered" })).kind).toBe("opened");
    const ordered = github.fileAt("acme/ordered", "heads/agent-rules/base", "AGENTS.md") ?? "";
    expect(ordered.indexOf("source=base")).toBeLessThan(ordered.indexOf("source=frontend"));
  });

  test("both have content: merges CLAUDE.md into AGENTS.md, measures current, keeps old rot old", async () => {
    const { github, runSync } = world();
    const dry = await runSync({ repo: "acme/both", dryRun: true });
    expect(dry.kind).toBe("planned");
    if (dry.kind !== "planned") return;
    expect(dry.status.status).toBe("eligible");
    expect(renderSync(dry)).toContain(
      "acme/both: eligible (append CLAUDE.md content to AGENTS.md under `## Merged from CLAUDE.md`, add CLAUDE.md wrapper, insert block) -> planned; dry run",
    );
    expect(github.calls).toEqual([]);

    const runUrl = "https://github.com/acme/agent-rules/actions/runs/7";
    const result = await runSync({ repo: "acme/both", runUrl });
    expect(result.kind).toBe("opened");
    if (result.kind !== "opened") return;
    expect(github.fileAt("acme/both", "heads/agent-rules/base", "AGENTS.md")).toBe(
      `# A\n\n- entry: \`src/main.ts\`\n\n## Merged from CLAUDE.md\n\n${BOTH_CLAUDE_EXTRA}\n\n${block("base", BODY, await revOf(github))}\n`,
    );
    expect(github.fileAt("acme/both", "heads/agent-rules/base", "CLAUDE.md")).toBe("@AGENTS.md\n");
    const pull = github.pulls("acme/both")[0];
    expect(pull?.body).toContain(
      "- append CLAUDE.md content to AGENTS.md under `## Merged from CLAUDE.md` (verbatim, before any managed block; duplicates or conflicts with the text above it are left for review)",
    );
    expect(pull?.body).toContain("- replace CLAUDE.md with the wrapper (`@AGENTS.md`)");
    // The single-target path threads `--run-url` into the written body (D23).
    expect(pull?.body).toEndWith(`Written by [this run](${runUrl}).`);
  });

  test("both have content, CLAUDE.md repeats AGENTS.md: only the wrapper is written; a marker in either file blocks", async () => {
    const { github, runSync } = world();
    // `<!-- END: tail -->` is a foreign region marker; the pair would be rewritten, so it blocks.
    // The refusal carries the measured status, so a `sync --all` row can show `blocked`.
    expect(await runSync({ repo: "acme/both-repeat" })).toEqual({
      kind: "refused",
      message:
        "acme/both-repeat AGENTS.md:8: unpaired region marker <!-- END: tail --> has no opening marker",
      status: expect.objectContaining({ status: "blocked", file: "AGENTS.md", line: 8 }),
    });
    expect(github.calls).toEqual([]);

    const clean = fakeGitHub({
      "acme/agent-rules": PACK_REPO,
      "acme/both-repeat": {
        files: { "AGENTS.md": `# A\n\n${REPEATED}\n`, "CLAUDE.md": `${REPEATED}\n` },
      },
    });
    const result = await Effect.runPromise(
      sync({
        repo: "acme/both-repeat",
        pack: "base",
        packs: "acme/agent-rules",
        dryRun: false,
      }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, clean.layer))),
    );
    expect(result.kind).toBe("opened");
    if (result.kind !== "opened") return;
    expect(result.plan.actions[0]).toBe("drop CLAUDE.md content, which AGENTS.md already contains");
    expect(clean.fileAt("acme/both-repeat", "heads/agent-rules/base", "AGENTS.md")).toBe(
      `# A\n\n${REPEATED}\n\n${block("base", BODY, await revOf(clean))}\n`,
    );
    expect(clean.fileAt("acme/both-repeat", "heads/agent-rules/base", "CLAUDE.md")).toBe(
      "@AGENTS.md\n",
    );
  });

  test("D15: paired foreign regions do not block; the block is appended after them, bytes intact", async () => {
    const { github, runSync } = world();
    const dry = await runSync({ repo: "acme/regions", dryRun: true });
    expect(dry.kind).toBe("planned");
    if (dry.kind !== "planned") return;
    expect(dry.status).toMatchObject({
      status: "eligible",
      file: "AGENTS.md",
      message: "insert block into AGENTS.md; 4 foreign regions stay untouched",
    });
    expect(github.calls).toEqual([]);

    const result = await runSync({ repo: "acme/regions" });
    expect(result.kind).toBe("opened");
    if (result.kind !== "opened") return;
    const written = github.fileAt("acme/regions", "heads/agent-rules/base", "AGENTS.md") ?? "";
    expect(written).toBe(
      `${COBRACKET.replace(/\s+$/, "")}\n\n${block("base", BODY, await revOf(github))}\n`,
    );
    // Lines 1-185 (all four regions, `<!-- convex-ai-end -->` at 185) are byte for byte the original.
    expect(written.split("\n").slice(0, 185).join("\n")).toBe(
      COBRACKET.split("\n").slice(0, 185).join("\n"),
    );
    expect(result.plan.blockLine).toBe(187);
    expect(github.pulls("acme/regions")[0]?.body).toContain("- block: AGENTS.md:187");
    expect(github.calls).toEqual([
      "createTree acme/regions AGENTS.md",
      "createCommit acme/regions",
      "setRef acme/regions heads/agent-rules/base create",
      "createPullRequest acme/regions agent-rules/base -> main",
    ]);

    // The planned tree reads current with the same four regions; a rerun is quiet.
    github.moveRef("acme/regions", "heads/main", "heads/agent-rules/base");
    github.calls.length = 0;
    expect((await runSync({ repo: "acme/regions" })).kind).toBe("nothing-to-do");
  });

  test("D16: a CLAUDE.md that imports AGENTS.md from inside a region is left byte for byte; the block lands in AGENTS.md", async () => {
    const { github, runSync } = world();
    const dry = await runSync({ repo: "acme/cobracket", dryRun: true });
    expect(dry.kind).toBe("planned");
    if (dry.kind !== "planned") return;
    expect(dry.status).toEqual({
      repo: "acme/cobracket",
      pack: "base",
      status: "eligible",
      file: "AGENTS.md",
      line: null,
      message:
        "insert block into AGENTS.md (CLAUDE.md already imports AGENTS.md; left untouched); 4 foreign regions stay untouched",
    });
    expect(dry.plan.changes.map((c) => c.path)).toEqual(["AGENTS.md"]);
    expect(github.calls).toEqual([]);

    const result = await runSync({ repo: "acme/cobracket" });
    expect(result.kind).toBe("opened");
    if (result.kind !== "opened") return;
    expect(github.fileAt("acme/cobracket", "heads/agent-rules/base", "CLAUDE.md")).toBe(
      COBRACKET_CLAUDE,
    );
    const written = github.fileAt("acme/cobracket", "heads/agent-rules/base", "AGENTS.md") ?? "";
    // `<!-- convex-ai-end -->` at line 185 closes the last region; the block follows one blank line later.
    expect(written).toBe(
      `${COBRACKET.replace(/\s+$/, "")}\n\n${block("base", BODY, await revOf(github))}\n`,
    );
    expect(written.split("\n")[184]).toBe("<!-- convex-ai-end -->");
    expect(result.plan.blockLine).toBe(187);
    const pull = github.pulls("acme/cobracket")[0];
    expect(pull?.body).toContain("- CLAUDE.md already imports AGENTS.md; left untouched");
    expect(pull?.body).not.toContain("wrapper");
    expect(github.calls).toEqual([
      "createTree acme/cobracket AGENTS.md",
      "createCommit acme/cobracket",
      "setRef acme/cobracket heads/agent-rules/base create",
      "createPullRequest acme/cobracket agent-rules/base -> main",
    ]);

    // The planned tree measured `current` before the write; after the merge the rerun agrees.
    github.moveRef("acme/cobracket", "heads/main", "heads/agent-rules/base");
    github.calls.length = 0;
    expect((await runSync({ repo: "acme/cobracket" })).kind).toBe("nothing-to-do");
  });

  test("refuses: not subscribed, foreign marker, modified block", async () => {
    const { github, runSync } = world();
    const messages: Record<string, string> = {};
    for (const repo of ["acme/unsubscribed", "acme/foreign", "acme/modified"]) {
      const result = await runSync({ repo });
      expect(result.kind).toBe("refused");
      if (result.kind === "refused") messages[repo] = result.message;
    }
    expect(messages["acme/unsubscribed"]).toBe(
      "acme/unsubscribed is not subscribed to `base`; add it to subscriptions.json in acme/agent-rules@" +
        `${(await revOf(github)).slice(0, 7)} first`,
    );
    expect(messages["acme/foreign"]).toBe(
      "acme/foreign AGENTS.md:1: another tool marks the whole file (no closing marker): <!-- managed by ruler; do not edit -->",
    );
    expect(messages["acme/modified"]).toStartWith(
      "acme/modified AGENTS.md:3: block `base` was edited in place",
    );
    expect(github.calls).toEqual([]);
  });

  test("refuses a pack that would introduce rot in the target, but not where the references hold", async () => {
    const { github, runSync } = world();
    // acme/canonical has package.json without `lint`; `src/main.ts` exists.
    const rotten = await runSync({ repo: "acme/canonical", pack: "rotten" });
    expect(rotten.kind).toBe("refused");
    if (rotten.kind === "refused") {
      expect(rotten.message).toBe(
        "acme/canonical: pack `rotten` would introduce rot in this repository:\n" +
          '  AGENTS.md:7  script "lint" is not defined in any package.json (bun run lint)',
      );
    }
    // acme/empty has no package.json and no src/, so neither reference can be judged: not rot.
    expect((await runSync({ repo: "acme/empty", pack: "rotten" })).kind).toBe("opened");
    expect(github.calls.filter((c) => c.includes("acme/canonical"))).toEqual([]);

    // The same stale `bun run lint` already flagged in a rule file does not excuse the block.
    const stale = await runSync({ repo: "acme/stale-rule", pack: "rotten" });
    expect(stale).toMatchObject({
      kind: "refused",
      message: expect.stringContaining('AGENTS.md:4  script "lint" is not defined'),
    });
    expect(github.calls.filter((c) => c.includes("acme/stale-rule"))).toEqual([]);

    // Outdated block in a both-full pair: the update moves no text, so the stale `bun run lint`
    // already sitting in CLAUDE.md does not excuse the same reference in the new block body.
    const staleBoth = await runSync({ repo: "acme/stale-both", pack: "rotten" });
    expect(staleBoth).toMatchObject({
      kind: "refused",
      message:
        "acme/stale-both: pack `rotten` would introduce rot in this repository:\n" +
        '  AGENTS.md:4  script "lint" is not defined in any package.json (bun run lint)',
    });
    expect(github.calls.filter((c) => c.includes("acme/stale-both"))).toEqual([]);
  });

  test("refuses to rewrite an agent-rules/<pack> branch whose tip was not written by rulecheck", async () => {
    const { github, run, runSync } = world();
    const repo = { owner: "acme", name: "canonical" };
    // A human pushed a branch with the tool's name.
    const main = (await run(github.service.getRef(repo, "heads/main"))) ?? "";
    const tree = (await run(github.service.getCommit(repo, main))).tree;
    const human = await run(
      github.service.createCommit(repo, { message: "wip: my own rules", tree, parents: [main] }),
    );
    await run(github.service.setRef(repo, "heads/agent-rules/base", human, { create: true }));
    github.calls.length = 0;

    const refusal = {
      kind: "refused",
      message: `acme/canonical: branch \`agent-rules/base\` exists but its tip commit (${human.slice(0, 7)}) was not written by rulecheck; delete or rename the branch first`,
    };
    expect(await runSync({ repo: "acme/canonical" })).toMatchObject(refusal);
    // The dry run reports the same refusal instead of previewing a write that would be refused.
    expect(await runSync({ repo: "acme/canonical", dryRun: true })).toMatchObject(refusal);
    expect(github.calls).toEqual([]);
    expect(await run(github.service.getRef(repo, "heads/agent-rules/base"))).toBe(human);
  });

  test("refuses unknown packs, bad targets, and missing branches", async () => {
    const { runSync } = world();
    expect(await runSync({ repo: "acme/canonical", pack: "nope" })).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("pack `nope` not found in acme/agent-rules@"),
    });
    expect(await runSync({ repo: "not-a-repo" })).toMatchObject({
      kind: "refused",
      message: "target must be owner/repo, got `not-a-repo`",
    });
    expect(await runSync({ repo: "acme/canonical", base: "release" })).toMatchObject({
      kind: "refused",
      message: "branch `release` not found in acme/canonical",
    });
  });
});

/** A human commit on top of `heads/main` that writes `files`; returns its sha (main is not moved). */
async function commitOnMain(
  github: ReturnType<typeof fakeGitHub>,
  run: <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | GitHub>) => Promise<A>,
  repo: { owner: string; name: string },
  files: Record<string, string>,
): Promise<string> {
  const main = (await run(github.service.getRef(repo, "heads/main"))) ?? "";
  const baseTree = (await run(github.service.getCommit(repo, main))).tree;
  const tree = await run(
    github.service.createTree(
      repo,
      baseTree,
      Object.entries(files).map(([path, content]) => ({ path, content })),
    ),
  );
  const sha = await run(
    github.service.createCommit(repo, { message: "docs: edit", tree, parents: [main] }),
  );
  github.calls.length = 0;
  return sha;
}

async function revOf(github: ReturnType<typeof fakeGitHub>): Promise<string> {
  return (
    (await Effect.runPromise(
      github.service.getRef({ owner: "acme", name: "agent-rules" }, "heads/main"),
    )) ?? ""
  );
}

describe("makeGitHub over ghTransport", () => {
  function runner(responses: Record<string, GhResult | ((stdin: string | null) => GhResult)>) {
    const seen: Array<{ args: ReadonlyArray<string>; stdin: string | null }> = [];
    const run = async (args: ReadonlyArray<string>, stdin: string | null): Promise<GhResult> => {
      seen.push({ args, stdin });
      const path = args[args.indexOf("Accept: application/vnd.github+json") + 1] ?? "";
      const response = responses[path];
      if (response === undefined) return { exitCode: 1, stdout: "", stderr: `no fake for ${path}` };
      return typeof response === "function" ? response(stdin) : response;
    };
    return { run, seen };
  }
  const repo = { owner: "acme", name: "r" };

  test("maps gh api responses and errors", async () => {
    const { run, seen } = runner({
      "repos/acme/r": { exitCode: 0, stdout: '{"default_branch":"trunk"}', stderr: "" },
      "repos/acme/r/git/ref/heads/missing": {
        exitCode: 1,
        stdout: '{"message":"Not Found","status":"404"}',
        stderr: "gh: Not Found (HTTP 404)",
      },
      "repos/acme/r/git/ref/heads/main": {
        exitCode: 0,
        stdout: '{"object":{"sha":"abc"}}',
        stderr: "",
      },
      "repos/acme/r/git/blobs/b1": {
        exitCode: 0,
        stdout: JSON.stringify({
          content: `${Buffer.from("hé").toString("base64")}\n`,
          encoding: "base64",
        }),
        stderr: "",
      },
      "repos/acme/r/git/trees": (stdin) => ({
        exitCode: 0,
        stdout: JSON.stringify({ sha: `tree-of-${JSON.parse(stdin ?? "{}").tree.length}` }),
        stderr: "",
      }),
      "repos/acme/r/git/refs/heads/x": { exitCode: 0, stdout: "", stderr: "" },
      "repos/acme/r/pulls?state=open&head=acme%3Ax": {
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 7, html_url: "https://github.com/acme/r/pull/7", title: "t", body: "b" },
        ]),
        stderr: "",
      },
      "repos/acme/r/git/commits/bad": {
        exitCode: 1,
        stdout: "",
        stderr: "gh: Bad credentials (HTTP 401)",
      },
      "repos/acme/r/git/commits/silent": { exitCode: 3, stdout: "not json", stderr: "" },
      "repos/acme/r/git/commits/c1": {
        exitCode: 0,
        stdout: JSON.stringify({
          sha: "c1",
          tree: { sha: "t1" },
          message: "chore(agent-rules): add",
        }),
        stderr: "",
      },
      "repos/acme/r/git/blobs/utf8": {
        exitCode: 0,
        stdout: JSON.stringify({ content: "plain", encoding: "utf-8" }),
        stderr: "",
      },
      "repos/acme/r/git/blobs/odd": {
        exitCode: 0,
        stdout: JSON.stringify({ content: "x", encoding: "rot13" }),
        stderr: "",
      },
    });
    const gh = makeGitHub(ghTransport(run));
    const runP = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);

    expect(await runP(gh.getRepository(repo))).toEqual({ defaultBranch: "trunk" });
    expect(await runP(gh.getRef(repo, "heads/missing"))).toBeNull();
    expect(await runP(gh.getRef(repo, "heads/main"))).toBe("abc");
    expect(new TextDecoder().decode(await runP(gh.getBlob(repo, "b1")))).toBe("hé");
    expect(
      await runP(
        gh.createTree(repo, "base", [
          { path: "a", content: "x" },
          { path: "b", content: null },
        ]),
      ),
    ).toBe("tree-of-2");
    const treeCall = seen.find((s) => s.args.includes("repos/acme/r/git/trees"));
    expect(treeCall?.args.slice(0, 3)).toEqual(["api", "-X", "POST"]);
    expect(JSON.parse(treeCall?.stdin ?? "{}")).toEqual({
      base_tree: "base",
      tree: [
        { path: "a", mode: "100644", type: "blob", content: "x" },
        { path: "b", mode: "100644", type: "blob", sha: null },
      ],
    });
    await runP(gh.setRef(repo, "heads/x", "abc", { create: false }));
    const refCall = seen.at(-1);
    expect(refCall?.args.slice(0, 3)).toEqual(["api", "-X", "PATCH"]);
    expect(JSON.parse(refCall?.stdin ?? "{}")).toEqual({ sha: "abc", force: true });
    expect((await runP(gh.listOpenPullRequests(repo, "acme:x"))).map((p) => p.number)).toEqual([7]);

    const unauthorized = await runP(gh.getCommit(repo, "bad").pipe(Effect.flip));
    expect(unauthorized).toMatchObject({
      _tag: "GitHubError",
      status: 401,
      message: "gh: Bad credentials (HTTP 401)",
    });
    const unknown = await runP(gh.getCommit(repo, "nowhere").pipe(Effect.flip));
    expect(unknown.status).toBeNull();
    const silent = await runP(gh.getCommit(repo, "silent").pipe(Effect.flip));
    expect(silent.message).toBe("gh exited with 3");
    expect(await runP(gh.getCommit(repo, "c1"))).toEqual({
      tree: "t1",
      message: "chore(agent-rules): add",
    });
    expect(new TextDecoder().decode(await runP(gh.getBlob(repo, "utf8")))).toBe("plain");
    expect((await runP(gh.getBlob(repo, "odd").pipe(Effect.flip))).message).toContain(
      "unsupported encoding",
    );
  });

  test("a missing gh binary is a GitHubError, not a crash", async () => {
    const gh = makeGitHub(
      ghTransport(async () => {
        throw new Error("ENOENT");
      }),
    );
    const failure = await Effect.runPromise(gh.getRepository(repo).pipe(Effect.flip));
    expect(failure.message).toContain("install the GitHub CLI");
  });
});

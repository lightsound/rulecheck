import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { hashBlockBody } from "../src/domain/block.ts";
import { GitHub, GitHubError } from "../src/github/client.ts";
import { renderSyncAllHtml } from "../src/report/html.ts";
import { renderSyncAll } from "../src/report/sync.ts";
import { resolvePacks } from "../src/scan/packs.ts";
import { type SyncAllOptions, type SyncAllResult, syncAll } from "../src/sync/all.ts";
import { syncTarget } from "../src/sync/sync.ts";
import { type FakeRepoInput, fakeGitHub } from "./fake-github.ts";

const BODY = "- Respond in Japanese.\n- Use Bun.";
const OLD_BODY = "- Respond in Japanese.";

function block(source: string, body: string) {
  return `<!-- agent-rules:begin source=${source} rev=aaaaaaa hash=${hashBlockBody(body)} -->\n${body}\n<!-- agent-rules:end -->`;
}

const PACK_REPO: FakeRepoInput = {
  files: {
    "packs/base/AGENTS.md": `${BODY}\n`,
    "packs/frontend/AGENTS.md": "React rules.\n",
    "subscriptions.json": JSON.stringify({
      base: [
        "acme/eligible",
        "acme/outdated",
        "acme/current",
        "acme/modified",
        "acme/foreign",
        "acme/gone",
        "acme/eligible",
      ],
      frontend: ["acme/eligible"],
    }),
  },
};

const TARGETS: Record<string, FakeRepoInput> = {
  "acme/eligible": { files: { "AGENTS.md": "# E\n", "CLAUDE.md": "@AGENTS.md\n" } },
  "acme/outdated": {
    files: { "AGENTS.md": `# O\n\n${block("base", OLD_BODY)}\n`, "CLAUDE.md": "@AGENTS.md\n" },
  },
  "acme/current": {
    files: { "AGENTS.md": `# C\n\n${block("base", BODY)}\n`, "CLAUDE.md": "@AGENTS.md\n" },
  },
  "acme/modified": {
    files: {
      "AGENTS.md": `# M\n\n${block("base", BODY).replace("Use Bun", "Use npm")}\n`,
      "CLAUDE.md": "@AGENTS.md\n",
    },
  },
  "acme/foreign": {
    files: { "AGENTS.md": "<!-- managed by ruler -->\n# F\n", "CLAUDE.md": "@AGENTS.md\n" },
  },
  // `acme/gone` is subscribed but does not exist: every API call answers 404.
};

function world() {
  const github = fakeGitHub({ "acme/agent-rules": PACK_REPO, ...TARGETS });
  const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | GitHub>) =>
    Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, github.layer))));
  const runAll = (options: Partial<SyncAllOptions> = {}) =>
    run(syncAll({ packs: "acme/agent-rules", pack: null, dryRun: false, ...options }));
  return { github, run, runAll };
}

function rows(result: SyncAllResult): string[] {
  return result.rows.map((row) => `${row.target.pack} ${row.target.repo} ${row.outcome.kind}`);
}

describe("syncAll", () => {
  test("dry run: every subscriber measured remotely, one row each, no writes, one API failure", async () => {
    const { github, runAll } = world();
    const result = await runAll({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(rows(result)).toEqual([
      "base acme/eligible planned",
      "base acme/outdated planned",
      "base acme/current nothing-to-do",
      "base acme/modified refused",
      "base acme/foreign refused",
      "base acme/gone failed",
      "frontend acme/eligible planned",
    ]);
    expect(result.failed).toBe(1);
    expect(github.calls).toEqual([]);

    // The status column is the pack status measured on the default branch, also for refusals;
    // the outcome column starts with the outcome label (docs/status-model.md).
    const text = renderSyncAll(result);
    expect(text).toContain("Sync (dry run, nothing written): 7 targets from acme/agent-rules@");
    expect(text).toMatch(/repository\s+pack\s+status\s+outcome/);
    expect(text).toMatch(
      /acme\/eligible\s+base\s+eligible\s+planned \+5 -0: insert block `base` into AGENTS.md/,
    );
    expect(text).toMatch(/acme\/outdated\s+base\s+outdated\s+planned \+2 -1: update block/);
    expect(text).toMatch(/acme\/current\s+base\s+current\s+nothing to do \(block at AGENTS.md:3\)/);
    expect(text).toMatch(
      /acme\/modified\s+base\s+modified\s+refused: acme\/modified AGENTS.md:3: block `base` was edited in place/,
    );
    expect(text).toMatch(
      /acme\/foreign\s+base\s+blocked\s+refused: acme\/foreign AGENTS.md:1: another tool marks the whole file/,
    );
    expect(text).toMatch(
      /acme\/gone\s+base\s+-\s+failed: GitHub getRepository failed \(HTTP 404\): Not Found/,
    );
    expect(text).toEndWith("7 targets: 1 nothing to do, 3 planned, 2 refused, 1 failed");

    // `--html` renders the same rows: measured status, outcome label, `+N -M` detail.
    const html = renderSyncAllHtml(result, { version: "test", generatedAt: "now" });
    expect(html).toContain(
      '<td class="mono">acme/eligible</td><td class="mono">base</td><td><span class="chip status-eligible">eligible</span></td><td><span class="chip outcome-planned">planned</span> +5 -0: insert block `base` into AGENTS.md',
    );
    expect(html).toContain('<span class="dot outcome-planned"></span> 3 planned');
    expect(html).toContain('<div class="label">Planned</div><div class="value">3</div>');
    expect(html).toContain('<td><span class="muted">-</span></td>');
  });

  test("real run: one pull request per target, refusals and the failure isolated; a rerun is idempotent; merged targets read current", async () => {
    const { github, runAll } = world();
    const runUrl = "https://github.com/acme/agent-rules/actions/runs/7";
    const first = await runAll({ runUrl });
    expect(rows(first)).toEqual([
      "base acme/eligible opened",
      "base acme/outdated opened",
      "base acme/current nothing-to-do",
      "base acme/modified refused",
      "base acme/foreign refused",
      "base acme/gone failed",
      "frontend acme/eligible opened",
    ]);
    expect(first.failed).toBe(1);
    expect(github.pulls("acme/eligible").map((p) => p.head)).toEqual([
      "acme:agent-rules/base",
      "acme:agent-rules/frontend",
    ]);
    expect(github.pulls("acme/outdated")).toHaveLength(1);
    // `--run-url` reaches every written body through the fan-out (D23).
    for (const pull of [...github.pulls("acme/eligible"), ...github.pulls("acme/outdated")]) {
      expect(pull.body).toEndWith(`Written by [this run](${runUrl}).`);
    }
    expect(github.pulls("acme/modified")).toHaveLength(0);
    expect(github.pulls("acme/foreign")).toHaveLength(0);
    expect(github.calls.filter((c) => c.startsWith("createPullRequest"))).toHaveLength(3);
    // Three targets read at once (D14); the write lock keeps one repository in its write
    // sequence at a time, so no two targets' tree/commit/ref/pull request calls interleave.
    expect(github.maxInFlight()).toBe(3);
    expect(github.maxWriters()).toBe(1);
    expect(renderSyncAll(first)).toEndWith(
      "7 targets: 1 nothing to do, 3 opened, 2 refused, 1 failed",
    );
    expect(renderSyncAll(first)).toMatch(
      /acme\/eligible\s+base\s+eligible\s+opened PR #1 \(https:\/\/github.com\/acme\/eligible\/pull\/1\)/,
    );

    // Nothing changed: the open pull requests already carry the planned content.
    github.calls.length = 0;
    const second = await runAll();
    expect(rows(second)).toEqual([
      "base acme/eligible up-to-date",
      "base acme/outdated up-to-date",
      "base acme/current nothing-to-do",
      "base acme/modified refused",
      "base acme/foreign refused",
      "base acme/gone failed",
      "frontend acme/eligible up-to-date",
    ]);
    expect(github.calls).toEqual([]);
    expect(renderSyncAll(second)).toMatch(
      /acme\/outdated\s+base\s+outdated\s+up to date \(PR #1 open, https:\/\/github.com\/acme\/outdated\/pull\/1\)/,
    );
    expect(renderSyncAll(second)).toEndWith(
      "7 targets: 1 nothing to do, 3 up to date, 2 refused, 1 failed",
    );

    // The `base` pull request on acme/outdated merges: the default branch decides, not the branch.
    github.moveRef("acme/outdated", "heads/main", "heads/agent-rules/base");
    const third = await runAll({ pack: "base" });
    expect(rows(third)).toEqual([
      "base acme/eligible up-to-date",
      "base acme/outdated nothing-to-do",
      "base acme/current nothing-to-do",
      "base acme/modified refused",
      "base acme/foreign refused",
      "base acme/gone failed",
    ]);
    expect(github.calls).toEqual([]);
  });

  test("without the write lock, concurrent targets interleave their writes (the lock test has teeth)", async () => {
    const { github, run } = world();
    const loaded = await run(resolvePacks("acme/agent-rules"));
    const base = loaded.packs.find((p) => p.id === "base");
    if (!base) throw new Error("no base pack");
    await run(
      Effect.forEach(
        ["acme/eligible", "acme/outdated"],
        (repo) => syncTarget({ repo, dryRun: false }, loaded, base),
        { concurrency: 2 },
      ),
    );
    expect(github.maxWriters()).toBe(2);
  });

  test("a GitHub failure after measurement keeps the measured status in its row", async () => {
    const { github } = world();
    const broken = Layer.succeed(GitHub, {
      ...github.service,
      createPullRequest: () =>
        Effect.fail(
          new GitHubError({ operation: "createPullRequest", status: 502, message: "Bad Gateway" }),
        ),
    });
    const result = await Effect.runPromise(
      syncAll({ packs: "acme/agent-rules", pack: "base", dryRun: false }).pipe(
        Effect.provide(Layer.mergeAll(BunServices.layer, broken)),
      ),
    );
    const eligible = result.rows.find((row) => row.target.repo === "acme/eligible")?.outcome;
    expect(eligible).toMatchObject({
      kind: "failed",
      status: { status: "eligible", file: "AGENTS.md" },
    });
    // The target that never existed has no status to show.
    const gone = result.rows.find((row) => row.target.repo === "acme/gone")?.outcome;
    expect(gone).toMatchObject({ kind: "failed", status: null });
    expect(result.failed).toBe(3);
    const text = renderSyncAll(result);
    expect(text).toMatch(
      /acme\/eligible\s+base\s+eligible\s+failed: GitHub createPullRequest failed \(HTTP 502\): Bad Gateway/,
    );
    expect(text).toMatch(/acme\/gone\s+base\s+-\s+failed: GitHub getRepository failed/);
    expect(text).toEndWith("6 targets: 1 nothing to do, 2 refused, 3 failed");
  });

  test("--pack restricts the run; an unknown pack refuses the whole run", async () => {
    const { runAll } = world();
    const frontend = await runAll({ pack: "frontend", dryRun: true });
    expect(rows(frontend)).toEqual(["frontend acme/eligible planned"]);
    expect(frontend.failed).toBe(0);

    const unknown = await runAll({ pack: "nope", dryRun: true }).catch((e: unknown) => e);
    expect(String(unknown)).toContain("pack `nope` not found in acme/agent-rules@");
  });

  test("a subscription list without a matching pack yields no targets", async () => {
    const github = fakeGitHub({
      "acme/agent-rules": {
        files: {
          "packs/base/AGENTS.md": `${BODY}\n`,
          "subscriptions.json": JSON.stringify({ base: [] }),
        },
      },
    });
    const result = await Effect.runPromise(
      syncAll({ packs: "acme/agent-rules", pack: null, dryRun: true }).pipe(
        Effect.provide(Layer.mergeAll(BunServices.layer, github.layer)),
      ),
    );
    expect(result.rows).toEqual([]);
    expect(renderSyncAll(result)).toEndWith("0 targets: none");
  });
});

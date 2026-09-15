import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { hashBlockBody } from "../src/domain/block.ts";
import { computeSkillHash } from "../src/domain/skills.ts";
import { renderText } from "../src/report/render.ts";
import { displayName, scan } from "../src/scan/scan.ts";
import { walk } from "../src/scan/walk.ts";

let root: string;
let packsRoot: string;

const PACK_BODY = "- Respond in Japanese.\n- Use Bun, never npm.";
const OLD_PACK_BODY = "- Respond in Japanese.";
const PACK_REV = "0123456789abcdef0123456789abcdef01234567";

function managedBlock(source: string, body: string, rev = "aaaaaaa") {
  return `<!-- agent-rules:begin source=${source} rev=${rev} hash=${hashBlockBody(body)} -->\n${body}\n<!-- agent-rules:end -->`;
}

const SKILL_MD = "---\nname: review\ndescription: Review pull requests.\n---\n# Review\n";
const SKILL_SCRIPT = "echo review\n";
const SKILL_HASH = computeSkillHash([
  { relativePath: "SKILL.md", content: Buffer.from(SKILL_MD) },
  { relativePath: "scripts/run.sh", content: Buffer.from(SKILL_SCRIPT) },
]);

async function put(relative: string, content: string, base = root) {
  const full = join(base, relative);
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
  packsRoot = await mkdtemp(join(tmpdir(), "rulecheck-packs-"));

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
  await put(
    ".home/.claude/CLAUDE.md",
    "@RTK.md\n@~/notes/global.md\n@~/agent-rules/packs/base/AGENTS.md\n",
  );
  await put(".home/.claude/RTK.md", "# RTK\n\nUse rtk.\n");
  await put(".home/notes/global.md", "Always respond in Japanese.\n");
  // The interim wiring (D13): ~/.claude/CLAUDE.md imports a checkout of the pack source that is
  // one edit behind the pack repository.
  await put(".home/agent-rules/packs/base/AGENTS.md", `${OLD_PACK_BODY}\n`);
  await put(".home/.claude/rules/style.md", "---\npaths:\n  - src/**\n---\nscoped\n");
  await put(".home/.claude/rules/always.md", "unscoped rule\n");
  // Cursor side of the personal layer: ~/AGENTS.md as a symlink to a canonical file, a ~/CLAUDE.md
  // wrapper, and ~/.cursor/rules with one always-apply and one scoped rule.
  await put(".home/pack/AGENTS.md", "# Personal\n\nRespond in Japanese.\n");
  await symlink(join(root, ".home/pack/AGENTS.md"), join(root, ".home/AGENTS.md"));
  await put(".home/CLAUDE.md", "@AGENTS.md\n");
  await put(".home/.cursor/rules/always.mdc", "---\nalwaysApply: true\n---\nalways on\n");
  await put(
    ".home/.cursor/rules/scoped.mdc",
    "---\nglobs: *.ts\nalwaysApply: false\n---\nscoped\n",
  );
  await put(".home/.cursor/rules/ignored.md", "not an mdc\n");

  // github.com/acme/empty: a repo with no instruction files
  await mkdir(join(root, "github.com/acme/empty/.git"), { recursive: true });
  await put("github.com/acme/empty/README.md", "hi\n");

  // a directory that is not a repo but contains an AGENTS.md: must not be attributed to anything
  await put("github.com/acme/not-a-repo/AGENTS.md", "orphan\n");

  // github.com/acme/blocked: carries an outdated `base` block, a modified `frontend` block, a
  // malformed marker, skills in two agent dirs, and a skills-lock.json with one missing entry.
  await mkdir(join(root, "github.com/acme/blocked/.git"), { recursive: true });
  await put(
    "github.com/acme/blocked/AGENTS.md",
    [
      "# Blocked",
      "",
      managedBlock("base", OLD_PACK_BODY),
      "",
      managedBlock("frontend", "React rules.").replace("React rules.", "React rules, edited."),
      "",
      "<!-- agent-rules:begin source=late -->",
      "",
    ].join("\n"),
  );
  await put("github.com/acme/blocked/CLAUDE.md", "@AGENTS.md\n");
  await put("github.com/acme/blocked/.agents/skills/review/SKILL.md", SKILL_MD);
  await put("github.com/acme/blocked/.agents/skills/review/scripts/run.sh", SKILL_SCRIPT);
  // `.claude/skills/review` is the symlink `npx skills` creates; `.cursor/skills/review` is a
  // separately edited copy.
  await mkdir(join(root, "github.com/acme/blocked/.claude/skills"), { recursive: true });
  await symlink(
    "../../.agents/skills/review",
    join(root, "github.com/acme/blocked/.claude/skills/review"),
  );
  await put("github.com/acme/blocked/.cursor/skills/review/SKILL.md", SKILL_MD);
  await put(
    "github.com/acme/blocked/.cursor/skills/review/scripts/run.sh",
    `${SKILL_SCRIPT}# local edit\n`,
  );
  await put("github.com/acme/blocked/.cursor/skills/Untracked/SKILL.md", "no frontmatter\n");
  await put(
    "github.com/acme/blocked/skills-lock.json",
    JSON.stringify(
      {
        version: 1,
        skills: {
          review: { source: "acme/skills", sourceType: "github", computedHash: SKILL_HASH },
          gone: { source: "acme/skills", sourceType: "github", computedHash: "0" },
        },
      },
      null,
      2,
    ),
  );

  // github.com/acme/restored: skill directories are gitignored and restored from the lock on install
  await mkdir(join(root, "github.com/acme/restored/.git"), { recursive: true });
  await put("github.com/acme/restored/.gitignore", ".agents/skills/\n");
  await put(
    "github.com/acme/restored/skills-lock.json",
    '{"version":1,"skills":{"pdf":{"source":"anthropics/skills","sourceType":"github","computedHash":"0"}}}',
  );

  // github.com/acme/foreign: canonical shape but AGENTS.md is owned by another generator
  await mkdir(join(root, "github.com/acme/foreign/.git"), { recursive: true });
  await put(
    "github.com/acme/foreign/AGENTS.md",
    "<!-- managed by ruler; do not edit -->\n# Foreign\n",
  );
  await put("github.com/acme/foreign/CLAUDE.md", "@AGENTS.md\n");

  // the pack repository: packs/base (block + one managed file), packs/frontend, subscriptions
  await put("packs/base/AGENTS.md", `${PACK_BODY}\n`, packsRoot);
  await put("packs/base/.cursor/skills/review/SKILL.md", SKILL_MD, packsRoot);
  await put("packs/frontend/AGENTS.md", "React rules.\n", packsRoot);
  await put(
    "subscriptions.json",
    JSON.stringify({
      base: ["acme/canonical", "acme/both", "acme/empty", "acme/blocked", "acme/foreign"],
      frontend: ["acme/canonical"],
    }),
    packsRoot,
  );
  await put(".git/HEAD", "ref: refs/heads/main\n", packsRoot);
  await put(".git/refs/heads/main", `${PACK_REV}\n`, packsRoot);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(packsRoot, { recursive: true, force: true });
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
      "github.com/acme/blocked",
      "github.com/acme/both",
      "github.com/acme/canonical",
      "github.com/acme/empty",
      "github.com/acme/foreign",
      "github.com/acme/restored",
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

  test("collects skill directories and the skills lock without treating SKILL.md as a rule", async () => {
    const repos = await run(walk(root));
    const blocked = repos.find((r) => r.root.endsWith("/acme/blocked"));
    expect(blocked?.files.map((f) => f.relativePath)).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(blocked?.skills.map((s) => `${s.agentDir}:${s.name}`)).toEqual([
      ".agents:review",
      ".claude:review",
      ".cursor:review",
      ".cursor:Untracked",
    ]);
    expect(blocked?.skillsLockPath).toBe(join(root, "github.com/acme/blocked/skills-lock.json"));
    const canonical = repos.find((r) => r.root.endsWith("/acme/canonical"));
    expect(canonical?.skills).toEqual([]);
    expect(canonical?.skillsLockPath).toBeNull();
  });
});

describe("scan", () => {
  test("classifies shapes, finds cross-repo duplicates, and estimates budgets", async () => {
    const report = await run(scan(root));
    expect(report.schemaVersion).toBe(1);

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

    expect(report.totals.repos).toBe(6);
    expect(report.totals.reposWithInstructions).toBe(4);
    expect(report.totals.shapes["agents-canonical"]).toBe(3);
    expect(report.totals.shapes["both-full"]).toBe(1);
    expect(report.totals.shapes.none).toBe(2);
    expect(report.personal).toBeNull();
    expect(report.distribution).toBeNull();
  });

  test("detects managed blocks, malformed markers, and skills drift per repository", async () => {
    const report = await run(scan(root));
    const blocked = report.repos.find((r) => r.name === "acme/blocked");
    const canonical = report.repos.find((r) => r.name === "acme/canonical");

    expect(
      blocked?.blocks.map((b) => `${b.source}@${b.file}:${b.line}-${b.endLine}:${b.modified}`),
    ).toEqual(["base@AGENTS.md:3-5:false", "frontend@AGENTS.md:7-9:true"]);
    expect(blocked?.blocks[0]?.rev).toBe("aaaaaaa");
    expect(blocked?.blockIssues.map((i) => `${i.kind}@${i.file}:${i.line}`)).toEqual([
      "malformed-marker@AGENTS.md:11",
    ]);
    expect(canonical?.blocks).toEqual([]);
    expect(canonical?.blockIssues).toEqual([]);

    const foreign = report.repos.find((r) => r.name === "acme/foreign");
    expect(foreign?.blockIssues.map((i) => `${i.kind}@${i.file}:${i.line}`)).toEqual([
      "foreign-marker@AGENTS.md:1",
    ]);

    const skills = blocked?.skills;
    expect(
      skills?.skills.map((s) => `${s.relativePath}:${s.files}:${s.hash === SKILL_HASH}`),
    ).toEqual([
      ".agents/skills/review:2:true",
      ".cursor/skills/review:2:false",
      ".cursor/skills/Untracked:1:false",
    ]);
    // The symlinked `.claude` copy folds into the `.agents` directory it points at.
    expect(
      skills?.skills.map((s) => `${s.relativePath} ${s.links.join(",")} ${s.lockState}`),
    ).toEqual([
      ".agents/skills/review .claude/skills/review match",
      ".cursor/skills/review  differs",
      ".cursor/skills/Untracked  unlocked",
    ]);
    expect(skills?.lock?.map((e) => e.name)).toEqual(["gone", "review"]);
    expect(skills?.issues.map((i) => `${i.kind}:${i.skill}@${i.file}:${i.line}`)).toEqual([
      "invalid-frontmatter:Untracked@.cursor/skills/Untracked/SKILL.md:1",
      "missing:gone@skills-lock.json:9",
    ]);

    // A lock entry whose gitignored directory is absent in a fresh checkout is not a finding.
    const restored = report.repos.find((r) => r.name === "acme/restored");
    expect(restored?.skills.lock?.map((e) => e.name)).toEqual(["pdf"]);
    expect(restored?.skills.issues).toEqual([]);

    expect(report.totals.blocks).toBe(2);
    expect(report.totals.modifiedBlocks).toBe(1);
    expect(report.totals.skills).toBe(3);
    expect(report.totals.skillIssues).toBe(2);
  });

  test("reports pack distribution status for every repository when --packs is given", async () => {
    const report = await run(scan(root, { packs: packsRoot }));
    const distribution = report.distribution;
    expect(distribution).not.toBeNull();
    expect(
      distribution?.packs.map((p) => `${p.id}:${p.rev}:${p.files.length}:${p.subscribers.length}`),
    ).toEqual([`base:${PACK_REV}:2:5`, `frontend:${PACK_REV}:1:1`]);

    expect(
      distribution?.entries.map(
        (e) => `${e.pack} ${e.repo} ${e.status} ${e.file ?? "-"}:${e.line ?? "-"}`,
      ),
    ).toEqual([
      "base acme/blocked blocked AGENTS.md:11",
      "base acme/foreign blocked AGENTS.md:1",
      "base acme/both eligible AGENTS.md:-",
      "base acme/canonical eligible AGENTS.md:-",
      "base acme/empty eligible AGENTS.md:-",
      "base acme/restored not-subscribed -:-",
      "frontend acme/blocked modified AGENTS.md:7",
      "frontend acme/canonical eligible AGENTS.md:-",
      "frontend acme/both not-subscribed -:-",
      "frontend acme/empty not-subscribed -:-",
      "frontend acme/foreign not-subscribed -:-",
      "frontend acme/restored not-subscribed -:-",
    ]);
    // The unpaired marker at line 11 blocks updating the stale `base` block; the edited
    // `frontend` block has no write pending and stays `modified`.
    const rows = distribution?.entries.filter((e) => e.repo === "acme/blocked") ?? [];
    expect(rows.map((e) => `${e.status}: ${e.message}`)).toEqual([
      `blocked: block at line 3 is outdated (rev aaaaaaa -> ${PACK_REV.slice(0, 7)}); \`agent-rules:begin\` is missing hash=`,
      "modified: body no longer matches its hash=",
    ]);
    // `both` carries its own text in CLAUDE.md, so the sync would merge it (D12).
    const both = distribution?.entries.find((e) => e.repo === "acme/both" && e.pack === "base");
    expect(both?.message).toStartWith("append CLAUDE.md content to AGENTS.md under");
    expect(report.repos.find((r) => r.name === "acme/both")?.normalization).toBe("merge");
    expect(report.repos.find((r) => r.name === "acme/canonical")?.normalization).toBe("keep");
    expect(report.repos.find((r) => r.name === "acme/empty")?.normalization).toBe("create");
    expect(distribution?.counts).toEqual({
      current: 0,
      outdated: 0,
      modified: 1,
      eligible: 4,
      blocked: 2,
      "not-subscribed": 5,
    });
    expect(distribution?.warnings).toEqual([]);

    // Without a home the personal layer is not scanned, so no copy can be reported.
    expect(distribution?.personalCopies).toEqual([]);

    const text = renderText(report);
    expect(text).toContain("Pack distribution");
    expect(text).toContain("acme/foreign");
    expect(text).toContain("AGENTS.md:1  another tool marks the whole file");
    expect(text).toContain("AGENTS.md:7-9");
    expect(text).toContain("MODIFIED");
  });

  test("an unreadable subscriptions.json is a warning, not silence", async () => {
    const broken = await mkdtemp(join(tmpdir(), "rulecheck-broken-packs-"));
    try {
      await put("packs/base/AGENTS.md", "body\n", broken);
      await put("subscriptions.json", "{ not json", broken);
      const report = await run(scan(root, { packs: broken }));
      expect(report.distribution?.warnings).toEqual([
        'subscriptions.json is not a { "<pack-id>": ["owner/repo", ...] } object; every repository counts as not subscribed',
        "not a git checkout; pack rev is unknown",
      ]);
      // Only the repo that already carries a `base` block gets a status from the block itself.
      expect(
        report.distribution?.entries
          .filter((e) => e.repo !== "acme/blocked")
          .every((e) => e.status === "not-subscribed"),
      ).toBe(true);
      expect(renderText(report)).toContain("! subscriptions.json is not a");
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
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
      "claude-md:~/.claude/CLAUDE.md",
      "imported-md:~/.claude/RTK.md",
      "imported-md:~/notes/global.md",
      "imported-md:~/agent-rules/packs/base/AGENTS.md",
      "claude-rule:~/.claude/rules/always.md",
      "claude-rule:~/.claude/rules/style.md",
      "agents-md:~/AGENTS.md",
      "claude-md:~/CLAUDE.md",
      "cursor-rule:~/.cursor/rules/always.mdc",
      "cursor-rule:~/.cursor/rules/scoped.mdc",
    ]);

    const tokensOf = (rel: string) =>
      personal?.files.find((f) => f.relativePath === rel)?.tokens ?? 0;

    // Claude Code: ~/.claude/CLAUDE.md, its imports, unscoped rules, ~/CLAUDE.md and the
    // ~/AGENTS.md it imports. Not the path-scoped rule.
    expect(personal?.claudeCodeTokens).toBe(
      tokensOf("~/.claude/CLAUDE.md") +
        tokensOf("~/.claude/RTK.md") +
        tokensOf("~/notes/global.md") +
        tokensOf("~/agent-rules/packs/base/AGENTS.md") +
        tokensOf("~/.claude/rules/always.md") +
        tokensOf("~/CLAUDE.md") +
        tokensOf("~/AGENTS.md"),
    );

    // Cursor: ~/AGENTS.md (through the symlink), ~/CLAUDE.md, and the always-apply .mdc only.
    expect(tokensOf("~/AGENTS.md")).toBeGreaterThan(0);
    expect(personal?.cursorTokens).toBe(
      tokensOf("~/AGENTS.md") + tokensOf("~/CLAUDE.md") + tokensOf("~/.cursor/rules/always.mdc"),
    );

    const homeWrapper = personal?.files.find((f) => f.relativePath === "~/CLAUDE.md");
    expect(homeWrapper?.wrapperTarget).toBe("AGENTS.md");
    expect(homeWrapper?.wrapperUsesImport).toBe(true);
    expect(personal?.managedPolicyPath).toBeNull();
  });

  test("reports pack bodies that also load from the personal layer (D13)", async () => {
    const report = await run(scan(root, { home: join(root, ".home"), packs: packsRoot }));
    // The imported checkout is one edit behind the pack: stale, not a false `current`. Only
    // `acme/blocked` carries a `base` block (outdated behind a malformed marker), and a block is a
    // block whatever its status.
    expect(report.distribution?.personalCopies).toEqual([
      {
        pack: "base",
        file: "~/agent-rules/packs/base/AGENTS.md",
        kind: "imported-md",
        state: "stale",
        doubleLoaded: ["acme/blocked"],
      },
    ]);
    const text = renderText(report);
    expect(text).toContain(
      "! personal layer ~/agent-rules/packs/base/AGENTS.md is the pack source but differs from the pack as loaded (checkout behind or ahead); loads a second, divergent copy in 1 repository carrying the block (acme/blocked).",
    );
    expect(text).toContain("have no headless write path");
  });
});

describe("scan: canonical by import (D16)", () => {
  test("a content CLAUDE.md with an @AGENTS.md line inside a region reads as agents-imported", async () => {
    const tree = await mkdtemp(join(tmpdir(), "rulecheck-imported-"));
    try {
      const repo = "github.com/acme/cobracket";
      await mkdir(join(tree, repo, ".git"), { recursive: true });
      await put(`${repo}/AGENTS.md`, "# Agents\n\nline\nline\nline\nline\n", tree);
      await put(
        `${repo}/CLAUDE.md`,
        [
          "# CLAUDE.md",
          "",
          "Project guidance for Claude Code.",
          "",
          "<!-- fallow:agent-install v1 claude-import:start -->",
          "@AGENTS.md",
          "<!-- fallow:agent-install v1 claude-import:end -->",
          "",
          "<!-- convex-ai-start -->",
          "Convex.",
          "<!-- convex-ai-end -->",
          "",
        ].join("\n"),
        tree,
      );
      const report = await run(scan(tree));
      const cobracket = report.repos.find((r) => r.name === "acme/cobracket");
      expect(cobracket?.shape).toBe("agents-imported");
      expect(cobracket?.normalization).toBe("keep");
      const claude = cobracket?.files.find((f) => f.relativePath === "CLAUDE.md");
      expect(claude?.wrapperTarget).toBeNull();
      expect(claude?.importsAgentsMd).toBe(true);
      // Claude Code loads CLAUDE.md and, through the import, AGENTS.md.
      const agents = cobracket?.files.find((f) => f.relativePath === "AGENTS.md");
      expect(cobracket?.budget.claudeCode).toBe((claude?.tokens ?? 0) + (agents?.tokens ?? 0));
      expect(report.totals.shapes["agents-imported"]).toBe(1);
      expect(report.totals.shapes["both-full"]).toBe(0);

      const text = renderText(report);
      expect(text).toContain("AGENTS.md via @import");
      expect(text).toContain(
        "! CLAUDE.md imports AGENTS.md and carries content of its own; not the strict one-line wrapper",
      );
      expect(text).toContain("region fallow:agent-install v1 claude-import");

      // Only the fenced line: prose, so the pair is `both-full` and D12 applies.
      await put(`${repo}/CLAUDE.md`, "# C\n\nline\nline\nline\n\n```md\n@AGENTS.md\n```\n", tree);
      const fenced = await run(scan(tree));
      expect(fenced.repos[0]?.shape).toBe("both-full");
      expect(
        fenced.repos[0]?.files.find((f) => f.relativePath === "CLAUDE.md")?.importsAgentsMd,
      ).toBe(false);
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
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

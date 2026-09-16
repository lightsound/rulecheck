# Roadmap

Ordered next steps. Each step is small enough for one chat session and ends with a check against
the real tree (`bun run dev scan ~/ghq`). Decisions behind the order are in
[decisions.md](decisions.md) (D4 to D12); tool facts in [tool-behavior.md](tool-behavior.md).

## Current state (2026-09-15)

- rulecheck: read-only scan works on `~/ghq` (shape, duplicates, budget, rot detection, personal
  layer, managed blocks, skills inventory, pack distribution status via `--packs`, which reads a
  local checkout or `owner/repo[@ref]` from GitHub). One write path: `rulecheck sync` (D10) opens
  a pull request per repository per pack through `gh api`. First real run done: `lightsound/rulecheck`
  carries block `base` ([rulecheck#6](https://github.com/lightsound/rulecheck/pull/6)) and reads
  `current`. Pack sources stay unwrapped; markers are rendered at sync time (D11). Every shape,
  including `both have content`, is normalized by the sync (D12); only marker conflicts block:
  well-formed marker pairs of other tools are opaque regions the sync appends after (D15), while
  unpaired, nested, and file-level markers still block. A content `CLAUDE.md` that holds an
  `@AGENTS.md` line is canonical by import (`agents-imported`, D16): the block goes into
  `AGENTS.md` and `CLAUDE.md` is left as it is, which unblocks `lightsound/cobracket`. `sync --all` fans out over `subscriptions.json` and its `--dry-run` table is the remote
  distribution report (D14); `scan --packs` reflects local checkouts only. The words of that
  model (shape, normalization, pack status, sync outcome) are fixed in one glossary,
  [status-model.md](status-model.md), which code, labels, and `scan --json` (`schemaVersion: 1`)
  follow (D17); a dashboard builds on it, and its first read-only slice exists: `scan --html
  <file>` and `sync --all --html <file>` render the same reports as one self-contained HTML page
  (overview cards, a next-actions list, the repo × pack matrix, per-owner repository rows, on
  GitHub Primer's tokens; a rendering, not a write path, D19–D22). Skills distribution is deferred (D18): `scan` keeps
  the per-repository skills inventory and lock state, `npx skills` stays the installer, and no
  skill directory is written by `sync`. Distribution is automated (D23): a workflow in
  agent-rules runs `sync --all` on every push to `main` that touches `packs/**` or
  `subscriptions.json`, and on demand with a dry-run input; `sync --run-url <url>` links each
  pull request to the run that wrote it. The workflow is live once the secret `RULECHECK_TOKEN`
  is set in agent-rules (Step 6).
- `lightsound/agent-rules/packs/base/AGENTS.md`: the portable pack `base` (D7 naming),
  environment-neutral only (Step 1, [agent-rules#1](https://github.com/lightsound/agent-rules/pull/1)).
  The repository's root `AGENTS.md` instructs agents working in agent-rules itself and is not
  distributed. Machine facts (`~/ghq` layout, "run rulecheck in lightsound/rulecheck") live in
  `~/.claude/CLAUDE.md` directly; `agent-rules/machine/CLAUDE.local.example.md` is the template.
- Interim wiring, to be dismantled in step 4: `~/.claude/CLAUDE.md` imports the pack;
  Cursor User Rule holds a copy synced by `/sync-agent-rules`
  (`~/.cursor/commands/sync-agent-rules.md` symlink); D13 retires that copy instead of
  automating it, and `scan --packs` reports the personal-layer copies that remain.
  `~/AGENTS.md` and `~/CLAUDE.md` do not exist.

## Step 1: Split the pack (agent-rules, no code) — done 2026-09-15

- Move machine facts out of `agent-rules/AGENTS.md` into `~/.claude/CLAUDE.md` directly (machine
  layer, D5). What stays must be true in any repository on any machine.
- Done when: the pack references no path or command outside the target repository.
- Result: [agent-rules#1](https://github.com/lightsound/agent-rules/pull/1). The pack lives at
  `packs/base/AGENTS.md`; the root `AGENTS.md` is repo-local and the README is gone. It states that
  project-specific sections of the destination file take precedence. `extractReferences` on the
  pack returns nothing, so rot detection cannot flag it in any destination. Machine layer applied
  on the primary machine; `scan ~/ghq` findings unchanged (3 before, 3 after), personal layer
  still imports the pack.
- Deferred to Step 3 and then dropped (D11): wrapping the body in managed-block markers. The pack
  file stays the bare body; `sync` renders the markers.

## Step 2: Block and Skills detection, distribution report (rulecheck, read-only) — done 2026-09-15

- `src/domain/block.ts`: parse `<!-- agent-rules:begin source= rev= hash= -->` ... `end` from an
  `AGENTS.md`; return blocks with `source`, `rev`, `hash`, body, `line` range; recompute hash and
  flag `modified`. Pure, tested.
- Skills inventory (D8): list `SKILL.md` directories (`.cursor/skills/*`, `.claude/skills/*`,
  `.agents/skills/*`) per repository and parse `skills-lock.json` (source + hash) when present;
  report skills installed without a lock entry and lock entries whose directory is missing.
  Frontmatter validity follows `skills-ref`; no rules of our own.
- Status per repository per pack: `current` / `outdated` / `modified` / `eligible` (shape allows
  insertion, no block) / `blocked` (shape needs a human: `both have content`, foreign managed
  markers) / `not subscribed`. Subscription source for now: a list in the pack repo
  (`agent-rules/subscriptions.json`, `{ "<pack-id>": ["owner/repo", ...] }`), read via `--packs <dir>`.
- Render a "Pack distribution" table in `render.ts`; add counts to `ScanTotals`.
- Done when: `bun run dev scan ~/ghq --packs ~/ghq/github.com/lightsound/agent-rules` lists every
  repo as eligible / blocked / not subscribed with `file:line` for blocked ones, and no false
  `modified`.
- Result: `src/domain/block.ts`, `src/domain/skills.ts`, `src/domain/pack.ts` (pure, tested),
  wired through `src/scan/skills.ts`, `src/scan/packs.ts`, `scan.ts`, `render.ts`. Marker syntax
  and body hash are fixed in D9. A pack is the file set under `packs/<id>/` (D8): `AGENTS.md` is
  the block body, everything else a whole managed file (listed, not yet classified). Every scanned
  repository appears once per pack; `eligible` rows carry the normalization a sync would perform,
  `blocked` rows the `file:line` of the reason. Verified against a tree of eight public
  repositories: one true `blocked` (`<!-- Generated by Skiller -->` in an `AGENTS.md`), zero
  `modified`. Skills: `skills-lock.json` `computedHash` is not reproducible from the installed
  directory (`npx skills` hashes the downloaded source before dropping `metadata.json` and
  dotfiles; an installed skill identical to upstream still differed from its lock entry), so hash
  differences are shown as a per-skill state, not a finding. Missing lock entries are findings unless the skill directory is gitignored. The
  `skills-ref` "unexpected fields" check is not mirrored: Claude Code's `argument-hint` and
  `disable-model-invocation` are routine and load fine.
- Left for Step 3: `--packs` still needs a local checkout of the pack repository (D6 wants the
  remote); whole managed files in a pack are inventoried but not compared with the target repo;
  blocks in nested `AGENTS.md` or in `CLAUDE.md` are listed but do not enter the status.
  (`--packs` remote form resolved in Step 3; the managed-file comparison is closed by the D18
  deferral, not by code; nested blocks remain.)

## Step 3: First write path — done 2026-09-15

- Record in `decisions.md` and `AGENTS.md` that rulecheck gains a remote-only write path (D6).
- `rulecheck sync <owner/repo> --pack <id>`: via `gh api`, create branch, write the normalized
  `AGENTS.md` (with block) and `CLAUDE.md` (`@AGENTS.md`), open a PR. Never touch local checkouts.
  `--dry-run` prints the diff.
- Shape normalization in the same PR for deterministic shapes (D6). Blocked shapes refuse.
- A pack is a set of files (D8): the first pack carries only the `AGENTS.md` block; whole managed
  files (skill directories) were to follow once Step 2 reported their inventory (deferred by D18).
- Done when: one PR on a solo lightsound repo, merged, and the next `scan` shows `current`.
- Result: D10 records the write path. `rulecheck sync <owner/repo> --pack <id> --packs <source>
  [--base <branch>] [--dry-run]` in `src/sync/sync.ts`, the `GitHub` service and `gh api` layer in
  `src/github/`, the pure plan in `src/domain/sync.ts`. A repository at a commit is presented as a
  read-only `FileSystem` (`src/github/fs.ts`), so the target is measured with the unchanged `scan`
  before planning and again on the planned tree; `not-subscribed`, `modified`, `blocked`, a
  writer/reader disagreement, and any new `unknown-script` / `missing-path` finding refuse with
  `file:line`. Branch `agent-rules/<pack>` is tool-owned and force-updated on rerun when its tip
  commit carries rulecheck's `chore(agent-rules):` prefix (otherwise the sync refuses); the open
  pull request is reused. The same filesystem view gives `--packs owner/repo[@ref]` (Step 2 carry-over
  resolved). Tested against an in-memory GitHub (`tests/fake-github.ts`): all five deterministic
  shapes, in-place update, block ordering by subscription, dry run issuing no write call, every
  refusal. Verified read-only against the real API: `scan --packs lightsound/rulecheck` and
  `sync lightsound/rulecheck --dry-run` with a scratch pack, including a rot refusal
  (`AGENTS.md:49 script "deploy" is not defined`).
- Live run 2026-09-15: `agent-rules/subscriptions.json` subscribes `lightsound/rulecheck` to
  `base` ([agent-rules#2](https://github.com/lightsound/agent-rules/pull/2)). `sync
  lightsound/rulecheck --pack base --packs lightsound/agent-rules` was run with `--dry-run` and
  then for real against the GitHub API without code changes; the pull request diff was byte-identical
  to the dry-run diff (project content first, block appended at `AGENTS.md:53`, `CLAUDE.md`
  untouched). [rulecheck#6](https://github.com/lightsound/rulecheck/pull/6) merged; the next
  `scan ~/ghq --packs lightsound/agent-rules` shows `current 1`, and a rerun of `sync --dry-run`
  reports `block base is current; nothing to do`. Only the `agents-canonical` shape was exercised
  live; the other four deterministic shapes are covered by `tests/fake-github.ts` and get their
  first live run when a matching repository subscribes.
- Pack sources are not wrapped in markers (D11); the reader keeps accepting both forms.

## Step 4: Remove the interim wiring — in progress

- Prerequisite, done 2026-09-15: every root-pair shape is now syncable. `both have content` was
  the one shape that refused (D6, D9) and would have kept daily repositories out of the block
  rollout; D12 makes it `eligible` with a content-derived normalization (`CLAUDE.md` repeats
  `AGENTS.md` → wrapper only; otherwise its text is appended under `## Merged from CLAUDE.md`
  before any managed block, then the wrapper). The status row and the pull request name the
  normalization; the planned tree must still measure `current`; the root pair counts as one file
  when findings are compared, only for plans that move text between its files, so rot moved out
  of `CLAUDE.md` is not mistaken for rot the pack introduced while rot elsewhere, or in the pair
  when nothing moves, still does not excuse the block. Covered by
  `tests/fake-github.ts` runs (merge, wrapper, foreign marker in either file, pre-existing rot);
  no live run yet, the first `both-full` subscriber gets it. Narrowed 2026-09-15 by D16: a
  `CLAUDE.md` that already holds an `@AGENTS.md` line is not `both-full` but canonical by import,
  so the sync writes `AGENTS.md` only and leaves `CLAUDE.md` byte for byte; the real
  `lightsound/cobracket` pair (420-line `CLAUDE.md`, three foreign regions, the import inside one
  of them) reads `eligible` and plans the block after the last region of `AGENTS.md`, verified
  with `sync --dry-run` against the remote and covered by a `tests/fake-github.ts` run over both
  files as fetched.
- Done 2026-09-15: the Cursor User Rule question is settled by D13. No headless way to write a
  User Rule exists (Admin API, `agent` CLI, on-disk state, Team Rules all checked; sources in
  tool-behavior.md), so the copy is retired rather than automated: the block is the Cursor
  channel, local and cloud. `scan --packs` with the personal layer now reports every personal
  file that equals a pack body or is the pack's own source path with a different hash, together
  with the repositories where the pack loads twice (`personalCopies` in `--json`, a `!` line
  under the pack in the text report). That is the removal gate for the next item.
- Remaining: after the block is in the repositories used daily (the `personalCopies` line lists
  them), delete the pack import from `~/.claude/CLAUDE.md`, delete the Cursor User Rule copy and
  `/sync-agent-rules`, set Claude Code's `language` setting for third-party repos. Verify with
  probes (tool-behavior.md method) that nothing loads twice. The `personalCopies` line must be
  gone from the scan, and that is necessary, not sufficient: the detector matches whole files
  and the pack's source path only, so a pack pasted inside a larger personal file goes
  unreported; the probe is what closes the gap.

## Step 5: Update fan-out and drift — done 2026-09-15

- `rulecheck sync --all`: for every subscribed repo whose status is `outdated`, open an update PR
  (Renovate style). `modified` repos get a report line, not a PR. The per-repository path exists
  (Step 3); fan-out adds iteration over `subscriptions.json` and a summary.
- Result: D14. `rulecheck sync --all --packs <source> [--pack <id>] [--dry-run]` in
  `src/sync/all.ts` runs the unchanged single-target path (`syncTarget`, `src/sync/sync.ts`) over
  every (`owner/repo`, pack) pair in `subscriptions.json`, three targets in flight, writes behind a
  one-permit semaphore. Every outcome is a row (repository, pack, remote status, result); a
  refusal or a GitHub error on one target does not stop the others. Exit code 1 only when a target
  could not be read or written; refusals exit 0. Idempotent by content: a target whose default
  branch already reads `current` is skipped before any branch is consulted (so a squash-merged
  block counts), and an open pull request whose branch tip already holds every planned path as
  planned is reported `up to date`, not re-pushed; the same applies to `sync <owner/repo>`, whose
  rerun no longer force-pushes an identical commit. `--dry-run` prints the same table with the
  planned action and `+N -M` per target and writes nothing. Tested against `tests/fake-github.ts`
  with seven targets: eligible, outdated, current, modified, foreign marker, a subscriber that does
  not exist (404 → `failed`), and one repository under two packs; the rerun and the post-merge
  states are asserted with zero write calls. Verified read-only against the real API with a
  scratch pack subscribing `lightsound/rulecheck` and a nonexistent repository: `current` plus one
  `failed` row and exit code 1; after a pack edit, `outdated +4 -3`.
- Local vs remote status: `scan --packs` measures local checkouts and showed `eligible` for two
  repositories whose pull requests had merged, because the checkouts sat on other branches.
  `sync --all --dry-run` measures every subscriber's default-branch HEAD on GitHub and is the
  distribution report from now on; no separate `status` command (D14).
- Carried from Step 3: auto-merge as a per-repository opt-in (D6); a stale `agent-rules/<pack>`
  branch whose pull request was closed without merge is rewritten on the next sync (D10) rather
  than skipped; written paths always get mode `100644` (an executable or symlinked root file is
  replaced by a regular file). Not a target of `--all`: a repository that carries a block without
  a subscription (only `scan --packs` over a checkout sees it).
- Multi-pack rollout, observed 2026-09-15 when `base` was split into `base` + `personal` across
  seven subscribers (14 pull requests): each pack is its own branch and pull request per
  repository (D10), both cut from the same default-branch head. The `base` update rewrites the
  block in place and the `personal` insert appends right after it, so the hunks share context
  lines and merging one pack's pull request makes the other pack's conflict. Procedure that
  worked: **merge one pack's pull requests → run `sync --all` again → merge the next pack's**.
  The rerun force-moved all seven `agent-rules/personal` branches onto the new heads and reused
  the open pull requests (`updated PR #n`; first live use of `PATCH git/refs` and `PATCH pulls`),
  and every one read `MERGEABLE` afterwards. Candidate follow-up: a single pull request per
  repository carrying every subscribed pack (one branch, blocks in subscription order), which
  removes the second phase at the cost of the one-pack-one-branch invariant in D10; needs a
  decision entry before it is built.
- Later: GitHub App + webhook so status updates without a local tree; the web/desktop UI on top.
  The `--html` page (D19–D22) is the static preview of that view: the same numbers, next
  actions, matrix, and rows from one scan, for judging whether the live version is worth building.

## Step 6: Automatic sync from the pack repository — workflow landed 2026-09-16, secret pending

- Stop running `sync --all` by hand after every pack merge. The trigger is the merge itself, so
  the pack repository runs the sync: `.github/workflows/sync.yml` in `lightsound/agent-rules`
  (D23) runs `rulecheck sync --all --packs "$GITHUB_WORKSPACE" --run-url <run>` on every push
  to `main` under `packs/**` or `subscriptions.json`, and on `workflow_dispatch` with `dry_run`
  (the D14 distribution report, no write) and `pack` inputs. One run at a time
  (`concurrency`, no cancel); exit 1 fails the run; the table is repeated in the job summary;
  nothing is merged.
- rulecheck: `sync --run-url <url>` appends `Written by [this run](<url>)` to every pull
  request body the run writes; the `gh` layer already honors `GH_TOKEN`, so the workflow passes
  the secret `RULECHECK_TOKEN` as `GH_TOKEN` and the client is unchanged.
- rulecheck is checked out into the job at a commit sha (`RULECHECK_REF`, Renovate `git-refs`
  comment) and installed with `bun install --frozen-lockfile`; Bun is `oven-sh/setup-bun` pinned
  to a sha with `BUN_VERSION` under a Renovate comment. No npm publish.
- Done when: the secret exists (a fine-grained PAT with Contents and Pull requests read/write on
  every repository in `subscriptions.json`; exact settings in D23 and in agent-rules
  `AGENTS.md`), a `workflow_dispatch` dry run prints the same table as a local
  `sync --all --dry-run`, and the next pack merge opens its pull requests without a local run.
  State on 2026-09-16: the workflow and `--run-url` are merged; `RULECHECK_TOKEN` is not yet
  set, so the workflow fails at its first step with a named error and `sync --all` is still run
  by hand until it is. The run step's shell was exercised locally with the dry-run input against
  the real subscribers (14 targets, all `current`).
- Operational rule that follows: a repository added to `subscriptions.json` is also added to the
  token's repository list, or its row reads `failed` and the run exits 1.
- Later: a GitHub App replaces the PAT (installation token per run, writes attributed to the
  app) when the tool leaves the single-owner phase; it is the same App the dashboard's webhook
  needs. Its MVP design is [app-design.md](app-design.md) (D25; nothing built yet). Candidates not built now: a nightly `schedule` as a safety net, a `pull_request` dry
  run on pack changes, the `--html` page as a run artifact.

## Deferred: Skills distribution (D18, 2026-09-16)

- Not built: writing skill directories (a pack's D8 `file` entries) into subscribers through
  `sync`. `npx skills` (vercel-labs/skills, `skills-lock.json`) is the de facto installer and D8
  says not to rebuild it; no cross-repository skill need has appeared; skills are stack-specific
  more often than repository-agnostic; the Step 2 inventory and lock-drift reporting already give
  the visibility a dashboard needs.
- What stays: `scan` lists every installed skill per repository with its lock state and reports a
  lock entry whose directory is missing. A pack's `file` entries are inventoried and ignored by
  the planner.
- If a need appears: rulecheck manages subscription and status (which subscriber has which
  listed skill, and whether it matches the lock) and delegates the install to the `skills` CLI,
  with the pull request carrying the `npx skills add` command instead of copied files. Needs a
  decision entry first.

## Not doing

- Managing the machine layer (`~/.claude`, `~/.cursor`) beyond reporting it.
- Cloud setup-script hacks to inject `~/.claude/CLAUDE.md`.
- Content conflict resolution between packs (lint at most, later).

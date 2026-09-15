# Roadmap

Ordered next steps. Each step is small enough for one chat session and ends with a check against
the real tree (`bun run dev scan ~/ghq`). Decisions behind the order are in
[decisions.md](decisions.md) (D4 to D8); tool facts in [tool-behavior.md](tool-behavior.md).

## Current state (2026-09-15)

- rulecheck: read-only scan works on `~/ghq` (shape, duplicates, budget, rot detection, personal
  layer). No write path.
- `lightsound/agent-rules/AGENTS.md`: the portable pack, environment-neutral only (Step 1,
  [agent-rules#1](https://github.com/lightsound/agent-rules/pull/1)). Machine facts (`~/ghq`
  layout, "run rulecheck in lightsound/rulecheck") live in `~/.claude/CLAUDE.md` directly;
  `agent-rules/machine/CLAUDE.local.example.md` is the template for that file.
- Interim wiring, to be dismantled in step 4: `~/.claude/CLAUDE.md` imports the pack;
  Cursor User Rule holds a copy synced by `/sync-agent-rules`
  (`~/.cursor/commands/sync-agent-rules.md` symlink). `~/AGENTS.md` and `~/CLAUDE.md` do not exist.

## Step 1: Split the pack (agent-rules, no code) — done 2026-09-15

- Move machine facts out of `agent-rules/AGENTS.md` into `~/.claude/CLAUDE.md` directly (machine
  layer, D5). What stays must be true in any repository on any machine.
- Done when: the pack references no path or command outside the target repository.
- Result: [agent-rules#1](https://github.com/lightsound/agent-rules/pull/1). The pack states that
  project-specific sections of the destination file take precedence. `extractReferences` on the
  pack returns nothing, so rot detection cannot flag it in any destination. Machine layer applied
  on the primary machine; `scan ~/ghq` findings unchanged (3 before, 3 after), personal layer
  still imports the pack.
- Deferred to Step 3: wrapping the body in managed-block markers, so that the file *is* the block
  body's source. The markers land together with the first write path that consumes them.

## Step 2: Block and Skills detection, distribution report (rulecheck, read-only)

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

## Step 3: First write path (needs a decision entry first)

- Record in `decisions.md` and `AGENTS.md` that rulecheck gains a remote-only write path (D6).
- `rulecheck sync <owner/repo> --pack <id>`: via `gh api`, create branch, write the normalized
  `AGENTS.md` (with block) and `CLAUDE.md` (`@AGENTS.md`), open a PR. Never touch local checkouts.
  `--dry-run` prints the diff.
- Shape normalization in the same PR for deterministic shapes (D6). Blocked shapes refuse.
- A pack is a set of files (D8): the first pack carries only the `AGENTS.md` block; whole managed
  files (skill directories) follow once Step 2 reports their inventory.
- Done when: one PR on a solo lightsound repo, merged, and the next `scan` shows `current`.

## Step 4: Remove the interim wiring

- After the block is in the repositories used daily: delete the pack import from
  `~/.claude/CLAUDE.md`, delete the Cursor User Rule copy and `/sync-agent-rules`, set Claude
  Code's `language` setting for third-party repos. Verify with probes (tool-behavior.md method)
  that nothing loads twice.

## Step 5: Update fan-out and drift

- `rulecheck sync --all`: for every subscribed repo whose status is `outdated`, open an update PR
  (Renovate style). `modified` repos get a report line, not a PR.
- Later: GitHub App + webhook so status updates without a local tree; the web/desktop UI on top.

## Not doing

- Managing the machine layer (`~/.claude`, `~/.cursor`) beyond reporting it.
- Cloud setup-script hacks to inject `~/.claude/CLAUDE.md`.
- Content conflict resolution between packs (lint at most, later).

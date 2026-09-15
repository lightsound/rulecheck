# Roadmap

Ordered next steps. Each step is small enough for one chat session and ends with a check against
the real tree (`bun run dev scan ~/ghq`). Decisions behind the order are in
[decisions.md](decisions.md) (D4 to D7); tool facts in [tool-behavior.md](tool-behavior.md).

## Current state (2026-09-15)

- rulecheck: read-only scan works on `~/ghq` (shape, duplicates, budget, rot detection, personal
  layer). No write path.
- `lightsound/agent-rules/AGENTS.md`: the personal pack prototype, one file, mixing portable rules
  with machine facts (`~/ghq` layout, "run rulecheck in lightsound/rulecheck").
- Interim wiring, to be dismantled in step 4: `~/.claude/CLAUDE.md` imports the pack;
  Cursor User Rule holds a copy synced by `/sync-agent-rules`
  (`~/.cursor/commands/sync-agent-rules.md` symlink). `~/AGENTS.md` and `~/CLAUDE.md` do not exist.

## Step 1: Split the pack (agent-rules, no code)

- Move machine facts out of `agent-rules/AGENTS.md` into `~/.claude/CLAUDE.md` directly (machine
  layer, D5). What stays must be true in any repository on any machine.
- Wrap the remaining body in the managed-block markers so the file *is* the block body's source.
- Done when: the pack references no path or command outside the target repository.

## Step 2: Block detection and distribution report (rulecheck, read-only)

- `src/domain/block.ts`: parse `<!-- agent-rules:begin source= rev= hash= -->` ... `end` from an
  `AGENTS.md`; return blocks with `source`, `rev`, `hash`, body, `line` range; recompute hash and
  flag `modified`. Pure, tested.
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

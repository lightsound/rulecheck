# Monorepo merge kickoff: rulecheck into rulefleet

Phase 2 of decision D34 (see [decisions.md](decisions.md)). Phase 1 is done (2026-10-29):
rulecheck is FSL-1.1-MIT from `fe309aa` on, the last MIT commit `f8691ce` is tagged
`mit-final` with a GitHub Release, and RuleFleet's production pin already points at
`f8691ce`. This document is the procedure for the merge itself. It is written to be
executed by a local agent (or by hand) in a real clone; the GitHub API cannot do a
history-preserving subtree import.

## Scope and non-goals

In scope: import rulecheck, with history, into `lightsound/rulefleet` as
`packages/rulecheck`; switch the dependency from the GitHub SHA pin to a Bun workspace;
update pointers; verify.

Explicitly out of scope:

- **Branch cleanup.** The family's branches (rulefleet, rulecheck, agent-rules) are held
  until after this merge, by the owner's decision (2026-10-29). Do not delete branches
  as part of this work.
- **Archiving rulecheck.** That is Phase 3, a separate task with its own checklist
  (unsubscribe rulecheck from the packs first, confirm on the dashboard that sync no
  longer targets it, only then archive). Do not archive in this phase.
- Renames, refactors, M3 work. The package name stays `rulecheck` and its `exports`
  map does not change, so every `rulecheck/...` import specifier in rulefleet keeps
  working unchanged.

## 0. Baseline (before touching anything)

1. Fresh clones of both repositories.
2. Dogfood baseline: from the rulecheck clone, scan a clean rulefleet checkout and
   save the JSON output, e.g. `bun run dev scan <rulefleet-checkout> --json` to a
   file outside both repos. Section 5 compares against this file.

## 1. Working branch

Work on a branch `monorepo-merge` in the rulefleet clone and open one pull request.
The whole phase is this one PR; closing it is the rollback. Merge with a merge commit,
not squash, so the imported history stays reachable.

## 2. Import with history

```
git remote add rulecheck https://github.com/lightsound/rulecheck.git
git fetch rulecheck
git subtree add --prefix=packages/rulecheck rulecheck main
```

Do not pass `--squash`: D34 requires the history preserved. This imports rulecheck's
current main, i.e. including the Phase 1 commits (FSL license, README, D34).

Follow-up commit inside the same PR:

- Delete `packages/rulecheck/.github/` (its pullfrog workflow is inert when nested
  and would only confuse).
- Delete `packages/rulecheck/bun.lock` (the workspace root owns the lockfile).
- Keep `packages/rulecheck/biome.json` and `tsconfig.json`; the package's own
  `bun run check` uses them.

## 3. Workspace wiring

In rulefleet's root `package.json`:

- `workspaces`: add `"packages/*"` alongside the existing `"infra"`.
- `dependencies`: replace `"rulecheck": "github:lightsound/rulecheck#f8691ce..."`
  with `"rulecheck": "workspace:*"`.
- Keep the `overrides.rulecheck` entry for now; section 5 verifies whether it still
  does its job.

Run `bun install` at the root and commit the regenerated `bun.lock`.

## 4. Pointers and README

- `AGENTS.md` (rulefleet root): update every `rulecheck/docs/...` reference to
  `packages/rulecheck/docs/...`, and the sentence describing rulecheck as "consumed
  as a dependency pinned to a commit sha" to describe the workspace package. The
  rule underneath it does not change: one engine, RuleFleet is a view and a runner,
  never a second implementation.
- New root `README.md` for rulefleet: what RuleFleet is, the layout (app at root,
  `infra/`, `packages/rulecheck`), and licensing: everything in this repository is
  FSL-1.1-MIT; rulecheck's pre-merge history up to `f8691ce` was MIT (tag `mit-final`
  in the archived repository).
- `packages/rulecheck/README.md`: update the closing paragraph that says the move
  "will later" happen; it has happened.

## 5. Verification gates (all must pass before merging the PR)

1. **Effect is single.** After `bun install`, inspect `bun.lock`: exactly one version
   and one instance of `effect` and of `@effect/platform-bun` across the workspace.
   Effect is sensitive to runtime identity; a duplicate is a silent failure, not a
   warning. If the nested `overrides.rulecheck` no longer applies to the workspace
   member, rewrite it as a flat root-level override and re-verify.
2. Root `bun run check` is green.
3. `bun --cwd packages/rulecheck run check` is green (typecheck, lint, tests).
4. CI on the PR: the `Check` job succeeds and the preview deploy (`Deploy pr-<n>`)
   succeeds.
5. **Dogfood diff.** Re-run the section 0 scan against the merged tree and diff
   against the baseline JSON. Every difference must be confined to
   `packages/rulecheck/**` paths (its `AGENTS.md`, `CLAUDE.md`, `docs/`, and the
   intentionally broken shapes under `tests/fixtures/`). A difference anywhere else
   stops the merge until it is explained.
6. CLI smoke test from the new home: `bun run --cwd packages/rulecheck dev scan
   <any local repository>` runs and reports.

## 6. After the merge

- Confirm the `prod` deploy from `main` succeeds.
- Record completion in [roadmap.md](roadmap.md) (Phase 2 done; Phase 3 remains).
- Phase 3 (unsubscribe, then archive rulecheck) is picked up separately; the
  rulecheck repository stays live and untouched until then.

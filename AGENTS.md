# rulecheck

Health check for AI coding agent instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.claude/rules`) across many repositories.

## What this project is

- A read-only CLI. It scans a directory tree, finds git repositories, and reports how each one arranges its instruction files: canonical shape, duplicates across repos, and the approximate context budget each tool loads.
- It does not write to scanned repositories. Structural fixes will arrive later as explicit, deterministic commands; content authoring is never in scope.
- Convention this project enforces on itself and recommends to others: `AGENTS.md` is canonical, `CLAUDE.md` is a one-line `@AGENTS.md` wrapper.

## Stack

- Bun (runtime, package manager, test runner). Use `bun <file>`, `bun test`, `bun add`. Never `node`, `npm`, `pnpm`, `vitest`, `jest`.
- TypeScript 7, strict. Imports use explicit `.ts` extensions.
- Effect v4 (release candidate, exact-pinned). CLI is `effect/unstable/cli`; filesystem access goes through `FileSystem` / `Path` services so tests can substitute layers.
- Biome for lint and format.

## Commands

- `bun run dev scan <dir>` run the CLI against a directory
- `bun run check` typecheck, lint, and test
- `bun test` tests only
- `bun run lint:fix` format and autofix

## Layout

- `src/main.ts` entry; provides Bun platform services and runs the command tree
- `src/cli.ts` command and flag definitions only, no logic
- `src/domain/` pure functions and types: file kind detection, wrapper detection, frontmatter parsing, shape classification, budget estimation, token counting, reference extraction (`references.ts`)
- `src/scan/` effectful code: `walk.ts` discovery, `analyze.ts` per-file analysis, `verify.ts` reference verification against the repo, `personal.ts` the personal layer (`~/.claude`, `~/AGENTS.md`, `~/CLAUDE.md`, `~/.cursor/rules`), `scan.ts` orchestration
- `src/report/` rendering of a `ScanReport` to text
- `tests/` `bun test` files; pure domain functions are tested directly, walking is tested against fixture trees
- `docs/tool-behavior.md` verified facts about what Cursor and Claude Code load, with evidence and a re-verification method. Update it when a heuristic depends on a new fact about a tool.
- `docs/decisions.md` dated design decisions (distribution unit, layers, sync model). Add an entry when a decision changes what rulecheck writes or reports.
- `docs/roadmap.md` ordered next steps with done criteria and the current wiring state. Read it first in a new session; update it when a step finishes.
- `docs/landscape.md` dated survey of overlapping tools and vendor features, with the verdict behind D8. Re-survey when a vendor ships repo-resident instruction distribution.

## Rules

- Keep `src/domain/` free of Effect and I/O. Anything that touches the filesystem lives in `src/scan/`.
- Add a new detector as a pure function in `src/domain/` first, with a test, then wire it into `scan.ts` and `render.ts`.
- Findings favor precision over recall. A finding asks a human to act; when the text is ambiguous, skip it rather than guess. Every finding carries `file:line`.
- Before changing a heuristic, run `bun run dev scan ~/ghq` and read the findings that appear or disappear; the real tree is the regression suite for false positives.
- Do not add an editor, watcher, or any write path to scanned repositories without an explicit decision recorded in this file.
- Effect `unstable/*` modules may break between minor versions; bump `effect` and `@effect/platform-bun` together and re-run `bun run check`.

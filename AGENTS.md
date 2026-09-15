# rulecheck

Health check for AI coding agent instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.claude/rules`) across many repositories.

## What this project is

- A CLI with a read-only `scan` and one write command, `sync`. `scan` walks a directory tree, finds git repositories, and reports how each one arranges its instruction files: canonical shape, duplicates across repos, the approximate context budget each tool loads, and per pack the distribution status (current / outdated / modified / eligible / blocked / not subscribed).
- `sync` distributes a pack's `AGENTS.md` block into one GitHub repository as a pull request (`docs/decisions.md` D10). It writes only through the GitHub API, never to local checkouts or `~/`, and only after re-running the scan on the remote tree before and after the planned change. Content authoring is never in scope.
- Convention this project enforces on itself and recommends to others: `AGENTS.md` is canonical, `CLAUDE.md` is a one-line `@AGENTS.md` wrapper.

## Stack

- Bun (runtime, package manager, test runner). Use `bun <file>`, `bun test`, `bun add`. Never `node`, `npm`, `pnpm`, `vitest`, `jest`.
- TypeScript 7, strict. Imports use explicit `.ts` extensions.
- Effect v4 (release candidate, exact-pinned). CLI is `effect/unstable/cli`; filesystem access goes through `FileSystem` / `Path` services so tests can substitute layers.
- Biome for lint and format.

## Commands

- `bun run dev scan <dir>` run the CLI against a directory (text summary). Flags: `--json` full report for tooling, `--all` include repositories with no instruction files, `--no-personal` skip the `~/.claude` layer, `--max-depth <n>` descent limit (default 12), `--packs <dir | owner/repo[@ref]>` pack repository (`packs/<id>/AGENTS.md`, `subscriptions.json`) as a local checkout or read from GitHub through `gh api`, to add the pack distribution report (with the personal layer, it also lists personal files that carry a pack body, D13)
- `bun run dev sync <owner/repo> --pack <id> --packs <dir | owner/repo[@ref]> --dry-run` measure one target on GitHub and print the planned diff; without `--dry-run` it pushes branch `agent-rules/<id>` and opens or updates the pull request. `--base <branch>` overrides the default branch. Needs `gh auth login`
- `bun run check` typecheck, lint, and test
- `bun test` tests only
- `bun run lint:fix` format and autofix

## Layout

- `src/main.ts` entry; provides Bun platform services and runs the command tree
- `src/cli.ts` command and flag definitions only, no logic
- `src/domain/` pure functions and types: file kind detection, wrapper detection, frontmatter parsing, shape classification, budget estimation, token counting, reference extraction (`references.ts`), managed-block parsing (`block.ts`), skills inventory and `skills-lock.json` (`skills.ts`), pack loading, distribution status, and personal-layer pack copies (`pack.ts`), the sync plan, block rendering and pull request text (`sync.ts`), unified diff (`diff.ts`)
- `src/scan/` effectful, read-only: `walk.ts` discovery, `analyze.ts` per-file analysis, `verify.ts` reference verification against the repo, `skills.ts` skill directory hashing, `packs.ts` reading a pack repository from a checkout or from GitHub (`resolvePacks`, `--packs`), `personal.ts` the personal layer (`~/.claude`, `~/AGENTS.md`, `~/CLAUDE.md`, `~/.cursor/rules`), `scan.ts` orchestration
- `src/github/` the `GitHub` Effect service (`client.ts`), its live layer over `gh api` (`gh.ts`), and `fs.ts`, which presents a repository at one commit as a read-only `FileSystem` mounted at `/github.com/<owner>/<repo>` so `scan` and `loadPacks` run unchanged on remote trees
- `src/sync/` the write path: `sync.ts` measures the target through the snapshot filesystem, plans, measures the planned tree again, then creates one commit, the branch `agent-rules/<pack>`, and the pull request. The only directory that issues GitHub writes
- `src/report/` rendering of a `ScanReport` (`render.ts`) and a sync result (`sync.ts`) to text; `failure.ts` prints expected failures (refusal, bad `--packs`, GitHub error) as one stderr line with exit code 1
- `tests/` `bun test` files; pure domain functions are tested directly, walking is tested against fixture trees, the write path against `fake-github.ts` (an in-memory `GitHub` layer with a flat git object store)
- `docs/tool-behavior.md` verified facts about what Cursor and Claude Code load, with evidence and a re-verification method. Update it when a heuristic depends on a new fact about a tool.
- `docs/decisions.md` dated design decisions (distribution unit, layers, sync model). Add an entry when a decision changes what rulecheck writes or reports.
- `docs/roadmap.md` ordered next steps with done criteria and the current wiring state. Read it first in a new session; update it when a step finishes.
- `docs/landscape.md` dated survey of overlapping tools and vendor features, with the verdict behind D8. Re-survey when a vendor ships repo-resident instruction distribution.

## Rules

- Keep `src/domain/` free of Effect and I/O. Anything that touches the filesystem lives in `src/scan/`; anything that talks to GitHub goes through the `GitHub` service in `src/github/`.
- Add a new detector as a pure function in `src/domain/` first, with a test, then wire it into `scan.ts` and `render.ts`.
- Findings favor precision over recall. A finding asks a human to act; when the text is ambiguous, skip it rather than guess. Every finding carries `file:line`. The rot-detection heuristics (what is extracted, what is skipped, how a reference is verified) are documented in the header comments of `src/domain/references.ts` and `src/scan/verify.ts`.
- `README.md` is intentionally absent; do not create it unless the user asks.
- Before changing a heuristic, run `bun run dev scan ~/ghq` and read the findings that appear or disappear; the real tree is the regression suite for false positives.
- The only write path is `src/sync/` and it writes only to GitHub through the `GitHub` service (D10). Do not add an editor, watcher, local-checkout write, or a second write path without a new entry in `docs/decisions.md` and here.
- Every write in `sync` is preceded by a scan of the remote tree and followed by a scan of the planned tree; a `blocked` or `modified` status or a new reference finding refuses the write. Keep that order when changing `src/sync/sync.ts`.
- Test the write path against `tests/fake-github.ts` only. Never point a test or a manual run without `--dry-run` at a real repository you do not own.
- Effect `unstable/*` modules may break between minor versions; bump `effect` and `@effect/platform-bun` together and re-run `bun run check`.

<!-- agent-rules:begin source=base rev=97f10769145defd3d3ae58f8755d2a2cceb1e569 hash=eee7698ebfe00708fb1da9f0f14eae53d3806e88a7258c48b1f6c8900400b155 -->
# Personal instructions

Portable conventions for AI coding agents. Everything here holds in any clone of any repository, including a fresh checkout on a cloud VM; nothing depends on one machine's paths or tools. Where a project-specific section of the file that carries this text says otherwise, the project-specific section takes precedence.

## Language

- English everywhere: code, comments, identifiers, commit messages, branch names, Issues, PR titles and bodies, review comments, and every file in the repository.
- Two exceptions: translation and i18n files together with user-facing UI copy, which follow the product's language; and the chat between the agent and the user, which is Japanese.

## Reporting

- No interim progress reports. Report once, when the work is done, with the results.
- Write the chat in concise, plain Japanese.

## Decisions

- When implementation needs a judgment call, do not ask the user. Propose a solution, then run rounds of searching for a strictly better alternative or a silver bullet; stop the search when a round produces no new option.
- Then extract the principle that generates the constraint and check whether the problem can be dissolved structurally. Only after that pick the best option.
- In the final report, state for each decision in which round no new options appeared.

## Delivery

- When the work is done, open the PR as ready for review, not as a draft, and address review-bot findings.

## Instruction files

- `AGENTS.md` carries the content; `CLAUDE.md` contains exactly `@AGENTS.md`. Do not put content in `CLAUDE.md` and do not write a prose pointer ("see AGENTS.md"): Claude Code only loads the `@` import form.
- Tool-scoped rules (glob-activated) go in `.cursor/rules/*.mdc` or `.claude/rules/*.md`, not in the root pair.
- When an instruction file names a command or path, it must exist in the repository at the time of writing. Remove or update the reference when the target is renamed or deleted.
- `README.md` is for humans and marketing only. Do not create or update it unless the user explicitly asks, and never duplicate `AGENTS.md` content into it. Agent-facing instructions live in `AGENTS.md`.
<!-- agent-rules:end -->

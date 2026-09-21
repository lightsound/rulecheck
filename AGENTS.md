# rulecheck

Health check for AI coding agent instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.claude/rules`) across many repositories.

## What this project is

- A CLI with a read-only `scan` and one write command, `sync`. `scan` walks a directory tree, finds git repositories, and reports how each one arranges its instruction files: canonical shape, duplicates across repos, the approximate context budget each tool loads, and per pack the distribution status (`current` / `outdated` / `modified` / `eligible` / `blocked` / `not-subscribed`; every word of the state model is defined in `docs/status-model.md`, D17).
- `sync` distributes a pack's `AGENTS.md` block into one GitHub repository as a pull request (`docs/decisions.md` D10), or with `--all` into every repository in `subscriptions.json`, one pull request per repository per pack (D14). It writes only through the GitHub API, never to local checkouts or `~/`, and only after re-running the scan on the remote tree before and after the planned change. Content authoring is never in scope.
- Distribution status has two sources. `scan --packs` measures the local checkouts under the directory, so it reflects whatever branch or uncommitted state each checkout is on. `sync --all --dry-run` measures every subscriber's default-branch HEAD on GitHub and is the authoritative distribution report; after a pull request merges, the checkout may still read `eligible` until it is pulled.
- Convention this project enforces on itself and recommends to others: `AGENTS.md` is canonical, `CLAUDE.md` is a one-line `@AGENTS.md` wrapper. What the sync requires is weaker: a root `CLAUDE.md` that holds an `@AGENTS.md` line anywhere outside fenced code is canonical by import (`agents-imported`, D16); it gets a note in `scan`, is left byte for byte by `sync`, and only a `CLAUDE.md` without that line is merged (D12).

## Stack

- Bun (runtime, package manager, test runner). Use `bun <file>`, `bun test`, `bun add`. Never `node`, `npm`, `pnpm`, `vitest`, `jest`.
- TypeScript 7, strict. Imports use explicit `.ts` extensions.
- Effect v4 (release candidate, exact-pinned). CLI is `effect/unstable/cli`; filesystem access goes through `FileSystem` / `Path` services so tests can substitute layers.
- Biome for lint and format.

## Commands

- `bun run dev scan <dir>` run the CLI against a directory (text summary). Flags: `--json` full report for tooling, `--all` include repositories with no instruction files, `--no-personal` skip the `~/.claude` layer, `--max-depth <n>` descent limit (default 12), `--include-nested` scan repositories nested inside other repositories as their own (by default a submodule or a clone inside a checkout is a different project: not a target, not part of the parent, not walked; counted in the text footer, `--json` `excludedNested[]` with kind `submodule` | `nested-clone`, and the HTML footnote; D24), `--packs <dir | owner/repo[@ref]>` pack repository (`packs/<id>/AGENTS.md`, `subscriptions.json`) as a local checkout or read from GitHub through `gh api`, to add the pack distribution report (with the personal layer, it also lists personal files that carry a pack body, D13), `--html <file>` also write the same report as one self-contained HTML page (inline CSS, no script, no external asset, GitHub Primer tokens in light and dark; overview cards with one number each, a `Next actions` list of every repo × pack that asks a human or a sync to act, one status bar per pack and the repo × pack matrix grouped by owner and ordered worst first, a folded `Not subscribed` candidate list saying what a sync would do once subscribed, per-owner repository rows under sticky headers, one per repository including those without instruction files so every name on the page links to a row, open only when the repository has an issue, personal layer, footer with version, date, and the glossary link; D19–D22) for someone who reads it in a browser or prints it. The HTML file is the only file `scan` writes, and only at the path given
- `bun run dev sync <owner/repo> --pack <id> --packs <dir | owner/repo[@ref]> --dry-run` measure one target on GitHub and print the planned diff; without `--dry-run` it pushes branch `agent-rules/<id>` and opens or updates the pull request. `--base <branch>` overrides the default branch. Needs `gh auth login` or a `GH_TOKEN` environment variable (how the agent-rules workflow authenticates, D23)
- `bun run dev sync --all --packs <dir | owner/repo[@ref]> [--pack <id>] --dry-run` measure every subscriber of every pack (or of one pack) on its default branch and print one row per target: repository, pack, remote status, outcome (`planned +N -M: <actions>`); the remote distribution report. Without `--dry-run` it opens or updates one pull request per target, at most three targets in flight, writes serialized. Exit code 1 only when a target could not be read or written (API/auth); `modified`, `blocked`, and other refusals are rows. `--html <file>` also writes the table as an HTML page (with `--all` only). `--run-url <url>` (either form) appends a link to the automated run that issued the sync to every pull request body it writes; the `Sync packs` workflow in `lightsound/agent-rules` passes its own run URL (D23)
- Distribution is driven by RuleFleet (the hosted App, `lightsound/rulefleet`): a push to the registered pack source starts a sync run that calls `syncTarget` per subscriber, live when the installation's `sync_on_push` is `live` (D31; D23's `Sync packs` workflow in `lightsound/agent-rules` is retired, B7). `sync --all` from a checkout remains the manual retry path and the way to sync from an unmerged pack ref
- `bun run check` typecheck, lint, and test
- `bun test` tests only
- `bun run lint:fix` format and autofix

## Layout

- `src/main.ts` entry; provides Bun platform services and runs the command tree
- `src/cli.ts` command and flag definitions only, no logic
- `src/domain/` pure functions and types: file kind detection, wrapper detection, frontmatter parsing, shape classification, budget estimation, token counting, reference extraction (`references.ts`), managed-block parsing and foreign marker / region detection (`block.ts`, D9, D15), report assembly from per-repository reports (`report.ts`: `assembleScanReport`, duplicates, totals; what `scan` ends with and what a host that stores one `RepoReport` per repository calls when it builds a page), nested repository kind and `.gitmodules` parsing (`nested.ts`, D24), skills inventory and `skills-lock.json` (`skills.ts`), pack loading, distribution status, and personal-layer pack copies (`pack.ts`), the sync plan, block rendering and pull request text (`sync.ts`), unified diff (`diff.ts`)
- `src/scan/` effectful, read-only: `walk.ts` discovery (stops at repositories nested inside a discovered repository unless `includeNested`, D24), `analyze.ts` per-file analysis, `verify.ts` reference verification against the repo, `skills.ts` skill directory hashing, `packs.ts` reading a pack repository from a checkout or from GitHub (`resolvePacks`, `--packs`), `personal.ts` the personal layer (`~/.claude`, `~/AGENTS.md`, `~/CLAUDE.md`, `~/.cursor/rules`), `scan.ts` orchestration
- `src/github/` the `GitHub` Effect service (`client.ts`); `transport.ts` the `Transport` interface (one request → status, headers, body) and `makeGitHub(transport)`, the one place a response is mapped to a service result (D26); `gh.ts` the `ghTransport` over `gh api` and `layerGh`, the CLI's front and the only module that spawns a process; `fetch.ts` the `fetchTransport` over `fetch` for the hosted App (token as an `Effect<string>`, secondary rate limit retried once, quota headers reported through `onRateLimit`, `retryAfter` on `GitHubError`); `installation-token.ts` the App installation token provider (`crypto.subtle` RS256 JWT, cached until five minutes before expiry, PKCS#1 keys refused; `repositoryIds` / `permissions` scope the minted token to a subset of the registration's); and `fs.ts`, which presents a repository at one commit as a read-only `FileSystem` mounted at `/github.com/<owner>/<repo>` so `scan` and `loadPacks` run unchanged on remote trees, listing subtrees one by one when the API truncates the recursive tree
- `package.json` `exports` exposes the `.ts` sources by subpath (`./domain/*`, `./scan/*`, `./sync/*`, `./report/html`, `./report/labels`, `./report/render`, `./report/sync`, `./github/*`, `./package.json`) for the App's sha-pinned git dependency (`rulecheck/scan/scan`); `tests/exports.test.ts` imports through the package name. The App never imports `main.ts`, `cli.ts`, or `github/gh`
- `src/sync/` the write path: `sync.ts` measures the target through the snapshot filesystem, plans, measures the planned tree again, then creates one commit, the branch `agent-rules/<pack>`, and the pull request (`WriteLock`, the structural interface a host's lock satisfies, is exported here and from `all.ts`); `all.ts` runs that path over every `subscriptions.json` entry in isolation and collects one row per target; `subscribe.ts` (D32, the D25 subscriptions writer for RuleFleet, no CLI command) changes `subscriptions.json` on the pack repository as one commit: `pull-request` mode rebuilds the branch `rulecheck/subscriptions` from the base head with the pending set (tip minus base) plus the requested changes under one open pull request, `direct-commit` mode fast-forwards the base branch and re-plans once on a head that moved; the pure planner is `src/domain/subscriptions.ts` (`planSubscriptionChanges`, `subscriptionDiff`). The only directory that issues GitHub writes
- `src/report/` rendering of a `ScanReport` (`render.ts`) and sync results (`sync.ts`: one target, or the `--all` table) to text, and of the same `ScanReport` / `--all` result to one self-contained HTML page (`html.ts`, `--html`; pure string building, every word from `labels.ts`, no detection of its own; `renderHtmlParts` hands the stylesheet, subtitle, sections, and footer to a host that supplies its own document); `labels.ts` the text label of every shape, pack status, sync outcome, and skill lock state, and the next-action verb per pack status, matching `docs/status-model.md`; `failure.ts` prints expected failures (refusal, bad `--packs`, GitHub error, an incomplete `--all` run) as one stderr line with exit code 1
- `tests/` `bun test` files; pure domain functions are tested directly, walking is tested against fixture trees, the write path against `fake-github.ts` (an in-memory `GitHub` layer with a flat git object store, also presented as GitHub's REST endpoints over `fetch` by `fakeRest` and as `gh api` output by `ghRunnerOver`, so `fetchTransport` and `ghTransport` are tested against the same store as the service)
- `docs/tool-behavior.md` verified facts about what Cursor and Claude Code load, with evidence and a re-verification method. Update it when a heuristic depends on a new fact about a tool.
- `docs/decisions.md` dated design decisions (distribution unit, layers, sync model). Add an entry when a decision changes what rulecheck writes or reports.
- `docs/status-model.md` the glossary of the distribution state model (shape, normalization, pack status, sync outcome): identifier, label, definition, transitions, and the command that surfaces each, plus the repo × pack lifecycle. Read it before touching a status, a label, or a `--json` field.
- `docs/roadmap.md` ordered next steps with done criteria and the current wiring state. Read it first in a new session; update it when a step finishes.
- `docs/landscape.md` dated survey of overlapping tools and vendor features, with the verdict behind D8. Re-survey when a vendor ships repo-resident instruction distribution.
- `docs/platform-comparison.md` dated survey of hosting stacks for the GitHub App (Cloudflare Workers + Queues + Durable Objects + D1 with Alchemy, versus Vercel Functions + Workflows/Queues + Neon, versus Prisma Compute + Postgres + Composer): runtime fit for Effect v4 and `src/*`, job and lock primitives, database, IaC, observability, price at 10 / 100 / 500 installations, GA versus beta, and the recommendation "Cloudflare unless …" with the switch conditions. Read it before changing the App's hosting; re-survey when a named beta reaches GA or a limit it relies on changes.
- `docs/app-design.md` the GitHub App MVP design (goals, flows, source of truth D25, architecture and what changes in `src/github`, the three dashboard pages, tech choices incl. Alchemy, Effect `HttpApi`, and a React + TanStack Start dashboard on HeroUI Pro in a private repository, the bootstrap flow, security, pricing deferred to after M2, milestones, the owner's answers to every question). Read it before building anything server-side; nothing in it is implemented.
- `docs/m1-kickoff.md` the handoff for the agents building RuleFleet (the hosted App, private repository `lightsound/rulefleet`) in M1: scope and done criteria from `app-design.md`, the repository bootstrap (stack, `exports` subpaths rulecheck must expose, sha-pinned git dependency), tasks P0 (the `src/github` transport split, on this repository) and T1–T7, the owner's secrets checklist, working rules, and what M2/M3 defer. Read P0 there before touching `src/github`; update the task list when P0 lands.
- `docs/m2-kickoff.md` the handoff for M2 of RuleFleet: M2a (pack source registration, source loading as the first step of a dry-run-only sync run, statuses classified live from stored reports, `status_snapshots` as history) and M2b (live sync as Workflow steps calling `syncTarget`, the `WriteLock` Durable Object, the D25 subscriptions writer in `src/sync/`, the repository page, the D23 workflow retired), each task with its done check; the rulecheck tasks P1 (`WriteLock` interface, scoped installation tokens, `committed`; done) and R2 (the subscriptions writer; done, D32); every judgment call recorded as options → rounds → principle → chosen. Read it before touching `src/sync/` for the App; update the task list when P1 or R2 lands.

## Rules

- Keep `src/domain/` free of Effect and I/O. Anything that touches the filesystem lives in `src/scan/`; anything that talks to GitHub goes through the `GitHub` service in `src/github/`.
- Add a new detector as a pure function in `src/domain/` first, with a test, then wire it into `scan.ts` and `render.ts`.
- A new shape, normalization, pack status, or sync outcome, and any new label, goes into `docs/status-model.md` first, then into the type and `src/report/labels.ts`; `tests/status-model.test.ts` enforces it. Labels for pack statuses and sync outcomes are the identifier with `-` replaced by a space. Renaming or removing a `scan --json` field bumps `schemaVersion`.
- Findings favor precision over recall. A finding asks a human to act; when the text is ambiguous, skip it rather than guess. Every finding carries `file:line`. The rot-detection heuristics (what is extracted, what is skipped, how a reference is verified) are documented in the header comments of `src/domain/references.ts` and `src/scan/verify.ts`.
- `README.md` is intentionally absent; do not create it unless the user asks.
- Before changing a heuristic, run `bun run dev scan ~/ghq` and read the findings that appear or disappear; the real tree is the regression suite for false positives.
- The only write path is `src/sync/` and it writes only to GitHub through the `GitHub` service (D10). Do not add an editor, watcher, local-checkout write, or a second write path without a new entry in `docs/decisions.md` and here. The second writer is `src/sync/subscribe.ts` (D32): it touches the pack repository's `subscriptions.json` only, measures before and after like `syncTarget`, and takes the caller's `WriteLock`. `--html <file>` is report output at a path the user names, like stdout, not a write to a scanned repository.
- Every write in `sync` is preceded by a scan of the remote tree and followed by a scan of the planned tree; a `blocked` or `modified` status or a new reference finding refuses the write. Keep that order when changing `src/sync/sync.ts`. `sync --all` must keep calling that single-target path per repository (`syncTarget`), so the fan-out never gets checks of its own.
- When the status of a repository matters (did a block land, is a repository outdated), read it from `sync --all --dry-run`, not from `scan --packs` over local checkouts.
- Test the write path against `tests/fake-github.ts` only. Never point a test or a manual run without `--dry-run` at a real repository you do not own.
- Everything under `src/github/` except `gh.ts` must run on workerd: no `Bun.*`, no `node:*`, no `Buffer`; `fetch`, `crypto.subtle`, `atob` only. A new operation goes into `GitHubService`, `makeGitHub`, the fake, and `fakeRest` together, so the three fronts keep answering alike.
- Effect `unstable/*` modules may break between minor versions; bump `effect` and `@effect/platform-bun` together and re-run `bun run check`.

<!-- agent-rules:begin source=base rev=749176a6369bb4206fc0ffb6e49329cf01c72040 hash=0ba521f2f137b14e657ffd3de0f4dc764d5a943199c3fd62f6e307f8d64cfbe1 -->
# Shared conventions

Portable conventions for AI coding agents. Everything here holds in any clone of any repository, including a fresh checkout on a cloud VM; nothing depends on one machine's paths or tools. Where a project-specific section of the file that carries this text says otherwise, the project-specific section takes precedence.

## Language

- English everywhere in the repository: code, comments, identifiers, commit messages, branch names, Issues, PR titles and bodies, and review comments.
- Exception: translation and i18n files and user-facing UI copy follow the product's language.

## Instruction files

- `AGENTS.md` carries the content; `CLAUDE.md` contains exactly `@AGENTS.md`. Do not put content in `CLAUDE.md` and do not write a prose pointer ("see AGENTS.md"): Claude Code only loads the `@` import form.
- Tool-scoped rules (glob-activated) go in `.cursor/rules/*.mdc` or `.claude/rules/*.md`, not in the root pair.
- When an instruction file names a command or path, it must exist in the repository at the time of writing. Remove or update the reference when the target is renamed or deleted.
- Agent-facing instructions live in `AGENTS.md`. `README.md` is for humans; never duplicate `AGENTS.md` content into it.
<!-- agent-rules:end -->

<!-- agent-rules:begin source=personal rev=749176a6369bb4206fc0ffb6e49329cf01c72040 hash=f1a5d3d27bb791dd3b47db3d20abb2766ca3b475178c259a8388ede569050e30 -->
# Personal working style

How this repository's owner works with agents. Portable: nothing here depends on one machine or repository. Where a project-specific section of the file that carries this text says otherwise, the project-specific section takes precedence.

## Chat and reporting

- The chat between the agent and the user is Japanese.
- No interim progress reports. Report once, when the work is done, with the results.
- Prose is concise and plain, but items the rules require (the decisions table, PR URLs, test counts, and other structured facts) are never omitted or aggregated for brevity.

## Decisions

- When implementation needs a judgment call, do not ask the user. Propose a solution, then run rounds of searching for a strictly better alternative or a silver bullet; stop the search when a round produces no new option.
- Then extract the principle that generates the constraint and check whether the problem can be dissolved structurally. Only after that pick the best option.
- The final report lists every judgment call in a table with three columns: decision, chosen option, and the round in which no new option appeared. Never summarize or aggregate this table; when relaying another agent's report, keep it intact.

## Delivery

- When the work is done, open the PR as ready for review, not as a draft, and address review-bot findings.
- Do not create or update `README.md` unless the user explicitly asks.
<!-- agent-rules:end -->

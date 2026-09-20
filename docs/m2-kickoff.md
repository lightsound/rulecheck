# RuleFleet M2 kickoff

Handoff for the agents that build M2 of **RuleFleet** (`lightsound/rulefleet`, private) and the
rulecheck changes it needs. Written 2026-09-20 against [app-design.md](app-design.md) as
revised for D29 / D30 (§1 three goals, §2 flows, §5 the five Fleet routes, §7 M2 sync and
`WriteLock`, §9 M2a read / M2b write), [decisions.md](decisions.md) D1–D30,
[status-model.md](status-model.md), [m1-kickoff.md](m1-kickoff.md) (whose form this document
follows), rulefleet `main` at `cc80d83` (`AGENTS.md`, `src/fleet/*`, `src/db/packs.ts`,
`src/jobs/*`, `infra/alchemy.run.ts`), and the M1 record (D27, D28, D29). Where this document
and `app-design.md` disagree, `app-design.md` wins; the departures this document proposes are
each a decision below and become `decisions.md` entries when built.

## 0. How judgment calls are made in this document

The owner delegates the M2a / M2b plan to the coordinator and prescribes the method for every
judgment call, which this document applies in §8 and summarizes in the closing table:

- **(a) Options.** List the candidate options first, including the one already in the design.
- **(b) Search loop.** Look for a strictly better option or a silver bullet; run another round;
  stop when a round produces no new option. The round in which nothing new appeared is recorded.
- **(c) Principle.** Extract the principle that generates the constraint and check whether the
  problem dissolves structurally instead of being decided.
- **(d) Choice.** Pick the best option under that principle.

Each decision in §8 is written as **Options → Rounds → Principle → Chosen**. Decisions the owner
made in `app-design.md` (§10 and its decisions table) are not reopened; where one of them is
listed here it is because the loop was run to confirm that no strictly better option appeared
since, and the entry says so.

## 1. What M2 is

- **Goal 2 with real data.** `app-design.md` §1 names three goals: (1) manage the source, (2) see
  where each pack is distributed, (3) start and stop distribution. M1 shipped the frame and every
  read-only page over a fixture (`src/fleet/fixture.ts`); no installation has a pack source, so
  every status word on the dashboard is fixture data. **M2a** registers a pack source per
  installation, reads it from GitHub, and puts measured statuses on the Fleet cards, the Packs
  pages, and the Repositories table.
- **Goal 3 from the UI.** **M2b** makes the App write to GitHub for the first time: `Sync` and
  `Dry run` buttons that run rulecheck's `syncTarget` as Workflow steps and open one pull request
  per repository per pack (D10, D14), the subscription checkboxes that change
  `subscriptions.json` in the pack repository (D25), the `WriteLock` Durable Object (§7),
  sync runs on the Runs page, and an audit row for every write. It ends with the D23 workflow
  removed from `lightsound/agent-rules` (app-design §10, answer 7).
- The App stays a view and a runner over rulecheck's code and the pack repository's files (D25):
  every status is `classifyPackStatus` over a stored `RepoReport`, every write goes through
  `src/sync/` in rulecheck, and every word on a page is one `labels.ts` prints.

**Done when** (app-design §9, rows M2a and M2b, quoted):

> **M2a.** Pack source registration (inside the installation; writes the database only);
> `loadPacks` at the source's HEAD and the installation scan with `packs` set, so
> `status_snapshots` fill; the Fleet pack cards; the Packs list and the pack page with body,
> hash, rev, the GitHub edit and new-file links (D30), the Subscribers table and the
> `Not subscribed` fold (both read-only); the pack status columns of the Repositories table;
> the `subscriptionChanges` and `fullRescan` settings; the scheduled dry run producing sync runs
> on the Runs page. No GitHub write and no `WriteLock`: goal 2 is met here.

> **M2b.** `sync-target` on pack push, `Dry run` / `Sync` on the Fleet and pack pages (dry run
> the default state, live on a confirmed second click), the `WriteLock` Durable Object in use;
> `src/sync/subscribe.ts` in rulecheck with `fake-github.ts` coverage and its decision entry,
> the subscription checkbox on the pack page writing D25 changes through it and showing the
> pending `subscription PR #n open`; runs and audit rows for every write; `html.ts` sections
> exported and rendered by HeroUI components in TanStack Start routes (the Repositories table
> and the repository page stop embedding static sections); the D23 workflow removed from
> `agent-rules` once the App has opened the next real pull requests (replacement, not
> coexistence).

Two readings of that text are fixed here (decisions 3 and 16 in §8): "the installation scan with
`packs` set" is met by classifying the stored reports against the loaded packs, with no rescan,
because the classifier needs nothing a `RepoReport` does not already carry; and the scheduled
dry run of M2a runs the same `SyncRunWorkflow` M2b makes live, with the dry-run flag fixed to
`true` by construction, so M2a exercises the whole sync path against real repositories without a
write.

**Non-goals for M2.** Do not build these; each has a milestone or a decision entry of its own.

- A pack editor (D30); a pull request that removes a block (D29, "what stop means"); the
  candidate `rulecheck subscribe` CLI command (app-design §2, own entry); the derived starter
  pack (bootstrap option c).
- Billing, the `plan` gate, Stripe, alerts, the status page, the uninstall purge, the
  installation switcher polish (M3).
- Several pack sources per installation, a source outside the installation (decision 1).
- Auto-merge of the pull requests the App opens (D6, off, not implemented).

## 2. Where M1 left things (facts the tasks build on)

- **Pages and model.** `src/fleet/model.ts` `fleetModel(overview, snapshot)` already projects
  repository × pack three ways (`packs`, `repositories`, `nextActions`) through rulecheck's
  `distribute` / `classifyIfSubscribed`, from the stored `RepoReport`s and a
  `PackSourceSnapshot` (`src/db/packs.ts`). The five routes render it. With `snapshot === null`
  the pages show the bootstrap state (block facts per `source=`, the onboarding card). The
  `PackSourceStore` interface has a D1 implementation (`d1PackSourceStore`, reading
  `pack_sources` / `packs`) and an in-memory one; the D1 rows are empty. The M2 controls
  (`Dry run`, `Sync`, `Register`, `Remove`, the two `CellSelect`s) are rendered disabled with a
  tooltip, where they will work.
- **Schema.** `pack_sources` (unique per installation, `repository_id`, `branch`, `head_sha`,
  `loaded_at`, `warnings`), `packs` (`(pack_source_id, head_sha, pack_id)`, `hash`, `body`,
  `subscribers`), `status_snapshots`, `runs` (`kind` `scan` / `sync`, `dry_run`, `counts`,
  `expected_rows`), `run_rows` (`pack_id`, `outcome`, `status`, `message`, `pull_request_url`,
  `plus`, `minus`), `audit_log`, and the settings columns `installations.subscription_changes`
  and `full_rescan` all exist (rulefleet `src/db/schema.ts`). M2 adds columns, not tables
  (§5).
- **Jobs.** A scan run is one Workflow instance (`ScanRunWorkflow`, D27; `src/jobs/run.ts`
  drives a `StepLike` so tests use an in-memory step); `dispatch.ts` starts instances;
  `schedule.ts` runs the daily Cron and the stale-run sweep; the `JOBS` queue is kept for M2 and
  carries nothing. `runProgress` feeds the live banner.
- **Webhooks.** `src/webhooks/route.ts` is the pure routing table; a `push` to a default branch
  that touches an instruction path is a `scan-repository`; `packs/**` and `subscriptions.json`
  are not instruction paths, so a push to the pack repository today is "recorded, no job".
  `pull_request.closed` produces no job.
- **rulecheck.** `syncTarget(options, loaded, pack)` (`src/sync/sync.ts`) is the single-target
  path: measure, plan, measure, write; `options.writeLock` is an Effect `Semaphore` whose
  `withPermits(1)` gates the write; `options.runUrl` links the pull request to a run. `loadPacks`
  runs over the snapshot filesystem. `installationToken` mints an installation-wide token with
  every permission of the registration. `setRef` has `force` (default `true`).
  `renderHtmlParts` returns the sections as HTML strings, not as data.
- **Registration.** One GitHub App, `RuleFleet`, with `Contents: read & write`,
  `Pull requests: read & write`, `Metadata: read`; webhook events `installation`,
  `installation_repositories`, `push`, `pull_request`, `repository`,
  `github_app_authorization`. Nothing needs re-authorization for M2.
- **Dogfood.** The `lightsound` personal installation. `lightsound/agent-rules` distributes
  `base` and `personal` to seven repositories through the D23 workflow (`RULECHECK_TOKEN`);
  `lightsound/rulefleet` is being added to `subscriptions.json`
  ([agent-rules#9](https://github.com/lightsound/agent-rules/pull/9)).

## 3. M2a: pack source and distribution (read)

Each task is one pull request or a small series and ends with the check written under it.
Tasks marked **P1** are on `lightsound/rulecheck`; A1–A6 are on `lightsound/rulefleet`.

**P1 (rulecheck): the interface changes M2 needs.** Small, independent of each other, and
mergeable during M2a so that M2b never waits on rulecheck. Each is a pull request with
`tests/fake-github.ts` or `tests/transport.test.ts` coverage; none changes CLI behavior.

- **P1.1 `WriteLock` interface.** `SyncTargetOptions.writeLock` is typed
  `Semaphore.Semaphore` and uses only `withPermits(1)`. Narrow it to an exported interface
  `WriteLock = Pick<Semaphore.Semaphore, "withPermits">` in `src/sync/sync.ts` (re-exported by
  `all.ts`), so a Durable Object–backed lock can be passed structurally. The CLI's `Semaphore`
  satisfies it unchanged.
- **P1.2 Scoped installation tokens.** `installationToken` gains `repositoryIds?: number[]` and
  `permissions?: Record<string, "read" | "write">`, passed in the body of
  `POST /app/installations/{id}/access_tokens` (GitHub's `repository_ids` and `permissions`; the
  result is a token for those repositories with those permissions, a subset of the
  registration's). The App mints read-only tokens (`contents: read`, `pull_requests: read`) for
  scan runs and dry runs, and a per-target token (`contents: write`, `pull_requests: write`,
  one `repository_ids` entry) for each live write (app-design §7). Done check: the JWT test in
  `tests/transport.test.ts` asserts the body; a token minted read-only against a real repository
  gets `403` on `createTree` (checked once by hand on `prod`, never in tests).
- **P1.3 Size gate before `syncTarget`.** Nothing in rulecheck: the App wraps each target step
  with the M1 `MAX_REPOSITORY_SIZE_KB` gate (`getRepository.size`) and records `refused: too
  large to measure` without calling `syncTarget`. Listed here so nobody adds the gate to
  `syncTarget` (the CLI has no memory ceiling).
- **P1.4 `docs/status-model.md`.** Add `committed` to the words outside the model (the
  subscriptions writer's result for a `direct-commit` landing; §4 B3) before the writer is
  built, per the glossary rule. No pack status, shape, or sync outcome changes.
- Done check for P1: `bun run check` green; `sync --all --dry-run` through `ghTransport`
  unchanged; rulefleet bumps its rulecheck sha in A2.

**A1: pack source registration and the settings (database only).**

- Settings page: a `Select` of the installation's live, non-archived repositories and an
  optional branch (empty = the repository's default branch, read at load time), `Register`;
  `Remove` on a registered source (confirmed). The handler re-checks that the repository row
  belongs to the installation (the structural form of app-design §2's "inside the
  installation" rule: the token can read and write it and nothing else is needed), inserts the
  `pack_sources` row with `head_sha` null, appends `audit_log` `pack-source.register` /
  `pack-source.remove` with actor `user:<login>`, and starts a dry-run sync run (A2) whose first
  step loads the source. `Remove` deletes the `pack_sources` row and its `packs` rows; the pages
  return to the bootstrap state; `status_snapshots` and runs stay as history.
- The two `CellSelect`s become live: `full_rescan` (`daily` / `weekly` / `off`) and
  `subscription_changes` (`pull-request` / `direct-commit`), each a `<form method="post">` to
  the settings route, admins only (`installationAccess`, then `403`), one `audit_log` row per
  change (`settings.full_rescan`, `settings.subscription_changes`, old → new in `target`).
  `subscription_changes` has no effect until B3 and the page says so under the control.
- The permission statement (app-design §4: what `Contents: write` lets the App write, the two
  paths, the audit rule) as plain text on the Settings page.
- Done check: registering `lightsound/agent-rules` on the dogfood installation produces one
  `pack_sources` row, one audit row, and one sync run (dry) on the Runs page; registering a
  repository not in the installation is refused with that reason (a forged id, tested through
  the handler); `Remove` returns Fleet to the bootstrap state; changing `full_rescan` to
  `weekly` skips the next daily Cron for that installation (`tests/schedule.test.ts`); a
  non-admin gets `403` on every one of these POSTs.

**A2: `SyncRunWorkflow`, dry run only** (bump the rulecheck sha to P1 here).

- A second Workflow class, `SyncRunWorkflow` (`src/jobs/sync-run-workflow.ts`, the second
  module importing `cloudflare:workers`), driven by `runSync(deps, params, step)` in
  `src/jobs/sync.ts` over the same `StepLike` as `runScan`; binding `SYNC_RUN` (the three-place
  edit: `infra/alchemy.run.ts`, `wrangler.jsonc`, `WorkerEnv`, class exported from
  `src/worker.ts`). Params: `runId`, `installationId`, `trigger`, `packs: "all" | string[]`,
  `dryRun: true` (M2a: the type is the literal `true`; B2 widens it).
- Steps, in order (decision 4): **`load-source`** reads `pack_sources`, resolves the branch head
  (`getRef`), and, unless `packs` rows exist for that sha, builds a `repositorySnapshot` of the
  pack repository and runs `loadPacks(snapshotFileSystem(snapshot), path, mount, label)`
  unchanged, upserting `packs` rows (`hash`, `body`, `subscribers`) and updating `head_sha`,
  `loaded_at`, `warnings`; then classifies every stored `RepoReport` of the installation against
  the loaded packs (`distribute`) and appends `status_snapshots` rows (primary key dedupes a
  repeat); then writes the `runs` row (`kind: sync`, `dry_run: 1`) and the target list: one
  (repository, pack) per `subscriptions.json` entry, in file order, pack by pack (D14), each
  resolved to a live repository row of the installation. An entry that names a repository the
  installation does not have, or an archived one, is written at once as a `run_rows` row
  `refused` with status `-` and the reason (`not in this installation`, `repository is
  archived`); it consumes no step. **`target <repo> <pack>`**, one step per remaining target
  with `retries.limit: 2` and a delay honoring `GitHubError.retryAfter`: mint the read-only
  token, apply the size gate (P1.3), call `syncTarget({ repo, dryRun: true, runUrl }, loaded,
  pack)` over `fetchTransport`, and write the row: outcome `planned` (`plus` / `minus` from the
  plan), `nothing-to-do`, `up-to-date` (with the open pull request URL), `refused` (message,
  measured status), or, after the step's retries, `failed` (status kept when measured, D14).
  **`finish`** closes the run from `run_rows` as `runScan` does. Steps run with `concurrency: 3`
  (decision 9).
- Run-level failure (the source cannot be read: 404 on the pack repository, a branch that does
  not exist, the token cannot be minted) ends `load-source` after its retries with
  `runs.error` set (new nullable column, §5) and the run finished with zero rows; the Runs page
  prints the error line; the Packs page shows the source's `warnings` and, when set, the last
  run's error. A killed instance is closed by the T7 sweep with `incomplete: 1` as today.
- `runProgress` works for sync runs (`expected_rows` = targets), so the live banner shows
  `measured / expected, pending` on every page while a sync run is in flight.
- Done check: a dry run over the dogfood installation writes one row per (subscriber, pack) of
  `lightsound/agent-rules` and **its table equals `bun run dev sync --all --dry-run --packs
  lightsound/agent-rules` from a rulecheck checkout, row for row** (repository, pack, status,
  outcome, `+N -M`); a second dry run at the same source sha makes no tree or blob call for the
  source (the `packs` cache hit, asserted in `tests/sync-run.test.ts` against
  `fake-github.ts` with every write operation replaced by a failure, as `scan-run.test.ts`
  does); the step never calls `createTree`, `createCommit`, `setRef`, `createPullRequest`, or
  `updatePullRequest`; a source repository that is removed mid-run gives a finished run with
  `runs.error` and zero rows; the token minted for the run carries `contents: read`.

**A3: webhooks for the pack repository.**

- `route.ts` gains a context argument (`packSource: { repositoryId, branch } | null`, looked up
  by the receiver) and one row: a `push` to the registered source's branch whose touched paths
  (the M1 union of `added` / `modified` / `removed`, with the three "touching everything" cases)
  include `subscriptions.json` or a path under `packs/` is a `sync-run` job (`packs: "all"`,
  dry run in M2a); the same push also produces the M1 `scan-repository` for the pack repository
  itself when it touched an instruction path (its root `AGENTS.md` is one), so a delivery may
  yield two runs, one per kind; `handle.ts` dispatches both. Trigger `webhook:<delivery id>`.
- `dispatch.ts` gains `SYNC_RUN.create`; run ids stay idempotent by id.
- Done check: `tests/webhooks.test.ts` covers a push touching `packs/base/AGENTS.md` (sync run),
  one touching only `README.md` on the source (nothing), one to a non-default branch (nothing),
  and one with `forced: true` (sync run); on `prod`, merging a pack change in
  `lightsound/agent-rules` produces one dry-run sync run within a minute whose rows read
  `outdated` / `planned` for the subscribers.

**A4: real data on the five pages; keep the fixture.**

- `loadFleet` reads `d1PackSourceStore` (already wired) and the Runs page lists sync runs with
  their D14 table: a run detail route `i.$installationId_.runs_.$runId.tsx`
  (`/i/<installation>/runs/<run>`) with the run header (kind, trigger, dry run, started,
  finished, counts, `error`) and one row per target (repository linked to its Repositories
  anchor, pack, status chip, outcome with `+N -M` or the message, pull request link). The Fleet
  cards, the Packs list, the pack page (body, hash, rev, `Edit on GitHub`, `New pack on GitHub`,
  Subscribers with both facts, the folded candidates), and the Repositories status columns need
  no change beyond what `fleetModel` already does over a real snapshot; verify, do not rewrite.
- The pack page's Subscribers table adds the column "last run" (outcome of the latest sync run
  row for that repository × pack, with the pull request link) from `run_rows`.
- `src/fleet/fixture.ts` stays: it is the only way to render every status of the model in one
  page, `tests/fleet.test.tsx` and `/debug/fleet` render from it, and the fixture is itself
  produced by rulecheck's `scan` (decision 11). `/debug/fleet` stays non-prod.
- Update rulefleet `AGENTS.md` (Layout: `src/jobs/sync.ts`, `sync-run-workflow.ts`, the run
  detail route; Rules: the `SYNC_RUN` binding, "M2a issues no GitHub write", the kickoff
  pointer becomes `docs/m2-kickoff.md`).
- Done check: on `prod`, the Fleet home of the dogfood installation shows two cards (`base`,
  `personal`) whose counts equal the status column of the A2 dry run; every subscriber row on
  the pack page links to an open pull request or shows `nothing to do`; the Repositories table
  has two status columns with `file:line`; `/i/<installation>/runs/<run>` prints the same rows
  as the CLI table; `bun test` still renders every page from the fixture.

**A5: `status_snapshots` and the schedule.**

- The scan step (`scanOne`) also appends `status_snapshots` rows for the repository it measured
  when the installation has a loaded source, so a push that changes a subscriber's `AGENTS.md`
  records the new status without waiting for a sync run. The pages keep classifying live
  (decision 3); snapshots are history, read by B6.
- `runSchedule` starts one dry-run `SyncRunWorkflow` (trigger `schedule`) per eligible
  installation that has a pack source, after its scan run, on the same `full_rescan` rule.
- Done check: after the daily Cron, the dogfood installation has one scan run and one sync run
  with trigger `schedule`; `status_snapshots` holds one row per (repository, pack) at the
  current shas; an installation without a source gets no sync run; `tests/schedule.test.ts`
  covers both.

**A6: M2a closing.**

- Write `decisions.md` D31 for what A2 decided about the shape of a sync run (a Workflow
  instance per run, a step per target, `load-source` first; D27 left it open) if the shape
  built departs from §8 decision 4 in any way; otherwise D31 records it as built, in the
  wording of decision 4.
- Update `roadmap.md` (a Step 8 entry: M2a done, M2b next) and app-design §9's M2a row to
  "done" with the date.

M2a is complete when every done check above passes on `prod` with the dogfood installation and
`lightsound/agent-rules` registered, and the A2 dry-run table equals the CLI's.

## 4. M2b: sync and subscriptions (write)

**R2 (rulecheck): `src/sync/subscribe.ts`, the D25 subscriptions writer.** The one rulecheck
task with a decision entry of its own (D32 when built; D25 announced it).

- Pure plan in `src/domain/subscriptions.ts`: `planSubscriptionChanges(text | null, changes)`
  where a change is `{ pack, repo, op: "add" | "remove" }`; returns the new file text or a
  reason. It parses with `parseSubscriptions`, applies the changes (adding a missing pack key at
  the end, keeping key order, normalizing `owner/repo` with `normalizeRepoName`, refusing a
  duplicate add or a remove of an absent entry as "nothing to change" rather than as an error),
  and prints two-space JSON with a trailing newline, the form `agent-rules` keeps. A `null`
  input (file absent) plans a new file. A file that is not the D7 object shape is a refusal.
- `subscribe(options)` in `src/sync/subscribe.ts` with `options: { source: string
  (owner/repo), base?: string | null, changes, mode: "pull-request" | "direct-commit", dryRun,
  runUrl?, writeLock? }`, requiring `GitHub | Path`, returning a `SubscribeResult` whose kinds
  are `nothing-to-do`, `planned`, `up-to-date`, `opened`, `updated`, `committed`, and the
  errors `SyncRefused` / `SyncFailed` (reused; both carry `status: null`). Order, as
  `syncTarget`: measure (read `subscriptions.json` at the base head, and, in `pull-request`
  mode, at the tip of `rulecheck/subscriptions` when that branch exists and its tip is
  rulecheck's; the pending set is tip minus base), plan (base + pending + changes), measure again
  (`parseSubscriptions` of the planned text yields exactly the intended sets), then write.
  `pull-request` mode: one commit on the base head, branch `rulecheck/subscriptions` created or
  force-moved under the D10 ownership check, one open pull request opened or updated whose body
  lists every pending change with a link to the run when `runUrl` is given; a branch whose tip
  already holds the planned text under an open pull request is `up-to-date`. `direct-commit`
  mode: one commit on the base head, `setRef(force: false)`; a `422` re-reads the head, plans
  once more on top of the moved head, and tries once; the second `422` is `refused`
  (`app-design.md` §2, D25). A planned text that equals the base file with no pending set is
  `nothing-to-do`; a planned text that equals the base file while a pending pull request exists
  is a refusal naming the pull request to close (decision 5).
- `tests/subscribe.test.ts` against `fake-github.ts`: add and remove in both modes; the
  pending set carried across two submissions; the fast-forward retry and its second refusal; a
  foreign tip on `rulecheck/subscriptions`; `dryRun` issuing no write; an absent file; an
  invalid file.
- `docs/decisions.md` D32 and the `AGENTS.md` Layout / Rules lines ("`src/sync/` is the only
  write path" gains the second writer). No CLI command: `rulecheck subscribe` stays a candidate.
- Done check: `bun run check` green; the writer is reachable from `rulecheck/sync/subscribe`;
  a `direct-commit` run against the fake with a concurrent head move lands both changes.

**B1: the `WriteLock` Durable Object.**

- `src/jobs/write-lock.ts`: class `WriteLock` (`DurableObject`, SQLite-backed class, the third
  module importing `cloudflare:workers`), one object per installation (`idFromName(String(id))`),
  RPC `acquire(holder: string, ttlMs: number): Promise<void>` that resolves when the lock is
  free (an in-memory promise queue; a held lease expires after `ttlMs`, so a killed step cannot
  hold it forever) and `release(holder)`. The adapter `durableWriteLock(stub)` returns
  rulecheck's `WriteLock` (P1.1): `withPermits(1)(effect)` is `Effect.acquireUseRelease` around
  the two RPCs with a 60 s lease. Binding `WRITE_LOCK` (three-place edit; Alchemy
  `Cloudflare.Workers.DurableObject` reference form, class exported from `src/worker.ts`;
  `wrangler.jsonc` `durable_objects` and the `new_sqlite_classes` migration).
- Done check: `tests/write-lock.test.ts` drives the lock's queue and lease with an in-memory
  stub (two holders never overlap; an expired lease is taken over); on a `pr-<n>` stage two
  concurrent probe requests holding the lock for two seconds each complete in about four.

**B2: live sync.**

- `runSync` params gain `dryRun: boolean`; live steps mint a per-target token (P1.2:
  `repository_ids: [target]`, `contents: write`, `pull_requests: write`) and pass
  `writeLock: durableWriteLock(env.WRITE_LOCK.get(...))` and `runUrl:
  https://rulefleet.com/i/<installation>/runs/<run>` to `syncTarget`; rows gain `opened` /
  `updated` with `pull_request_url`. Each written row appends `audit_log` (`sync.opened` /
  `sync.updated`, target `owner/repo#<pack>`, `run_id`, `url`). A retried step is safe: a rerun
  of `syncTarget` measures first and reads `up-to-date` when the previous attempt's write landed
  (D14).
- Triggers: the `Sync` control on the Fleet home (per pack and once for all packs) and the pack
  page is a `Button` whose default state is `Dry run` and whose live run is a second, confirmed
  click (a `Modal`, as `Rescan`); both post to the runs route (`action=sync`, `pack`, `live`),
  admins only, audit `sync.requested` with the mode, trigger `manual:<login>`. A push to the
  pack repository (A3) starts a live run when the installation's `sync_on_push` setting (new,
  `live` / `dry-run`, default `live`; B5) says so, a dry run otherwise. The schedule stays dry.
- `pull_request.closed` on a branch `agent-rules/*` of a subscriber: find the `run_rows` row
  by `pull_request_url`, append ` (PR closed)` to its message when the pull request was not
  merged, and start a `scan-repository` for the base repository at its default-branch head
  (app-design §2 table); a merge is also a `push` and needs nothing here.
- Done check: on `prod`, a live run over the dogfood installation after a pack edit opens or
  updates one pull request per subscriber × pack, authored by `rulefleet[bot]`, whose diff is
  byte-identical to the dry run's and whose body ends with the run link; a second live run
  reads `up-to-date` for every target and writes nothing (zero write calls in the fake; on
  `prod`, no new commit on the branches); two live runs started within a second (button and
  push) converge on the same branch tips and one pull request per target; a killed target step
  (the `probe` param, non-prod) leaves its lease to expire and the next target writes; the
  audit log has one row per pull request; the token minted for a target opens `403` on any
  other repository (checked once by hand).

**B3: the subscription checkboxes.**

- The pack page's Subscribers table and the `Not subscribed` fold become one
  `<form method="post">` with one checkbox per repository (checked = in `subscriptions.json`
  after the pending set) and one `Apply` button (decision 5: the form is the basket). The
  handler (admins only) diffs the posted set against base + pending, calls rulecheck's
  `subscribe` synchronously with the installation's `subscription_changes` mode under the
  `WriteLock` (decision 6), appends `audit_log` (`subscriptions.changed`, the change list in
  `target`, the pull request or commit URL), refreshes the pending cache on `pack_sources`
  (`pending_sha`, `pending_pull_request`, `pending_subscriptions` JSON; §5), and redirects to
  the pack page with `?subscriptions=<outcome>` for a `Toast` (as `?rescan=started`). The row of
  a repository in the pending set shows `subscription PR #n open` with the link; under
  `direct-commit` the `push` that follows reloads the source (A3) and the row reads `eligible`.
- Webhooks: a `push` to `rulecheck/subscriptions` on the source, and `pull_request.closed`
  from that branch, refresh or clear the pending cache (a new `route.ts` row each, lifecycle,
  no run).
- Done check: on `prod` with `subscription_changes: direct-commit`, ticking a repository lands
  one commit on `lightsound/agent-rules` `main`, the push produces a sync run, and the row
  reads `eligible` then `planned` / `opened`; with `pull-request`, two ticks in a row produce one
  open pull request carrying both, `subscription PR #n open` on both rows, and its merge turns
  both `eligible`; unticking a repository that carries the block leaves its chip `current` and
  the checkbox unticked, and the page says so; a non-admin gets `403`; `tests/subscribe-form.test.ts`
  covers the diff and the redirect through the in-memory stores and the fake.

**B4: sync runs on the Runs page, complete.**

- The run detail (A4) shows `opened` / `updated` / `failed` rows with their pull request links
  and the ` (PR closed)` annotation; the Fleet cards count open pull requests from the latest
  run's rows; `Next actions` rows link to their open pull request.
- Done check: after the B2 live run, every `Next actions` row that reads `Run sync` has a pull
  request link, and the count on the card equals the number of open pull requests on GitHub
  (checked by `gh pr list` once).

**B5: settings and audit.**

- `sync_on_push` (`live` / `dry-run`) on the Settings page next to the two M2a settings, audit
  row per change. The Settings page's audit log lists the M2 actions with their URLs.
- Done check: with `sync_on_push: dry-run`, a pack push produces a dry run; switching to
  `live` and pushing again produces a live run; both are audit rows.

**B6: the repository page and rulecheck's sections as components.**

- Route `i.$installationId_.r.$owner.$repo.tsx` (`/i/<installation>/r/<owner>/<repo>`): the
  repository row opened (app-design §5 item 3): files with budgets per tool, findings with
  `file:line` linking to the GitHub blob at the measured sha, managed blocks (`source`, `rev`,
  `hash`, modified), status per pack with `STATUS_ACTION`, skills with lock state, and the
  history of this repository's `status_snapshots` and `run_rows` (status over time, pull
  requests opened).
- The `Repositories` and `Duplicates` sections stop being embedded strings: the App renders
  them as HeroUI components from the data it already holds (`RepoReport`s and
  `assembleScanReport(...).duplicates`) with `labels.ts` and the `render.ts` sentences
  (`SHAPE_NOTE`, `describeScope`); no new rulecheck export is needed (decision 15). A parity test
  asserts every number and `file:line` against `renderHtmlParts` over the same report.
  `report-css.ts` and the `@scope` embedding are removed when nothing embeds a section any more.
- Done check: the repository page of `lightsound/rulecheck` shows its two blocks, both
  `current`, the skills inventory, and a history of at least the runs since M2a; the parity test
  passes; `scopeReportCss` has no caller.

**B7: replace the D23 workflow.**

- Precondition: B2's live run has opened or updated the real pull requests for every
  `lightsound/agent-rules` subscriber and they merged. Then, in `lightsound/agent-rules`: delete
  `.github/workflows/sync.yml`, rewrite the `Automatic sync` and `Rules` sections of its
  `AGENTS.md` to name the App (the source is edited on GitHub, the App opens the pull requests,
  `sync --all` from a rulecheck checkout remains the manual retry path), and delete the
  `RULECHECK_TOKEN` secret (owner). In rulecheck: `decisions.md` D23 gets a dated note that the
  workflow is retired and the App is the trigger; `roadmap.md` Step 6 "Later" reads done;
  `AGENTS.md` Commands drops the workflow sentence; app-design §9's M2b row reads done.
- Done check: the next pack merge in `lightsound/agent-rules` opens its pull requests through
  the App alone (no Actions run), and `sync --all --dry-run` from a checkout reads `current`
  for every subscriber after they merge.

M2b is complete when every done check above passes on `prod`, the D23 workflow is gone, and
app-design §9's M2b row reads true.

## 5. Schema and infrastructure changes

| Change | Where | Task |
| --- | --- | --- |
| `runs.error` (nullable text: why a run could not proceed; the target rows say the rest) | `src/db/schema.ts`, migration | A2 |
| `pack_sources.pending_sha`, `pending_pull_request`, `pending_subscriptions` (cache of the `rulecheck/subscriptions` branch: tip sha, pull request URL, the pending `subscriptions.json` as JSON; null under `direct-commit` or when nothing is pending) | schema, migration | B3 |
| `installations.sync_on_push` (`live` / `dry-run`, default `live`) | schema, migration | B5 |
| Workflow `SyncRun` (`SYNC_RUN`, class `SyncRunWorkflow`) | `infra/alchemy.run.ts`, `wrangler.jsonc`, `WorkerEnv`, `src/worker.ts` | A2 |
| Durable Object `WriteLock` (`WRITE_LOCK`, SQLite-backed) | same four places plus the `new_sqlite_classes` migration in `wrangler.jsonc` | B1 |
| No new table, no new secret, no new App permission | — | — |

`status_snapshots`, `runs`, `run_rows`, `audit_log`, `pack_sources`, `packs` are used as they
exist. Workers Paid already covers Workflows and Durable Objects.

## 6. Permissions, secrets, and what the owner does

**GitHub App.** Nothing to add: `Contents: read & write` and `Pull requests: read & write` are
in the registration since M1 and cover both writers. What M2 changes is how the App *uses* them:

- Scan runs and dry runs mint tokens downgraded to `contents: read`, `pull_requests: read`
  (P1.2), so the read paths cannot write even by mistake.
- Each live target step mints a token for that one repository (`repository_ids`) with write
  permissions, so a bug in one target's code path cannot reach another repository (§7).
- `Contents: write` has no path scope; the two paths the App writes (`AGENTS.md` / `CLAUDE.md`
  through the D10 pull request, `subscriptions.json` in the pack repository through D25) are
  enforced structurally: the only write code is rulecheck's `src/sync/`, and every write is an
  audit row with its URL. The Settings page says so in those words (A1).

**Owner tasks, in order.**

| When | Task | Why |
| --- | --- | --- |
| Before A1 | Confirm the `lightsound` installation covers `lightsound/agent-rules` (GitHub → Settings → Applications → RuleFleet → Repository access); add it if not | The source must be inside the installation (app-design §10, answer 3) |
| Before A1 | Merge [agent-rules#9](https://github.com/lightsound/agent-rules/pull/9) (`lightsound/rulefleet` subscribed) | The dogfood installation then has eight subscribers |
| A1 | Register `lightsound/agent-rules` from the Settings page | First real source |
| B2 | Watch the first live run's pull requests before merging them | The App's first write |
| B3 | Set `subscription_changes` to `direct-commit` for the personal installation, if preferred | D25's solo-account mode |
| B7 | Delete the `RULECHECK_TOKEN` secret in `lightsound/agent-rules` after the workflow is removed | The PAT has no reader left |

No new secret, environment, or Cloudflare token change. The `CLOUDFLARE_API_TOKEN` already
has Workers Scripts edit, which covers Durable Object namespaces and Workflows.

## 7. Working rules for agents

The `base` and `personal` packs apply (they are in both repositories' `AGENTS.md`). In addition,
for M2:

- Every GitHub write goes through rulecheck's `syncTarget` or `subscribe`; the App has no write
  call of its own. `tests/sync-run.test.ts` fails a dry run that reaches a write operation, as
  `scan-run.test.ts` does for scans.
- A new word on a page goes into rulecheck's `docs/status-model.md` first (`committed` is the
  one this plan adds; run kinds, triggers, audit actions, and `runs.error` text are App prose,
  not model words).
- Test the write path against `fake-github.ts` only; the first live run against real
  repositories is B2's done check on the owner's own repositories, never a test.
- Bump the rulecheck sha in rulefleet once per rulecheck change that M2 needs (P1 at A2, R2 at
  B3), and keep `effect` pinned to the same version.
- Keep the fan-out rule: `runSync` schedules `syncTarget` and records rows; no check of its own.

## 8. Judgment calls: Options → Rounds → Principle → Chosen

### Decision 1: pack source multiplicity (owner's decision, confirmed)

- **Options.** (i) One source per installation, inside it (app-design). (ii) Several sources per
  installation, each with its own packs. (iii) One source, but allowed outside the installation
  with a stored PAT. (iv) A source per repository (each repository names its own pack
  repository in a file).
- **Rounds.** Round 1: (ii) needs a merge order between sources and a place to say which
  source a block's `source=` belongs to; (iii) is a second credential to issue, store, rotate
  (app-design §10 answer 3); (iv) moves the subscription list out of the pack repository, which
  D25 forbids. Round 2: (v) one source with several branches as "environments" (a branch per
  team) was considered and dropped: statuses are per pack, and a pack id would then name two
  bodies. No new option.
- **Principle.** The D9 marker is `source=<pack id>`; a pack id is global within an
  installation. Two sources with a `base` pack would be indistinguishable in the block, so
  the constraint is structural, not a preference: one namespace of pack ids, one source.
- **Chosen.** (i). Settled in round 2. The owner's decision stands.

### Decision 2: when the source is re-read

- **Options.** (i) On `push` to the source's branch touching `packs/**` or `subscriptions.json`
  (app-design's webhook row). (ii) On the daily Cron. (iii) On demand (a `Reload` button).
  (iv) On every page load (`getRef`, then load if the sha moved). (v) As the first step of every
  sync run, whatever started it.
- **Rounds.** Round 1: (iv) puts GitHub calls on the read path of a page and a user's reload
  behind the API; (i)–(iii) each need their own loader entry point. Round 2: (v) subsumes
  (i)–(iii): the push, the Cron, the button, and registration all start a sync run, and the run
  cannot plan targets without the current `subscriptions.json`, so loading the source is its
  first step anyway; the `packs` cache keyed by sha makes a run at an unchanged source cost one
  `getRef`. No new option.
- **Principle.** The source is read where it is needed: a sync run needs it, a page does not
  (pages read the cache). One loader, many triggers.
- **Chosen.** (v), with (i), (ii), and registration as the triggers; no separate `Reload`
  control (a `Dry run` is the reload). Settled in round 2.

### Decision 3: how statuses reach the pages (`status_snapshots`)

- **Options.** (i) Rescan the installation with `packs` set after registration and after every
  source change, storing `status_snapshots`, and render from the snapshots (app-design's
  wording). (ii) Classify live at page build from `repo_reports` × `packs` (what `fleetModel`
  does today) and drop `status_snapshots`. (iii) Classify live for the pages; append
  `status_snapshots` as history when either input changes (a scan step, a source load); read
  the history only on the repository page.
- **Rounds.** Round 1: (i) refetches 100 repositories to change nothing in their reports (the
  classifier reads `blocks`, `shape`, `files`, `findings`, all in the stored `RepoReport`) and
  a page could show a snapshot older than the report next to it; (ii) loses "status over time",
  which app-design §5's repository page promises. Round 2: (iv) materialize the current status
  in a view table refreshed by the same writers as (iii) was considered as a query optimization
  and dropped: hundreds of rows classify in milliseconds. No new option.
- **Principle.** One classifier, one reading: a status word on a page must be
  `classifyPackStatus` over the current report and the current pack, never a stored copy that
  can lag either. History is a different question (what was true at a past measurement) and a
  stored row answers it.
- **Chosen.** (iii). Registration triggers no rescan. Settled in round 2.

### Decision 4: the execution unit of a sync run

- **Options.** (i) One queue message per target (`sync-target`, app-design §4's job table) with
  a run counted by rows. (ii) One Workflow instance per run, one step per target, `load-source`
  first, `finish` last (the D27 shape). (iii) One Workflow instance per target, a parent
  waiting. (iv) `syncAll` inside one invocation.
- **Rounds.** Round 1: (i) is the shape D27 replaced for scans after a run stayed open for nine
  hours; (iv) is the rejected "200 targets in one invocation"; (iii) adds a parent-child
  protocol for parallelism a bounded loop already gives. Round 2: (v) reuse `ScanRunWorkflow`
  with a `kind` param was considered and dropped: the steps, retries, tokens, and rows differ,
  and two small classes are clearer than one with two modes; the shared `StepLike` driver is the
  reuse. No new option.
- **Principle.** D27's: the unit the platform kills must be the unit the run counts. A target is
  that unit; the instance's end is the run's end.
- **Chosen.** (ii). `packs: "all" | string[]` is the only shape parameter (a pack-scoped button
  is the same run). Settled in round 2.

### Decision 5: how a subscription change reaches `subscriptions.json` (owner's D25, detailed)

- **Options** for the part D25 leaves open, the UI-to-writer step. (i) Every checkbox tick
  posts at once and rewrites the branch (N ticks, N force-pushes, N pull request updates).
  (ii) A client-side basket, then one submit (client state; D28 wants form posts). (iii) The
  Subscribers table is one form; `Apply` posts the desired set; the writer diffs it against
  base + pending and writes once. Pending set: (a) a `pending_changes` table in D1, (b) read
  from the `rulecheck/subscriptions` branch on every page load, (c) read from the branch by the
  writer and by the webhooks for that branch, cached on `pack_sources`.
- **Rounds.** Round 1: (i) is noisy and racy; (ii) needs script for a state a form already
  holds; (a) makes the database a second source of pending truth (D25 forbids); (b) is three
  API calls per page view. Round 2: for the emptied-pending case (a user unticks every pending
  add), (vi) close the pull request and delete the branch from the App was considered; it adds
  two service operations (`closePullRequest`, `deleteRef`) to all three fronts for one edge
  case, so the writer refuses and names the pull request to close instead. No new option.
- **Principle.** D25's: the file and the branch are the truth; the database caches what
  webhooks and the writer already know. And D28's: a state change is a form post.
- **Chosen.** (iii) with (c). Settled in round 2.

### Decision 6: how the subscription write executes

- **Options.** (i) Synchronously in the POST handler (six GitHub calls, a few seconds), under
  the `WriteLock`, recorded as an `audit_log` row with the URL. (ii) A Workflow instance (a
  run of kind `subscribe` with one row). (iii) A queue message on `JOBS`.
- **Rounds.** Round 1: (ii) invents a run kind for a write whose result the user wants on the
  next page (`?subscriptions=opened`), and its durability guards against nothing: a failed
  handler leaves the file unchanged and the user retries the form; (iii) is (ii) without the
  visibility. Round 2: no new option.
- **Principle.** A run is for work that outlives a request and has many rows; a subscription
  change has one row and the person is waiting. app-design §7 already lists it as a person
  action in the audit log, with the pull request URL.
- **Chosen.** (i). Settled in round 2.

### Decision 7: `WriteLock` granularity and location

- **Options** for granularity. (i) One Durable Object per installation (app-design §4). (ii)
  Per target repository. (iii) One global lock. (iv) No lock: write steps of one run
  sequential, and one live run per installation admitted by a coordinator. **Options** for
  location: (a) the lock class in rulecheck; (b) the interface in rulecheck (P1.1), the class
  and the adapter in rulefleet.
- **Rounds.** Round 1: GitHub's secondary-limit guidance ("no concurrent content-creating
  requests") is per authenticated identity, and the identity is the installation token, so (ii)
  does not satisfy it and (iii) over-serializes unrelated customers; (iv) needs a second
  scheduler to admit runs and still leaves the subscription write (decision 6) outside it;
  (a) puts `cloudflare:workers` into a repository whose `src/github` rule is "workerd-portable,
  no platform import". Round 2: (v) a lease stored in D1 (compare-and-set) instead of a Durable
  Object was considered: D1 has no wait primitive, so waiters poll; the Durable Object's
  single-threaded RPC is the wait. The lease TTL is kept in (i) so a killed step cannot hold
  the lock. No new option.
- **Principle.** The lock's key is the identity GitHub throttles: the installation. The lock's
  home is where the platform primitive lives: the App.
- **Chosen.** (i) with a 60 s lease, (b). Settled in round 2.

### Decision 8: failure in a sync run

- **Options** for a target failure. (i) `failed` row, measured status kept, run continues and
  closes (D14). (ii) Abort the run. (iii) Retry until success. **Options** for a run-level
  failure (source unreadable, token). (a) Finish the run with `runs.error` and zero rows.
  (b) Mark it `incomplete: 1`. (c) Never create the run row (fail before `plan`).
- **Rounds.** Round 1: (ii) is what D14 rejected; (iii) turns a deterministic failure into an
  open run; (b) changes the meaning of `incomplete` (the sweep's word for a vanished instance);
  (c) hides the failure from the Runs page, where the person who pressed the button looks.
  Round 2: step retries are bounded at `retries.limit: 2` with the `retryAfter` delay because a
  rerun of `syncTarget` is idempotent (D14: `up-to-date` when the previous attempt landed). No
  new option.
- **Principle.** D14's: a row says what happened to a target; the run says whether the report
  is complete. A run-level failure is a run with an empty report and a reason.
- **Chosen.** (i) and (a). Settled in round 2.

### Decision 9: sync parallelism and tokens

- **Options.** (i) Three targets in flight (D14's number), writes serialized by the lock.
  (ii) One at a time (the scan run's default after the memory gate). (iii) Unbounded.
  Tokens: (a) one installation-wide token per run; (b) a read-only token for the run plus a
  per-target write token (P1.2).
- **Rounds.** Round 1: (iii) is GitHub's guidance ignored; (ii) is safe but a 14-target run
  takes a minute it need not; subscribers are instruction-file repositories, small by nature,
  and the size gate refuses the exception. (a) hands every target the power to write every
  repository. Round 2: no new option; `concurrency` stays a `RunDeps` parameter so the pr-stage
  gate can lower it to 1 if a memory kill shows up.
- **Principle.** Reads may overlap, writes may not (D14); a token carries the least it needs
  (§7).
- **Chosen.** (i) and (b). Settled in round 2.

### Decision 10: trigger to mode

- **Options.** For a push to the source: (i) always live (D23's behavior); (ii) always dry;
  (iii) a per-installation setting `sync_on_push`, default `live`. For the schedule: dry
  (app-design). For the button: dry by default, live on a confirmed second click (owner). For
  registration: dry.
- **Rounds.** Round 1: (ii) makes the App weaker than the workflow it replaces; (i) gives a team
  no way to review 200 planned pull requests before they exist, which app-design's webhook table
  anticipates ("or dry run when the setting says so"). Round 2: no new option.
- **Principle.** The default is what the replaced tool did; the switch exists for the team that
  wants a look first.
- **Chosen.** (iii). Settled in round 2.

### Decision 11: the fixture

- **Options.** (i) Keep `src/fleet/fixture.ts` and `/debug/fleet` (non-prod). (ii) Delete both
  once real rows exist. (iii) Keep the fixture for tests, delete the route.
- **Rounds.** Round 1: (ii) leaves no page that shows every status at once (the dogfood
  installation reads mostly `current`); (iii) loses the one-hop visual review agents used in
  M1. Round 2: no new option.
- **Principle.** A fixture measured by rulecheck's own `scan` is test data of the same kind as
  production data; it costs nothing at runtime.
- **Chosen.** (i). Settled in round 2.

### Decision 12: what changes in rulecheck

- **Options.** (i) P1.1 `WriteLock` interface, P1.2 scoped tokens, R2 `subscribe.ts`; nothing
  else. (ii) Also a `sync` entry point taking a `GitHub` layer and a pack snapshot (a server
  API). (iii) Also export `html.ts` sections as data.
- **Rounds.** Round 1: (ii) exists: `syncTarget(options, loaded, pack)` takes loaded packs and
  needs only `GitHub` and `Path`, which the App provides as it does for `scan`; (iii) is
  unnecessary because the App holds the `ScanReport` the sections are rendered from and the
  sentences are exported (decision 15). Round 2: a `sizeGate` inside `syncTarget` was
  considered and dropped (the CLI has no memory ceiling; the App wraps). No new option.
- **Principle.** rulecheck exports functions over data it defines; the App composes them. A
  change lands in rulecheck only when both fronts need the same meaning (D26).
- **Chosen.** (i). Settled in round 2.

### Decision 13: the subscriber that is not in the installation

- **Options.** (i) A `failed` row (the CLI's 404 on an unknown repository). (ii) A `refused`
  row with status `-` and the reason `not in this installation`. (iii) Skip silently.
- **Rounds.** Round 1: (i) says "truth unknown", but the App knows: it is not installed there;
  (iii) hides a subscription the file lists. Round 2: no new option.
- **Principle.** `refused` is "declined and says why", a row a human acts on (install the App
  there, or remove the entry); `failed` is for an unknown outcome (D14).
- **Chosen.** (ii); the same for an archived subscriber (`repository is archived`). Settled in
  round 2.

### Decision 14: `pull_request.closed`

- **Options.** (i) Keep M1's "no job". (ii) Annotate the run row and rescan the base
  repository at its head (app-design §2). (iii) Rescan only.
- **Rounds.** Round 1: (i) leaves a closed-without-merge pull request looking open on the Runs
  page; (iii) loses the annotation the table promises. Round 2: no new option.
- **Principle.** The run row is the App's record of a write; a human's answer to it (closing)
  belongs on the row.
- **Chosen.** (ii), in B2. Settled in round 2.

### Decision 15: rulecheck's sections as components

- **Options.** (i) rulecheck exports section data (`SectionData` types) and the App renders
  them. (ii) The App renders from the `ScanReport` it already assembles, using `labels.ts`
  and the exported `render.ts` sentences, with a parity test against `renderHtmlParts`.
  (iii) Keep embedding static HTML.
- **Rounds.** Round 1: (i) adds a second shape of the same report to keep in step; (iii) is
  what app-design's M2b row ends. Round 2: no new option.
- **Principle.** The `ScanReport` is the data; the HTML is one rendering of it and a React tree
  is another. Parity is asserted, not assumed.
- **Chosen.** (ii), in B6. Settled in round 2.

### Decision 16: where the M2a / M2b boundary falls

- **Options.** (i) M2a builds the sync Workflow in dry-run-only form (the flag a literal
  `true`), M2b widens it. (ii) M2a builds only the source loader and pages; M2b builds the
  Workflow.
- **Rounds.** Round 1: app-design's M2a row asks for "the scheduled dry run producing sync
  runs", which needs the orchestrator; (ii) then builds a loader twice. Round 2: no new option.
- **Principle.** A dry run is the same code path as a live run with no write (D10); building it
  first is measuring before writing at the milestone scale.
- **Chosen.** (i). Settled in round 2.

## 9. Schedule, risks, and what goes to M3

**Schedule.** app-design §9 budgets 1.5 weeks for M2a and 1.5 for M2b (one person with cloud
agents, part-time attention). The order and the gates:

- **M2a**: P1 in parallel with A1; A1 → A2 → A3 → A5 → A4 → A6. Gate: the A2 dry-run table
  equals the CLI's `sync --all --dry-run` on the dogfood installation, and the Fleet cards show
  measured statuses. A1 and A4 are mostly wiring of what M1 built; A2 is the substantive task.
- **M2b**: R2 in parallel with B1; B1 → B2 → B3 → B4 → B5 → B6 → B7. Gate: the first live run's
  pull requests are byte-identical to the dry run's, then B7. B6 is the one task whose slip
  does not block B7; if the budget runs short, B6 is the last to land, not the first to cut
  (the milestone row names it).

**Risks.**

| Risk | Where | Mitigation |
| --- | --- | --- |
| A killed target step keeps the `WriteLock` | B1 | The 60 s lease; the pr-stage probe in B2's done check |
| Two live runs race (push and button) | B2 | D14 idempotence: both measure first; the second reads `up-to-date` or force-moves onto the same base; the lock serializes the writes |
| `Contents: write` on every repository | all | Read-only tokens for reads, per-target tokens for writes (P1.2), `src/sync/` as the only writer, an audit row per write |
| A subscriber too large for a step | A2 | The size gate before `syncTarget` → `refused: too large to measure` |
| Two pull requests per subscription feel heavy | B3 | `direct-commit` for solo accounts (D25); the page states the consequence in one sentence |
| `subscriptions.json` reformatted by the writer | R2 | Two-space JSON with a trailing newline, the file's current form; the test asserts a no-op change is byte-identical |
| Rate limit on a push to the source with many subscribers | A2 | ~15 calls per target; `RATE_LIMIT_FLOOR` and `step.sleep` as in scans; `retryAfter` honored |
| The App and the D23 workflow both write during the transition | B7 | Replacement, not coexistence: the workflow is removed in the same week the first live run lands; until then `sync_on_push: dry-run` on the dogfood installation |
| Section components drift from `renderHtmlParts` | B6 | The parity test over the same `ScanReport` |

**Sent to M3.**

- Billing, `plan` gate, Stripe; custom-domain and name work already done stays.
- Alerts (`failed` rows above zero, signature failures), the status page.
- Audit log export as JSON (app-design §7); the uninstall purge.
- Installation switcher polish.
- Candidates without a decision entry: `rulecheck subscribe`, a block-removing normalization,
  `closePullRequest` / `deleteRef` for an emptied pending set, a dry run against a pack
  repository pull request before it merges (D30), the derived starter pack.

## Decisions made in this document

| Decision | Chosen | Alternatives considered | Settled in round |
| --- | --- | --- | --- |
| Pack source multiplicity (owner's, confirmed) | One source per installation, inside it; the D9 `source=<pack id>` marker makes one pack-id namespace structural | several sources; a source outside with a stored PAT; a source per repository; branches as environments | 2 |
| When the source is re-read | As the first step of every sync run; triggers are the push webhook, the schedule, the buttons, and registration; `packs` cached by sha | per trigger loaders; on page load; a `Reload` control | 2 |
| Statuses on the pages | Classified live from `repo_reports` × `packs`; `status_snapshots` appended as history by the scan step and the source load; no rescan on registration | rescan with `packs` and render from snapshots; drop `status_snapshots`; a materialized view | 2 |
| Execution unit of a sync run | One Workflow instance per run, `load-source` → one step per target → `finish`; `packs: "all" \| string[]` | queue message per target; instance per target with a parent; `syncAll` in one invocation; one class with a `kind` | 2 |
| UI to `subscriptions.json` (owner's D25, detailed) | The Subscribers form is the basket, one write per `Apply`; pending set = branch tip − base, cached on `pack_sources` by the writer and the branch's webhooks; an emptied pending set refuses and names the pull request | a write per tick; a client basket; a pending table; branch read per page view; closing the pull request from the App | 2 |
| Subscription write execution | Synchronously in the POST handler under the `WriteLock`, an audit row with the URL, no run | a run of kind `subscribe`; a queue message | 2 |
| `WriteLock` granularity and location | One Durable Object per installation with a 60 s lease; interface in rulecheck (P1.1), class and adapter in rulefleet | per repository; global; run admission without a lock; the class in rulecheck; a D1 lease | 2 |
| Failure in a sync run | Target: `failed` row, status kept, run closes; `retries.limit: 2` honoring `retryAfter`. Run-level: `runs.error`, zero rows, finished | abort the run; retry until success; `incomplete`; no run row | 2 |
| Parallelism and tokens | Three targets in flight, writes serialized; read-only token per run, per-target write token | one at a time; unbounded; one installation-wide token | 2 |
| Trigger to mode | Push: `sync_on_push` (`live` default, `dry-run`); schedule dry; button dry then confirmed live (owner); registration dry | always live; always dry | 2 |
| The fixture | Kept, with `/debug/fleet` non-prod | delete both; delete the route | 2 |
| Changes in rulecheck | P1.1 `WriteLock` interface, P1.2 scoped tokens, P1.4 `committed`, R2 `subscribe.ts` (D32) | a server `sync` API; section data export; a size gate in `syncTarget` | 2 |
| A subscriber outside the installation | `refused: not in this installation`, status `-`; archived likewise | `failed`; skip | 2 |
| `pull_request.closed` | Annotate the run row, rescan the base at head (B2) | no job; rescan only | 2 |
| Sections as components | Rendered by the App from the `ScanReport` with `labels.ts` and `render.ts` sentences; parity test against `renderHtmlParts` | section data export from rulecheck; keep embedding | 2 |
| M2a / M2b boundary | The sync Workflow lands in M2a dry-run-only (`dryRun: true` literal), widened in M2b | orchestrator only in M2b | 2 |

**Structural check.** Most rows reduce to two principles the earlier decisions already hold.
D25's "one configuration, many readers" decides where subscriptions are written (the file),
what the database may hold (a cache), and how pending changes are known (from the branch).
D27's "the unit the platform kills is the unit the run counts" decides the run's shape, its
failure handling, and where the lock is held (around one target's write, inside one step).
Where a question seemed new, it dissolved into one of the two: the pending set is a cache of a
branch; the subscription write is one target with one row; the lock's key is the token's
identity. What remains a true choice is the M2a / M2b boundary, and it follows D10's own rule
(measure, then write) applied to a milestone.

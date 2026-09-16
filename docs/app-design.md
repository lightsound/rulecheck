# rulecheck App: MVP design

Design of the hosted GitHub App that turns the CLI's two commands into a service: a dashboard
that is the `--html` page kept live by webhooks, and "pack change → pull requests everywhere"
without a workflow or a token to maintain. Written 2026-09-16 against D1–D25; M0 below is this
document being accepted. The CLI stays open source and is the self-host path and the dev tool;
the App is the hosted product for teams (D23 named it the business-phase replacement of the
Actions + PAT setup).

Every judgment call is in the decisions table at the end, with the search round in which no
better option appeared. Words in `code` that name a status, shape, or outcome are the ones
[status-model.md](status-model.md) defines.

## 1. Goals and non-goals

**Day 1 (after M2).** An organization installs the App on a set of repositories and gets:

- a live Overview (the D19–D22 page: cards, `Next actions`, pack distribution, repository rows)
  measured on every repository's default branch, updated on push, with no local tree;
- a registered pack source (a repository laid out like `lightsound/agent-rules`: `packs/<id>/`,
  `subscriptions.json`) and a subscriptions view;
- a sync that opens or updates one pull request per repository per pack (D10, D14) when the
  pack repository's default branch changes, from a button, or as a dry run, authenticated as
  the App;
- pull requests attributed to `rulecheck[bot]`, each linking to the run that wrote it (D23's
  `--run-url`, pointing at the App's run page);
- team access derived from GitHub: whoever can read a repository can read its rows; whoever
  administers the installation account can register sources and trigger syncs.

**Not in the MVP.**

- A pack editor. Packs are edited in the pack repository with the tools the team already has;
  D6's "author a pack in a web app" is deferred past M3.
- Auto-merge. The App opens pull requests; humans or per-repository auto-merge (D6, off by
  default, not implemented) merge them.
- MCP / Hooks governance, Skills distribution (D18), Subagents. The inventory `scan` already
  prints (skills, lock state) is shown; nothing more.
- Billing and pricing (section 8: deferred to after M2; only the `plan` column and a repository-count gate exist in the schema).
- GitHub Enterprise Server, GitLab, Bitbucket. GitHub.com only.
- Any write to a repository other than the D10 pull request into a subscriber and the D25 pull
  request into the pack repository.

## 2. User flows

**Install → first scan → dashboard.** GitHub's install page (organization or personal account;
"all repositories" or a selection) → `installation` webhook → the App records the installation
and its repositories and enqueues one full scan → the user lands on `/i/<installation>` and sees
the page fill in (a row per repository as its report arrives; the page reloads without script,
`<meta http-equiv="refresh">` while a run is in flight). Without a pack source the page has no
`Pack distribution` section and says so with a link to the next step.

**Bootstrap: an installation with no pack repository yet.** Until a pack source is registered
the dashboard is the read-only inventory: shapes, budgets, duplicates, findings, skills, the
`Next actions` list without pack rows. That is already useful and needs no write permission
exercised. The onboarding banner offers three ways to get a pack repository:

- **(a) Create a pack repository.** The App publishes a public GitHub template repository
  (`lightsound/agent-rules-template`: `packs/base/AGENTS.md` as a commented starter,
  `subscriptions.json` as `{}`, the D23 `Sync packs` workflow included but disabled by a
  comment, a root `AGENTS.md` explaining the layout). The banner links to GitHub's create page
  with the template preselected
  (`https://github.com/new?template_owner=lightsound&template_name=agent-rules-template&owner=<account>&name=agent-rules`),
  the user clicks `Use this template`, then adds the new repository to the installation (GitHub's
  install page again, or the link the banner gives) and selects it in the App. The
  `installation_repositories` webhook makes the new repository appear in the selector without a
  reload. Three clicks, all of them GitHub's own pages, and the App never holds the permission to
  create repositories. Least privilege decided this: creating the repository from the App
  (`POST /repos/{template_owner}/{template_repo}/generate` or `POST /orgs/{org}/repos`) needs
  `Administration: write` on the installation, a permission that also deletes and transfers
  every repository the App can see, for one click at onboarding; asking for it through the user
  token needs the same permission on the App registration. Neither is worth it.
- **(b) Use an existing repository.** The registration flow below, for a team that already keeps
  a rules repository; the App shows the `loadPacks` warnings (`subscriptions.json not found`,
  `no packs/<id>/ directories`) as the checklist of what the repository still lacks.
- **(c) Derive a starter pack from the installation (post-MVP).** Once the inventory has
  scanned every `AGENTS.md`, propose a `base` pack from the sections that recur across
  repositories (the duplicate groups the scan already finds, plus headings shared by most root
  files), as a pull request to the pack repository that the team edits before merging. Content
  authoring is out of scope for the CLI (D1) and stays so for the App at MVP; this is a
  proposal from measured text, and it needs its own decision entry before it is built.

**Register a pack source.** An installation admin enters `owner/repo` (optionally `@branch`).
The repository must be one of the installation's repositories (the App reads it with the same
installation token; a source outside the installation is refused with the reason). The App reads
`packs/<id>/AGENTS.md` and `subscriptions.json` at the default-branch HEAD with `loadPacks`
unchanged, stores the packs and subscriptions as a cache keyed by the commit sha (section 3),
and re-runs the installation scan with `packs` set so every repository × pack gets a status.
One pack source per installation in the MVP.

**Subscriptions.** The Pack & subscriptions page lists every pack with its subscribers and every
installed repository with its `not-subscribed` projection (`classifyIfSubscribed`, D20: what a
sync would do the moment it is subscribed). Ticking a repository under a pack does not write the
database: it opens a pull request against the pack repository that edits `subscriptions.json`
(D25). The pending change is shown on the page as "subscription PR #n open" until it merges;
the merge's `push` webhook reloads the cache and the row becomes `eligible`. Consequence stated
plainly on the page: subscribing takes two pull requests, one to the pack repository and one
into the subscriber.

**Pull-style entry point (candidate CLI command, not implemented).** The dashboard is the
push side: an admin subscribes repositories from the pack's point of view. The lightweight
onboarding path is the other direction, from inside a repository, the way `npx skills add`
installs a skill: `npx rulecheck subscribe <owner>/<pack-repo> --pack base` (name to be decided)
reads the current repository's `origin` remote, and opens the same D25 pull request on the pack
repository that adds `owner/repo` to `subscriptions.json` under `base`; with `--dry-run` it
prints the planned diff. When the App is installed on the pack repository, the command calls
the App instead (one endpoint, the same job as the checkbox), so the pull request is written by
`rulecheck[bot]` and appears in the App's run and audit log; without the App it writes through
the user's own `gh` authentication, as `sync` does today. Either way the command ends where the
dashboard flow ends: a subscription pull request open on the pack repository, and, once it
merges, the block's pull request arrives by push. Distribution and status stay the App's job;
the command only shortens the first step for a developer who is in the repository already. It
adds no writer of its own: it calls the D25 subscriptions writer (section 4), and needs its own
decision entry before it is built.

**Sync.** Three triggers, one code path (`syncTarget`, D10; the fan-out rule in `AGENTS.md`
holds: no check lives outside it):

- `push` to the pack repository's default branch touching `packs/**` or `subscriptions.json`
  (D23's trigger, moved from the workflow to the App) → one sync run for the installation, one
  target per (repository, pack) in `subscriptions.json`;
- the `Sync now` button (admin), with `Dry run` as the default state of the button and a second
  click to confirm a live run;
- `Dry run` on a schedule (daily) so the distribution report cannot go stale when no webhook
  arrived (a missed delivery, a suspended installation).

A run page shows the D14 table as it fills: repository, pack, remote status, outcome
(`planned +N -M`, `opened`, `updated`, `up-to-date`, `nothing-to-do`, `refused: …`,
`failed: …`), each pull request linked.

**Pull request experience.** Unchanged from the CLI (`pullRequestText`): title
`chore(agent-rules): …`, body naming the normalization applied, the pack, the rev, "this branch
is rewritten by rulecheck", and the run link. Author is the App's bot account, so the
subscriber's own workflows run on the pull request (a pull request opened with `GITHUB_TOKEN`
would not trigger them). Merging fires `push` on the default branch → the repository is
rescanned → the row reads `current` within seconds.

**Team roles.** None of the App's own. Access is GitHub's: a signed-in user sees an installation
if `GET /user/installations` lists it, and inside it the repositories that
`GET /user/installations/{id}/repositories` returns for them; `Register pack source`,
`Sync now`, and `Uninstall` require the user to be an owner of the installation account (organization
owner, or the account itself for a personal installation), which the App reads from the
membership API at sign-in and caches for the session. Subscription edits need nothing extra:
the pull request to the pack repository is gated by that repository's own permissions and
branch protection.

## 3. Source of truth: files in the pack repository, database as cache

Two candidates: keep `subscriptions.json` and `packs/` in the pack repository as the CLI reads
them today, or move subscriptions (and eventually packs) into the App's database and generate
the file for the CLI.

| | Files in the pack repository (chosen) | App database |
| --- | --- | --- |
| Review and history | git: who subscribed what, when, reviewed by whom | an audit table the App must build and expose |
| Self-host parity | the CLI, the D23 workflow, and the App read the same files; a customer can leave the App and keep everything | the CLI needs an export, or the App becomes required |
| Cloud agents and repo-resident configuration | the owner's stated preference (D4: the repository is the only input every agent shares) | configuration lives outside every clone |
| Edit latency from the UI | a pull request, then a merge; two pull requests to get a block into a repository | immediate |
| Branch protection, CODEOWNERS on the pack repository | apply for free | must be re-implemented as roles |
| Multi-writer conflicts | git's | the App's |

Files win on every row except latency, and latency is a property the owner already accepted
for the subscriber side (D6: "teams need review"). The same argument applies to the
subscription list: committing a subscription to a shared repository makes it a team decision
(D6's opt-in principle).

**Decision (D25).** `subscriptions.json` and `packs/**` on the pack repository's default branch
are canonical. The App's database holds a cache keyed by commit sha (packs, hashes,
subscribers) and an index it computes (status snapshots, runs, audit). Every cache row is
reproducible from GitHub; dropping the database loses history, never configuration.

**Consequences.**

- UI edits are pull requests to the pack repository: `subscriptions.json` on the tool-owned
  branch `rulecheck/subscriptions`, force-updated on rerun with the D10 ownership check (tip
  commit prefixed `chore(agent-rules):`), one open pull request at a time carrying every pending
  subscription change. The App never commits to the default branch.
- The App needs `Contents: write` on the pack repository, which it has because the source must
  be inside the installation.
- A team that prefers the CLI or the D23 workflow keeps working; the App is a view and a runner
  over the same files.
- Pack editing in the UI, when it comes, is the same mechanism on `packs/<id>/AGENTS.md`.

## 4. Architecture

### GitHub App registration

| Item | Value |
| --- | --- |
| Repository permissions | `Contents: read & write` (trees, commits, refs; also every read), `Pull requests: read & write`, `Metadata: read` (mandatory). Nothing else: no `Workflows`, no `Administration`, no `Members` |
| Organization permissions | none. Owner status for the admin gate comes from the user token (`GET /user/memberships/orgs/{org}`), not from the installation |
| Account permissions (user token) | `email: read` is not needed; login and id come from `GET /user` |
| Webhook events | `installation`, `installation_repositories`, `push`, `pull_request` (`closed` only, to attribute merges to runs), `repository` (`renamed`, `transferred`, `deleted`, `archived`), `github_app_authorization` (`revoked`) |
| User authorization | "Request user authorization (OAuth) during installation" on; "Expire user authorization tokens" on (8 h tokens, refresh not used: the session lives as long as the token) |
| Setup URL | `/setup` (redirect after install: creates the session, enqueues the first scan) |

`Contents: write` is broader than the two files rulecheck writes; GitHub has no path-scoped
permission. The mitigations are structural: the only code that issues a write is
`src/sync/sync.ts` `write` (subscribers) and the D25 subscriptions writer (pack repository),
both through the `GitHub` service, and every write is a row in the audit log with the pull
request URL. The App's user-facing pages state this in the same words.

**Where the D25 writer lives.** In rulecheck, not in the App: `src/sync/subscribe.ts`
(measure the pack repository's `subscriptions.json` at the default-branch HEAD, plan the edit as
a pure function in `src/domain`, write the branch and pull request under the D10 ownership
check), tested against `tests/fake-github.ts` like `sync`. The App calls it from the checkbox
job; the candidate `rulecheck subscribe` command (section 2) calls the same function from a
checkout. One implementation, so the CLI and the App cannot disagree on what a subscription
pull request contains, and `AGENTS.md`'s rule that `src/sync/` is the only write path keeps
holding. It is built in M2 and gets its decision entry then.

### Jobs

Three kinds of job, each a message on one queue, each idempotent by its key so a redelivered
webhook or a retried message does no second write:

| Job | Trigger | Key | Work | GitHub calls |
| --- | --- | --- | --- | --- |
| `scan-installation` | install, source registered, daily schedule, `Rescan` button | `(installation, requested sha set)` | One `repositorySnapshot` per repository at its default-branch HEAD, each attempted on its own; the ones that succeed are merged into one `Snapshot` (`/github.com/<owner>/<repo>` each) and `scan("/", { packs })` runs once over it, so cross-repository duplicates and the per-pack counts come out of the unchanged pipeline; stores one `RepoReport` per measured repository and the distribution entries. A repository whose snapshot could not be built (empty repository: no default-branch ref; removed, transferred, or archived mid-run: 404; truncated tree; a 5xx after the transport's retry) is left out of the snapshot and gets a `scan_error` (message, time) on its `repositories` row instead, shown as an issue on its repository row (`could not be measured: <reason>`) and excluded from the counts; the other repositories scan normally. The word is a row-level failure, not a shape or a pack status (the way `failed` is a sync outcome, not a pack status); it is added to `status-model.md` as a word outside the four vocabularies when it is built | per repository: `getRepository`, `getRef`, `getCommit`, `getTree`, then one `getBlob` per file the scan reads (root pair, rule files, nested `AGENTS.md`, `package.json` for the script check, `SKILL.md`, `skills-lock.json`); typically 6–15 |
| `scan-repository` | `push` to a default branch (subscriber or not), `repository` events | `(installation, repo, head sha)` | Same pipeline over one repository, same `scan_error` handling; the installation's duplicates are recomputed from the stored `contentHash` values without refetching the others (a repository without a stored report contributes nothing until it has one) | 6–15 |
| `sync-target` | `push` to the pack repository (one message per `subscriptions.json` target), `Sync now`, daily dry run | `(installation, repo, pack, pack sha, dry-run flag)` | `syncTarget` unchanged: measure, plan, measure, write. `writeLock` is the per-installation serializer below | reads as `scan-repository`, plus for a write: `getRef`, `getCommit`, `createTree`, `createCommit`, `setRef`, `listOpenPullRequests`, `createPullRequest` or `updatePullRequest` |

A **run** groups the messages one trigger produced (one `sync` run per pack push, one `scan`
run per rescan) and is what the run page and the audit log show; a message writes its row into
its run when it finishes. The D14 fan-out therefore lives in the queue, not in `all.ts`, but
each message still calls `syncTarget`, so the per-target checks stay in one place. `all.ts`
keeps serving the CLI.

**Write serialization (D14).** Reads run in parallel; content-creating requests to one
installation pass through one lock. On Workers that lock is a Durable Object per installation
whose single-threaded RPC `withWriteLock(fn)` replaces the `Semaphore` the CLI passes as
`writeLock`; on a long-lived process it is the same `Semaphore`.

**Rate limits.** An installation token has at least 5,000 requests per hour (more with
repositories and users, capped at 12,500; 15,000 on Enterprise Cloud). A full scan of 200
repositories is about 3,000 calls, so a daily full scan plus webhook-driven single-repository
rescans fits with room; a sync run adds about 15 calls per target. Git Data responses are
immutable by sha, so `getBlob` and `getTree` results are cacheable by sha in the database for
the duration of a run (the CLI's `Effect.cached` per snapshot already does this within one
target). The transport reads `x-ratelimit-remaining` and `retry-after`; below a floor it delays
the job (the queue's `delaySeconds`) instead of failing it, and a `403`/`429` secondary limit
retries once with the advertised delay. That is the retry D14 kept out of the CLI "until a real
run shows it necessary"; the App is that run, and the retry sits where D14 said it would, in the
GitHub layer.

**Idempotency.** D10 and D14 carry over untouched: a target whose default branch reads
`current` issues no write; a tool-owned branch already carrying the planned content under an
open pull request reads `up-to-date`; a rerun after a base change force-moves the branch. So a
webhook delivered twice, a queue message retried, or two triggers racing (push and button)
converge on the same branch and pull request. Job keys make the second message a no-op before
it reaches GitHub; the D14 property makes it a no-op even if it does.

### Running `src/*` on the server

What runs unchanged: everything in `src/domain/`, `src/scan/` (over `snapshotFileSystem`),
`src/sync/sync.ts` (`syncTarget`), `src/github/fs.ts`, `src/report/labels.ts`, `render.ts`
(the sentences `html.ts` imports), `html.ts` (`renderHtml`, `renderSyncAllHtml`). `scan` needs
`FileSystem` and `Path` services: `FileSystem` is the snapshot, `Path` is the POSIX
implementation `effect` ships without a platform package. `resolvePacks` first `stat`s its
argument as a local directory; the server calls `loadPacks(snapshotFs, path, "/packs", label)`
directly, which is already exported.

What must change in `src/github` (small, and useful to the CLI too):

1. **Transport split.** `makeGh(run)` builds the `GitHubService` around one function, `api(method,
   path, body)`, that spawns `gh`. Lift that function into a `Transport` interface (`request(method,
   path, body) → { status, json }`), keep `ghTransport(run)` for the CLI, and add
   `fetchTransport({ baseUrl, token })` where `token` is an `Effect<string>` so the caller decides
   how it is minted. The response mapping (`treeEntry`, `pullRequest`, `parseError`) is shared.
   `Bun.spawn` then lives only in `bunGhRunner`, which the server never imports.
2. **Installation token provider.** `installationToken(appId, privateKey, installationId)`: an
   RS256 JWT signed with WebCrypto (`crypto.subtle`, available on Bun, Node, and workerd), `POST
   /app/installations/{id}/access_tokens`, cached until five minutes before `expires_at`.
   GitHub hands out the App private key as PKCS#1 (`BEGIN RSA PRIVATE KEY`) and
   `crypto.subtle.importKey` takes RSA keys as `pkcs8` only, so the key is converted once
   (`openssl pkcs8 -topk8 -nocrypt`) before it is stored as the secret; the signer refuses a
   PKCS#1 header with a message that names the command.
3. **Rate-limit handling** in `fetchTransport` as described above. `GitHubError` gains
   `retryAfter: number | null`; nothing else in the interface changes.
4. **Truncated trees.** `repositorySnapshot` refuses a tree the API truncates (about 100,000
   entries). The CLI never met one; a customer might. M2 adds a fallback that lists the root and
   the directories rulecheck reads (`.cursor/rules`, `.claude`, `.agents/skills`, …)
   non-recursively and marks the report `partial` (nested `AGENTS.md` and `missing-path`
   verification are then incomplete and say so). Until then such a repository is a `scan_error`
   row (job table above), not a failed run: snapshot assembly is per repository, so one
   unreadable repository never aborts the others.

`src/main.ts` (`BunServices`, `BunRuntime`) is the CLI's entry and is not reused; the App has its
own entry that provides `Path`, the snapshot `FileSystem` per job, and `GitHub` over
`fetchTransport`. `node:crypto` (`createHash` in `block.ts`, `pack.ts`, `skills.ts`,
`analyze.ts`) and `Buffer` run on workerd with `nodejs_compat`; `js-tiktoken` is pure JS. The
one true Bun dependency in the reusable code is `Bun.spawn`, and item 1 isolates it.

### Data model

Tables, with what each row is a cache of (reproducible from GitHub) or an index of (the App's
own history):

| Table | Kind | Columns (key) |
| --- | --- | --- |
| `installations` | cache | `id` (GitHub installation id), `account_login`, `account_type` (`Organization` / `User`), `suspended_at`, `created_at`, `plan` (section 8) |
| `repositories` | cache | `id` (GitHub repo id), `installation_id`, `full_name`, `default_branch`, `archived`, `removed_at`; plus the index columns `scan_error` (message, null when the last scan measured it) and `scan_error_at` |
| `users`, `user_installations` | cache | `id`, `login`; `(user_id, installation_id, is_admin, refreshed_at)` from the user token |
| `pack_sources` | cache | `installation_id`, `repository_id`, `branch`, `head_sha`, `loaded_at`, `warnings` (the `loadPacks` warnings) |
| `packs` | cache | `(pack_source_id, head_sha, pack_id)`, `hash`, `body`, `subscribers` (JSON array) |
| `repo_reports` | index | `(repository_id, head_sha)`, `schema_version`, `report` (the `RepoReport` JSON, block bodies included: they are the customer's pack text), `measured_at`, `run_id` |
| `status_snapshots` | index | `(repository_id, pack_id, head_sha, pack_sha)`, `status`, `file`, `line`, `message`, `normalization`, `measured_at`. The `PackStatusEntry` flattened, one row per measurement, so the matrix and the `Next actions` list are one query and history is a range |
| `runs` | index | `id`, `installation_id`, `kind` (`scan` / `sync`), `trigger` (`install` / `webhook:<delivery id>` / `manual:<user>` / `schedule`), `dry_run`, `started_at`, `finished_at`, `counts` (per outcome) |
| `run_rows` | index | `(run_id, repository_id, pack_id)`, `outcome`, `status`, `message`, `pull_request_url`, `plus`, `minus` |
| `audit_log` | index | `id`, `installation_id`, `actor` (`user:<login>` / `webhook` / `schedule`), `action`, `target`, `run_id`, `url`, `at` |
| `webhook_deliveries` | index | `delivery_id`, `event`, `received_at`; the replay guard |

Sizes are small: hundreds of repositories × a few packs × one row per measurement. Reports are
kept for 90 days, snapshots and runs for 12 months, audit for 12 months (open question 7).

## 5. Dashboard pages

The dashboard has three pages (HTML pages the App serves, not images or mockups), all rendered
server-side to the D21 design system (Primer tokens, no script beyond progressive enhancement,
`<details>` folds, print keeps what is open). Labels come from `src/report/labels.ts`; nothing
on a page is a word the glossary does not have.

1. **Overview page** (`/i/<installation>`): the D19–D22 page as `renderHtml` produces it, with
   an App header (installation switcher, `Rescan`, `Pack source`, sign out) and a run banner
   when a run is in flight. In M1 the page is served byte for byte from a `ScanReport` assembled
   from `repo_reports` and `status_snapshots`; in M2 `html.ts` exports its sections so the header
   and the matrix links can point at the pages below instead of anchors.
2. **Repository page** (`/i/<installation>/r/<owner>/<repo>`): the repository row opened, plus
   what the page could not hold: the files it loads with budgets per tool, findings with
   `file:line` linking to the GitHub blob at the measured sha, managed blocks with `source`,
   `rev`, `hash`, status per pack with the next-action verb, the skills inventory with lock
   state, and the history of this repository's rows in past runs (status over time, pull
   requests opened for it).
3. **Pack & subscriptions page** (`/i/<installation>/packs`): the registered source with
   `head_sha` and `loadPacks` warnings; one card per pack (id, hash, rev, subscribers, the
   stacked status bar); the subscriptions matrix (every installed repository × every pack, a
   checkbox per cell; checked cells that are not yet in `subscriptions.json` show
   `PR #n open`); the `Sync now` / `Dry run` controls; the list of runs with their tables; the
   audit log for the installation.

## 6. Tech options

Constraint that decides most rows: the reusable code is Effect + TypeScript with one
Bun-specific function (section 4), the workload is bursty (idle until a webhook, then tens of
API calls), and the operator is one person working through cloud agents who wants nothing to
babysit.

| Concern | Cloudflare Workers + Queues + Durable Objects (chosen) | Fly.io, one Bun container | Vercel functions |
| --- | --- | --- | --- |
| Reuse of `src/*` | Everything except `Bun.spawn`, via the transport split; `@effect/platform-bun` is not loaded. Effect v4 on workerd is a known-good stack: the owner runs it in other projects, and Alchemy (below) is itself an Effect program | Everything as is, including `all.ts` and the `Semaphore`; the only change is the fetch transport | As Workers, but no queue or lock primitive of its own |
| Job model | Queues (at-least-once, retries, `delaySeconds`), Durable Object per installation as the write lock and run coordinator, Cron Triggers for the daily runs. 15 min wall clock per consumer invocation, CPU up to 5 min (configured); one `sync-target` is seconds of CPU | An in-process Effect queue, or pg-boss on the database; a restart mid-run loses in-flight work unless persisted | Needs a third service (Inngest, Upstash QStash) for queues and retries |
| Cold path latency | Webhook to first API call under 50 ms; a full scan of 200 repositories is bounded by GitHub, not compute | Same order; always-on | Same, cold starts on the function |
| Runtime | workerd is not Bun: no `Bun.*`, `node:` via `nodejs_compat`, 128 MB memory per isolate (`js-tiktoken` ranks fit); tests keep running under `bun test` | Bun, the runtime rulecheck is developed with | Node runtime; Bun runtime experimental |
| Ops | No server; infrastructure defined and deployed with Alchemy (below); logs and traces built in | A VM to patch, deploy, and watch; `fly deploy` per change | No server; logs built in |
| Cost at MVP scale | Workers Paid $5/month covers the queue and Durable Object usage at this volume | $5–15/month always-on, plus the database | $20/month Pro plus the queue service |
| Exit | Queue and lock semantics are Cloudflare's; the job functions are plain Effect programs and move | Portable container | Vendor functions |

| Concern | D1 (SQLite, chosen) | Postgres (Neon) |
| --- | --- | --- |
| Fit | Small rows, single region, one writer per installation (the Durable Object); SQL, `PRAGMA` and JSON functions available | Overkill for the volume; needed if the App ever runs many regions or joins large histories |
| Reuse | Same SQL either way; the schema above uses no Postgres-only type, so a move is a dump and a load | — |
| Cost | Included in Workers Paid at this scale | Free tier at first, then $19/month |
| Risk | 10 GB per database; a database per App, not per installation | Connection pooling from Workers needs the HTTP driver |

| Concern | Choice | Alternatives |
| --- | --- | --- |
| Infrastructure as code | [Alchemy](https://alchemy.run): the Workers, Queues, Durable Objects, D1, Cron Triggers, and secrets are one TypeScript stack (`alchemy.run.ts`, an Effect program, so it is the same language and library as the App and reviewable in the same pull request), with `alchemy plan` / `deploy` / `destroy` and state in the account's Cloudflare-hosted state store (`Cloudflare.state()`, encrypted at rest). Environments are Alchemy stages: `prod` is the stage the webhook URL and domain point at; `dev_<user>` is each developer's own copy (passed as an explicit `--stage`; Alchemy's own default for `alchemy deploy` is `$ALCHEMY_STAGE` or `live_$USER`), and a pull request in the App repository deploys stage `pr-<n>` from GitHub Actions, gets its URL as a comment, and is destroyed when the pull request closes. State and resource names are namespaced by stage, so no environment can touch another's D1 or queue. Secrets (App private key, webhook secret, session key) are set per stage; the GitHub App registration is per stage too (a `prod` App and a `dev` App with different webhook URLs), because one registration has one webhook URL | `wrangler.jsonc` plus `wrangler deploy` (the resources exist as configuration, not as code; per-environment copies are hand-named and secrets are set by hand per environment); Terraform / Pulumi (a second language or a heavier toolchain for six resource types); SST (AWS-first; its Cloudflare support is thinner and it is not Effect) |
| Auth | GitHub OAuth through the App's user authorization (one registration, one login button, tokens 8 h); session in a signed cookie holding the user id and the token encrypted with a Worker secret; access recomputed from `GET /user/installations` at sign-in | A separate OAuth App (a second registration to keep in step); email/password (nothing to gain, a password database to protect) |

**Recommendation.** Workers + Queues + Durable Objects + D1 defined and deployed with Alchemy,
Effect programs as the job bodies, `fetchTransport` for GitHub. The Fly.io and Vercel columns
are the comparison, not a fallback: Effect v4 on Workers is a stack the owner already runs.
The queue and the lock are still the two interfaces the App defines for itself (`JobQueue`,
`WriteLock`), because they are the only places the job model touches the platform. A broader
platform comparison (Cloudflare, Vercel, a Prisma-centred stack) is being written separately as
`docs/platform-comparison.md`; link it here once it lands.

### Technology decisions

Decided by the owner (2026-09-16); none changes sections 3–5.

| Choice | Decided | Notes |
| --- | --- | --- |
| Web framework on Workers | Effect `HttpApi` (`effect/unstable/httpapi`) | Routes, schema-validated inputs, and the `GitHub` / queue services in one Effect layer, matching the CLI's `effect/unstable/cli`. Hono was the alternative (more Workers examples, a second request model next to Effect) |
| Database access and migrations | D1 with Drizzle | Typed queries from the schema in section 4; `drizzle-kit` generates the numbered migrations, applied on deploy by the Alchemy stack. The schema stays Postgres-portable, which Drizzle keeps easy |
| Observability | Workers Logs | Plus the `runs` table as the domain-level trace; alerts on `failed` rows above zero in a run and on webhook signature failures. Sentry is added only if errors need grouping across installations |
| CI/CD | GitHub Actions + Alchemy deploy | `bun run check`, then `alchemy deploy --stage pr-<n>` on pull requests and `--stage prod` on `main`; credentials provisioned as code by an Alchemy `github` stack (a scoped Cloudflare API token written as Actions secrets). Revisit if Cloudflare ships a first-party build and deploy pipeline for Workers ("Cloudflare Artifacts") |
| Session storage | Decided at implementation | Candidates: encrypted, signed cookie only (no server-side table; revocation waits for the 8 h expiry), or KV / D1 session rows (server-side revocation). The choice is local to the auth module |
| Domain | Later | `workers.dev` for every stage until a product name exists; the custom domain is one resource in the same Alchemy stack when it does |
| Webhook verification | Hand-written HMAC-SHA256 over the raw body with `crypto.subtle`, constant-time compare | Twenty lines, no dependency; `@octokit/webhooks` is the alternative when its typed payloads become worth the package |

### Front-end library: open, candidates on Workers

The D21 page is server-rendered HTML from string builders, and M1 serves it as is. The owner
wants room for a front-end library for the UI that follows, so the choice is not made here; it
is open question 8. Candidates, each already deployable on Workers:

| Candidate | For | Against |
| --- | --- | --- |
| SolidStart / Solid 2 | Fine-grained reactivity, small bundles, SSR + islands on Workers; the owner maintains `lightsound/solid2-agent-kit`, so the agent tooling and conventions exist | Solid 2 is pre-release; smaller ecosystem for tables and forms; fewer Effect integrations |
| TanStack Start | Type-safe routing and loaders, SSR on Workers, React ecosystem for components; pairs with TanStack Table for the matrix and rows | React's bundle and rendering model for pages that are mostly static tables; framework still young |
| React Router (Remix) | Mature SSR and forms model (`action` / `loader`) that fits the App's `POST` + redirect flows; first-class Workers adapter | React as above; the D21 no-script pages become a React tree to maintain |
| Astro islands | Static-first pages with islands only where interaction is needed (the checkbox matrix, the run banner); SSR adapter for Workers; any island framework | Two component models in one App if islands use a second framework; less suited if most pages become interactive |
| HTMX-style progressive enhancement | Keeps `renderHtml`'s string builders as the whole rendering path; interaction by swapping server-rendered fragments; no build step, no hydration | No component model for a later design system; the fragments are still hand-built strings |

Constraint every candidate must satisfy: the words on the page stay the ones `labels.ts` prints
and `html.ts`'s sections stay the source of the report markup (exported as data or as
components in M2), so the D21 design system is carried, not re-implemented. M1 serves the
`renderHtml` page inside the chosen framework's shell if the choice is made before M1 starts;
otherwise behind `HttpApi` as a plain response, which every candidate above can wrap later.

## 7. Security

- **App private key**: a Worker secret (set per Alchemy stage, never in the stack file or the
  repository), read only by the JWT signer,
  never logged, rotated from the GitHub App settings page with a redeploy. **Installation
  tokens**: minted per job, held in memory for the job (at most one hour by construction), never
  written to D1 or logs. **User tokens**: 8 h expiry, encrypted (AES-GCM, key in a Worker
  secret) inside the session cookie, never in the database; sign-out clears the cookie.
  **Webhook secret**: `X-Hub-Signature-256` verified before the body is parsed; `delivery_id`
  recorded, duplicates dropped.
- **Least privilege**: the three repository permissions in section 4 and no organization or
  account permission. Installation tokens can be minted with a `repositories` subset; a
  `sync-target` job mints its token for the target repository only, so a bug in one target's
  code path cannot reach another repository during that job.
- **What is never stored**: repository contents other than what the `RepoReport` carries (paths,
  byte and token counts, hashes, `file:line` findings, managed block bodies, which are the pack
  text the customer distributes). Instruction files, `package.json`, and skill files are read
  into memory for the measurement and dropped with the job. No source code is fetched: the
  snapshot lists every path but reads only the files `scan` opens. Reports older than 90 days
  are deleted.
- **What is never written**: anything outside the two pull request paths (section 1); the
  default branch of any repository; a branch whose tip rulecheck did not write (D10).
- **Audit log**: every write (pull request opened or updated, with URL and run) and every
  action taken by a person (sign-in, pack source registered or removed, `Sync now`, `Rescan`,
  subscription change requested) and by GitHub (install, repositories added or removed,
  uninstall, suspend, authorization revoked), with actor, installation, target, run id, time.
  Shown on the Pack & subscriptions page; kept 12 months; exportable as JSON.
- **Uninstall**: the `installation` `deleted` event marks the installation, stops its jobs, and
  deletes its rows after 30 days (the grace period lets a reinstall keep history).

## 8. Pricing: deferred, decided after M2

No plan or price is proposed here. Pricing is decided after M2, when the App has run a real
sync for at least one organization other than the owner's and the first conversations have
shown what buyers compare (repositories, seats, or packs) and in which currency they want to
be invoiced. What the design fixes now is only what M3 needs to exist: a `plan` column on
`installations`, a repository-count gate that can be turned on, and the rule that an
installation over its limit keeps being scanned and stops being synced, with the page saying
so. Everything else (tiers, a free tier and its size, JPY or USD, annual terms) is open until
then.

## 9. Milestones

Effort is for one person working with cloud agents, in calendar weeks of part-time attention;
the unit is a week because the milestones gate on each other, not because any one is large.

| Milestone | Done when | Weeks |
| --- | --- | --- |
| M0: design accepted | This document merged with the open questions answered or defaulted; D25 recorded; the App registered on GitHub (name, permissions, webhook URL to a stub), one registration per stage; the template repository `lightsound/agent-rules-template` published | 0.5 |
| M1: install and read-only dashboard | The transport split and `fetchTransport` land in rulecheck (with `fake-github.ts` coverage); the App repository exists and depends on rulecheck at a sha; the Alchemy stack deploys `prod`, `dev_*`, and `pr-*` stages from GitHub Actions; install → `scan-installation` → Overview page served from `repo_reports`; `push` rescans one repository; daily rescan. Dogfood on `lightsound` | 3 |
| M2: sync and subscriptions | Pack source registration; `sync-target` on pack push, `Sync now`, dry run; runs and audit; `src/sync/subscribe.ts` in rulecheck with `fake-github.ts` coverage and its decision entry; Pack & subscriptions page with the subscriptions matrix writing D25 pull requests through it; Repository page; `html.ts` sections exported; the D23 workflow in agent-rules switched off once the App has opened the next real pull requests | 3 |
| M3: organizations and billing | Pricing decided (section 8), plan column and repository gate live; Stripe checkout and portal; installation switcher for users in several organizations; uninstall lifecycle; the truncated-tree fallback; status page and the alerts in section 6 | 3 |

Total about ten weeks to a chargeable product. M2 carries the product risk (does a team accept
two pull requests per subscription); M3 the commercial one (pricing is decided there).

## 10. Open questions for the owner

Each with the default this document assumes.

1. **Where does the App code live?** Default: a private repository `lightsound/rulecheck-app`
   that depends on `rulecheck` at a commit sha (D23's pinning method; `effect` is exact-pinned,
   so the "dependencies resolved afresh" concern is moot), and rulecheck adds an `exports` map
   in M1. Alternative: an `app/` workspace in this repository, which makes the App public.
2. **Must the pack source be inside the installation?** Default: yes (one token, one permission
   set, the D25 write has what it needs); D25 records this default and is amended if the answer
   changes. Alternative: a public pack repository outside the installation, read anonymously,
   with subscriptions then necessarily in the App (contradicts D25).
3. **May an admin commit a subscription change straight to the pack repository's default
   branch?** Default: no; always a pull request (D6). Alternative: a per-source opt-in when the
   branch has no protection, for solo installations.
4. **Scan cadence.** Default: webhooks plus one full rescan per installation per day and one
   dry run per day. Alternative: webhooks only (cheaper, stale after a missed delivery).
5. **Personal (user) installations in the MVP?** Default: yes on Free, since the owner's own
   estate is one and it is the dogfood; billing is organizations only in M3.
6. **Should the App replace the D23 workflow for `lightsound` at M2, or run beside it?**
   Default: replace (the workflow is switched off when the App has opened one real set of pull
   requests); running both would race on the same tool-owned branches.
7. **Retention.** Default: reports 90 days, snapshots, runs, and audit 12 months, rows deleted
   30 days after uninstall. Alternative: keep everything until the customer deletes it.
8. **Front-end library.** Candidates and trade-offs in section 6 ("Front-end library: open").
   No default is set: the owner picks. What the design fixes regardless: `html.ts` stays the
   source of the report markup, labels come from `labels.ts`, and the decision lands before M2
   (M1 serves `renderHtml` either way).

## Decisions

Search rounds as the owner's rule prescribes: round n is the round of looking for a strictly
better option that produced nothing new.

| Decision | Chosen | Alternatives considered | Settled in round |
| --- | --- | --- | --- |
| Source of truth | Files in the pack repository (`subscriptions.json`, `packs/**`) on the default branch; the database is a cache keyed by sha plus the App's own history (D25) | App database canonical with a generated file for the CLI (a second configuration store, an export the CLI must trust, roles to rebuild); both writable with a merge rule (the conflict the D9 hash exists to detect, moved to configuration) | 2 |
| How UI subscription edits reach the file | A pull request to the pack repository on the tool-owned branch `rulecheck/subscriptions`, D10 ownership check, one open pull request carrying every pending change | direct commit to the default branch (D6 forbids; open question 3); one branch per subscription change (N pull requests for one screen's worth of ticks); an issue asking a human to edit (a manual step the App exists to remove) | 1 |
| Hosting | Cloudflare Workers + Queues + Durable Objects, Cron Triggers for the daily runs; Effect v4 on Workers is a stack the owner already runs, so no fallback is planned | Fly.io Bun container (full reuse, a server to run); Vercel functions plus a queue service (two vendors for one job model); Deno Deploy (Deno, a third runtime; no queue with retries) | 2 |
| Infrastructure as code | Alchemy: one Effect-based TypeScript stack for every Cloudflare resource and secret; stages `prod` / `dev_<user>` / `pr-<n>`; deployed from GitHub Actions with credentials provisioned as code (decided by the owner) | `wrangler.jsonc` + `wrangler deploy`; Terraform / Pulumi; SST | decided by owner, n/a |
| Pricing | Deferred to after M2; the design fixes only the `plan` column, the repository gate, and the over-limit rule (decided by the owner) | a placeholder tier table now (removed: numbers before the first buyer conversation anchor the wrong thing) | decided by owner, n/a |
| Technology decisions | Effect `HttpApi`; D1 + Drizzle; Workers Logs; GitHub Actions + Alchemy deploy; session storage at implementation; domain later (decided by the owner) | Hono; raw SQL; Sentry; laptop deploys | decided by owner, n/a |
| Front-end library | Left open (open question 8) with five candidates compared on Workers; `html.ts` remains the source of the report markup whatever is chosen | pick server-rendered strings for good (closes the door the owner wants open); pick one now (the owner's call) | 1 |
| Bootstrap without a pack repository | Read-only inventory until a source is registered; (a) a public GitHub template repository the user instantiates with `Use this template` via a prefilled `github.com/new` link, then adds to the installation; (b) an existing repository; (c) a derived starter pack, post-MVP | the App creating the repository through the installation or user token (`Administration: write` on every visible repository for one onboarding click); the App pushing starter files into an empty repository the user created (`Contents: write` suffices, but the user still creates the repository, so the template saves the same click with fewer bytes of ours in the flow) | 2 |
| Database | D1, schema kept Postgres-portable | Neon Postgres (right when multi-region or large joins appear, not now); Durable Object SQLite storage per installation (no cross-installation query for the operator, no single backup) | 2 |
| Job model | One queue message per unit of work (`scan-installation`, `scan-repository`, `sync-target`), idempotent by key; a run groups messages; a Durable Object per installation is the D14 write lock | `syncAll` as one message (a 200-target run inside one 15-minute invocation, no partial progress); a Durable Object per installation running the whole sync (single-threaded, so no read parallelism); Workflows (durable steps, but a step per target is the queue with more ceremony) | 2 |
| Scan unit | Full scan mounts every repository of the installation into one snapshot and runs `scan` once (duplicates and counts come out unchanged); a push rescans one repository and duplicates are recomputed from stored hashes | one `scan` per repository always (cross-repository duplicates need a second implementation); full rescan on every push (3,000 calls per push at 200 repositories) | 2 |
| Team roles | None of the App's own: visibility from `GET /user/installations` and its repositories, admin from owner status of the installation account, subscription edits gated by the pack repository's own permissions | a roles table (a second permission system to keep in step with GitHub's); GitHub Teams mapping (adds `Members: read` for a gate the pack repository already enforces) | 2 |
| GitHub client change | Split `makeGh` into shared response mapping plus a `Transport`; `ghTransport` for the CLI, `fetchTransport` with an installation token provider and rate-limit handling for the App | a second `GitHubService` implementation (duplicated mapping that drifts); Octokit (a dependency for twelve endpoints whose mapping exists) | 1 |
| Where retries live | In `fetchTransport`: `retry-after` honored, one retry on secondary limit, job delayed below a remaining-calls floor | in the job runner (loses the header information); in `syncTarget` (D14 named the GitHub layer) | 1 |
| App code location | Private repository depending on rulecheck at a sha; rulecheck gains an `exports` map (open question 1) | `app/` workspace here (public App code); npm publish (a version to bump for one consumer; D23's argument still holds) | 2 |
| Pull-style onboarding | A candidate CLI command (`rulecheck subscribe <owner>/<pack-repo> --pack <id>`, name open) run inside a repository, opening the D25 subscription pull request directly or through the App when it is installed; documented, not scheduled, needs its own decision entry | make it the only subscription path (a developer must be in the repository; an admin subscribing twenty repositories wants the matrix); have it write the subscriber's block directly (skips the pack repository, so the CLI and the App would disagree on who is subscribed); a GitHub Action in the subscriber (a workflow per repository to onboard one line) | 1 |
| Per-repository failure in a full scan | Snapshots are built per repository; a failure becomes a `scan_error` on that repository's row (a row-level failure, not a shape or a pack status; glossary-listed as a word outside the four vocabularies when built) and the rest scan normally | one snapshot, one failure aborts the run (the CLI's behavior for one target; unacceptable over 200 repositories); a synthetic `RepoReport` with shape `none` (lies about the repository) | 1 |
| Where the D25 writer lives | rulecheck `src/sync/subscribe.ts`, pure plan in `src/domain`, `fake-github.ts` tests; called by the App and by the candidate CLI command | App-only code (two writers once the CLI command exists, and outside the `fake-github.ts` rule); the App calling the CLI as a process (no `Bun.spawn` on Workers) | 1 |
| Pack source scope | One source per installation, inside the installation | several sources (a merge order between sources nobody asked for); a source outside the installation (open question 2) | 1 |
| Overview in M1 | `renderHtml` output served as is under an App header | rebuilding the page as components first (three pages' worth of work before anything is live) | 1 |
| Manual sync control | `Dry run` is the default state of the button; a live run is a second, confirmed action | one `Sync` button (a live write one click away); no manual trigger (a missed webhook then waits for the daily run) | 1 |
| Report storage | The `RepoReport` JSON as `scan --json` produces it, `schemaVersion` recorded, block bodies kept | strip block bodies (the pack text is the customer's own distributed text, and the detail screen shows it); store instruction file contents for a diff view (content the security section promises not to keep) | 1 |
| Milestone unit | Weeks for one person with agents, four milestones | story points (nothing to calibrate against); no estimate (the owner asked for one) | 1 |

**Structural check.** The constraint behind most rows is "one configuration, many readers": the
CLI, the D23 workflow, and the App must agree on what is subscribed to what. It dissolves only
if there is one place all three read, and the one place they already read is the pack
repository. Putting the App's database in front of it would create the second place; keeping
the database behind it (a cache) does not. The same principle dissolves team roles (GitHub is
the one place permissions already live) and the fan-out question (one `syncTarget` is the one
place checks already live, so the queue may only schedule it).

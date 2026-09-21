# rulecheck App: MVP design

Design of the hosted GitHub App that turns the CLI's two commands into a service: a dashboard
that is the `--html` page kept live by webhooks, and "pack change → pull requests everywhere"
without a workflow or a token to maintain. Written 2026-09-16 against D1–D25; M0 below is this
document being accepted. The CLI stays open source and is the self-host path and the dev tool;
the App is the hosted product for teams (D23 named it the business-phase replacement of the
Actions + PAT setup).

Naming, decided after this document merged: the product is **RuleFleet**, its private repository
is `lightsound/rulefleet` (not `lightsound/rulecheck-app` as answer 1 in section 10 says), and
the bot account is `rulefleet[bot]`. The M1 handoff, [m1-kickoff.md](m1-kickoff.md), records the
override; the design itself is unchanged.

Revised 2026-09-20 for the dashboard's information architecture (D29: pages split by subject,
pack side first; D30: packs are edited on GitHub): sections 1, 2, 3, 5, 6, and 9 and the
decisions table. Architecture, jobs, data model, and security are as accepted at M0.

Every judgment call is in the decisions table at the end, with the search round in which no
better option appeared. Words in `code` that name a status, shape, or outcome are the ones
[status-model.md](status-model.md) defines.

## 1. Goals and non-goals

**Three goals, in the order the dashboard shows them (D29).** The person who installs the App
wants to (1) **manage the source**: know what the packs are, where they live, and what they
say, and get to the place where they are edited; (2) **see where each pack is distributed**:
which repositories carry it, at which rev, and which are behind, blocked, or edited by hand;
(3) **start and stop distribution**: subscribe or unsubscribe a repository, run a sync or a dry
run, and follow the pull requests it opened. The health of the instruction files (shapes,
budgets, findings, duplicates) is the fourth thing, a property of the repositories that
matters when one of the three above points at a repository. All four are projections of one
dataset, repository × pack with its pack status plus `subscriptions.json`, so the pages are
split by subject (pack, repository, run), not by command (`scan`, `sync`).

**Day 1 (after M2).** An organization installs the App on a set of repositories and gets:

- a registered pack source (a repository laid out like `lightsound/agent-rules`: `packs/<id>/`,
  `subscriptions.json`), each pack shown with its body, hash, rev, and a link to where it is
  edited on GitHub (goal 1; D30);
- the distribution of every pack over every repository, measured on each repository's
  default branch, updated on push, with no local tree: the Fleet home with one card per pack,
  the pack page with its subscribers, the Repositories table with one status column per pack
  (goal 2);
- a sync that opens or updates one pull request per repository per pack (D10, D14) when the
  pack repository's default branch changes, from a button, or as a dry run, authenticated as
  the App; subscriptions changed from the pack page and landing in `subscriptions.json` (D25)
  (goal 3);
- pull requests attributed to `rulecheck[bot]`, each linking to the run that wrote it (D23's
  `--run-url`, pointing at the App's run page);
- the health of the instruction files (the D19–D22 sections: `Next actions`, repository rows,
  duplicates, budgets) on the Repositories page and each repository's page, and as the last
  section of the Fleet home;
- team access derived from GitHub: whoever can read a repository can read its rows; whoever
  administers the installation account can register sources and trigger syncs.

**Not in the MVP.**

- A pack editor. GitHub is the editor (D30): the pack page links to GitHub's edit page for
  `packs/<id>/AGENTS.md` and to its new-file page for a new pack, and shows the body read-only.
  D6's "author a pack in a web app" is deferred past M3.
- Auto-merge. The App opens pull requests; humans or per-repository auto-merge (D6, off by
  default, not implemented) merge them.
- MCP / Hooks governance, Skills distribution (D18), Subagents. The inventory `scan` already
  prints (skills, lock state) is shown; nothing more.
- Billing and pricing (section 8: deferred to after M2; only the `plan` column and a
  repository-count gate exist in the schema).
- GitHub Enterprise Server, GitLab, Bitbucket. GitHub.com only.
- Any write to a repository other than the D10 pull request into a subscriber and the D25
  `subscriptions.json` change in the pack repository (a pull request, or a direct commit when
  the installation opts in).

## 2. User flows

**Install → first scan → dashboard.** GitHub's install page (organization or personal account;
"all repositories" or a selection) → `installation` webhook → the App records the installation
and its repositories and enqueues one full scan → the user lands on `/i/<installation>`, the
Fleet home (section 5), and sees the page fill in (a row per repository as its report arrives;
in M1 the page reloads without script, `<meta http-equiv="refresh">` while a run is in flight;
from T5b the banner fetches the run's progress and the sections reload when it finishes, D28).
Without a pack source the Fleet home opens with the onboarding card below instead of the pack
cards.

**Bootstrap: an installation with no pack repository yet.** Until a pack source is registered
the dashboard is the read-only inventory: shapes, budgets, duplicates, findings, skills, the
`Next actions` list without pack rows. That is already useful and needs no write permission
exercised. The Fleet home then opens with two things. First, the facts the reports already
hold about distribution: the managed blocks found in the stored `RepoReport`s, grouped by
`source` (how many repositories carry one, how many distinct `hash=` values, which `rev=`s),
with the sentence that registering the pack repository is what turns them into statuses; no
pack status word is printed here, because none has been measured (the D9 classifier needs the
pack's current hash). Second, the onboarding card, which offers the ways to get a pack
repository; (a) and (b) are shown as links, (c) is post-MVP and not shown:

- **(a) Create a pack repository.** The App publishes a public GitHub template repository
  (`lightsound/agent-rules-template`: `packs/base/AGENTS.md` as a commented starter,
  `subscriptions.json` as `{}`, the D23 `Sync packs` workflow included but disabled by a
  comment, a root `AGENTS.md` explaining the layout). The banner links to GitHub's create page
  with the template preselected
  (`https://github.com/new?template_owner=lightsound&template_name=agent-rules-template&owner=<account>&name=agent-rules`),
  the user clicks `Use this template`, then adds the new repository to the installation (GitHub's
  install page again, or the link the card gives) and selects it in the App (Settings, pack
  source). The `installation_repositories` webhook makes the new repository appear in the
  selector without a reload. Three clicks, all of them GitHub's own pages, and the App never
  holds the permission to create repositories. Least privilege decided this: creating the
  repository from the App
  (`POST /repos/{template_owner}/{template_repo}/generate` or `POST /orgs/{org}/repos`) needs
  `Administration: write` on the installation, a permission that also deletes and reconfigures
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
The repository must be one of the installation's repositories, because the installation token
can then read and write it and nothing else is needed; a source outside the installation would
need a second credential to be issued, stored, and rotated. A source outside is refused with
that reason. The App reads
`packs/<id>/AGENTS.md` and `subscriptions.json` at the default-branch HEAD with `loadPacks`
unchanged, stores the packs and subscriptions as a cache keyed by the commit sha (section 3),
and re-runs the installation scan with `packs` set so every repository × pack gets a status.
One pack source per installation in the MVP.

**Subscriptions.** The pack page (`/i/<installation>/packs/<pack>`, section 5) lists the
pack's subscribers with their status, and under a fold every other installed repository with
its `not-subscribed` projection (`classifyIfSubscribed`, D20: what a sync would do the moment
it is subscribed). Each row carries two facts side by side, because they are two facts
([status-model.md](status-model.md), "Subscription and block are two facts"): whether the
repository is in the pack's `subscriptions.json` list (the checkbox) and what its block reads
(the status chip). Unsubscribing removes the list entry and nothing else: the block stays in
the repository, the row keeps reading `current` or `outdated` from it (D9), and no sync run
has it as a target any more (D14). The page says so on the row (block present, not in
`subscriptions.json`); the App opens no pull request that removes a block, which would be a new
normalization and needs its own decision entry. Ticking a repository under a pack does not
write the database: it changes `subscriptions.json` in the pack repository (D25), in one of two
ways chosen by the per-installation setting `subscriptionChanges`:

- `pull-request` (default): a pull request against the pack repository; the pending change is
  shown on the page as "subscription PR #n open" until it merges, and the merge's `push`
  webhook reloads the cache and the row becomes `eligible`. Consequence stated plainly on the
  page: subscribing takes two pull requests, one to the pack repository and one into the
  subscriber.
- `direct-commit`: one commit on the pack repository's default branch, for solo accounts where
  a review of one's own subscription list is a formality; the `push` webhook that follows is
  the same, so the row becomes `eligible` at once. The D10 ownership check cannot apply to a
  default branch, so its place is taken by a **fast-forward-only update**: the writer reads the
  branch head, builds the commit on that head's tree with that head as its parent, and updates
  the ref without `force`, which GitHub rejects (`422`) when anything else has moved the branch
  in between; the writer then starts over once from the new head (measure `subscriptions.json`
  again, plan the edit against that content, commit, fast-forward), so the retry applies the
  intended change on top of the concurrent one rather than reverting it; a second rejection is
  a `refused` row. Nothing rulecheck did not read can be overwritten, at the ref or in the
  file. (`setRef` gains a `force` option for this; today it always forces, which is right for
  the tool-owned branch and wrong here.)
  GitHub's branch protection still applies (a protected default branch makes the update fail
  with that reason, and the page says to switch the setting back). Either way the subscriber
  repository is never written directly: the block always arrives as the D10 pull request.

**Pull-style entry point (candidate CLI command, not implemented).** The dashboard is the
push side: an admin subscribes repositories from the pack's point of view. The lightweight
onboarding path is the other direction, from inside a repository, the way `npx skills add`
installs a skill: `npx rulecheck subscribe <owner>/<pack-repo> --pack base` (name to be decided)
reads the current repository's `origin` remote, and makes the same D25 change to the pack
repository's `subscriptions.json` that adds `owner/repo` under `base` (a pull request, or a
direct commit where the installation opted in); with `--dry-run` it
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
- `Dry run` on the full-rescan schedule below, so the distribution report cannot go stale when
  no webhook arrived (a missed delivery, a suspended installation).

**What each webhook does.** Every delivery is verified, recorded by `delivery_id`, and turned
into at most one job; the paths are matched against the union of the push payload's per-commit
`added` / `modified` / `removed` lists. The payload does not say when those lists are
incomplete, so the router treats three observable cases as "touching everything": `commits` at
GitHub's documented cap of 2,048 entries, `forced: true`, or a `before` sha that is not the
previous head the App recorded for that branch (a gap in deliveries). Erring toward a scan is
cheap (6–15 calls) and the job key dedupes it:

| Event | Condition | Job |
| --- | --- | --- |
| `push` | to the pack repository's default branch; a touched path is under `packs/**` or is `subscriptions.json` | reload the pack cache at the pushed sha; one `sync-target` per subscriber × pack (live, or dry run when the setting says so) |
| `push` | to a subscriber's (or any installed repository's) default branch; a touched path is `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, a nested `AGENTS.md`, under `.cursor/**`, `.claude/**`, `.agents/skills/**`, or is `package.json` (the script check) | `scan-repository` at the pushed sha |
| `push` | any other branch, or no matching path | nothing (recorded, no job) |
| `installation_repositories` | `added` | `scan-repository` for each added repository; the Repositories table, the candidate fold on each pack page, and the pack-source selector in Settings update |
| `installation_repositories` | `removed` | prune: mark `removed_at`, drop the repository from the Repositories table, the pack pages, and the candidate list; its rows stay for history |
| `installation` | `created` / `unsuspend` | full `scan-installation` |
| `installation` | `suspend` / `deleted` | stop jobs; `deleted` starts the 30-day deletion (section 7) |
| `pull_request` | `closed` on a branch `agent-rules/*` or `rulecheck/subscriptions` | status refresh: `scan-repository` for the base repository (a merge is also a `push`, so this catches a close without merge, where the row stays `eligible` / `outdated` and the run row is annotated `PR closed`) |
| `repository` | `renamed`, `transferred`, `archived`, `deleted` | update `full_name` / `archived` / `removed_at`; an archived repository keeps its rows and gets no sync |
| `github_app_authorization` | `revoked` | end that user's sessions |

**Full rescan interval** is a per-installation setting, `fullRescan: "daily" | "weekly" | "off"`,
default `daily`: one `scan-installation` and one dry-run sync run per interval, as a safety net
under the webhooks. `off` is for an installation that trusts deliveries and wants the API budget
for something else; the page shows when the last full measurement happened either way.

The Runs page lists every run of the installation (kind, trigger, started, finished, counts
per outcome); a sync run opened shows the D14 table as it fills: repository, pack, remote
status, outcome (`planned +N -M`, `opened`, `updated`, `up-to-date`, `nothing-to-do`,
`refused: …`, `failed: …`), each pull request linked; a scan run shows its rows (`scanned`,
`scan_error` with the reason).

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

- UI edits change `subscriptions.json` in the pack repository, never the database alone. By
  default (`subscriptionChanges: "pull-request"`) as a pull request on the tool-owned branch
  `rulecheck/subscriptions`, force-updated on rerun with the D10 ownership check (tip commit
  prefixed `chore(agent-rules):`), one open pull request at a time carrying every pending
  change; with `subscriptionChanges: "direct-commit"` (a per-installation setting meant for solo
  accounts) as one commit on the default branch. Subscriber repositories are never written
  directly under either setting.
- The App needs `Contents: write` on the pack repository, which it has because the source must
  be inside the installation.
- A team that prefers the CLI or the D23 workflow keeps working; the App is a view and a runner
  over the same files.
- Pack editing stays on GitHub (D30): the pack page shows the body read-only with its hash and
  rev and links to GitHub's edit page for `packs/<id>/AGENTS.md` (and its new-file page for a
  new pack), so review, history, CODEOWNERS, and branch protection are the pack repository's
  own. An in-App editor, if one is ever built, would be the same mechanism as the
  subscriptions writer on `packs/<id>/AGENTS.md`, and needs its own decision entry.

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
check, or one fast-forward commit on the default branch when the installation's
`subscriptionChanges` setting says `direct-commit`), tested against `tests/fake-github.ts` like
`sync`. The App calls it from the checkbox
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

A **run** is what the run page and the audit log show (one `sync` run per pack push, one `scan`
run per rescan). For scans, a run is one Cloudflare Workflow instance (`id = run id`, D27):
its first step plans the run (rows, `expected_rows`), one step per repository measures that
repository (two attempts, then `scan_error`), and the last step closes the run from its rows,
so the instance's end is the run's end and a repository that exceeds a platform limit fails
only its own step. The D14 fan-out therefore lives in the orchestrator, not in `all.ts`, but
each target still calls `syncTarget` when M2 moves sync runs onto the same shape, so the
per-target checks stay in one place. `all.ts` keeps serving the CLI. The queue of the job table
remains the entry point for webhook-triggered work and for M2's `sync-target`.

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

What changed in `src/github` for this (shipped as P0, D26; the shape below is the one in the
tree, not the earlier sketch):

1. **Transport split.** `Transport` (`src/github/transport.ts`) turns one request (`method`,
   `path`, JSON `body`) into one response `{ status, headers, body }`: the status, the lowercased
   headers, and the raw body text, so `retry-after` and the quota headers survive and a non-JSON
   error page has somewhere to go. `makeGitHub(transport)` holds every path, request body, and
   response mapping (`treeEntry`, `pullRequest`, the error `message`) once, for both fronts.
   `ghTransport(run)` (`gh.ts`) is the CLI's front and the only module that spawns a process;
   `fetchTransport({ token, ... })` (`fetch.ts`) uses `fetch` alone, with `token` an
   `Effect<string>` so the caller decides how it is minted. The server never imports `gh.ts`.
2. **Installation token provider.** `installationToken({ appId, privateKey, installationId })`
   (`installation-token.ts`): an RS256 JWT signed with WebCrypto (`crypto.subtle`, available on
   Bun, Node, and workerd), `POST /app/installations/{id}/access_tokens`, cached until five
   minutes before `expires_at`. The mint is one more `fetchTransport` request and takes the same
   options (`onRateLimit`, `sleep`, `maxRetryDelaySeconds`, `userAgent`), so its response
   reports quota and retries like every other; `installationTokenTransport(options)` is the
   two wired together, sharing one `onRateLimit`. The quota the mint reports is the App's own
   bucket (JWT-authenticated requests, 5,000 per hour per App), not the installation's, and the
   headers do not reliably tell the two apart (GitHub documents no `x-ratelimit-resource` value
   specific to App-authenticated requests, so do not build a discriminator on that header); a
   job runner that keys a floor on the installation quota passes `installationToken` its own
   `onRateLimit` (or ignores the one sample per installation per token lifetime the mint
   contributes) rather than using `installationTokenTransport`.
   GitHub hands out the App private key as PKCS#1 (`BEGIN RSA PRIVATE KEY`) and
   `crypto.subtle.importKey` takes RSA keys as `pkcs8` only, so the key is converted once
   (`openssl pkcs8 -topk8 -nocrypt`) before it is stored as the secret; the signer refuses a
   PKCS#1 header with a message that names the command.
3. **Rate-limit handling** in `fetchTransport` as described above. `GitHubError` gains an
   optional `retryAfter` (seconds, set only when the API advertised a wait; D26 chose the
   optional field over `number | null`). The one other interface change is `setRef`'s options gaining
   `force: boolean` (default `true`, today's behavior) so the D25 `direct-commit` writer can ask
   for a fast-forward-only update; a `422` from GitHub then surfaces as a `GitHubError` with
   that status, which the writer treats as "the branch moved".
4. **Truncated trees.** When the API truncates the recursive listing (about 100,000 entries),
   `repositorySnapshot` lists the tree one level and asks for each subtree recursively in turn,
   skipping the directories the scan never descends into (`isIgnoredDirectory`), so the snapshot
   is complete and the report needs no `partial` word (D26 rejected the shallow fallback: a
   partial tree makes `missing-path` verification guess). More than `MAX_TREE_LISTINGS` (200)
   calls is a `GitHubError`, so one repository cannot spend a run's quota; such a repository is a
   `scan_error` row (job table above), not a failed run: snapshot assembly is per repository, so
   one unreadable repository never aborts the others.

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
| `installations` | cache | `id` (GitHub installation id), `account_login`, `account_type` (`Organization` / `User`), `suspended_at`, `created_at`, `plan` (section 8); settings `subscription_changes` (`pull-request` / `direct-commit`) and `full_rescan` (`daily` / `weekly` / `off`) |
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
kept for 90 days, snapshots and runs for 12 months, audit for 12 months (section 10, answer 8).

## 5. Dashboard pages

The dashboard is one frame with a sidebar of five entries, `Fleet / Packs / Repositories /
Runs / Settings`, and the pages under them (HTML pages the App serves, not images or mockups),
all rendered server-side. The information architecture is D29: pages are split by subject
(pack, repository, run), not by command (`scan`, `sync`); the pack side is primary, the
repository side secondary; a control that writes (M2) appears on the page that already shows
what it acts on, so M1 → M2 adds buttons and checkboxes to existing pages and no page of its
own. Every page is read-only in M1; the writes of M2 are marked below.

rulecheck's sections keep the D21 design system (Primer tokens, no script, `<details>` folds,
print keeps what is open) and are embedded as the static HTML `html.ts` produces. The App frame
around them is HeroUI / HeroUI Pro, and from T5b on it may hydrate client components where a
control needs script (a collapsing navigation bar or sidebar, a dropdown switcher, a confirmed
action, a live run banner that fetches progress instead of reloading the page, a theme toggle):
hydration is limited to those islands, the page still renders complete without it, and the
embedded sections are never hydrated or re-rendered (D28). T5 shipped the D19–D22 page at
`/i/<installation>` as static HTML with no script at all (`<meta http-equiv="refresh">` while a
run is in flight) and is done in that form; the Fleet home below takes its place at the same
route, and its sections move to the Repositories page and the repository page. Labels come from
`src/report/labels.ts`; the App may write navigation headings and onboarding prose of its own,
but a status, shape, outcome, or skill lock word is never one the glossary does not have. Where
the App assembles a view itself (the pack cards, the tables; from `status_snapshots` and
`repo_reports`), the words are `labels.ts`'s and the order of statuses is `STATUS_ORDER`, so a
card and the CLI's page agree on every count.

1. **Fleet** (`/i/<installation>`, home): the question "where does each pack stand, and what
   is next". Three sections in this order. **Pack distribution**: the registered source (name,
   short `head_sha`, loaded at) and one card per pack with the stacked status bar, the counts
   per status (nonzero, `STATUS_ORDER`), rev and short hash, the number of open pull requests,
   a link to the pack page, and in M2 the `Dry run` / `Sync` controls for that pack (also once
   for every pack, next to the source). **Next actions**: the D21 list, same verbs
   (`STATUS_ACTION`), same order, each row linking to its repository and its open pull request.
   **Health**: the D21 overview cards reduced to one row (repositories, issues, instruction
   files with the token sums), linking to the Repositories page. Without a pack source the
   first section is the bootstrap state of section 2: the managed blocks found in the reports
   and the onboarding card; `Next actions` then holds the issue rows only.
2. **Packs** (`/i/<installation>/packs`) and the **pack page**
   (`/i/<installation>/packs/<pack>`): goal 1 and the pack side of goals 2 and 3. The list shows
   the source with `head_sha`, `loaded_at`, and the `loadPacks` warnings, one row per pack (id,
   title, rev, hash, subscriber count, the stacked bar), and a `New pack on GitHub` link
   (`github.com/<owner>/<repo>/new/<branch>?filename=packs/<id>/AGENTS.md`). The pack page shows
   the body read-only (`<pre>`, with its size and token count), rev, hash, an `Edit on GitHub`
   link (`github.com/<owner>/<repo>/edit/<branch>/packs/<id>/AGENTS.md`), one sentence
   explaining the flow (edit → pull request → merge → `push` → one pull request per subscriber),
   and in M2 `Dry run` / `Sync` for this pack; then the **Subscribers** table, one row per
   subscriber: status chip, `file:line`, open pull request, the outcome of the last run for it,
   and in M2 the subscription checkbox, with a filter by status; then, folded, the
   `Not subscribed` candidates with the `classifyIfSubscribed` projection (D20) and in M2 a
   checkbox to add each. A repository that carries the block without being in the list is a
   row with the chip and an unticked checkbox and says so (section 2, Subscriptions). Pending
   subscription changes show as `subscription PR #n open` under `pull-request`; under
   `direct-commit` the row turns `eligible` at the next `push`.
3. **Repositories** (`/i/<installation>/repositories`) and the **repository page**
   (`/i/<installation>/r/<owner>/<repo>`): the repository side of goal 2 and the health of the
   estate. The list is one table, one row per live repository, including those without
   instruction files and those that could not be measured (`could not be measured: <reason>`
   in place of their columns): shape, issue count, one status column per pack (chip and
   `file:line`; absent until a source is registered, when the block's `source` and `rev` are
   shown instead), the Cursor and Claude Code budgets; filters by owner, shape, issues, and pack
   status; a search box; rows link to the repository page. Until `html.ts` exports its sections
   as data (M2b), this page also embeds the D21 `Repositories` and `Duplicates` sections
   unchanged as the static HTML `html.ts` produces (D28), under the table. The repository page
   is the repository row opened, plus what the row could not hold: the files it loads with
   budgets per tool, findings with `file:line` linking to the GitHub blob at the measured sha,
   managed blocks with `source`, `rev`, `hash`, and whether the body was modified, status per
   pack with the next-action verb, the skills inventory with lock state, and the history of this
   repository's rows in past runs (status over time, pull requests opened for it).
4. **Runs** (`/i/<installation>/runs`): the history side of goal 3. One row per run (kind
   `scan` / `sync`, trigger, dry run or live, started, finished, counts per outcome); a run
   opened shows its rows (section 2, "The Runs page"). M1 lists scan runs; sync runs arrive
   with M2b.
5. **Settings** (`/i/<installation>/settings`): the pack source (register, with the
   inside-the-installation check and the `loadPacks` warnings as the checklist; remove), the
   `subscriptionChanges` and `fullRescan` settings, the audit log (section 7), and the plain
   statement of what the App's permissions let it write (section 4, `Contents: write`). In M1
   the page shows `fullRescan` read-only and the audit log. Registering a source and changing
   the two settings write the App's database only, so they belong to M2a; the subscription
   checkbox and `Sync` are the writes to GitHub and belong to M2b (section 9).

Mobile: the sidebar folds into the frame's drawer, the Fleet cards stack in one column, and
the tables scroll horizontally; there is no separate layout.

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
platform comparison (Cloudflare, Vercel, a Prisma-centred stack, with prices at 10 / 100 / 500
installations and the conditions under which to switch) is
[platform-comparison.md](platform-comparison.md).

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

### Front end: React + TanStack Start on Workers, HeroUI Pro

Decided by the owner: the dashboard is **React with TanStack Start** on Workers, its UI built on
**HeroUI Pro** (the paid HeroUI component set; the owner holds the license), and it lives in a
**private repository** (`lightsound/rulecheck-app`, on the owner's personal GitHub account for
now; an organization only if one is ever needed). Private because HeroUI Pro's license forbids
redistribution in open source, so the component code cannot sit in a public repository; the CLI
in this repository stays open source and framework-free. The **marketing site and the
documentation** may live in the same private repository on the same stack (decided for now;
revisit if a static site turns out cheaper to run apart). Documentation tooling is **Fumadocs**:
MDX docs inside the TanStack Start app, same deploy, same design tokens. Not chosen: Mintlify
(hosted, nothing to run, but a second domain and a subscription for pages the App already
serves).

The framework comparison that led to the pick, kept for the record:

| Candidate | For | Against |
| --- | --- | --- |
| TanStack Start (chosen) | Type-safe file routes, loaders, and server functions; SSR on Workers through Vite with the Cloudflare plugin; TanStack Table and Query for the matrix, rows, and run pages; HeroUI Pro is plain React and drops in | The youngest of the three; fewer production reports on Workers; server functions are its own convention next to `HttpApi` (kept for webhooks and the job API, so two request models coexist by design) |
| React Router v7 (framework mode) | The mature Remix `loader` / `action` model, which fits the App's form-and-redirect flows; first-class Cloudflare Workers template; large ecosystem | Less type inference across routes than TanStack; data APIs shaped around HTML forms, so the checkbox matrix needs client code either way |
| Next.js on Workers (OpenNext) | The most React tooling and the most familiar to hires or contractors; App Router server components | Runs through an adapter layer (OpenNext) rather than natively; heaviest bundle and cold start of the three; the adapter is another thing that can break on a Next release |

Why TanStack Start: best type story end to end (routes, loaders, table, query in one family),
native Workers deployment through Vite, and nothing between React and the runtime. React
Router v7 was the safe second; Next-on-Workers was not recommended for a product whose whole
surface is a handful of data pages (three when this was written, five since D29). Not chosen
further out: SolidStart / Solid 2 (the owner maintains `lightsound/solid2-agent-kit`, but HeroUI
Pro is React), Astro islands (a second component model next to React for no gain on a few
interactive pages), HTMX-style fragments over `renderHtml`'s strings (no component model for
HeroUI to plug into).

Constraint: the words on the page stay the ones `labels.ts` prints, and the report's structure
comes from `html.ts` (its sections exported as data in M2b, rendered by HeroUI components that
carry the D21 tokens as the theme), so the design system is carried, not re-implemented. Until
then the App embeds `html.ts`'s sections as static HTML (D28) and assembles only what the
sections do not hold (the Fleet pack cards, the Repositories and Subscribers tables) from
`status_snapshots` and `repo_reports`, with `labels.ts`'s words and `STATUS_ORDER`. M1 serves
those pages inside TanStack Start routes, with `HttpApi` handling webhooks and the job API
next to it.

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
- **What is never written**: anything outside the two paths of section 1; the default branch
  of any repository, except the pack repository's under `subscriptionChanges: "direct-commit"`
  and then only `subscriptions.json`; a subscriber repository other than through the D10 pull
  request; a branch whose tip rulecheck did not write (D10).
- **Audit log**: every write (pull request opened or updated, with URL and run) and every
  action taken by a person (sign-in, pack source registered or removed, `Sync now`, `Rescan`,
  subscription change requested) and by GitHub (install, repositories added or removed,
  uninstall, suspend, authorization revoked), with actor, installation, target, run id, time.
  Shown on the Settings page; kept 12 months; exportable as JSON.
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
| M0: design accepted | This document merged with every question in section 10 answered; D25 recorded; **Accounts**: the dedicated Cloudflare account created (billing set up, Alchemy state store bootstrapped) and the App registration and private repository placed under the personal GitHub account; **HeroUI Pro** license confirmed to cover use in the private repository (and the marketing site, if it shares it); the App registered on GitHub (name, permissions, webhook URL to a stub), one registration per stage; the template repository `lightsound/agent-rules-template` published | 0.5 |
| M1: install and read-only dashboard | The transport split and `fetchTransport` land in rulecheck (with `fake-github.ts` coverage); the private App repository exists and depends on rulecheck at a sha; the Alchemy stack deploys `prod`, `dev_*`, and `pr-*` stages from GitHub Actions; install → `scan-installation` → the D19–D22 page served from `repo_reports` at `/i/<installation>`; `push` rescans one repository; the `fullRescan` schedule. Dogfood on `lightsound`, personal installation included. **Remainder after D29, read-only:** the sidebar frame (`Fleet / Packs / Repositories / Runs / Settings`); the Fleet home in its bootstrap state (managed blocks found in the reports, the onboarding card) with `Next actions` and the health row; the Repositories table from `repo_reports` (shape, issues, budgets, block `source` / `rev`) with the D21 sections embedded under it; the Runs list of scan runs; Settings showing `fullRescan` and the audit log | 3 |
| M2a: pack source and distribution (read) — **done 2026-09-21** (roadmap Step 8, D31) | Pack source registration (inside the installation; writes the database only); `loadPacks` at the source's HEAD and the installation scan with `packs` set, so `status_snapshots` fill; the Fleet pack cards; the Packs list and the pack page with body, hash, rev, the GitHub edit and new-file links (D30), the Subscribers table and the `Not subscribed` fold (both read-only); the pack status columns of the Repositories table; the `subscriptionChanges` and `fullRescan` settings; the scheduled dry run producing sync runs on the Runs page. No GitHub write and no `WriteLock`: goal 2 is met here | 1.5 |
| M2b: sync and subscriptions (write) — **done 2026-09-21** (roadmap Step 8, D31 / D32) | `sync-target` on pack push, `Dry run` / `Sync` on the Fleet and pack pages (dry run the default state, live on a confirmed second click), the `WriteLock` Durable Object in use; `src/sync/subscribe.ts` in rulecheck with `fake-github.ts` coverage and its decision entry, the subscription checkbox on the pack page writing D25 changes through it and showing the pending `subscription PR #n open`; runs and audit rows for every write; `html.ts` sections exported and rendered by HeroUI components in TanStack Start routes (the Repositories table and the repository page stop embedding static sections); the D23 workflow removed from `agent-rules` once the App has opened the next real pull requests (replacement, not coexistence) | 1.5 |
| M3: organizations and billing | Product name decided and the custom domain added to the stack; pricing decided (section 8), plan column and repository gate live; Stripe checkout and portal; installation switcher for users in several organizations; uninstall lifecycle; status page and the alerts in section 6 | 3 |

Total about ten weeks to a chargeable product. M2 is two slices because they gate differently:
M2a needs nothing but reads and can start the moment the M1 remainder lands, and it already
answers goal 2 for an installation that distributes with the D23 workflow; M2b is where the
App first writes to GitHub and where the product risk sits (does a team accept two pull
requests per subscription, or does it switch to `direct-commit`). M3 carries the commercial
risk (name and pricing are decided there).

## 10. Questions for the owner: answers

Answered 2026-09-16; the answers are folded into the sections above and recorded here so the
document does not have to be diffed to find them.

| # | Question | Answer |
| --- | --- | --- |
| 1 | Where does the App code live? | A **private repository** (`lightsound/rulecheck-app` on the owner's personal GitHub account; see 10), depending on `rulecheck` at a commit sha (D23's pinning; `effect` is exact-pinned) with an `exports` map added to rulecheck in M1. Private because the dashboard uses HeroUI Pro, whose license forbids redistribution in open source. The CLI stays open source here. The marketing site and the docs may live in the same repository on the same stack (decided for now); docs tooling **Fumadocs** |
| 2 | Front end | **React + TanStack Start** on Workers, UI on **HeroUI Pro** |
| 3 | Must the pack source be inside the installation? | **Yes.** The installation token can read and write it and nothing else is needed; a source outside would need a second credential to issue, store, and rotate |
| 4 | May a subscription change go straight to the default branch? | **A per-installation setting**, `subscriptionChanges: "pull-request" \| "direct-commit"`, default `pull-request`; `direct-commit` is meant for solo accounts. Subscriber repositories are never written directly under either value (D25 updated) |
| 5 | Scan schedule | Webhooks as tabulated in section 2 ("What each webhook does"); the full rescan interval is a per-installation setting `fullRescan: "daily" \| "weekly" \| "off"`, default `daily` |
| 6 | Personal (user) installations in the MVP? | **Included** |
| 7 | The D23 workflow in `agent-rules` at M2 | **Removed when M2 ships**: the App replaces it; no coexistence (both would race on the same tool-owned branches) |
| 8 | Retention | Defaults **accepted**: reports 90 days; snapshots, runs, audit 12 months; rows deleted 30 days after uninstall |
| 9 | Product name | **Decided before M3** (the custom domain follows it) |
| 10 | Accounts | A **new, dedicated Cloudflare account** for the product (its own billing, API tokens, and Alchemy state store, nothing shared with other projects); **GitHub stays on the personal account** (`lightsound`) for the App registration and the private repository, an organization later if ever |

No question is open. Documentation tooling is Fumadocs (section 6); Mintlify was not chosen.

## Decisions

Search rounds as the owner's rule prescribes: round n is the round of looking for a strictly
better option that produced nothing new.

| Decision | Chosen | Alternatives considered | Settled in round |
| --- | --- | --- | --- |
| Source of truth | Files in the pack repository (`subscriptions.json`, `packs/**`) on the default branch; the database is a cache keyed by sha plus the App's own history (D25) | App database canonical with a generated file for the CLI (a second configuration store, an export the CLI must trust, roles to rebuild); both writable with a merge rule (the conflict the D9 hash exists to detect, moved to configuration) | 2 |
| How UI subscription edits reach the file | Per-installation setting `subscriptionChanges`: `pull-request` (default; the tool-owned branch `rulecheck/subscriptions`, D10 ownership check, one open pull request carrying every pending change) or `direct-commit` (one commit on the default branch, for solo accounts); subscriber repositories never written directly (decided by the owner) | pull request only (the first draft; a review of one's own list is a formality for a solo account); one branch per subscription change (N pull requests for one page's worth of ticks); an issue asking a human to edit (a manual step the App exists to remove) | decided by owner, n/a |
| Hosting | Cloudflare Workers + Queues + Durable Objects, Cron Triggers for the daily runs; Effect v4 on Workers is a stack the owner already runs, so no fallback is planned | Fly.io Bun container (full reuse, a server to run); Vercel functions plus a queue service (two vendors for one job model); Deno Deploy (Deno, a third runtime; no queue with retries) | 2 |
| Infrastructure as code | Alchemy: one Effect-based TypeScript stack for every Cloudflare resource and secret; stages `prod` / `dev_<user>` / `pr-<n>`; deployed from GitHub Actions with credentials provisioned as code (decided by the owner) | `wrangler.jsonc` + `wrangler deploy`; Terraform / Pulumi; SST | decided by owner, n/a |
| Pricing | Deferred to after M2; the design fixes only the `plan` column, the repository gate, and the over-limit rule (decided by the owner) | a placeholder tier table now (removed: numbers before the first buyer conversation anchor the wrong thing) | decided by owner, n/a |
| Technology decisions | Effect `HttpApi`; D1 + Drizzle; Workers Logs; GitHub Actions + Alchemy deploy; session storage at implementation; domain later; a dedicated Cloudflare account for the product, GitHub on the personal account (decided by the owner) | Hono; raw SQL; Sentry; laptop deploys | decided by owner, n/a |
| Front end | React + TanStack Start on Workers, HeroUI Pro for the UI, in a private repository because HeroUI Pro cannot be redistributed in open source (decided by the owner); the marketing site and docs may share the repository and stack, docs with Fumadocs (Mintlify not chosen: hosted pages next to an App that already serves pages) | React Router v7 (the safe second), Next.js on Workers via OpenNext (adapter layer, heaviest); SolidStart / Solid 2, Astro islands, HTMX-style fragments (each would sit next to a React component library or leave it unused) | decided by owner, n/a |
| Guard for `direct-commit` | Fast-forward-only ref update (parent = the head that was read, `force: false`, one re-read and retry on `422`, then `refused`), since the D10 ownership check cannot apply to a default branch | force update as for the tool-owned branch (would overwrite a commit pushed between read and write); a lock in the App only (does not see pushes from outside the App); require branch protection with the App as the only allowed pusher (a setting the solo account this targets does not have) | 1 |
| Scan schedule | Webhook table in section 2 plus a per-installation `fullRescan` setting (`daily` default, `weekly`, `off`) (decided by the owner) | fixed daily rescan; webhooks only | decided by owner, n/a |
| Bootstrap without a pack repository | Read-only inventory until a source is registered; (a) a public GitHub template repository the user instantiates with `Use this template` via a prefilled `github.com/new` link, then adds to the installation; (b) an existing repository; (c) a derived starter pack, post-MVP | the App creating the repository through the installation or user token (`Administration: write` on every visible repository for one onboarding click); the App pushing starter files into an empty repository the user created (`Contents: write` suffices, but the user still creates the repository, so the template saves the same click with fewer bytes of ours in the flow) | 2 |
| Database | D1, schema kept Postgres-portable | Neon Postgres (right when multi-region or large joins appear, not now); Durable Object SQLite storage per installation (no cross-installation query for the operator, no single backup) | 2 |
| Job model | One queue message per unit of work (`scan-installation`, `scan-repository`, `sync-target`), idempotent by key; a run groups messages; a Durable Object per installation is the D14 write lock | `syncAll` as one message (a 200-target run inside one 15-minute invocation, no partial progress); a Durable Object per installation running the whole sync (single-threaded, so no read parallelism); Workflows (durable steps, but a step per target is the queue with more ceremony) | 2 |
| Scan unit | Full scan mounts every repository of the installation into one snapshot and runs `scan` once (duplicates and counts come out unchanged); a push rescans one repository and duplicates are recomputed from stored hashes | one `scan` per repository always (cross-repository duplicates need a second implementation); full rescan on every push (3,000 calls per push at 200 repositories) | 2 |
| Team roles | None of the App's own: visibility from `GET /user/installations` and its repositories, admin from owner status of the installation account, subscription edits gated by the pack repository's own permissions | a roles table (a second permission system to keep in step with GitHub's); GitHub Teams mapping (adds `Members: read` for a gate the pack repository already enforces) | 2 |
| GitHub client change | Split `makeGh` into shared response mapping plus a `Transport`; `ghTransport` for the CLI, `fetchTransport` with an installation token provider and rate-limit handling for the App | a second `GitHubService` implementation (duplicated mapping that drifts); Octokit (a dependency for twelve endpoints whose mapping exists) | 1 |
| Where retries live | In `fetchTransport`: `retry-after` honored, one retry on secondary limit, job delayed below a remaining-calls floor | in the job runner (loses the header information); in `syncTarget` (D14 named the GitHub layer) | 1 |
| App code location | Private repository `lightsound/rulecheck-app` on the owner's personal GitHub account, depending on rulecheck at a sha; rulecheck gains an `exports` map; private because HeroUI Pro cannot be redistributed (confirmed by the owner) | `app/` workspace here (public App code, impossible with the library's license); npm publish (a version to bump for one consumer; D23's argument still holds); a GitHub organization now (later, if ever) | 2 |
| Pull-style onboarding | A candidate CLI command (`rulecheck subscribe <owner>/<pack-repo> --pack <id>`, name open) run inside a repository, opening the D25 subscription pull request directly or through the App when it is installed; documented, not scheduled, needs its own decision entry | make it the only subscription path (a developer must be in the repository; an admin subscribing twenty repositories wants the matrix); have it write the subscriber's block directly (skips the pack repository, so the CLI and the App would disagree on who is subscribed); a GitHub Action in the subscriber (a workflow per repository to onboard one line) | 1 |
| Per-repository failure in a full scan | Snapshots are built per repository; a failure becomes a `scan_error` on that repository's row (a row-level failure, not a shape or a pack status; glossary-listed as a word outside the four vocabularies when built) and the rest scan normally | one snapshot, one failure aborts the run (the CLI's behavior for one target; unacceptable over 200 repositories); a synthetic `RepoReport` with shape `none` (lies about the repository) | 1 |
| Where the D25 writer lives | rulecheck `src/sync/subscribe.ts`, pure plan in `src/domain`, `fake-github.ts` tests; called by the App and by the candidate CLI command | App-only code (two writers once the CLI command exists, and outside the `fake-github.ts` rule); the App calling the CLI as a process (no `Bun.spawn` on Workers) | 1 |
| Pack source scope | One source per installation, inside the installation (confirmed by the owner: the installation token reads and writes it; outside would mean a second credential) | several sources (a merge order between sources nobody asked for); a source outside the installation (a second credential to issue, store, and rotate) | 1 |
| Overview in M1 | `renderHtml` output served as is under an App header | rebuilding the page as components first (three pages' worth of work before anything is live) | 1 |
| Manual sync control | `Dry run` is the default state of the button; a live run is a second, confirmed action | one `Sync` button (a live write one click away); no manual trigger (a missed webhook then waits for the daily run) | 1 |
| Dashboard information architecture (D29, 2026-09-20) | Five routes under a sidebar, split by subject: `Fleet` (home: pack cards, `Next actions`, health row), `Packs` (list and pack page: source, body, subscribers), `Repositories` (table and repository page), `Runs`, `Settings`; pack side primary, repository side secondary; M2 controls appear on the pages that already show their subject; the `not-subscribed` and bootstrap states are the same pages with the fold or the onboarding card | the D19–D22 page as home with a `Packs` link (goal 1–3 below the fold or on another page); pack-centred only (an empty home without a source, health demoted); a repository × pack matrix as the home (no place for the source or per-pack actions); a `Next actions` inbox as the home (empty when everything is `current`, no structure); two dashboards, health and distribution (one dataset shown twice); a setup wizard as the IA (it is the empty state of Fleet, not a page tree); minimal App with GitHub pull requests and checks as the status (no cross-repository view, D8) | 4 |
| What "stop" means on the pack page | Unsubscribe only: the `subscriptions.json` entry is removed through the D25 writer; the block stays and the row shows both facts (unticked, `current` / `outdated` chip) | a pull request that removes the block (a new normalization and a new kind of write; recorded as a candidate without a decision entry) | 3 |
| Pack editing (D30) | Not in the App: the pack page shows the body read-only with hash and rev and links to GitHub's edit and new-file pages for `packs/<id>/AGENTS.md`; the Packs list explains edit → merge → `push` → subscriber pull requests in one sentence | an in-App Markdown editor writing through the D25 mechanism (re-implements review, history, permissions, and branch protection the pack repository already has; the one advantage, rot detection before saving, is what a dry run after the merge shows as `refused`) | 2 |
| Report storage | The `RepoReport` JSON as `scan --json` produces it, `schemaVersion` recorded, block bodies kept | strip block bodies (the pack text is the customer's own distributed text, and the detail screen shows it); store instruction file contents for a diff view (content the security section promises not to keep) | 1 |
| Milestone unit | Weeks for one person with agents, four milestones | story points (nothing to calibrate against); no estimate (the owner asked for one) | 1 |

**Structural check.** The constraint behind most rows is "one configuration, many readers": the
CLI, the D23 workflow, and the App must agree on what is subscribed to what. It dissolves only
if there is one place all three read, and the one place they already read is the pack
repository. Putting the App's database in front of it would create the second place; keeping
the database behind it (a cache) does not. The same principle dissolves team roles (GitHub is
the one place permissions already live) and the fan-out question (one `syncTarget` is the one
place checks already live, so the queue may only schedule it).

# RuleFleet M1 kickoff

Handoff for the agents that build **RuleFleet** in the private repository `lightsound/rulefleet`
(empty on 2026-09-16). Those agents do not share the conversation that produced the design; this
document is self-sufficient for M1 and points at [app-design.md](app-design.md) for every
rationale. Where the two disagree, `app-design.md` wins, with one exception recorded here: the
product is named **RuleFleet** and its repository is `lightsound/rulefleet` (app-design still
says `lightsound/rulecheck-app`; the bot account is therefore `rulefleet[bot]`, not
`rulecheck[bot]`). The open source CLI stays `lightsound/rulecheck` for now; renaming it is a
separate item outside this plan (not one of P0 or T1–T7; see §7).

## 1. What RuleFleet is

- A hosted GitHub App that keeps AI coding agent instruction files (`AGENTS.md`, `CLAUDE.md`,
  `.cursor/rules`, `.claude/rules`) healthy across every repository of an installation.
- It runs rulecheck's `scan` on every repository's default branch, from webhooks, with no local
  tree, and serves the `--html` report live as a dashboard.
- From M2 it distributes shared rule packs as one pull request per repository per pack
  (rulecheck's `sync`), authenticated as the App, with `subscriptions.json` in the pack
  repository as the only source of truth (D25).
- The CLI `lightsound/rulecheck` is the engine and the self-host path; RuleFleet is a view and a
  runner over the same code and the same files, never a second implementation.
- Design: [app-design.md](app-design.md) (architecture, jobs, data model, security, milestones).
  Vocabulary: [status-model.md](status-model.md) (every status, shape, and outcome word the
  pages may print). Decisions: [decisions.md](decisions.md) (D1–D25; D25 is the App's own entry,
  the technology decisions are app-design §6).

## 2. M1 scope

**Done when** (copied from app-design §9, row M1: install and read-only dashboard):

> The transport split and `fetchTransport` land in rulecheck (with `fake-github.ts` coverage);
> the private App repository exists and depends on rulecheck at a sha; the Alchemy stack deploys
> `prod`, `dev_*`, and `pr-*` stages from GitHub Actions; install → `scan-installation` →
> Overview page served from `repo_reports`; `push` rescans one repository; the `fullRescan`
> schedule. Dogfood on `lightsound`, personal installation included.

**Non-goals for M1.** Do not build any of these; each has a milestone or a decision entry of its
own.

- Pack source registration, the `sync-target` job, `Sync now`, dry runs, runs and audit pages,
  the Pack & subscriptions page, the Repository page (M2).
- `src/sync/subscribe.ts` (the D25 subscriptions writer) and the candidate `rulecheck subscribe`
  command (M2, own decision entry).
- Exporting `html.ts` sections as data and rendering them with HeroUI components (M2). M1 serves
  `renderHtml` output as is.
- Any write to any repository. M1 issues no GitHub write; the App holds `Contents: write` and
  `Pull requests: write` from registration so M2 needs no re-authorization, but no M1 code path
  calls a write operation.
- Billing, the `plan` gate, Stripe, custom domain, product marketing site (M3). The name is
  decided (RuleFleet); the domain is not.
- Truncated-tree fallback (M2); GitHub Enterprise Server, GitLab, Bitbucket (never in MVP).
- Renaming `lightsound/rulecheck`; the pack template repository `lightsound/agent-rules-template`
  (M0 item, owner's task).

## 3. Repository bootstrap: `lightsound/rulefleet`

Stack, exactly. Versions marked `=` are exact pins that must match rulecheck's `package.json` at
the pinned sha; the others follow the same ranges rulecheck uses.

| Concern | Choice | Notes |
| --- | --- | --- |
| Runtime, package manager, tests | Bun `1.4.2` | `bun <file>`, `bun test`, `bun add`. Never `node`, `npm`, `pnpm`, `vitest`, `jest`. Declare `"packageManager"` or a `.bun-version` so CI and Cloud Agents agree |
| Language | TypeScript `^7`, strict | Copy rulecheck's `tsconfig.json` flags: `moduleResolution: bundler`, `allowImportingTsExtensions: true`, `verbatimModuleSyntax`, `noEmit`, `noUncheckedIndexedAccess`. The first two are required, not stylistic: rulecheck's sources import with explicit `.ts` extensions and are type-checked as part of the App's program |
| Effect | `effect` `=4.0.0-rc.115` | Exact, identical to rulecheck's pin, so one copy of `effect` is installed and rulecheck's services (`GitHub`, `FileSystem`, `Path`) resolve in the App's layers. Bump both repositories together. `@effect/platform-bun` is not a dependency of the App (it is rulecheck's CLI entry only) |
| Web | TanStack Start (React) on Cloudflare Workers via Vite and `@cloudflare/vite-plugin` | File routes, loaders, server functions for pages. Webhooks and the job API use Effect `HttpApi` (`effect/unstable/httpapi`) next to it; two request models by design (app-design §6) |
| UI | HeroUI Pro (paid, license held by the owner) | **License constraint**: no redistribution in open source, which is why this repository is private. Do not copy HeroUI Pro component source into any public repository, gist, or pull request against `lightsound/rulecheck`. Install method: `<placeholder: owner supplies the HeroUI Pro download or registry instructions in the first session>`; until then use HeroUI (open source) primitives and keep component files under `src/ui/heroui-pro/` so the swap is one directory |
| Docs | Fumadocs (MDX inside the TanStack Start app) | Same deploy and design tokens as the dashboard; served under `/docs` |
| Database | Cloudflare D1 with Drizzle ORM and `drizzle-kit` | Schema from app-design §4 (data model); numbered migrations applied on deploy by the Alchemy stack; keep the schema Postgres-portable (no SQLite-only types) |
| Jobs | Cloudflare Queues; Cron Triggers for the schedule | Behind two App-owned interfaces, `JobQueue` and `WriteLock` (app-design §6). M1 implements `JobQueue` over Queues; `WriteLock` (a Durable Object per installation) is defined but unused until M2, because M1 issues no write |
| Infrastructure | Alchemy, `alchemy.run.ts` (an Effect program) | Stages `prod`, `dev_<user>`, `pr-<n>`; state in the Cloudflare-hosted state store; secrets per stage. Deploy from GitHub Actions: `bun run check`, then `alchemy deploy --stage pr-<n>` on pull requests and `--stage prod` on `main`; `pr-<n>` destroyed when the pull request closes |
| Lint and format | Biome `^2.5.13` | Copy rulecheck's `biome.json` (2 spaces, width 100, double quotes, semicolons, trailing commas) |
| Instruction files | `AGENTS.md` canonical, `CLAUDE.md` containing exactly `@AGENTS.md` | Project sections first (what RuleFleet is, stack, commands, layout, rules), then the managed blocks below, which arrive by pull request |
| Rules packs | Subscribe to `base` and `personal` of `lightsound/agent-rules` | One pull request against `lightsound/agent-rules` adding `"lightsound/rulefleet"` under both keys of `subscriptions.json`. The D23 workflow then opens the block pull request into `rulefleet` once `RULECHECK_TOKEN` exists and lists `lightsound/rulefleet` in its repository access (D23; a missing entry reads `failed`, 404). The secret does not exist yet (roadmap Step 6), so today the only path is manual: run `bun run dev sync lightsound/rulefleet --pack base --packs lightsound/agent-rules` (then `--pack personal`) from a rulecheck checkout; `--dry-run` first |
| Cloud Agents | `.cursor/environment.json` with an install step that installs Bun `1.4.2` and runs `bun install --frozen-lockfile` | Agents in this repository run on cloud VMs; nothing may depend on one machine |
| README | None | Do not create `README.md` unless the owner asks (the `personal` pack says so) |

### Consuming rulecheck

- Dependency form: `"rulecheck": "github:lightsound/rulecheck#<full commit sha>"` in
  `dependencies`. A sha, never a branch (D23's pinning argument). Renovate may propose bumps
  later; until then bump by hand and re-run `bun run check`.
- A git-URL install ignores rulecheck's `bun.lock` and resolves its dependencies afresh (D23).
  Consequence: pin `effect` in the App to the identical exact version, and after every bump run
  `bun pm ls | grep effect` and confirm a single copy.
- The App imports only what runs on workerd. **Never import** `src/main.ts`, `src/cli.ts`, or
  `src/github/gh.ts` (`Bun.spawn`). `node:crypto` (`createHash`) and `Buffer` in the reusable
  code need `nodejs_compat` on the Worker; `js-tiktoken` is pure JavaScript.
- Modules the App needs, and the `exports` subpaths rulecheck must expose for them:

| App use | rulecheck module | `exports` subpath |
| --- | --- | --- |
| Types (`ScanReport`, `RepoReport`, `PackStatusEntry`, …), `classifyIfSubscribed`, `STATUS_ORDER`, `loadPacks` inputs | `src/domain/*` | `./domain/*` → `./src/domain/*.ts` |
| `scan(root, { packs })` over the snapshot filesystem, `loadPacks` | `src/scan/scan.ts`, `src/scan/packs.ts` (and their siblings, imported transitively) | `./scan/*` → `./src/scan/*.ts` |
| `syncTarget`, `SyncRefused`, `SyncFailed`, `SyncOutcome` (M2; exported now so the pin does not move for it) | `src/sync/sync.ts`, `src/sync/all.ts` | `./sync/*` → `./src/sync/*.ts` |
| `renderHtml(report, { version })`, `renderSyncAllHtml` | `src/report/html.ts` | `./report/html` |
| `SHAPE_LABEL`, `STATUS_LABEL`, `STATUS_ACTION`, `OUTCOME_LABEL`, `LOCK_STATE_LABEL`, `NESTED_KIND_LABEL` | `src/report/labels.ts` | `./report/labels` |
| Sentences `html.ts` shares with the text report (`SHAPE_NOTE`, `describeScope`, `describePersonalCopy`), `outcomeDetail` | `src/report/render.ts`, `src/report/sync.ts` | `./report/render`, `./report/sync` |
| `GitHub` service, `GitHubService`, `GitHubError`, `RepositoryRef`, `parseRepositorySpec` | `src/github/client.ts` | `./github/client` |
| `repositorySnapshot`, `snapshotFileSystem`, `withChanges`, `mountPath` | `src/github/fs.ts` | `./github/fs` |
| `Transport` interface, `makeGitHub(transport)` (the shared response mapping), `fetchTransport({ baseUrl, token })`, `installationToken(appId, privateKey, installationId)` | `src/github/transport.ts`, `src/github/fetch.ts`, `src/github/installation-token.ts` (new in P0) | `./github/transport`, `./github/fetch`, `./github/installation-token` |

- Is a rulecheck pull request required first? **Yes, before T4, not before T1.** Today rulecheck
  has no `exports` map and no fetch transport: `makeGh(run)` builds the service around a function
  that spawns `gh`, so nothing in `src/github` runs on workerd. Deep imports
  (`rulecheck/src/domain/types.ts`) would resolve without an `exports` map, but the transport does
  not exist, and app-design §10 answer 1 fixes the `exports` map as an M1 deliverable. That
  pull request is **P0** below, on `lightsound/rulecheck`. T1–T3 do not import rulecheck and
  proceed in parallel with P0; T4 pins the sha of P0's merge commit.

## 4. Tasks, in order

Each task is one pull request or a small series; each ends with the check written under it.
P0 is on `lightsound/rulecheck`; T1–T7 are on `lightsound/rulefleet`.

**P0 (rulecheck): `exports` map and fetch transport** (app-design §4 "What must change in
`src/github`", items 1–3).

- Split `makeGh` into `makeGitHub(transport)` (shared response mapping: `treeEntry`,
  `pullRequest`, `parseError`) plus a `Transport` interface (`request(method, path, body) →
  { status, json }`); keep `ghTransport(run)` for the CLI (`Bun.spawn` only in `bunGhRunner`);
  add `fetchTransport({ baseUrl, token })` where `token` is an `Effect<string>`.
- `installationToken(appId, privateKey, installationId)`: RS256 JWT with `crypto.subtle`,
  `POST /app/installations/{id}/access_tokens`, cached until five minutes before `expires_at`;
  refuse a PKCS#1 (`BEGIN RSA PRIVATE KEY`) key with a message naming
  `openssl pkcs8 -topk8 -nocrypt`.
- Rate limits in `fetchTransport`: read `x-ratelimit-remaining` and `retry-after`; one retry on a
  `403`/`429` secondary limit with the advertised delay; `GitHubError` gains
  `retryAfter: number | null`. `setRef` options gain `force: boolean` (default `true`).
- `package.json` `exports` as tabulated in §3. `AGENTS.md` Layout updated for the new files;
  `docs/decisions.md` gets no new entry (the decision is app-design's "GitHub client change"
  row) unless the shape of the split departs from it.
- Done check: `bun run check` green; `tests/github.test.ts` covers `fetchTransport` against a
  fake `fetch` (status mapping, `retryAfter`, the secondary-limit retry) and the JWT signer
  against a test key; the CLI still runs `sync --all --dry-run` through `ghTransport` with no
  output change; from a scratch directory `bun add github:lightsound/rulecheck#<sha>` and
  `import { scan } from "rulecheck/scan/scan"` type-checks.

**T1: repository skeleton, CI, hello Worker on `dev`.**

- Bun, TypeScript, Biome, Effect, TanStack Start with the Cloudflare Vite plugin, `AGENTS.md`
  and `CLAUDE.md`, `.cursor/environment.json`, `bun run check` (`typecheck`, `lint`, `test`).
- `alchemy.run.ts` with one Worker, one D1 database, one Queue, and the stage convention;
  `.github/workflows/ci.yml` running `bun run check` then `alchemy deploy --stage pr-<n>` with
  the URL as a pull request comment, `--stage prod` on `main`, and destroy on close. Actions
  secrets set by the owner from §5 (an Alchemy `github` stack that writes them is app-design's
  end state and may follow in T1 or later).
- Open the `subscriptions.json` pull request on `lightsound/agent-rules` (§3, Rules packs).
- Done check: `bun run check` green in CI; `GET /` on the `dev_<user>` and `pr-<n>` Workers
  returns a page from a TanStack Start route; `alchemy destroy --stage pr-<n>` removes every
  resource; `AGENTS.md` carries both managed blocks (`current` in `sync --all --dry-run`).

**T2: GitHub App registration and webhook receiver.**

- Two registrations under the `lightsound` account, `RuleFleet` (prod) and `RuleFleet Dev`
  (dev), each with: repository permissions `Contents: read & write`, `Pull requests: read &
  write`, `Metadata: read`, no organization or account permission; webhook events
  `installation`, `installation_repositories`, `push`, `pull_request`, `repository`,
  `github_app_authorization`; "Request user authorization (OAuth) during installation" and
  "Expire user authorization tokens" on; Setup URL `<stage origin>/setup`; webhook URL
  `<stage origin>/webhooks/github`; callback URL `<stage origin>/auth/callback` (app-design §4).
  `pr-<n>` stages reuse the dev registration's credentials for pages and receive no webhook
  deliveries (one registration has one webhook URL).
- `POST /webhooks/github` as an `HttpApi` endpoint: verify `X-Hub-Signature-256` over the raw
  body with `crypto.subtle` HMAC-SHA256 and a constant-time compare before parsing; record
  `X-GitHub-Delivery` in `webhook_deliveries` and drop duplicates; route by event per the table
  in app-design §2 "What each webhook does"; unknown events are recorded and produce no job.
- Done check: a `ping` delivery from the App settings page returns 2xx and a row; a delivery
  with a wrong signature returns 401 and writes nothing; a redelivered `delivery_id` returns
  2xx and writes nothing; unit tests cover the verifier with a known key and body.

**T3: installation events → D1 rows.**

- Drizzle schema for `installations`, `repositories`, `webhook_deliveries`, `runs`, `run_rows`,
  `repo_reports`, `status_snapshots`, `users`, `user_installations`, `audit_log` (app-design §4
  data model; `pack_sources` and `packs` may be created now and stay empty). `installation`
  `created` / `unsuspend` / `suspend` / `deleted`, `installation_repositories` `added` /
  `removed`, and `repository` `renamed` / `transferred` / `archived` / `deleted` update the rows
  as the table says; `deleted` marks the 30-day deletion but M1 implements no purge job.
- Done check: installing the dev App on a test account produces one `installations` row and one
  `repositories` row per selected repository; adding and removing a repository flips
  `removed_at`; every handled event leaves an `audit_log` row with actor `webhook`.

**T4: scan job over Queues** (needs P0 merged; bump the rulecheck sha here).

- `scan-installation` and `scan-repository` messages, keyed as app-design §4 says; the consumer
  mints an installation token (`installationToken`), builds one `repositorySnapshot` per
  repository at its default-branch HEAD (each attempted on its own), merges them into one
  `Snapshot`, mounts it with `snapshotFileSystem`, provides `Path.layer` (the POSIX `Path` from
  `effect`) and runs `scan("/", { home: null })` once; stores one `RepoReport` per repository in
  `repo_reports` with `schema_version`, and the run's rows.
- A repository whose snapshot fails (no default-branch ref, 404, truncated tree, a 5xx after the
  transport's retry) gets `scan_error` and `scan_error_at` on its row and the others scan. Add
  `scan_error` to `docs/status-model.md` "Words outside the model" in rulecheck in the same
  step (app-design §4 job table).
- `installation` `created` enqueues `scan-installation`; a `push` to a default branch that
  touches a path from the webhook table enqueues `scan-repository` at the pushed sha.
- Done check: after install, `repo_reports` holds one row per measurable repository within one
  minute; a push editing `AGENTS.md` in one repository refreshes only that repository's row; a
  repository emptied or deleted mid-run shows `scan_error` and does not stop the run; the job
  consumer never calls `createTree`, `createCommit`, `setRef`, `createPullRequest`, or
  `updatePullRequest` (grep the Worker bundle).

**T5: Overview page.**

- `GET /i/<installation>`: assemble a `ScanReport` from `repo_reports` (and, later,
  `status_snapshots`), call `renderHtml(report, { version })`, and serve the result as the body
  of a TanStack Start route inside the HeroUI layout: App header (installation name, `Rescan`
  disabled until T6 gives a user, sign out placeholder), run banner with
  `<meta http-equiv="refresh">` while a run is in flight, `renderHtml` output below. Without a
  pack source the page has no `Pack distribution` section and says so (app-design §2).
- Do not re-render sections as components; do not print any word `labels.ts` does not have.
- Done check: the page renders for the dogfood installation in light and dark, prints, and
  matches `bun run dev scan --html` of the same repositories in every number; `tests/` covers
  the `ScanReport` assembly from stored rows.

**T6: GitHub OAuth login and installation switcher.**

- `/auth/login` → GitHub's authorize URL for the App's user authorization; `/auth/callback`
  exchanges the code, calls `GET /user` and `GET /user/installations`, stores login and id in
  `users`, refreshes `user_installations` (with `is_admin` from
  `GET /user/memberships/orgs/{org}` for organizations, the account itself for a personal
  installation), and sets an encrypted, signed session cookie (AES-GCM, key in a Worker
  secret) holding user id and the 8 h user token; `/setup` does the same after install and
  redirects to `/i/<installation>`. Session storage form (cookie only, or KV / D1 rows) is
  decided here (app-design §6 "Session storage"); record the choice in the App's `AGENTS.md`.
- Every `/i/*` route requires a session and shows only installations listed for that user; the
  header's switcher lists them; `Rescan` enqueues `scan-installation` for admins and is hidden
  otherwise; `github_app_authorization` `revoked` ends the user's sessions.
- Done check: an anonymous request to `/i/<installation>` redirects to login; a user without
  the installation gets 404, not the page; sign-out clears the cookie; a `Rescan` writes an
  `audit_log` row with actor `user:<login>`.

**T7: daily Cron rescan.**

- A Cron Trigger (daily) that enqueues `scan-installation` for every installation whose
  `full_rescan` setting is `daily` and is not suspended; `weekly` on the matching day; `off`
  never. The setting exists on `installations` (default `daily`); no settings UI in M1. The
  page shows when the last full measurement happened.
- Done check: forcing the trigger (`alchemy` or the dashboard's scheduled-event test) produces
  one run per eligible installation with `trigger = schedule`; a suspended installation gets
  none; the Overview footer shows the time.

M1 is complete when every done check above passes on `prod` with the `lightsound` personal
installation (dogfood) and app-design §9's M1 row reads true.

## 5. Owner-provided accounts and secrets

No values here. Every secret is set per Alchemy stage; nothing is committed. Names are the
suggested environment variable / Worker secret names; keep them if nothing forces a change.

| Item | Where it goes | Note |
| --- | --- | --- |
| Cloudflare account (new, dedicated to the product) | `CLOUDFLARE_ACCOUNT_ID` in GitHub Actions secrets of `rulefleet` and in each developer's `.env` (gitignored) | Workers Paid plan (queues, Durable Objects) |
| Cloudflare API token for Alchemy | `CLOUDFLARE_API_TOKEN` (same places) | Scoped to the account: Workers Scripts, Workers KV, D1, Queues, Durable Objects, Account Settings read. One token for CI, one per developer |
| Alchemy state store choice and its encryption passphrase | `ALCHEMY_PASSWORD` (same places) | Default per app-design: the Cloudflare-hosted state store (`Cloudflare.state()`, encrypted at rest). Choose a different store only with a note in the App's `AGENTS.md` |
| GitHub App `RuleFleet` (prod) and `RuleFleet Dev`: App ID | `GITHUB_APP_ID` Worker secret, per stage | From the App settings page; `pr-*` stages take the dev value |
| GitHub App private key, converted to PKCS#8 | `GITHUB_APP_PRIVATE_KEY` Worker secret, per stage | GitHub downloads PKCS#1; run `openssl pkcs8 -topk8 -nocrypt -in <downloaded>.pem` once and store the output; the signer refuses PKCS#1 |
| GitHub App webhook secret | `GITHUB_WEBHOOK_SECRET` Worker secret, per stage | Generated by the owner, pasted into the App settings and the secret |
| GitHub App OAuth client id and client secret | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` Worker secrets, per stage | From the same App registration (user authorization), not a separate OAuth App |
| Session encryption key | `SESSION_SECRET` Worker secret, per stage | Generated by the agent (`openssl rand -base64 32`), not by the owner; listed so it is not forgotten |
| HeroUI Pro credentials | Where the install method (§3) requires; if a registry token, `HEROUI_PRO_TOKEN` in Actions secrets and `.env`, never in the repository | Owner supplies the install instructions with the credentials |
| `RULECHECK_TOKEN` in `lightsound/agent-rules`, covering `lightsound/rulefleet` | agent-rules repository secret (specified by D23, not yet created as of 2026-09-16) | Fine-grained PAT; include `rulefleet` in its repository list when creating it so the D23 workflow can open the block pull request. Until it exists, the manual `sync` in §3 is the only path |
| Actions secrets for Pullfrog in `rulefleet` | `rulefleet` repository secrets | Same provider keys as rulecheck's `.github/workflows/pullfrog.yml`, if the owner wants Pullfrog reviews there too |

Worker secrets flow: Actions secret or `.env` → `alchemy.run.ts` reads it (`alchemy.secret`)
→ set on the Worker of that stage. Never log a secret; never store an installation or user
token in D1 (app-design §7).

## 6. Working rules for agents in `lightsound/rulefleet`

These come from the `base` and `personal` packs of `lightsound/agent-rules`, which arrive in
`AGENTS.md` by pull request (§3). Until that pull request merges, apply them by hand:

- English everywhere in the repository (code, comments, commits, branches, PRs); the chat with
  the owner is Japanese.
- No interim progress reports; one final report with the results, including every structured
  item the rules require (decisions table, PR URLs, test counts).
- Judgment calls are not questions: propose, search for a strictly better option in rounds,
  stop when a round adds nothing, check whether the constraint dissolves structurally, then
  choose. The final report lists every judgment call as a table (decision, chosen option, round
  in which no new option appeared), never summarized.
- Open pull requests as ready for review, not draft; address Pullfrog (review-bot) findings
  before reporting.
- No `README.md` unless the owner asks. `AGENTS.md` carries agent-facing content; `CLAUDE.md`
  is exactly `@AGENTS.md`.
- Repository-specific rules to add to the App's `AGENTS.md` in T1: the App never writes to
  GitHub outside rulecheck's `src/sync/` functions; every word on a page comes from
  `rulecheck/report/labels` or `status-model.md`; the rulecheck dependency is a sha; `effect` is
  pinned to rulecheck's version.

## 7. Deferred to M2 / M3

- **M2**: pack source registration (inside the installation only); `sync-target` on pack push,
  `Sync now` with `Dry run` default, scheduled dry run; runs and audit log; Pack & subscriptions
  page with the checkbox matrix writing `subscriptions.json` through `src/sync/subscribe.ts`
  (`pull-request` / `direct-commit` setting, D25); Repository page; `html.ts` sections exported
  and rendered by HeroUI components; `fullRescan` and `subscriptionChanges` settings UI;
  truncated-tree fallback; the D23 workflow removed from `agent-rules` once the App has opened
  the next real pull requests; `WriteLock` Durable Object in use.
- **M3**: pricing and billing (Stripe checkout and portal, `plan` column and repository gate
  live, over-limit rule: scanned but not synced); custom domain in the Alchemy stack; status
  page and alerts (failed rows, signature failures); uninstall lifecycle purge; installation
  switcher polish for users in several organizations.
- **Name and domain**: the product name is RuleFleet; the domain, the rename of
  `lightsound/rulecheck` (CLI, npm-less git dependency, GitHub redirects), and the
  `rulecheck[bot]` → `rulefleet[bot]` wording in app-design are separate items and are not
  blocked on M1.
- **Candidates without a decision entry**: `rulecheck subscribe` (pull-style onboarding),
  derived starter pack (bootstrap option c), Sentry, `@octokit/webhooks` typed payloads.

## Decisions made in this document

| Decision | Chosen | Alternatives considered | Settled in round |
| --- | --- | --- | --- |
| When P0 must merge | Before T4; T1–T3 run in parallel with it, because they do not import rulecheck | before T1 (blocks the skeleton on a rulecheck change it does not use); after T5 with deep imports and a temporary `gh`-free shim in the App (a second GitHub client the design rules out) | 2 |
| `exports` form | Subpath patterns per directory (`./domain/*`, `./scan/*`, `./sync/*`) plus named entries for `report/*` and `github/*`, all pointing at `.ts` sources | one barrel `index.ts` (hides which module runs on workerd; `gh.ts` would be one import away); a build step emitting `.js` + `.d.ts` (a publish pipeline for one consumer, D23) | 2 |
| `WriteLock` in M1 | Interface defined, Durable Object not deployed until M2 | deploy it unused in M1 (a resource with no caller to test it); skip the interface (M2 then retrofits the job consumer) | 1 |
| `pr-*` stages and webhooks | Reuse the dev registration's credentials; receive no deliveries; end-to-end webhook tests run on `dev_<user>` and `prod` | a registration per pull request (the App's own API cannot create one; manual work per PR); no `pr-*` stages (app-design M1 names them) | 1 |
| HeroUI Pro until the install method is known | Open source HeroUI primitives under one directory, swapped later | block T1/T5 on the credentials (M1 has one page; the layout is a header) | 1 |
| Where `scan_error` is recorded as a word | rulecheck `docs/status-model.md`, "Words outside the model", in the T4 step | the App's own docs (the glossary rule says every printed word is in the glossary) | 1 |
| Secret names | One `GITHUB_*` / `CLOUDFLARE_*` / `ALCHEMY_PASSWORD` / `SESSION_SECRET` set, identical across stages, values differing | per-stage prefixes (`PROD_…`, `DEV_…`; Alchemy stages already namespace) | 1 |

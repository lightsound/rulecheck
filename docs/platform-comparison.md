# Hosting platform comparison for the rulecheck App

Is the Cloudflare stack (Workers + Queues + Durable Objects + D1 + Cron Triggers, Alchemy for
infrastructure) the right home for the hosted GitHub App, against (a) the Vercel stack (Functions
on Fluid compute, Workflows and Queues, Neon Postgres through the Marketplace, Cron Jobs) and (b)
the Prisma stack (Prisma Postgres, Prisma Compute, Prisma Composer, Prisma Accelerate)? The App
is the one designed in `docs/app-design.md` (pull request
[#26](https://github.com/lightsound/rulecheck/pull/26), section 6 of which chose Cloudflare
before this survey existed): a GitHub App that receives webhooks, runs `scan` and `sync` jobs
against the GitHub API with bounded concurrency and one writer per installation, stores status
snapshots, and serves a dashboard. TypeScript, Effect v4, Bun for the CLI. Target scale: tens to
a few hundred installations, low traffic, bursty jobs.

Surveyed: 2026-09-16, from official documentation and pricing pages (URLs inline), the npm
registry and GitHub for release states. Prices are USD list prices on that date. Re-survey when
Prisma Composer or Vercel Queues reaches GA, when Alchemy ships a stable 2.0, or when a platform
changes a limit this document leans on (the 128 MB isolate, the 15-minute consumer, the 60-second
first byte). Nothing here changes what rulecheck writes or reports; it confirms the hosting row
of the App design's decisions table and records the conditions under which that row would
change.

## 1. What the App asks of a platform

The workload, stated once so every column below measures the same thing. Figures come from the
App design (section 4, jobs and rate limits) and the CLI as it runs today.

- **Code to run.** Everything in `src/domain/`, `src/scan/`, `src/sync/sync.ts`, `src/github/fs.ts`
  and `src/report/` unchanged. Node APIs used: `node:crypto` `createHash` (four files), `Buffer`;
  `js-tiktoken` is pure JavaScript with a few MB of rank tables. The GitHub client becomes
  `fetch`-only (`fetchTransport`); `Bun.spawn` stays in the CLI's `gh` runner and is never
  imported by the server. Effect v4 release candidate, exact-pinned (`4.0.0-rc.115` at the time
  of writing; Effect targets stable in Q3/Q4 2026,
  [announcement](https://effect.website/blog/releases/effect/40-rc)).
- **Jobs.** Three message kinds (`scan-installation`, `scan-repository`, `sync-target`), each
  idempotent by key, each a few seconds of CPU and up to tens of seconds of wall time waiting on
  GitHub; a full scan of 200 repositories is about 3,000 API calls spread over many messages.
  Triggers: webhooks, a button, and a daily schedule (full rescan and dry run per installation).
- **One writer per installation.** Reads run in parallel; content-creating GitHub requests to
  one installation pass through one lock. D14 serializes writes with one `Semaphore` per
  `sync --all` run (`src/sync/all.ts`); the App design narrows that run-wide lock to one per
  installation and names two interfaces the job model touches the platform through, `JobQueue`
  and `WriteLock`.
- **Data.** Small rows: installations, repositories, sha-keyed pack cache, `RepoReport` JSON per
  (repository, sha), one status row per measurement, runs, audit. Hundreds of repositories × a
  few packs × one row per measurement; 90-day report retention. Migrations with Drizzle are the
  design's stated upgrade path once the schema grows.
- **Dashboard.** Server-rendered HTML, low traffic, GitHub OAuth session in a signed cookie.
- **Operator.** One person working through coding agents; nothing to babysit.

Scale points for the price estimates: 10, 100, and 500 installations, each with a daily rescan.

## 2. The three stacks, verified

**Cloudflare.** Workers (V8 isolates, `workerd`), Queues, Durable Objects (SQLite-backed),
D1, Cron Triggers, Workflows: all generally available on the Workers Paid plan ($5/month
minimum, [pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
[Alchemy](https://alchemy.run) is a third-party infrastructure-as-code framework written as an
Effect program; npm `alchemy` is at `2.0.0-beta.77` (published 2026-09-09, releases roughly
weekly) and its README says "Expect breaking changes"
([repository](https://github.com/alchemy-run/alchemy)). Its peer range is
`effect >=4.0.0-rc.112 || >=4.0.0`, so it installs beside rulecheck's pin.

**Vercel.** Vercel Functions run on Fluid compute (Node.js 24 GA and default; Bun 1.4 in public
beta, [changelog](https://vercel.com/changelog/bun-1-4-is-now-available-in-vercel-functions)).
[Vercel Workflows](https://vercel.com/docs/workflows) (the open-source Workflow SDK, formerly
WDK) went GA on 2026-04-16
([announcement](https://vercel.com/blog/a-new-programming-model-for-durable-execution));
[Vercel Queues](https://vercel.com/docs/queues), the primitive under it, is in public beta since
2026-02-27. Cron Jobs are GA. "Vercel Postgres" no longer exists as a product: every store was
moved to Neon's Marketplace integration in Q4 2024 – Q1 2025 and new code is told to use
`@neondatabase/serverless`
([Neon transition guide](https://neon.com/docs/guides/vercel-postgres-transition-guide)); the
Marketplace also lists Supabase, AWS Aurora, and Prisma Postgres for Postgres, and Upstash Redis
for KV ([marketplace storage](https://vercel.com/docs/marketplace-storage)). Vercel Blob is
first-party and not needed here. Pro is $20/month with a $20 usage credit; Hobby is restricted to
non-commercial personal use ([Hobby plan](https://vercel.com/docs/plans/hobby)), so a product
starts on Pro.

**Prisma.** Four names, four different things as of this date:

| Name | What it is | State |
| --- | --- | --- |
| [Prisma Postgres](https://www.prisma.io/pricing) | Managed Postgres with built-in connection pooling; pooled TCP and a serverless HTTP driver (`@prisma/adapter-ppg`) for edge runtimes. Standard Postgres wire protocol, so Drizzle over `pg` works. Billed per operation (query), not per compute hour | GA |
| [Prisma Compute](https://www.prisma.io/docs/compute/limitations) | TypeScript app hosting that runs on Bun next to Prisma Postgres, scales to zero, immutable deploys with preview URLs and rollback, per-branch preview environments, deploy from GitHub Actions with OIDC (`prisma/cloud-deploy-action`), config in `prisma.compute.ts`. Public beta 2026-06-08, GA 2026-08-28 ([changelog](https://www.prisma.io/changelog/2026-08-28)) | GA (three weeks old) |
| [Prisma Composer](https://www.prisma.io/docs/composer) | A TypeScript framework that declares a multi-service topology (services, databases, secrets, and the first-party `cron`, `storage`, `streams` modules) and deploys it to Compute and Postgres with `prisma deploy module.ts`; `prisma dev` runs the same topology against local emulators. npm `@prisma/composer` `0.20.0` (2026-09-13, daily releases); repository created 2026-02-13, 5 stars. Its deploy engine is Alchemy (`alchemy 2.0.0-beta.74` in its dependencies) and it exact-pins `effect 4.0.0-rc.112`; the docs require the app to pin the same `effect` version or every command fails with `DEPS.EFFECT_VERSION_CONFLICT` ([getting started](https://www.prisma.io/docs/composer/getting-started)). Its CLI needs Node 22.18+ | Early Access, "APIs and commands can change between releases" |
| [Prisma Accelerate](https://www.prisma.io/docs/accelerate) | Connection pooling plus a global query cache for Prisma ORM clients. Standalone Accelerate and the hosted `accelerate.prisma-data.net` connection retire on 2026-12-01; Prisma Postgres keeps pooling, drops caching ("not on our immediate roadmap"); Prisma 8 does not use it | Retiring; irrelevant to an app that uses Drizzle and has no query-cache need |

Two things worth noticing before the comparison. Composer's cron module contradicts Compute's own
limitations page ("Cron scheduling … not part of it"): the scheduler is a Composer-provisioned
service that calls your service, not a Compute feature, so it exists only for Composer users.
And the Prisma stack is built from the same parts as the Cloudflare stack (Alchemy, Effect v4),
one layer up and several months younger.

## 3. Comparison

Columns are the stacks as they would be used here: Cloudflare = Workers + Queues + one Durable
Object per installation + D1 + Cron, Alchemy; Vercel = Functions + Queues (or Workflows) + Neon +
Cron, `vercel.json` and the Vercel CLI; Prisma = Compute + Postgres + Composer (`cron`), a job
table in Postgres for the queue.

| Criterion | Cloudflare | Vercel | Prisma |
| --- | --- | --- | --- |
| Runtime and Effect v4 | `workerd`, not Node or Bun. `node:crypto` is fully supported under Node.js compatibility, on by default from compatibility date 2026-08-04 ([docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)); `Buffer` likewise. Effect v4 runs there and ships first-party `@effect/sql-d1` and `@effect/sql-sqlite-do` in the RC; Alchemy's own Worker handlers are Effect programs. 128 MB per isolate, fixed ([limits](https://developers.cloudflare.com/workers/platform/limits/)); `js-tiktoken` rank tables fit. No `Bun.*`, no subprocess: exactly the boundary the transport split draws | Node.js 24, full Node API ([limits](https://vercel.com/docs/functions/limitations)). Effect v4 on Node is the least surprising runtime of the three; `@effect/platform-node` for the entry. Bun runtime available but beta. 2 GB / 1 vCPU standard, 4 GB / 2 vCPU optional ([memory](https://vercel.com/docs/functions/configuring-functions/memory)) | Bun, the runtime rulecheck is developed and tested with; `@effect/platform-bun` as in `src/main.ts`. Instance memory is not published (examples use 1 GB). Prisma's own account of Bun in production before the Rust rewrite (leaks, a pool that deadlocked after resume, [blog](https://www.prisma.io/blog/bun-rust-rewrite-prisma-compute)) says the runtime is young at this job |
| Long-running and bursty jobs | Queue consumer: 15 min wall clock, CPU configurable to 5 min per invocation, batches to 100, up to 250 concurrent invocations, 100 retries, dead-letter queue, `delaySeconds` up to 24 h ([Queues limits](https://developers.cloudflare.com/queues/platform/limits/)). Cron Trigger: 15 min wall. HTTP: no wall limit, CPU 5 min. One `sync-target` is seconds, so nothing here binds; the CPU meter (30 M CPU-ms included) is the one to watch for `js-tiktoken` | Function: 300 s default, 800 s max GA on Pro, 1,800 s in beta per function ([duration](https://vercel.com/docs/functions/configuring-functions/duration)). Billing is Active CPU (paused during I/O) plus Provisioned Memory for the whole instance lifetime including I/O waits ([pricing](https://vercel.com/docs/functions/usage-and-pricing)), so a job that waits on GitHub pays for 2 GB while it waits. Workflows lift the wall limit by splitting into steps | 60 s to first byte or the client gets a 504 and the request is cancelled ([request timeout](https://www.prisma.io/docs/compute/request-timeout)). Work longer than that must be acknowledged first and continued under `waitUntil` / `KeepAwakeGuard`, which are "best-effort": no durability, no retry, not guaranteed across restarts or deploys ([keeping instances awake](https://www.prisma.io/docs/compute/keeping-instances-awake)). Memory is billed while the instance is awake |
| Queue and scheduling primitives | Queues (GA): at-least-once, no ordering, no built-in deduplication ([delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)); one active consumer per queue. Cron Triggers (GA, 250 per account). Workflows (GA): durable steps, retries per step, unlimited wall time per step, instance IDs are unique so a second `create` with the same ID is refused, which is the idempotency hook; step billing from 2026-08-10, 500 k steps included ([pricing](https://developers.cloudflare.com/workflows/reference/pricing/)) | Queues (beta): at-least-once, approximate ordering, publish-side deduplication with an idempotency key for the message's TTL (billed 2× for that send), visibility timeout up to 60 min, delay up to 7 days, push to a function or poll ([concepts](https://vercel.com/docs/queues/concepts), [pricing and limits](https://vercel.com/docs/queues/pricing)). Workflows (GA): `'use workflow'` / `'use step'`, sleep, hooks, observability UI; idempotent start is a hook token checked inside the run today, an atomic keyed `start()` is experimental in the 5.0 beta ([idempotency](https://workflow-sdk.dev/docs/foundations/idempotency), [PR #2762](https://github.com/vercel/workflow/pull/2762)). Cron Jobs (GA): per-minute on Pro, invoke a function ([cron pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)) | No queue. Composer `cron` (Early Access) fires your service on an interval; `streams` is an append-only event log over object storage, not a work queue (no lease, no retry, no dead letter) ([building blocks](https://www.prisma.io/docs/composer/building-blocks)). The App would implement its own: a `jobs` table with `SELECT … FOR UPDATE SKIP LOCKED`, a cron tick that drains it under `waitUntil`, retries as rows. Idempotency is then a unique key on that table, which is clean; durability of an in-flight job across a deploy is not |
| Per-key serialization (one writer per installation) | Native. A Durable Object per installation is single-threaded by construction; `withWriteLock(fn)` on it is the D14 `Semaphore` with the same interface and no lock table, no lease expiry, no clock. Requests 1 M included then $0.15/M; duration 400 k GB-s included ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)) | No primitive. Options, all built in the App: a Postgres advisory lock held for the write (needs a session-mode connection, so the WebSocket `neon-serverless` driver rather than HTTP); a Workflows hook token per installation used as an in-flight mutex (the pattern Vercel documents, with the race resolved inside the run); a Queues consumer group at `max concurrency 1` serializes everything, not per key | No primitive. Postgres advisory lock or `SELECT … FOR UPDATE` on the installation row inside the job transaction; reliable and cheap because the database is in-region, but the lock holder is a best-effort background task that a deploy can interrupt mid-write |
| SQL database | D1 (GA): SQLite, 10 GB per database and the limit "cannot be further increased", one primary with optional read replication, Time Travel 30 days ([limits](https://developers.cloudflare.com/d1/platform/limits/)). Drizzle: native `d1` driver plus `drizzle-orm/effect-d1`; Alchemy applies `drizzle-kit` output on deploy ([D1 + Drizzle](https://alchemy.run/cloudflare/data/d1-drizzle)). Export is a SQLite dump; moving to Postgres is a dump, a type pass, and a load; the design already keeps the schema Postgres-portable. Hyperdrive to Neon or Prisma Postgres is the same-platform escape hatch | Neon (GA): Postgres with branching, scale-to-zero after 5 min, Free 100 CU-hours per project then Launch at $0.106/CU-hour and $0.35/GB-month ([plans](https://neon.com/docs/introduction/plans)). Drizzle `neon-http` / `neon-serverless`, `drizzle-kit migrate` over a direct connection. Portability: it is Postgres; `pg_dump` and leave | Prisma Postgres (GA): Postgres with pooling, per-operation billing (Starter 1 M ops then $8/M, Pro 10 M then $2/M). Drizzle over `pg` on pooled TCP; migrations over direct TCP. Portability: Postgres, `pg_dump`. A polling job runner and a daily rescan turn into operations, which is the meter that grows with installations here |
| Secrets and config | Per-Worker secrets (GA) set per Alchemy stage; account-level Secrets Store bindings in open beta ([Secrets Store](https://developers.cloudflare.com/secrets-store/integrations/workers/)). 128 env vars per Worker, 5 KB each | Environment variables per environment (production / preview / development), sensitive variables write-only, GA. Marketplace stores inject their connection strings | Environment variables per environment and Composer-declared `secrets` wired at deploy so services never read `process.env` ([Composer docs](https://www.prisma.io/docs/composer)) |
| IaC and preview environments | Alchemy: one `alchemy.run.ts` for Workers, Queues, Durable Objects, D1 (with migrations), Cron, secrets, domain; `plan` / `deploy` / `destroy`; stages (`prod`, `dev_<user>`, `pr-<n>`) namespace every resource; state in a Cloudflare-hosted store; `alchemy dev` emulates Queues, D1, DO, Cron locally (beta.68 notes). Beta, weekly releases, breaking changes possible. Fallback: `wrangler.jsonc` + `wrangler deploy` (GA, less code, hand-named environments) | Preview deployments per pull request are the platform's core feature (GA); `vercel.json` carries crons and function settings (framework-defined infrastructure also provisions Workflows and Queues); official Terraform provider for projects and environment variables ([guide](https://vercel.com/kb/guide/integrating-terraform-with-vercel)); Neon branch per preview through the Marketplace integration. Two consoles, one bill | `prisma.compute.ts` + GitHub Actions with OIDC, one preview environment (app and branched database) per branch, rollback from the Console (GA). Composer for the multi-resource topology (Early Access; a first deploy that fails before state is written leaves untracked resources, [core concepts](https://www.prisma.io/docs/composer/core-concepts)) |
| Observability | Workers Logs: 20 M events/month included then $0.60/M, 7-day retention ([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)); Logpush for longer retention; tracing in beta, billed into the same pool from 2026-10-01. Queue and DO metrics in the dashboard | Runtime logs 1 day on Pro; Observability Plus $1.20 per 1 M events for 30 days, queries, alerts ([Observability Plus](https://vercel.com/docs/observability/observability-plus)); Drains $0.50/GB; Workflows has a per-run trace UI | Deploy and runtime logs in the Prisma Console and CLI; no published retention, pricing, or alerting found on the docs surveyed |
| Lock-in and exit cost | Queue and lock semantics are Cloudflare's, wrapped behind `JobQueue` and `WriteLock`; job bodies are Effect programs and move as is. D1 is SQLite (dump + type pass to Postgres). Exit target: one Bun container (Fly.io or Compute) with the `Semaphore` and a Postgres job table. Medium | Functions are plain handlers; Workflow SDK is open source with a Postgres "World" for self-hosting; Queues API is Vercel's. Neon is Postgres. Low for data, medium for jobs | App is a Bun HTTP server: runs anywhere Bun runs. Postgres is Postgres. Composer topology is Prisma's but small. The job runner the App would build is ordinary SQL and moves with it. Low |
| Maturity and risk (GA vs not) | GA: Workers, Queues, Durable Objects, D1, Cron, Workflows, Workers Logs. Beta: Alchemy 2.0 (third party), Secrets Store, tracing. Risks: Alchemy churn on a solo schedule; the 128 MB ceiling if a customer's tree is huge (bounded by the per-repository snapshot design); Effect RC on `workerd` is less trodden than on Node | GA: Functions (to 800 s), Workflows, Cron, Neon, Terraform provider, Observability Plus. Beta: Queues, 30-minute functions, Bun runtime, atomic keyed workflow start. Risks: the per-installation lock is application code; two vendors for one job model (the D25-era design's reason for not choosing it) | GA: Postgres, Compute (since 2026-08-28). Early Access: Composer and its cron. Retiring: Accelerate. Risks: Compute GA is three weeks old and HTTP-first (60 s first byte, background work best-effort); Composer is pre-1.0 with an exact `effect` pin that collides with rulecheck's; no queue, so the App builds and operates one; single region per service |
| Developer velocity for a solo builder with agents | One language (TypeScript/Effect) from resource to handler; typed bindings; `alchemy dev` local emulation; agents already know Workers well. Debt: Alchemy API drift lands on the builder's plate | Highest: `vercel` deploy, previews for free, the Workflow SDK reads like async code, Node runtime means zero runtime surprises, the largest body of examples for agents. Debt: gluing lock and queue semantics out of Postgres or hook tokens, and a second console for the database | `prisma deploy` and per-branch previews are a good loop; Composer is agent-oriented by design (its skill ships in the package). Debt: writing the job runner, tracking daily Composer releases, pinning `effect` to whatever Composer needs that week |

## 4. Price at 10 / 100 / 500 installations

Assumptions, applied identically to every stack: 20 repositories per installation; one full
rescan per day (about 15 GitHub calls per repository, 2 s CPU and 30 s wall per installation);
20 default-branch pushes per day each rescanning one repository (0.1 s CPU, 3 s wall); one daily
dry run over 10 (repository, pack) targets (1 s CPU, 50 s wall); 50 dashboard requests per day.
Per installation that is about 100 inbound requests, 30 queue messages, 6 s CPU, and 150 s of
job wall time per day; 3,000 requests, 900 messages, 180 s CPU, and 1.25 wall-hours per month.
Storage: reports are keyed by (repository, sha), so a rescan of an unchanged repository adds no
row; about 20 KB × 20 repositories × 10 shas per 90 days ≈ 4 MB per installation, 2 GB at 500.
Rows: about 100 written and 1,000 read per installation per day. Job wall time is billed at 2 GB
on Vercel (standard instance) and 1 GB on Prisma (their pricing example size); Cloudflare does
not bill wall time on Workers. These are order-of-magnitude figures, not quotes.

| Installations | Cloudflare | Vercel + Neon | Prisma |
| --- | --- | --- | --- |
| 10 | **$5** (Workers Paid minimum; 30 k requests, 1.8 M CPU-ms, 27 k queue ops, 30 k D1 rows written, DO requests in the thousands: all inside included allowances) | **$20** (Pro; usage ≈ $0.06 active CPU + $0.27 provisioned memory + $0.02 invocations + $0.03 Queues, inside the $20 credit; Neon Free: 0.5 GB and 100 CU-hours cover a database awake a few hours a day). With Workflows instead of Queues: 9 k messages × ~6 events ≈ 54 k events ≈ +$1 | **$10** (Starter: 330 k Postgres operations of 1 M included, 30 k Compute requests of 5 M; memory 12.5 GB-h ≈ $0.08, CPU 0.5 vCPU-h ≈ $0.03). A 30-second cron poller keeps one 1 GB instance awake: +$4.40/month at every scale point |
| 100 | **$5** (300 k requests, 18 M CPU-ms of 30 M included, 270 k queue ops, 300 k rows written, 0.4 GB storage) | **≈ $36** (Pro $20; usage ≈ $0.64 CPU + $2.65 memory + $0.18 invocations + $0.27 Queues, inside the credit; Neon Launch: webhooks all day keep the 0.25 CU compute awake most hours ≈ 150 CU-h ≈ $16 + storage $0.15). With Workflows: 90 k messages ≈ 540 k events ≈ +$11 | **≈ $33** (Starter $10 + 2.3 M operations over the 1 M included × $8/M = $18.40 + Compute usage ≈ $1 + poller $4.40; Pro at $49 becomes cheaper once operations pass ~5.9 M) |
| 500 | **≈ $7** (1.5 M requests; 90 M CPU-ms: 60 M over × $0.02/M = $1.20; 1.35 M queue ops: $0.14; 1.5 M D1 rows written and 2 GB storage inside allowances; DO usage negligible; logs ≈ 4.5 M events of 20 M included) | **≈ $45–65** (Pro $20; usage ≈ $3.20 CPU + $13.25 memory + $0.90 invocations + $1.35 Queues ≈ $19, which the $20 credit absorbs if nothing else uses it; Neon Launch always awake ≈ 182 CU-h ≈ $19.30 + $0.70 storage; Observability Plus for 30-day logs ≈ +$5.40). With Workflows: 450 k messages ≈ 2.7 M events ≈ +$54 | **≈ $70** (Pro $49 + 6.5 M operations over 10 M × $2/M = $13 + Compute usage ≈ $5.40 + poller $4.40) |

Reading the table: Cloudflare's bill is flat because none of its meters (requests, CPU-ms,
queue operations, rows) moves at this volume and it does not charge for time spent waiting on
GitHub. Vercel's growth is Neon compute (a Postgres that never sleeps once webhooks arrive around
the clock) and provisioned memory during I/O; its Workflows product is priced per event ($20 per
million) and would be the largest single line at 500 installations, so the Vercel column assumes
Queues (beta) and shows Workflows as the increment. Prisma's growth is the per-operation database
meter, which a polling job runner feeds directly. Absolute differences are tens of dollars a
month; none of the three is chosen or rejected on price.

## 5. Recommendation

**Cloudflare, unless one of the following holds.**

1. The owner would rather own a job table and an advisory lock in Postgres than depend on
   Durable Objects and Queues. Then the Prisma stack (Bun, Effect on Bun, Postgres, one vendor)
   is the better fit, once Composer is out of Early Access or the App deploys with
   `prisma.compute.ts` alone and runs its scheduler from GitHub Actions.
2. Alchemy's beta churn costs more than a few hours a month. Then switch the tool, not the
   platform: `wrangler.jsonc` and `wrangler deploy` describe the same six resource types and
   are GA. This is the most likely condition to trigger and it is cheap.
3. A job needs more than 128 MB in one isolate or more than 15 minutes in one message. The design
   already prevents both (a message is one repository or one target), so this would be a design
   change, not a platform surprise.
4. Effect v4 on `workerd` shows a defect in the M1 spike (the transport split plus a
   `scan` over `snapshotFileSystem` inside a Worker). Then Vercel Functions on Node 24 are the
   nearest runtime with no such question; keep Neon and build the lock from a hook token or an
   advisory lock.
5. Customers ask for Postgres access to their history (BI, exports). Then move the database
   only: Hyperdrive to Neon or Prisma Postgres from the same Workers, Durable Object lock intact.

Why Cloudflare wins the default: it is the only stack where the two things the App must get
right, one writer per installation and idempotent at-least-once jobs, are platform primitives
(a Durable Object and a Queue) rather than code the App carries; every primitive it needs is GA;
its bill is flat at the target scale; and the reusable code already runs in that runtime with
one seam (`Bun.spawn`) the design isolates anyway. Vercel offers the smoothest developer loop
and the most conventional runtime but no lock primitive and a queue still in beta, with a
second vendor for the database. Prisma is the most interesting of the three for this codebase
(Bun and Effect v4 are its own foundation) and is not ready: Compute went GA three weeks ago,
Composer is Early Access with an `effect` pin the App cannot share, and the App would have to
build its queue.

## 6. What would make us switch

- **To Prisma:** Composer reaches GA with a work-queue module (lease, retry, dead letter) and a
  peer range for `effect` instead of an exact pin; Compute publishes memory and background-work
  guarantees (or a durable job primitive) and lifts the 60-second first-byte rule for
  non-HTTP triggers; the owner wants the database and the app on one vendor with Postgres.
- **To Vercel:** Vercel Queues reaches GA with a per-key ordering or a keyed lock, or Workflows
  ships atomic keyed `start()` at a per-message price; Neon becomes a requirement (branching per
  preview, Postgres exports); or Effect v4 on `workerd` proves unreliable while Node stays boring.
- **Off Alchemy, staying on Cloudflare:** two consecutive Alchemy releases break the stack file,
  or `alchemy dev` emulation diverges from production in a way that costs a debugging day.
- **Off D1, staying on Cloudflare:** a single installation's history approaches 10 GB, a second
  write region is needed, or a customer needs SQL access to their rows.

## Sources

Cloudflare: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Queues limits](https://developers.cloudflare.com/queues/platform/limits/),
[Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/),
[Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/),
[Workflows step billing changelog](https://developers.cloudflare.com/changelog/post/2026-07-07-workflows-billing-updates/),
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
[Traces](https://developers.cloudflare.com/workers/observability/traces/),
[Secrets Store](https://developers.cloudflare.com/secrets-store/integrations/workers/),
[`node:crypto` on Workers](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/).
Alchemy: [site](https://alchemy.run), [repository](https://github.com/alchemy-run/alchemy),
[D1 + Drizzle](https://alchemy.run/cloudflare/data/d1-drizzle),
[beta.68 notes](https://alchemy.run/blog/2026-08-06-beta-68/), npm `alchemy@2.0.0-beta.77`.

Vercel: [pricing](https://vercel.com/pricing), [limits](https://vercel.com/docs/limits),
[Hobby plan](https://vercel.com/docs/plans/hobby),
[Fluid compute](https://vercel.com/docs/fluid-compute),
[function duration](https://vercel.com/docs/functions/configuring-functions/duration),
[function limitations](https://vercel.com/docs/functions/limitations),
[Fluid compute pricing](https://vercel.com/docs/functions/usage-and-pricing),
[Queues](https://vercel.com/docs/queues), [Queues concepts](https://vercel.com/docs/queues/concepts),
[Queues pricing and limits](https://vercel.com/docs/queues/pricing),
[Workflows](https://vercel.com/docs/workflows), [Workflows GA post](https://vercel.com/blog/a-new-programming-model-for-durable-execution),
[Workflows pricing](https://vercel.com/docs/workflows/pricing),
[Workflow SDK idempotency](https://workflow-sdk.dev/docs/foundations/idempotency),
[Cron Jobs pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing),
[Bun 1.4 on Functions](https://vercel.com/changelog/bun-1-4-is-now-available-in-vercel-functions),
[Node.js 24 GA](https://vercel.com/changelog/node-js-24-lts-is-now-generally-available-for-builds-and-functions),
[Marketplace storage](https://vercel.com/docs/marketplace-storage),
[Observability Plus](https://vercel.com/docs/observability/observability-plus),
[Terraform provider guide](https://vercel.com/kb/guide/integrating-terraform-with-vercel).
Neon: [plans](https://neon.com/docs/introduction/plans),
[Vercel Postgres transition guide](https://neon.com/docs/guides/vercel-postgres-transition-guide),
[Drizzle with Neon](https://orm.drizzle.team/docs/connect-neon).

Prisma: [pricing](https://www.prisma.io/pricing),
[Compute pricing](https://www.prisma.io/docs/compute/pricing),
[Compute limitations](https://www.prisma.io/docs/compute/limitations),
[Compute request timeout](https://www.prisma.io/docs/compute/request-timeout),
[Keeping instances awake](https://www.prisma.io/docs/compute/keeping-instances-awake),
[Compute GA changelog](https://www.prisma.io/changelog/2026-08-28),
[Compute public beta post](https://www.prisma.io/blog/launching-prisma-compute-public-beta),
[Bun on Compute](https://www.prisma.io/blog/bun-rust-rewrite-prisma-compute),
[Composer](https://www.prisma.io/docs/composer),
[Composer core concepts](https://www.prisma.io/docs/composer/core-concepts),
[Composer getting started](https://www.prisma.io/docs/composer/getting-started),
[Composer building blocks](https://www.prisma.io/docs/composer/building-blocks),
[Composer repository](https://github.com/prisma/composer), npm `@prisma/composer@0.20.0`,
[Accelerate](https://www.prisma.io/docs/accelerate),
[Connect without Accelerate](https://www.prisma.io/docs/postgres/database/switch-from-accelerate).
Effect: [v4 RC announcement](https://effect.website/blog/releases/effect/40-rc), npm `effect` dist-tags.

## Decisions

Judgment calls made while writing this survey, with the search round in which no strictly better
option appeared.

| Decision | Chosen | Alternatives considered | Settled in round |
| --- | --- | --- | --- |
| Verdict | Cloudflare by default, with five named conditions under which another stack or tool wins | Vercel (best loop, but lock and queue are application code and a second vendor); Prisma (closest to the codebase, but three weeks GA, Composer Early Access, no queue); a hybrid (Workers compute with Neon or Prisma Postgres over Hyperdrive), kept as the database escape hatch rather than the default because D1 is enough at this size | 2 |
| How the Vercel column runs jobs | Vercel Queues (beta) as the primary, Workflows noted as the durable alternative and priced | Workflows as primary (GA, but $20 per million events is the largest line at 500 installations and a per-message price for what is a queue); Cron polling a Postgres job table (works, but then Vercel adds nothing over Prisma) | 1 |
| How the Prisma column runs jobs | A Postgres `jobs` table drained by a Composer `cron` tick under `waitUntil` | Composer `streams` as a queue (append-only log, no lease or retry); an external queue (Upstash QStash) (a third vendor, which is what the stack is supposed to avoid); GitHub Actions `schedule` calling the App (no Composer dependency; kept as the fallback in condition 1) | 2 |
| Per-key lock on Vercel | Advisory lock over a session connection, with the Workflows hook-token mutex as the documented alternative | Upstash Redis lock (a fourth service); Queues consumer at max concurrency 1 (serializes every installation, not one) | 1 |
| Workload model for prices | 20 repositories per installation, one daily rescan, 20 pushes, one dry run of 10 targets, 50 page views; wall time billed at the platform's standard instance | A range per scale point (three numbers per cell, harder to compare); the App design's 200-repository organization as the unit (a large customer, not the median) | 1 |
| Where the document lives and what it changes | `docs/platform-comparison.md`, listed in `AGENTS.md` Layout; no `decisions.md` entry because it changes nothing rulecheck writes or reports, and the hosting row already exists in the App design's decisions table | A D26 entry (the recording rule in `decisions.md` is for changes to what rulecheck writes or reports); a section inside `app-design.md` (that file is on an unmerged branch in PR #26) | 1 |
| Treatment of Prisma Accelerate | Verified and marked retiring and irrelevant (Drizzle, no cache need) rather than compared feature by feature | A full column row for it (it is not a hosting component); omission (the question asked for it by name) | 1 |
| Linking to `app-design.md` | Plain path and a link to PR #26, not a relative Markdown link | A relative link (broken on `main` until #26 merges) | 1 |

**Structural check.** The constraint that generates most rows is "one writer per installation,
idempotent jobs, nothing to babysit." It dissolves only where the platform holds the lock and
the queue for you; on Vercel and Prisma the App carries them, so the question "is Cloudflare
right" reduces to "is a Durable Object a better lock than one we write," and at this scale, for
one person, it is. The residual risk on Cloudflare is tooling (Alchemy) rather than platform, and
that risk has a GA fallback on the same platform, which is why the recommendation's most likely
exit is a tool swap, not a migration.

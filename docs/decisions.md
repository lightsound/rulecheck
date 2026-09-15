# Decisions

Dated record of design decisions for rulecheck and the personal/team instruction layout it
supports. Newer entries supersede older ones where they conflict; superseded entries stay here
with a pointer. Facts about tool behavior live in [tool-behavior.md](tool-behavior.md).

## 2026-09-14 D1: Start read-only

rulecheck scans and reports; it does not write to scanned repositories. Structural fixes come later
as explicit, deterministic commands; content authoring is never in scope. Reason: understand the
real state of ~76 repositories before automating anything.

## 2026-09-14 D2: `AGENTS.md` is canonical, `CLAUDE.md` is `@AGENTS.md`

Every tool reads `AGENTS.md`; Claude Code resolves the `@` import; a prose pointer ("see
AGENTS.md") loads nothing. Tool-scoped rules go in `.cursor/rules/*.mdc` or `.claude/rules/*.md`.

## 2026-09-14 D3: Personal pack in a private repo, wired by import and User Rule (superseded by D5, D6, D13)

`lightsound/agent-rules/AGENTS.md` as the single personal source. Claude Code:
`~/.claude/CLAUDE.md` imports it. Cursor: a User Rule copy, synced with `/sync-agent-rules`
(after a one-day detour through `~/AGENTS.md`, which Cursor loads by an undocumented ancestor walk
but which never reaches Cloud Agents). Superseded because it assumes the agent runs on the
developer's machine.

## 2026-09-15 D4: Cloud-first changes the distribution unit to the repository

Nine tenths of development runs in cloud agents. Cursor Cloud Agents receive User Rules; Claude
Code on the web has **no per-user channel** at all (only the repo clone and organization
server-managed settings). Therefore shared rules are delivered as a **managed block** inside each
repository's `AGENTS.md`:

```
<!-- agent-rules:begin source=<pack-id> rev=<git sha> hash=<sha256 of body> -->
...
<!-- agent-rules:end -->
```

Considered and rejected: cloud setup scripts writing `~/.claude/CLAUDE.md` (unverified, fragile,
Claude-only); submodule/subtree plus `@import` (Cursor does not resolve imports); separate
`.claude/rules` + `.cursor/rules` copies (two copies per repo, other tools miss them).

Principle: when the agent runs on a fresh clone, the repository is the only reliable input.
Treat shared rules as a distributed artifact with a source, a revision, drift detection, and an
update path, the way Renovate treats dependencies.

## 2026-09-15 D5: Two layers instead of "personal": portable pack and machine layer

Content is placed where it is true.

- **Pack**: environment-neutral rules distributed into repositories (D4). Must not reference
  machine paths or commands that do not exist in the target repository; rulecheck's rot detection
  applies to the block like any other text.
- **Machine layer**: facts about one machine (`~/ghq` layout, where rulecheck lives). Stays in
  `~/.claude/CLAUDE.md` (and, if wanted, `~/AGENTS.md` for Cursor local). Never distributed,
  correctly absent in the cloud. rulecheck **reports** this layer but does not manage it.

Once a repository carries the block, the `~/.claude` import of the pack and the Cursor User Rule
copy are removed so that nothing loads twice. Response language for local sessions in third-party
repositories can come from Claude Code's `language` setting instead of a memory file.

## 2026-09-15 D6: Sync targets the remote, through pull requests

The sync writes to the **remote repository** (branch + commit + PR via the GitHub API), never to
local checkouts. Reasons: cloud agents clone the default branch, so a rule reaches them only after
merge; local checkouts get it through normal `git pull`; teams need review. Auto-merge is a
per-repository option, **off by default**; it suits solo repositories only. Distribution status
(current / outdated / modified / eligible / blocked / not subscribed) is a first-class report, per
repository with `file:line`.

Order of operations for every sync is measure, then write: rot detection runs on the pack against
the target repository before a PR is opened, and a pack that references a command or path missing
there is blocked, not distributed.

Confirmed 2026-09-15 that this matches the intended product: author a pack in a web or desktop
app, select repositories, press sync, receive PRs (or auto-merge where enabled). `rulecheck scan`
is the backend of the status view.

Shape normalization is a prerequisite and is itself a PR: deterministic cases (`none`,
`AGENTS.md only`, `CLAUDE.md only` via rename, reversed canonical) are automated; `both have
content` and files carrying another tool's managed markers are reported for a human (`both have
content` is automated since D12; the marker case stands).

Opt-in is per repository and explicit; ownership is not inferred from the GitHub owner because
committing rules to a shared repository makes them team rules.

## 2026-09-15 D7: Multiple named packs

A team has more than one shared rule set. Vocabulary: a **pack** is a named `AGENTS.md` fragment
(`base`, `frontend`, ...); a **subscription** is the relation repository ↔ pack, zero or more per
repository; each pack is its own managed block identified by `source=<pack-id>`. Block order in
the file is the subscription order. Conflicts between packs are content, not
structure, and are out of scope for automation (a lint may point them out later).

## 2026-09-15 D8: Scope is the agent configuration surface; Rules and Skills first

Scope is the whole agent configuration surface: Rules, Skills, MCP, Hooks, Subagents/Commands.
Delivery order is developer productivity first: Rules, then Skills, then MCP/Hooks. MCP and Hooks
are **governance targets** (inventory, allow/deny, required), not pack-distribution targets,
because they carry secrets and execution rights.

The pack unit is generalized from "an `AGENTS.md` fragment" to **a set of files**: Skills are
distributed as directories (`.cursor/skills/<name>/SKILL.md`, `.claude/skills/<name>/`), so a pack
may contain a managed block for `AGENTS.md` plus whole managed files. D7's vocabulary (pack,
subscription, `source=`) is unchanged.

Skills drift is reported by reading the de-facto standard `skills-lock.json` (vercel-labs/skills;
source + hash per skill). rulecheck defines no manifest of its own.

Not built: single-repo lint rule catalogs (agnix and similar; recommend or invoke them instead),
tool-format expansion (`ruler`, `rulesync`; D2 makes it unnecessary), and PR plumbing beyond
`gh api` / `multi-gitter`. Rationale and the survey behind it: [landscape.md](landscape.md).

## 2026-09-15 D9: Marker syntax and body hash, fixed for the reader before the writer exists

D4 gave the marker shape without pinning what `hash=` covers. The Step 2 reader fixes it, so that
the Step 3 writer produces blocks the reader already classifies correctly:

- Markers occupy a whole line. `source=` and `hash=` are required, `rev=` is optional (the pack
  repository's full HEAD sha; displayed short). Unknown `key=value` attributes are ignored, values
  may be quoted. Blocks do not nest; an unpaired `begin` or `end`, or a `begin` without `hash=`, is
  a malformed marker with `file:line`, and the surrounding text is not a block.
- `hash=` is the sha256 of the body with `\r\n` normalized to `\n` and surrounding blank lines
  trimmed. Reason: `autocrlf` and editors that add or drop a final newline must not turn a
  distributed block into `modified`; `modified` is reserved for an edit a human made.
- Status precedence per repository per pack: a block with `source=<pack>` in the root
  `AGENTS.md` / `CLAUDE.md` decides, regardless of subscription: `modified` if the body hash
  differs from `hash=`, else `current` if `hash=` equals the pack's current hash, else the block
  is outdated and an update is pending; if the file carrying it also has a malformed or foreign
  marker the row is `blocked` (the rewrite would land inside a file another tool or a broken
  marker owns; the message names the pending update), otherwise `outdated`. Without a block:
  `not subscribed`, or for subscribers `blocked` (a foreign/malformed marker in a root file the
  sync would write; `both have content` blocked too until D12) else `eligible`. `blocked` therefore appears
  exactly where a write is pending, so every write is gated by "a human looks first" (D6), and
  `current` / `modified` rows stay quiet about markers (the repository's own `!` line and
  `totals.malformedMarkers` carry them). Comparison is by hash, not `rev`: a pack commit that
  touches other files leaves subscribers `current`.
- Foreign markers: a single-line HTML comment containing `managed`, `generated`, `autogenerated`
  or `do not edit`, or starting with `BEGIN` / `END` in capitals. Only root-pair files are
  checked, and only files the normalization would rewrite block insertion (a marked `CLAUDE.md`
  wrapper next to a canonical `AGENTS.md` does not). Revised by D15: well-formed marker pairs
  are opaque regions and no longer block; unpaired, nested, and file-level markers still do.

Skills (D8) get no finding for a hash mismatch against `skills-lock.json`. rulecheck's
`computeSkillHash` is the same algorithm as `computeSkillFolderHash` in `vercel-labs/skills`
(paths sorted with `localeCompare`, path then bytes per file, `.git` and `node_modules` skipped),
but `npx skills add` records the hash of the *downloaded source snapshot* ("blob snapshot or
folder hash", `src/add.ts`), before the installer drops `metadata.json` and dotfiles on copy
(`EXCLUDE_FILES` in `src/installer.ts`; vercel-labs/skills#806), and `core.autocrlf` changes the
bytes on Windows checkouts (#781). Observed 2026-09-15: an installed skill byte-identical to its
upstream still differed from its lock entry. So a mismatch does not prove drift; the state is
shown per skill (`matches lock`, `lock hash differs`, `no lock entry`) and the one finding is a
lock entry whose directory is missing and not gitignored.

## 2026-09-15 D10: First write path, `rulecheck sync`: remote only, measured twice, one branch per pack

D1 said "read-only until an explicit decision". This is that decision. rulecheck gains one write
command, `sync <owner/repo> --pack <id> --packs <source>`, and it writes to exactly one place.

**What is written, where.** Through the GitHub API (`gh api`, so authentication stays with the
GitHub CLI and rulecheck holds no token): one commit on top of the target's base branch head that
contains the normalized root pair (`AGENTS.md` carrying the pack's block, `CLAUDE.md` containing
`@AGENTS.md`), pushed to the branch `agent-rules/<pack-id>`, and one pull request from that
branch. Nothing is written to a local checkout, to `~/`, or to the pack repository (D6).
Auto-merge is not implemented; it stays a per-repository opt-in for a later step (D6, default off).

**Preconditions, all checked against the remote tree at the base sha.** The target is treated as
a filesystem (below) and `scan` runs on it unchanged, so the status is the one the report shows:

1. The repository appears in the pack's `subscriptions.json` list, or already carries the block.
   `not-subscribed` refuses: opt-in is explicit (D6).
2. The status is `eligible` or `outdated`. `current` is a no-op that exits successfully;
   `modified` refuses (a human edited the body; overwriting is not rulecheck's call); `blocked`
   refuses with the `file:line` of the reason (D9).
3. Measure after write: the planned tree (base tree plus the changes) is scanned again. The pack
   status there must read `current` (writer and reader agree) and no reference finding
   (`unknown-script`, `missing-path`) may appear that the base tree did not have. A new finding
   refuses with its `file:line` in the planned file: the pack would introduce rot in that
   repository (D5, D6 "measure, then write").
4. Every path the plan writes is either absent or the recognized input of the normalization (the
   content file, the wrapper). Anything else, for example both `CLAUDE.md` and
   `.claude/CLAUDE.md` present, refuses instead of overwriting.

`--dry-run` runs every step including both measurements and prints the diff; it issues no
write call. The same code path runs with or without the flag, so a dry run exercises exactly
what a real run would do.

**Plan.** Deterministic shapes (D6) are normalized in the same commit: `none` creates both files;
`agents-only` appends the block and adds the wrapper; `agents-canonical` appends the block;
`claude-only` moves the content into `AGENTS.md`, appends the block, and turns `CLAUDE.md` into
the wrapper (a `.claude/CLAUDE.md` content file is removed and a root wrapper created);
`claude-canonical` swaps the pair the same way. Project-specific content comes first; blocks
follow in the order of the pack ids in `subscriptions.json` (D7), so a new block is inserted
before the first existing block of a later pack and otherwise appended. An `outdated` block is
replaced in place, wherever it is. The block is written as D9 specifies, with `rev=` set to the
pack repository's commit sha.

**Branch ownership.** `agent-rules/<pack-id>` is a tool-owned branch: a rerun force-updates it
to a fresh commit on the current base head and reuses the open pull request if there is one
(Renovate model). Ownership is verified, not assumed: the branch is rewritten only when its tip
commit message starts with `chore(agent-rules):`, the prefix every rulecheck commit carries. A
branch of that name whose tip a human or another tool wrote refuses with the commit sha, before
any write. The pull request body says the branch is rewritten and points at the pack as the
place to edit. Consequence: one repository, one pack, one branch, one pull request; two packs in
one repository are two pull requests.

**A remote repository is a filesystem.** The git tree of a repository at a commit is presented
as a read-only `FileSystem` layer (`src/github/fs.ts`), mounted at `/github.com/<owner>/<repo>`
so `displayName` yields `owner/repo`, with a synthetic `.git/HEAD` holding the commit sha so
`walk` sees a repository and `loadPacks` sees a `rev`. `scan`, the reference check, the block
parser, and `loadPacks` run on remote data without a remote-specific branch in their code. The
same layer serves `--packs owner/repo[@ref]`, which resolves the Step 2 carry-over (remote pack
source, D6); the local directory form stays because it costs nothing. Measure-before-write and
the read-only report are therefore the same code by construction, not by discipline.

**Code placement.** `src/github/` holds the GitHub client service (interface, errors, live layer
over `gh api`) and the filesystem view; both `scan` (read) and `sync` (write) use it, and tests
substitute an in-memory layer, never a real repository. `src/sync/` holds the orchestration and
is the only directory that issues writes. `src/domain/sync.ts` (plan, block rendering, pull
request text) and `src/domain/diff.ts` stay pure. `src/scan/` remains read-only.

**Not in this step.** Whole managed files in a pack (D8 `file` entries) are inventoried by scan
but not written; nested `AGENTS.md` blocks are not touched; the pack `AGENTS.md` in
`lightsound/agent-rules` is not yet wrapped in its own markers (both marker-wrapped and bare
bodies are read; settled by D11: it stays bare); no fan-out (`--all`, Step 5, now D14, which also
replaces the unconditional rerun force-push above with a content check).

## 2026-09-15 D11: Pack sources stay unwrapped; markers are rendered at sync time

Step 1 deferred wrapping `packs/<id>/AGENTS.md` in its own `agent-rules:` markers so that "the
file is the block". Decided against it at the first live sync: `hash=` is derived from the body
and `rev=` is the pack repository's HEAD, which a file cannot contain for the commit that
includes it. Storing derived values in the source means hand-maintaining a hash that drifts,
which is the very state rulecheck exists to detect. So the pack file is the bare body,
`packFromFiles` computes the hash from it, and `renderBlock` writes the markers at sync time
(D9 syntax, D10 `rev=`). The reader keeps accepting a wrapped pack file (first block's body), so
a pack repository that wants visible markers may still carry them at its own risk. Consequence:
what a subscriber's `AGENTS.md` shows between the markers is the pack file verbatim after body
normalization, and `packs/<id>/AGENTS.md` is also what `~/.claude/CLAUDE.md` imports and the
Cursor User Rule copies, without comment lines.

## 2026-09-15 D12: `both have content` is normalized by the sync, not handed to a human

D6 and D9 left the `both-full` shape (`AGENTS.md` and `CLAUDE.md` both carry content) `blocked`:
"decide which one is canonical first". The decision is already made by D2, `AGENTS.md` is
canonical, so the only open question was what to do with the text in `CLAUDE.md`, and that has a
deterministic answer that loses nothing. `both-full` is therefore `eligible`, and the sync commit
normalizes the pair in one of two ways, chosen from the files' content:

- **wrapper**: the text `CLAUDE.md` adds beyond an `@AGENTS.md` import line (line endings
  normalized, surrounding blank lines trimmed; an import line inside a code fence is prose and
  stays) is empty or appears verbatim as a substring of `AGENTS.md` outside its managed blocks.
  `CLAUDE.md` becomes exactly `@AGENTS.md`; nothing else moves. Verbatim containment is the test,
  not a line set or a similarity score: dropping a file is only safe when every byte of it
  provably survives, so a reordered or reworded copy is merged instead (precision over recall, as
  for findings). Block bodies do not count as survival because they belong to a pack and are
  replaced whole on its next update.
- **merge**: otherwise the same text is appended to `AGENTS.md` under the heading
  `## Merged from CLAUDE.md`, placed before the first managed block so project text stays ahead
  of distributed text (D10), then `CLAUDE.md` becomes `@AGENTS.md`. The text is copied verbatim;
  duplicates and contradictions with the text above it are left for the pull request review,
  which is where such conflicts already go under the Renovate model (D6). Semantic merging is
  content authoring and stays out of scope (D1).

The `eligible` row names the normalization it will apply, the pull request body and commit
message name the one that was applied, and `scan --json` carries it as `bothFull` per repository.
`blocked` keeps its two remaining reasons: a foreign or malformed marker in a root file the sync
would rewrite (D9; for `both-full` that is both files, as for every shape change) and the
preconditions D10 lists (two `CLAUDE.md` files, files contradicting the shape). Measure after
plan is unchanged: the planned tree must read `agents-canonical` and `current`.

One reader change follows: the "new finding" check treats the root pair (`AGENTS.md`,
`CLAUDE.md`, `.claude/CLAUDE.md`) as one file when comparing findings, but only for plans that
move text between files of the pair (`claude-only`, `claude-canonical`, and now the merge).
Moving text from `CLAUDE.md` into `AGENTS.md` carries any rot that text already had into a
different file of the pair, and that rot is the repository's, not the pack's. Where nothing
moves (an `outdated` block being replaced, a plain insert into a canonical `AGENTS.md`), each
file keeps its identity, so a stale reference sitting in `CLAUDE.md` does not excuse the same
reference in a new block body. Files outside the pair always keep their own identity: a stale
reference in a nested `AGENTS.md` or a rule file does not excuse the same reference inside the
block.

A `CLAUDE.md` that is an `@AGENTS.md` line plus up to three short lines is still a wrapper to the
scanner (`agents-canonical`), so those lines are not merged; that threshold predates this decision
and is unchanged here.

## 2026-09-15 D13: The Cursor User Rule copy of the pack is retired, not automated

D3 wired the pack into Cursor as a User Rule copy refreshed by a slash command
(`/sync-agent-rules`), the one manual step left in the distribution. The question was whether to
automate it. Researched 2026-09-15 against Cursor's published docs (facts and sources in
[tool-behavior.md](tool-behavior.md), "User Rules have no headless write path"): User Rules live in
the Cursor account, are edited only in Customize → Rules or by the in-app agent, are absent from
the Admin API (it logs `team_rule` events and exposes `/grok-bot/team-rules`, a team-plan
surface documented for the review bot; nothing addresses a user's rules), absent from the
`agent` CLI (`generate-rule` writes a project `.mdc`), and their legacy on-disk mirror
(`state.vscdb`, key `aicontext.personalContext`) is declared stale by Cursor staff now that the
account is authoritative. Team Rules need a team plan and admin rights and are Cursor-only, so
they are no channel for a personal pack either. So option (c), a headless `sync-user-rule`, has
no supported target, and option (b), drift detection against an on-disk copy, has no safe file
to read.

The structural answer is already in D4 and D5: the repository is the only input every agent
shares, so the pack reaches Cursor, local and cloud, through the managed block in each
subscribed repository's `AGENTS.md`, which Cursor always applies and ranks above User Rules
(Team → Project → User). A User Rule copy is therefore redundant wherever the block is present
and loads the pack twice there; it adds value only in unsubscribed repositories and in chats
without a repository. Keeping a synced copy for those cases would preserve the manual step for a
shrinking benefit. Decision:

- The pack is **not** kept in a User Rule. Once the block covers the repositories used daily
  (roadmap Step 4), the User Rule copy and `/sync-agent-rules` are deleted. An unsubscribed
  repository that should have the pack is subscribed and synced, not covered by a copy.
- A User Rule may still exist, hand-written, for **account-level preferences that are not pack
  content** (for example the reply language for chats outside any repository). It is never
  generated from the pack, so nothing needs syncing. Same rule for the machine layer: facts about
  one machine stay in `~/.claude/CLAUDE.md` (D5); rulecheck does not manage either.
- No `.cursor/rules/*.mdc` copy of the pack is added to repositories: an `alwaysApply: true`
  rule and the root `AGENTS.md` are applied in the same way by Cursor's local and cloud agents,
  and the block already lives in a file every other tool reads (D2).
- rulecheck does not read Cursor's storage or write to it. What it adds is the read-only check
  that makes the removal verifiable: when the personal layer is scanned together with `--packs`,
  a personal file that equals a pack body, or that is the pack's own source path
  (`packs/<id>/AGENTS.md`) with a different hash, is reported under the pack with the
  repositories in which the pack now loads twice (`personalCopies` in `scan --json`). Two exact
  signals, no similarity guess, following the precision rule for findings. The bound that buys:
  a pack pasted inside a larger personal file, or wrapped in a managed block there, is not
  reported, so an empty `personalCopies` is necessary for the removal, not sufficient; the probe
  run in roadmap Step 4 is what confirms that nothing loads twice.

Considered and rejected: a Cloud Agent environment symlink `/.cursor -> ~/.cursor` plus an
install script that clones the pack (a staff-acknowledged workaround for the rules lookup; per
environment, needs a token for a private pack repository, and the roadmap excludes setup-script
hacks); a Cursor plugin carrying the pack as a rule (client install, Cursor-only, update
semantics undocumented, and it would double-load next to the block); a record file written by
the slash command for rulecheck to compare (keeps the manual step alive to measure it).

## 2026-09-15 D14: `sync --all`: fan-out over subscriptions, per-target isolation, exit code by knowledge

D10 built the path for one repository and one pack. Step 5 runs it for every subscriber. The
fan-out is the same `sync` command with `--all` instead of a repository argument, not a new
command: the one write surface stays one (`sync`), and `--dry-run` keeps its meaning (every check,
no write). `--pack <id>` narrows the run to one pack; without it every pack in `subscriptions.json`
runs. `--base` is refused with `--all`: each subscriber is synced on its own default branch.

**Targets.** One target per (`owner/repo`, pack) pair listed in `subscriptions.json`, in file
order, pack by pack. A repository under two packs is two targets and two pull requests (D10). A
repository that carries a block without being subscribed is not a target: the fan-out has no tree
to discover it from, and `scan --packs` over a checkout still reports it.

**Isolation.** Each target runs the unchanged single-target path (`syncTarget`), measure then
write, and its outcome is one row. A refusal (`modified`, `blocked`, rot the block would introduce,
a foreign `agent-rules/<pack>` branch, a planned tree that does not read `current`) is a row that
names the `file:line`, and the run continues. So is a GitHub error. Nothing aborts the others.

**Exit code.** The run exits 1 only when at least one target's outcome is unknown: GitHub could
not be read or written (404, 401, network, `gh` missing). Refusals exit 0. Principle: the exit
code says whether the report is complete, not whether every repository is in the desired state;
the rows say that. A refusal is rulecheck's answer for that repository (a human must look), and
answering is success. An unknown outcome means the report is missing a row's truth, which a
script chaining on the command must not mistake for "nothing to do". No retry or backoff is
built in: a `failed` row may be transient (a secondary rate limit, a 5xx), and the answer is to
run the command again, which the idempotence below makes cheap because every target that was
delivered reads `current` or `up to date` and issues no write. Retries move inside the `GitHub`
layer if a real run over tens of repositories shows them necessary.

**Idempotence by content, default branch first.** A rerun must not push again when nothing is
left to deliver. The single-target path already measures the default-branch HEAD before anything
else, so a block that merged (by squash or otherwise, so the merged content is on the default
branch and not on `agent-rules/<pack>`) reads `current` and the tool-owned branch is never
consulted. When the base still needs the block, the tool-owned branch is left alone if its tip
commit is rulecheck's, every planned path reads at the tip exactly as the plan would write it, and
a pull request from the branch is open; the row says `up to date (PR #n open)`. The key is the
planned content, not the pack `rev` or the branch's parent: if the default branch changes the
file the plan rewrites, the plan changes and the branch is force-updated onto the new base; if it
changes other files, the delivered content is the same and the open pull request still merges. A
closed pull request or a tip with other content falls through to the D10 rewrite. This applies to
`sync <owner/repo>` too: one code path, so a single rerun is as quiet as the fan-out.

**Concurrency.** Targets run up to three at a time (`Effect.forEach` with `concurrency: 3`); the
write calls (tree, commit, ref, pull request) of every target pass through one semaphore with one
permit, so at most one target writes at any moment. GitHub's secondary rate limit guidance asks
that content-creating requests not be issued concurrently; reads are fine in parallel, and three
keeps a run over tens of repositories short without a flag nobody would tune.

**The remote report.** `scan --packs` measures the checkouts under a directory, so it reflects
whichever branch or working-tree state each checkout has; two repositories were observed reading
`eligible` locally after their pull requests had merged, because the checkouts were on other
branches. The distribution status that decides anything is the default-branch HEAD on GitHub,
which is what every target of `sync --all --dry-run` measures. That table (repository, pack,
remote status, planned action with `+N -M`) is therefore the distribution report, and no separate
`status` command is added: it would compute the same rows through the same path, and a dry run
of the write is already the definition of "what is the state, what would change".

## 2026-09-15 D15: Paired foreign markers are opaque regions, not a reason to block

D9 blocked every root-pair file that carried another tool's marker. Observed in
`lightsound/cobracket`: `AGENTS.md` holds four such pairs (`<!-- generated:task-matrix:start -->`
… `:end`, `<!-- solid2-agent-kit:agents-section:start -->` … `:end`, `<!-- fallow:setup-hooks:start -->`
… `:end`, `<!-- convex-ai-start -->` … `<!-- convex-ai-end -->`), each owned by a generator that
rewrites its own region and nothing else. Appending our block after them changes none of their
bytes, so blocking there asked a human to look at nothing. Revised rule:

- **Region markers** are single-line HTML comments in one of two vocabularies: a comment starting
  with `BEGIN` / `END` in capitals (`<!-- BEGIN_TF_DOCS -->`, `<!-- END: foo -->`), or a comment
  whose last token is `start` / `begin` / `end` joined to a name by `:`, `-` or `_`
  (`<!-- generated:task-matrix:start -->`, `<!-- convex-ai-end -->`). The name is the comment
  text without the token, compared case-insensitively. A `start` followed by the `end` of the same
  name, with no other region marker between them, is a **well-formed region**.
- A well-formed region is **opaque**: rulecheck never reads or writes inside it. No region marker
  inside it is read, and a file-level marker inside it is opaque when it names the region's owner:
  a word of the region name appears as a whole word in the marker, and only words that can
  identify a tool count. The file-marker vocabulary (`managed`, `generated`, `auto`, `edit`, …),
  the names of the files rulecheck manages (`agents`, `claude`), and words that describe a marker
  or a span rather than a tool (`file`, `block`, `section`, `region`, `import`, `install`,
  `rules`) never count, nor do words under three characters. So "Managed by solid2-agent-kit
  v0.11.1. Do not edit inside this block" inside `solid2-agent-kit:agents-section` describes the
  region (`solid2`), while "Generated by Skiller" inside `generated:task-matrix` and "Do not edit
  AGENTS.md by hand" inside `stripe-projects-cli managed:agents-md` share only excluded words. A
  file-level marker inside a region that does not name its owner may belong to a third tool
  marking the whole file, and blocks as it did under D9: the pair shape alone does not buy
  opacity for someone else's marker. Inserting our block outside the regions (append at the end
  of the file, after the last region; or replace our own existing block) is allowed, and the row
  reads `eligible` / `outdated` as usual, with the number of regions left untouched named in the
  message. Names ending in `ignore` or `disable` (`prettier-ignore-start`) are formatter or
  linter directives about a span, not ownership, and are not region markers. Lines inside our
  own `agent-rules` blocks are never read for markers: a pack body may quote marker-shaped
  comments.
- Everything that is not a well-formed region keeps the file `blocked` with `file:line`: a
  `start` without its `end` or an `end` without its `start`, a `start` inside an open region
  (nested regions are not supported; the outer tool owns the inner marker and we cannot tell
  which one), an `end` whose name does not match the open region, and a **file-level marker**, a
  single-line comment containing `managed`, `generated`, `autogenerated` or `do not edit` that is
  not a region marker (`<!-- Generated by Skiller -->` at the top of a file means the whole file
  is generated).
- Regions stay in the file they are in. A plan that would move or drop a file holding a region
  (`claude-only` and `claude-canonical` move `CLAUDE.md` into `AGENTS.md`; `both-full` turns
  `CLAUDE.md` into the wrapper, merging or dropping its text; `claude-canonical` replaces the
  `AGENTS.md` wrapper) is `blocked` at the region's first line: the generator that owns the region
  writes to the file it knows, and a copy elsewhere would be duplicated on its next run. The D12
  merge therefore never moves text into or out of a region, and text of `CLAUDE.md` that appears
  in `AGENTS.md` only inside a region does not count as surviving (as for pack blocks). Where
  `AGENTS.md` ends with a region, merged text and the block are appended after the region's end
  marker. An `outdated` block that sits inside a region is `blocked` too: replacing it would write
  inside the region.
- Two assertions guard the promise. The planner compares the regions of every file it rewrites
  before and after (same names, same order, same bytes) and refuses on any difference; the
  measure-after step in `sync` repeats the comparison on the planned tree. Both run on every sync,
  including `--dry-run`.

`scan --json` carries the regions per repository (`foreignRegions`: file, name, lines) and the
text report lists them next to the managed blocks. The marker vocabulary above replaces D9's
"single-line comment containing a foreign word or starting with `BEGIN` / `END`" as the
definition of a foreign marker; D9's status precedence is otherwise unchanged.

## Recording rule

Add an entry here whenever a decision changes what rulecheck writes, what it reports, or which
layer a kind of content belongs to. Add a fact to `tool-behavior.md` whenever a decision depends
on how a tool behaves.

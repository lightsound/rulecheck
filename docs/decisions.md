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
`AGENTS.md only`, `CLAUDE.md only` via rename (D17 names it `move`), reversed canonical) are automated; `both have
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
Delivery order is developer productivity first: Rules, then Skills (distribution deferred by
D18; the inventory stands), then MCP/Hooks. MCP and Hooks are **governance targets** (inventory,
allow/deny, required), not pack-distribution targets, because they carry secrets and execution
rights.

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
but not written (deferred indefinitely by D18); nested `AGENTS.md` blocks are not touched; the
pack `AGENTS.md` in `lightsound/agent-rules` is not yet wrapped in its own markers (both
marker-wrapped and bare bodies are read; settled by D11: it stays bare); no fan-out (`--all`,
Step 5, now D14, which also replaces the unconditional rerun force-push above with a content
check).

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

- **wrapper** (renamed `drop` by D17): the text `CLAUDE.md` adds beyond an `@AGENTS.md` import line (line endings
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
message name the one that was applied, and `scan --json` carries it as `bothFull` per repository
(since D17: `normalization`, on every repository).
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
and is unchanged here. Revised by D16: a `CLAUDE.md` of any length that holds an `@AGENTS.md`
line outside fenced code is `agents-imported` and left untouched, so the two normalizations above
apply only to a `CLAUDE.md` without an import line.

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

## 2026-09-15 D16: A `CLAUDE.md` that imports `AGENTS.md` is canonical in effect, whatever else it holds

D2 set the convention, `AGENTS.md` canonical and `CLAUDE.md` exactly `@AGENTS.md`, and the reader
took the second half literally: only a `CLAUDE.md` of at most four short lines counted as the
wrapper, everything longer was `both-full`, and D12 then merged its text into `AGENTS.md` and
replaced it with the one-line wrapper. Observed in `lightsound/cobracket`: `CLAUDE.md` is 420
lines, four of them a project intro and the rest three regions of other tools (D15), one of
which, `fallow:agent-install`, consists of the single line `@AGENTS.md`; the repository's own
`AGENTS.md` says "Do not merge the two files or delete either." The pair was `both-full`, the
merge would have rewritten a file holding regions, so the row read `blocked` at `CLAUDE.md:9`
and asked a human to do something the repository forbids.

The requirement behind D2 is that Claude Code loads `AGENTS.md`, not that `CLAUDE.md` is one
line: Claude Code resolves an `@AGENTS.md` line wherever it sits in the file, and it does not
evaluate imports inside markdown code spans and code blocks ([tool-behavior.md](tool-behavior.md)).
So the shape is decided by the presence of the import line, not by the length of the file:

- **`agents-imported`** (new shape, "canonical by import"): both root files carry content and
  the root `CLAUDE.md` holds a line that is exactly `@AGENTS.md` (or `@./AGENTS.md`, surrounding
  whitespace allowed), anywhere in the file, inside another tool's region included. `AGENTS.md` is the block target; `CLAUDE.md` is never a change of the plan and is
  left byte for byte as it is; no D12 merge or wrapper conversion is planned. The row reads
  `eligible` / `outdated` as usual, with the message "CLAUDE.md already imports AGENTS.md; left
  untouched", and the pull request carries the same line as an action. Because `CLAUDE.md` is
  not written, its markers and regions do not block (as for the strict wrapper, D9); a marker in
  `AGENTS.md` still does. The planner refuses when the files no longer show the import line the
  shape promises. The measure-after step accepts the planned tree as it is: the status is read
  from the block, and the shape stays `agents-imported`, so `current` there is what "writer and
  reader agree" (D10) means for this shape; D12's "must read `agents-canonical`" applies to the
  shapes D12 normalizes.
- The strict one-line wrapper stays `agents-canonical`; `scan` labels the new shape `AGENTS.md
  via @import` and adds a low-severity note (not a finding, nothing to act on for the sync) that
  the pair is not the one-line wrapper and Claude Code loads the extra text too. `--json` carries
  `agents-imported` in `shape` and `importsAgentsMd` per file.
- `both-full` is now a `CLAUDE.md` with content and **no** import line. D12 applies to it
  unchanged: a merge when the text is its own, the wrapper when `AGENTS.md` already contains it,
  and D15 keeps it `blocked` when either file holds a region the change would move or drop. An
  `AGENTS.md` that is itself a pointer back at `CLAUDE.md` keeps the pair `claude-canonical`; the
  import line does not override that, because the content would then be in the wrong file.
- Only the root `CLAUDE.md` qualifies. A `.claude/CLAUDE.md` with the same line stays
  `both-full`: Claude Code resolves a relative import against the importing file's directory, so
  the line there points at `.claude/AGENTS.md`, not at the root file.
- The line must sit where Claude Code parses imports: outside fenced code (documented) and
  outside a multi-line HTML comment (block comments are stripped before injection; that this
  happens before import parsing is an inference, marked as such in tool-behavior.md). The
  comment rule errs on the safe side: wrongly excluding a line yields `both-full` and a D12
  rewrite, wrongly including one would leave `AGENTS.md` unloaded. A single-line comment next to
  the line, such as a region marker, changes nothing.
- The invariant "CLAUDE.md is never a change" holds on the update path too. A block for the pack
  that sits in an `agents-imported` `CLAUDE.md` (hand-placed; the sync only ever inserts into
  `AGENTS.md`) reads `current` or `modified` as under D9, but when it is outdated the row is
  `blocked` at the block ("move the block into AGENTS.md") instead of being rewritten there, and
  the planner refuses any plan for this shape that names a root `CLAUDE.md`.

Consequence for D12: a `CLAUDE.md` that repeats `AGENTS.md` verbatim next to an import line is
no longer collapsed into the wrapper; it is `agents-imported` and left alone, so Claude Code keeps
loading the duplicate text. That is content the repository chose, reported by the note, and
touching it would be authoring (D1). D12's `wrapper` normalization therefore fires only for a
`CLAUDE.md` without an import line whose text `AGENTS.md` already contains.

## 2026-09-15 D17: One glossary for the distribution state model; identifiers, labels, and `--json` follow it

Skills distribution and a status dashboard are next (Skills distribution deferred by D18; the
dashboard stands), and both build on the words `scan` and `sync` already print. Those words
came from five decisions written one at a time (D6, D9, D10, D12, D14, D16) and had drifted:
`current` was a pack status and also the `SyncResult` kind for "nothing written"; `written`
printed as `opened` or `updated`; `planned` was summarized as `would write`; the `sync --all`
status column showed `refused` or `failed` for some rows and a pack status for the others; only
`both-full` had normalization identifiers (`wrapper` / `merge` in `bothFull`), while the
`eligible` row said `rename` or `swap` where the plan said `move` for the same operation.
[status-model.md](status-model.md) is now the one glossary, with four
vocabularies (shape, normalization, pack status, sync outcome), a transition table, the
lifecycle, and the surfaces each word appears on. Rule: a new value is added to the glossary
first; `tests/status-model.test.ts` fails on an identifier or label the glossary does not name.

**Principle.** A state model has three representations, the identifier in code and `--json`, the
label in text, and the sentence in a decision, and they must be one thing seen three ways. Where
a word did two jobs (`current`, `wrapper`), one job got a new word; where two words did one job
(`rename` / `swap` / `move`; `refused` in a status column), the one word won. Labels for pack
statuses and sync outcomes are the identifier with `-` replaced by a space, so a reader can go
from a report line to the JSON field without a table.

**Decisions, with the search rounds behind each** (round n: a round of looking for a strictly
better option produced nothing new):

| Decision | Chosen | Alternatives considered | Settled in round |
| --- | --- | --- | --- |
| `refused` vs `blocked` | Both stay, in different vocabularies: `blocked` is a pack status (a write is pending and a human must look first), `refused` is a sync outcome that results from `blocked`, `modified`, `not-subscribed`, or a check that runs after measurement. `SyncRefused` carries the measured status; the `sync --all` status column always shows the pack status (`-` when unmeasured) and the outcome column starts with `refused:`. | Fold refusals into `blocked` (wrong: rot, a foreign branch, `modified` are not `blocked`); split `refused` into sub-kinds (`refused-status`, `refused-rot`, …; nothing needs the split yet, the message carries the reason) | 2 |
| Status of a `failed` row | A GitHub error after the base branch was measured becomes `SyncFailed { error, status }`, so the row keeps the status (`eligible failed: GitHub createPullRequest failed …`); an error before measurement stays a bare `GitHubError` and the row reads `-`. The single-target CLI prints `SyncFailed` as the GitHub error it wraps. | Always `-` for `failed` (loses a measurement the run made; raised in review); widen the glossary wording instead of carrying the status; attach the status to `GitHubError` itself (the GitHub layer knows nothing about packs) | 2 |
| `SyncResult` kind for "base already current" | `nothing-to-do`, the label the reports already printed | keep `current` (collides with the status); `noop` / `no-op`; `skipped` (suggests not evaluated); `unchanged`; `already-current` | 2 |
| `written` with `pullRequestCreated` | Two kinds, `opened` and `updated`; identifier equals label, summary counts them apart as before | keep `written` plus the boolean and label it `written`; `written (new)` / `written (existing)` | 1 |
| Label of `planned` | `planned`; row reads `planned +N -M: <actions>` | `would write` (summary only); `would open or update a pull request` (row only) | 1 |
| Outcome wrapper `done` | Flattened: `SyncOutcome = SyncResult \| refused \| failed`, so `outcome.kind` is the identifier | keep `done` and document two levels | 1 |
| Normalization identifiers | `keep`, `add-wrapper`, `create`, `move`, `drop`, `merge`; one per shape, `both-full` chooses `drop` / `merge` by content; `repos[].normalization` on every repository replaces `bothFull` | `bothFull` plus prose for the other shapes (the prose had already diverged); `null` for canonical shapes (a dashboard cannot tell "nothing to do" from "unknown"); `none` (collides with the shape); `insert-only`, `as-is` for `keep`; `wrap` / `wrapper` for `add-wrapper`; `create-pair`, `bootstrap` for `create` | 2 |
| `rename` / `swap` / `move` | `move`: the planner runs the same code for `claude-only` and `claude-canonical`, and it moves content, it does not rename a file (a `.claude/CLAUDE.md` is removed and a root wrapper created; a pointer `AGENTS.md` is overwritten). D6's "via rename" is superseded. | `rename` (D6); `swap` (status row for `claude-canonical`); `promote` | 2 |
| D12's `wrapper` | `drop`: the text CLAUDE.md adds is dropped because AGENTS.md already contains it verbatim. `wrapper` also named the file every normalization ends with and collided with `add-wrapper`. | keep `wrapper`; `dedupe`; `collapse`; `replace`; `subsumed`; `redundant` | 2 |
| `--json` versioning | `schemaVersion: 1` on `ScanReport`; bumped on rename, removal, or change of meaning, not on addition; absence means pre-1 (`bothFull`) | start at 2 to mark the break from the unversioned shape; a `version` field name | 1 |
| Status column when a target was never measured | `-` | `unknown` (reads like a status); blank; `?` | 1 |
| Shape identifiers and labels | Unchanged; already one-to-one and file-named | rename `both-full` to `both-content` to match the label; not worth a break | 1 |
| Where label tables live | `src/report/labels.ts` for shape, status, outcome (plus outcome order); normalization sentences in `describeNormalization` (domain, because the `eligible` message is built there) | keep them in `render.ts` and `sync.ts`; move every label into domain (labels are presentation) | 1 |
| Words outside the model (`PersonalPackCopy.state` `current` / `stale`, `SkillLockState`, `ManagedBlock.modified`, issue and finding kinds) | Listed in the glossary as not part of the model; unchanged | rename `PersonalPackCopy.state` values to avoid `current` (the collision is in a different type with a different subject; no report prints them side by side) | 1 |

**Structural check.** Could the vocabulary problem dissolve rather than be fixed? Only if sync
outcomes were derived from pack statuses (then one vocabulary would do), but they cannot be: the
same `eligible` row ends in `planned`, `opened`, `updated`, `up-to-date`, or `refused` depending
on the dry-run flag, the tool-owned branch, and checks that run after measurement. Two
vocabularies with an explicit "results from" relation is the minimum, and that relation is what
the glossary's outcome table records.

## 2026-09-16 D18: Skills distribution is deferred; rulecheck keeps the inventory, `skills` keeps the install

D8 put Skills second in the delivery order and generalized the pack to a set of files so that a
pack could carry whole skill directories; D10 left those `file` entries "inventoried but not
written", and the roadmap carried the gap forward as unfinished work. It is not unfinished; it is
not being built, for four reasons:

1. **The installer exists and D8 says not to rebuild it.** `npx skills` (vercel-labs/skills) is
   the de facto installer: it resolves a source, copies the directory into `.agents/skills/`,
   symlinks the per-tool directories, and records source and hash in `skills-lock.json`.
   rulecheck already reads that lock (D9) instead of defining a manifest; writing skill
   directories through the sync would be a second installer with its own copy semantics, the kind
   of overlap D8 rules out.
2. **No concrete cross-repository skill need has appeared.** Every subscriber so far needs the
   `AGENTS.md` block; none needs the same skill in many repositories. A distribution path without
   a first consumer would be designed against a guess.
3. **Skills are stack-specific more often than repository-agnostic.** A skill for one framework
   or one deployment target belongs to the repositories on that stack, which is a per-repository
   install decision, not a pack subscription. The pack model fits rules that hold everywhere
   (D5); it fits few skills.
4. **Visibility is already covered.** The Step 2 inventory lists every installed skill per
   repository with its lock state, and the one finding (a lock entry whose directory is missing)
   is reported. What a dashboard needs to show about skills is there without a write path.

Decision: **no skill directory is written by `sync`**, and a pack's `file` entries stay what they
are today, inventoried by `scan` and ignored by the planner. The D8 generalization (a pack is a
set of files) is kept as vocabulary; nothing is removed.

If a cross-repository skill need does appear, the direction is **rulecheck manages subscription
and status, `skills` performs the install**: a pack lists skill sources, `scan` reports per
subscriber whether each listed skill is present and matches its lock (the inventory already
knows), and the sync's pull request carries the `npx skills add <source>` command (or runs it
through the GitHub API only if that proves necessary) rather than copying files. That keeps one
installer, one lock format, and rulecheck's role as the status view (D6). It needs its own
decision entry before it is built.

Considered and rejected: removing the `file` pack kind and the D8 generalization (churn without
benefit; the inventory code is used); building the copy now behind a flag (a second write path
without a consumer, contrary to the rule that every write path is a decision entry).

## 2026-09-16 D19: `--html` is a rendering of the report, not a write path; the first read-only slice of the status view

D6 said `rulecheck scan` is the backend of a status view; D14 made `sync --all --dry-run` the
remote distribution report; D17 fixed the words both print. Before a dashboard is built, someone
who does not run the CLI has to be able to read those reports and judge whether a dashboard is
worth paying for. `scan --html <file>` and `sync --all --html <file>` write the same
`ScanReport` / `SyncAllResult` the text report prints as one self-contained HTML page: inline
CSS, no script, no external asset, readable in light and dark, printable.

**What it is.** A second renderer next to the text one (`src/report/html.ts`), fed from the same
data, using the same label tables (`src/report/labels.ts`) and the same sentences (the shape
notes, `describeScope`, `describePersonalCopy`, the outcome detail are exported from the text
renderer, not duplicated). It detects and computes nothing the report does not already carry.
The page is a standalone report format today and the read-only first slice of the status view:
the headline numbers, the repo × pack matrix, and the per-repository cards are the views a
dashboard would show, rendered once from a scan instead of served live. A dashboard proper (a
GitHub App plus webhook so the status updates without a local tree, the web or desktop UI on
top) remains future work on the roadmap and is not started by this entry.

**What it is not.** Not a write path in the D10 sense. The file goes to the path the user names,
like stdout redirected; nothing is written into a scanned repository, a local checkout, `~/`, or
GitHub. It is the only file `scan` writes. It is written after the stdout report, so an
unwritable path loses nothing already measured or, on a live `sync --all`, already opened, and
it fails as every expected failure does: one stderr line, exit 1. `AGENTS.md` records the same
distinction under Rules so the "one write path" rule keeps its meaning.

**Decisions, with the search rounds behind each:**

| Decision | Chosen | Alternatives considered | Settled in round |
| --- | --- | --- | --- |
| Where `--html` lives | A flag on `scan` and on `sync --all` (refused with a single target: the table is what it renders), so one command produces both outputs of one measurement | a `report` subcommand reading `scan --json` (a second step, and a second parser of the JSON shape); `--format html` to stdout (the page is meant to be opened, and `--json` already owns stdout) | 2 |
| Relation to stdout | Additive: text or `--json` still print, the file is written afterwards | replace stdout when `--html` is given (drops the shell-visible result, and the file failure would leave nothing) | 1 |
| Distribution counts in the headline | All six statuses, `not subscribed` included, in glossary order | only `current` / `outdated` / `eligible` / `blocked` (hides `modified`, the one state that needs a human) | 1 |
| Distribution table shape | Repo × pack matrix, packs as columns with rev, subscribers, and per-status counts in the header; rows subscribed to no pack dimmed | one table per pack as the text report prints (does not show a repository's whole subscription at a glance) | 1 |
| Collapsing | `<details open>` per repository, no script; print gets every card expanded because they start open | a script to open all before print; collapsed by default (unprintable without a script) | 1 |
| Duplicates section | Included between the cards and the personal layer when the report has any | omit (the spec order did not name it; leaving out data the text report prints would make the page the lesser report) | 1 |
| Card badge | Counts findings, malformed `agent-rules` markers, and skill issues; shape notes and the prose-wrapper note are advice, not findings | findings only (a repository whose only problem is a malformed marker showed the marker with no badge) | 2 |
| Version and glossary link | `version` from `package.json` passed in by the CLI; the glossary URL a constant in `html.ts` | a `repository` field in `package.json` (nothing else needs it) | 1 |

## 2026-09-16 D20: the `--html` page reads worst first, grouped by owner; `not-subscribed` becomes a candidate list

The first D19 page was reviewed as the artifact a tech lead would open to judge whether a
dashboard is worth paying for, against a real tree of 77 repositories and 2 packs. The numbers
were right (every figure matched the text report) but the page did not read: the matrix listed
77 alphabetical rows of which 70 were `not subscribed` twice, the interesting seven were
scattered among them, the repository cards were alphabetical too, one card carried 68 skill
rows, the `Findings 3` card disagreed with the card badges that summed to 7, and "Tokens loaded
per tool ~99,888" read as a per-session figure when it is a sum over every repository. The
headline was a chip soup and the token card wrapped at 1400px. Same data, same labels, a
different order and grouping.

**What changed.** `src/report/html.ts` only, plus one domain helper. The page orders worst
first throughout: the matrix by the most urgent status a repository has against any pack, the
cards by issue count. Both are grouped by owner (the first path segment), owners with the worst
or most first, with per-owner counts in the group header. Repositories subscribed to no pack
leave the matrix for a closed `Not subscribed (N)` list, grouped by owner, one line per
repository with its shape and what a sync would do if it were subscribed. That last sentence is
the one classification the page adds: `classifyIfSubscribed` in `src/domain/pack.ts`, which is
`classifyPackStatus` with the subscription assumed, so `eligible` and `blocked` there mean what
the glossary says and nothing is decided twice. `scan --json` is unchanged.

**Decisions.** Five were decided by the user on the screenshots and are recorded as such; the
rest were settled by the search-rounds rule.

| Decision | Chosen | Alternatives considered | Settled in round |
| --- | --- | --- | --- |
| Token card | Two compact rows, `Cursor` / `Claude Code`, smaller numerals, no wrap at 1400px; the "sum of every root budget; personal layer adds …" note becomes a footnote line under the cards | — | decided by user, n/a |
| Matrix column headers | Pack name and short rev only; per-pack status counts as one caption line per pack above the table, nonzero statuses only | — | decided by user, n/a |
| Headline content | Repositories, files/tokens, tokens per tool, issues, and one distribution summary per pack as a horizontal stacked bar with a legend (nonzero only, worst first); the Shapes breakdown moves into the Repositories section header | — | decided by user, n/a |
| Owner grouping | Owner group rows in the matrix and owner headers over the cards, with per-owner counts; owners sorted worst / most subscribed first, repositories within an owner worst first (`STATUS_ORDER`) | — | decided by user, n/a |
| `not-subscribed` rows | Out of the matrix; a closed `<details>` "Not subscribed (N)" after it, grouped by owner, one line per repository: name, shape chip, and the `eligible` normalization or `blocked: reason` it would read once subscribed; `--json` unchanged | — | decided by user, n/a |
| `N managed files` in the pack caption | Dropped from the page: the figure is 0 for every pack while Skills distribution is deferred (D18), the text report keeps printing it, and only `no AGENTS.md block` (the one pack fact that changes a status) stays in the caption | keep it for parity with the text report (one more number on a line meant to be read at a glance) | 1 |
| Shapes row | Labelled `Shapes, all N repositories`, because it counts `totals.shapes` over every repository while the section note counts the cards shown | count shapes over the shown cards only (would disagree with the text report's `Shapes` block) | 1 |
| Where "if subscribed" is computed | `classifyIfSubscribed(repo, pack)` in the domain: the same classifier with `subscribers` replaced by the repository; computed once per repository with the first pack, since without a block the answer does not depend on the pack | a second decision table in `html.ts` (would drift from the classifier); a new `PackStatusEntry.ifSubscribed` field in `--json` (a schema addition for one rendering) | 2 |
| Headline `Issues` card | `findings + malformed markers + skill issues`, the sum the card badges already show, with the breakdown in the small text | keep `Findings` and add a second card (two red numbers to reconcile) | 1 |
| Card order | Issue count descending, then name; owners by total issues, then repository count | shape severity first (a `both-full` repository with no finding is advice, not work) | 1 |
| Skill inventory | A closed `<details>` per card whose summary carries the count per lock state; printed only when opened | open when at most N rows (a threshold to explain); always open (68 rows on one card) | 2 |
| Matrix rows link to cards | Repository names in the matrix and the candidate list link to `#repo-<encoded name>` when the page has that card; `:target` highlights it | no links (the reader searches the page) | 1 |
| Root-budget footnote | Names the heaviest repository by `max(cursor, claudeCode)` root budget | an average per repository (hides the outlier a lead wants to see) | 1 |
| Print | What is open prints: cards yes, the skill folds and the candidate list only if the reader opened them | a print stylesheet that forces folds open (not possible for a closed `<details>` without script) | 1 |

## 2026-09-16 D21: the `--html` page adopts GitHub Primer's tokens and opens with a next-actions list

The D20 page was reviewed again on a synthesized tree of 80 repositories across four owners
(7 subscribed to 2 packs, 2 blocked, 7 issues) and read as "still hard to read": the words
"Pack distribution" appeared twice with the same six-status legend repeated three times (bars,
pack captions, owner rows), the reader had to derive what to do from a matrix, 72 open cards
made a 19,000 px page in which every repository looked equally important, shapes were
seven-colored chips next to six-colored status chips, and the four headline cards mixed a
two-row value with single numbers. Same data, same labels; a different hierarchy and a design
system instead of ad hoc styling.

**Design system.** GitHub Primer's tokens, not a system of rulecheck's own: type scale 12 / 14 /
16 / 20 / 28, spacing on a 4 px grid (4 / 8 / 16 / 24), Primer's neutral grays and semantic
colors (`success`, `attention`, `danger`, `done`, `accent`) in light and dark, one accent
(blue) for links and `eligible`, content width 1100 px. Color is used only where a status is the
content: status chips in the next-actions list and the matrix, the stacked bar, the
`Action needed` / `Issues` numbers. Everything else is gray text. Labels are printed as written
(no all-caps). Tables are zebra-free with a 1 px separator, text left, numbers right, tabular
numerals. No script; `<details>` for every fold; print keeps what is open.

**Sections, one question each, in reading order.** Overview: how big is the estate and how
healthy (at most five cards, one number each; `Action needed` counts repositories that are
`modified`, `outdated`, `blocked`, or `eligible` against any pack, and is the one red number).
Next actions: what must a human or a sync do, most urgent first, one row per repository × pack
with the verb from `STATUS_ACTION` (glossary, "Next action per status"), the status message,
and `file:line`; then one row per repository with issues. Pack distribution: where each pack
stands (one line per pack with rev, subscribers, a stacked bar, and counts), then the repo ×
pack matrix of the subscribed repositories grouped by owner, cells reduced to status and
`file:line`; the `not-subscribed` candidate list stays closed. Repositories: what each one loads
and where its issues are; owner groups under sticky headers that double as column headers
(Shape, Cursor, Claude Code), one collapsed row per repository, open only when it has an issue,
budgets as two right-aligned numeric columns. Duplicates and Personal layer unchanged.

**What did not change.** `scan --json`, the text report, every glossary label, the one extra
classification of D20 (`classifyIfSubscribed`), the sync `--all` page's table (its cards and
counts line follow the same tokens).

| Decision | Chosen | Alternatives considered | Settled in round |
| --- | --- | --- | --- |
| Design system | GitHub Primer tokens, hand-written as CSS variables (light and dark), no external asset | Tailwind-like utility CSS inline (hundreds of classes in a generated string, no gain for a static page); Material (denser type ramp, elevation shadows the page does not need); a system of rulecheck's own (the thing the review said not to do) | 2 |
| First section after the cards | `Next actions`: pack statuses that ask for an action, then repositories with issues, both as tables with `file:line` | actions folded into the matrix cells (D20; the reader had to scan 2 × N cells and read the message to know what to do); one merged list of statuses and issues (two different units, repo × pack against repo) | 2 |
| Where the action verb lives | `STATUS_ACTION` in `labels.ts`, one verb per status, documented in the glossary and enforced by `tests/status-model.test.ts` | prose in `html.ts` (a sentence table that drifts from the glossary); a new `PackStatusEntry` field (a `--json` addition for one rendering) | 1 |
| The one red number | `Action needed`, counting repositories (one repository behind on two packs is one thing to open), with the per-status entry counts in the small text; `Issues` is the second red number (the second thing to act on). Card colors are the Primer tokens by name: `danger` red, `attention` yellow (the `Refused` card of the sync page, matching its chip), `success` green | counting entries (7 for 6 repositories; the reader reconciles two numbers); one `attention` class that renders red (a chip and a card of the same word in two colors) | 2 |
| `Current` card denominator | Every measured repo × pack pair, worded `of N with a block or a subscription`: `classifyPackStatus` decides by the block before the subscription list, so a non-subscriber carrying a block is measured too | `of N subscriptions` (wrong word: the `frontend` pack line said `0 subscribed` while the card said `of 5 subscriptions`); the sum of `pack.subscribers` (then `current` can exceed the denominator) | 1 |
| Cards | Five: Repositories, Action needed, Current, Issues, Instruction files; per-tool token sums move to one footnote line under the cards | keep the two-row token card (the one card whose value was not one number); a `Heaviest repository` card (a name, not a number) | 1 |
| Shapes | Plain text everywhere (the shapes line, the repository row, the candidate list); `SHAPE_LABEL` unchanged | keep shape chips (seven more colors next to the six status colors, on rows where shape is a property, not the content) | 1 |
| Repository rows | One `<details>` row per repository with name, issue badge, shape, Cursor, Claude Code as aligned columns; open only when `issueCount > 0`; the sticky owner header carries the column labels | all open (D19; 19,000 px); all closed (issues invisible without a click); a plain table with a detail row (no `<details>` without script) | 2 |
| Status legend | Once per pack, as `● N label` text under the bar; owner rows show a repository count only | chips with bold counts in three places (D20) | 1 |
| Matrix cells | Status chip and `file:line`; the message lives in `Next actions` | chip, `file:line`, and message per cell (D20; the widest cells decided the row height for every row) | 1 |
| Verification method | Render a synthesized 80-repository report through headless Chromium at 1280 px in light and dark, critique against the brief, fix, repeat; three rounds; the harness lives outside the repository and Playwright is not a dependency | commit the harness and Playwright as a visual test (a browser download in CI for a page whose structure `tests/html.test.ts` already pins) | 1 |

## 2026-09-16 D22: the `Action needed` breakdown counts repositories, and every repository has a row

Two readings of a real `scan --packs --html` report, 6 repositories behind on two packs. The
`Action needed` card said `6` over `2 blocked · 10 eligible`: the number counted repositories
(D21) while the small text counted repo × pack entries, and the reader tried to add 2 and 10 to 6.
In `Next actions`, two repositories that were subscribed but had no instruction files locally
(`eligible`, "create AGENTS.md ...") were printed as plain text where every other name was a
link: the page hid repositories without instruction files unless `--all` was given, as the text
report does, so they had no row to link to.

**Breakdown in the card's unit.** The small text counts repositories too, each once under its
most urgent status against any pack (`STATUS_ORDER`), and says so: `6 repositories by worst
status · 1 blocked · 5 eligible`. The parts sum to the number above them. The per-entry counts
stay where entries are the unit: one line per pack under its bar.

**One row per repository, always.** The Repositories section lists every repository of the
report, including those without instruction files, as the same closed one-line row (shape
`none`, two budgets of 0, `No instruction files.` when opened). Every repository name printed
anywhere on the page (`Next actions`, the matrix, the candidate list, the issues table) therefore
links to one and the same kind of place, and `renderHtml` no longer takes an `all` option. `--all`
keeps its meaning for the text summary, where an empty repository costs a paragraph; on the page
it costs one collapsed row, and a repository that a pack asks a sync to write to is not empty in
the sense that matters.

**What did not change.** `scan --json`, the text report and its `--all`, every glossary label,
the order and content of the other sections.

| Decision | Chosen | Alternatives considered | Settled in round |
| --- | --- | --- | --- |
| Unit of the `Action needed` breakdown | Repositories, each counted once under its worst status, worded `N repositories by worst status · 1 blocked · 5 eligible` so the parts visibly sum to the headline | keep entry counts and change the headline to entries (D21 chose repositories: one repository behind on two packs is one thing to open); count a repository under every status it has (parts exceed the headline again); drop the breakdown (the one place the card says which statuses are behind) | 2 |
| Where a name without a row should link | Nowhere special: give every repository a row so the question does not arise; `repoName` always links | link to the repository's matrix row when it has no card (two kinds of link target for the same kind of name; a candidate-list row would link to itself); render a row only for repositories that some pack entry or issue refers to (a third visibility rule beside the text report's `--all` and "has files", and a candidate-list name would still not resolve) | 2 |
| `--all` and the page | The page always lists every repository; `--all` stays a text-report flag and its help says so | keep `all` on `renderHtml` (a flag whose absence breaks links); make `--all` the text report's default too (a separate decision about the text report, not needed here) | 1 |

## 2026-09-16 D23: The pack repository syncs itself: a GitHub Actions workflow in agent-rules runs `sync --all`

Every distribution so far was a human running `sync --all` from a checkout of rulecheck after
merging a pack change; the roadmap's multi-pack rollout note shows what that costs (merge, run,
merge, run). The trigger is known in advance: the packs are outdated exactly when `packs/**` or
`subscriptions.json` changes on `main` of `lightsound/agent-rules`. So the pack repository runs
the sync itself. `.github/workflows/sync.yml` in agent-rules runs
`rulecheck sync --all --packs <checkout> --run-url <run>` on every such push, and on
`workflow_dispatch` with two inputs: `dry_run` (the D14 remote distribution report, no write)
and `pack` (restrict to one pack id). rulecheck itself gains one flag, `--run-url <url>`, whose
value is appended to every pull request body the run writes (`Written by [this run](…)`), so a
reviewer of a subscriber's pull request can open the log of the run that produced it.

**What does not change.** The workflow is a scheduler for the one write path, not a second one:
it calls the same `sync --all`, every check of D10 and D14 runs unchanged, refusals are rows and
exit 0, an unknown outcome exits 1 and fails the run. No pull request is merged by the workflow
or by rulecheck; auto-merge stays the per-repository opt-in D6 left off. `--dry-run` from the
workflow is the same flag as from a shell: every measurement, no write call.

**How the workflow obtains rulecheck.** `actions/checkout` of `lightsound/rulecheck` as a
second checkout in the job, at a commit sha held in one workflow variable (`RULECHECK_REF`)
under a Renovate `git-refs` comment, followed by `bun install --frozen-lockfile` and
`bun run src/main.ts`. The sha, not a branch, so a rulecheck change cannot alter what runs in
agent-rules until someone bumps it (or Renovate proposes the bump); the frozen lockfile, so the
run resolves the exact dependency tree rulecheck tests against, which no git-URL install can
promise (`bun add github:…` resolves the package's dependencies afresh and ignores its
`bun.lock`). Publishing to npm is not done: there is one consumer, and a version number would be
a second thing to bump for no reader.

**Authentication.** `GITHUB_TOKEN` is scoped to the repository that runs the workflow, so it
cannot write to a subscriber. The workflow passes a **fine-grained personal access token** stored
as the repository secret `RULECHECK_TOKEN` to `gh` through `GH_TOKEN`, which the GitHub CLI
honors ahead of any `gh auth login` state; rulecheck's `gh` layer spawns `gh` with the process
environment and needed no change (verified in `src/github/gh.ts`; the "could not run gh"
message now names `GH_TOKEN` next to `gh auth login`). Token settings, exactly: resource owner
`lightsound`; repository access **Only select repositories**, listing every repository in
`subscriptions.json` (today `lightsound/rulecheck`, `lightsound/tanstack-convex`,
`lightsound/heroui-stack`, `lightsound/rererepo`, `lightsound/cobracket`,
`lightsound/solid2-agent-kit`, `lightsound/noican`); repository permissions **Contents: Read and
write**, **Pull requests: Read and write**, **Metadata: Read** (added automatically); no account
permissions. The pack source is the workflow's own checkout of agent-rules, so the token needs
no access to agent-rules itself. A repository added to `subscriptions.json` must also be added to
the token's repository list, or its row reads `failed` (404) and the run exits 1; that failure
is loud by design (D14). A GitHub App (installation token minted per run, no expiry to rotate,
writes attributed to the app) is the replacement when the tool leaves the single-owner phase; the
webhook the roadmap's dashboard needs is the same App, so the two arrive together.

**Decisions, with the search rounds behind each:**

| Decision | Chosen | Alternatives considered | Settled in round |
| --- | --- | --- | --- |
| Where automation lives | A GitHub Actions workflow in the pack repository (`lightsound/agent-rules`), triggered by the change it distributes | a workflow in rulecheck polling agent-rules (the trigger is a push to agent-rules; polling adds latency and a second repository to configure); a job per subscriber pulling from the pack (inverts the model, N configurations, the D14 report disappears); a GitHub App with a webhook (the roadmap's "Later"; a hosted process for one owner today) | 2 |
| How the workflow obtains rulecheck | `actions/checkout` of `lightsound/rulecheck` at `RULECHECK_REF` (a commit sha) into `rulecheck/`, `bun install --frozen-lockfile`, `bun run src/main.ts` | `bunx github:lightsound/rulecheck#<sha>` or `bun add` from the git URL (dependencies resolved afresh, `bun.lock` ignored, the `bin` is a `.ts` file); publish to npm (one consumer, a second version to bump); a container image (a registry and a build for a script) | 2 |
| Pin form | A full commit sha of rulecheck `main` in one `env` variable with a `# renovate: datasource=git-refs … currentValue=main` comment, so Renovate can propose the bump once it is enabled | a branch (`main`; a rulecheck merge would change what runs in agent-rules without a review there); a tag (rulecheck has none and would need a release step) | 1 |
| Pack source for the run | The job's own checkout of agent-rules (`--packs "$GITHUB_WORKSPACE"`, HEAD is the pushed commit, so `rev=` is the sha that triggered the run) | `--packs lightsound/agent-rules@${{ github.sha }}` read through the API (the same tree fetched again, and the token would need read access to the private pack repository, one more way to misconfigure it) | 2 |
| Authentication | Fine-grained PAT in secret `RULECHECK_TOKEN`, passed as `GH_TOKEN`; Contents and Pull requests read/write on the listed subscribers only | `GITHUB_TOKEN` (cannot write to other repositories); a classic PAT (`repo` on every repository of the account); a deploy key per subscriber (git only, no pull request API); a GitHub App now (the right end state, an app registration and a private key for one owner today; recorded as the business-phase replacement) | 2 |
| rulecheck's `gh` client | Unchanged: `gh` reads `GH_TOKEN` from the inherited environment | pass a token flag into rulecheck (it would then hold a credential, against D10); call `gh auth login --with-token` in the workflow (an extra step for what the environment variable already does) | 1 |
| Triggers | `push` to `main` filtered to `packs/**` and `subscriptions.json`; `workflow_dispatch` with `dry_run` (boolean) and `pack` (string) | every push to `main` (root `AGENTS.md` and `machine/` edits would run a sync that finds nothing); a nightly `schedule` as a safety net (idempotent and cheap, but nothing is known to drift without a push; add if a run is ever missed); `pull_request` dry runs on pack changes (a useful review aid; a second job, later) | 2 |
| Link from the pull request to the run | A `--run-url <url>` flag on `sync`, appended to the body by `pullRequestText` as its last line, absent without the flag | reading `GITHUB_RUN_ID` and friends inside rulecheck (implicit input the tests cannot see; a shell run under `act` would link nowhere); no link (the body already says "managed by rulecheck", but not which run) | 2 |
| Concurrency | `concurrency: sync-packs`, `cancel-in-progress: false`: one run at a time, a run that arrives while one is in flight waits (GitHub keeps the newest pending one) | cancel the in-flight run (it may be mid-write; the D14 semaphore serializes writes within a run, not across runs); no group (two runs racing on the same tool-owned branches) | 1 |
| Failure | Exit 1 fails the run, no retry step; the rows name what failed and a rerun of the workflow is the retry, cheap because delivered targets read `current` or `up to date` (D14) | a retry loop in the workflow (D14 keeps retries out until a real run shows them necessary) | 1 |
| Output | stdout to the log and the same table inside a code fence in the job summary; the workflow writes no `--html` file | upload the `--html` page as an artifact (a second place to look for the same rows; add when someone wants the page) | 1 |
| Bun | `oven-sh/setup-bun` pinned to a commit sha, `bun-version` from one `BUN_VERSION` variable with a Renovate `github-releases` comment (today `1.4.2`, the version rulecheck is developed with) | `latest` (a Bun release could change a run without a change in either repository); `bun-version-file` (rulecheck declares no `.bun-version` or `packageManager`; adding one is a rulecheck decision, not a workflow one) | 1 |
| Merging | Never automatic: the workflow opens or updates pull requests; humans or per-repository auto-merge (D6, off by default) merge them | enable auto-merge from the workflow for solo repositories (D6 reserves that for a per-repository opt-in that does not exist yet) | 1 |

**Structural check.** The constraint is "a human runs a command after every merge". It dissolves
only if the sync is triggered by the merge, and the merge happens in agent-rules; anything that
watches from elsewhere polls. A workflow in the pack repository is the smallest thing that is
triggered by the merge, so the constraint dissolves at that place and nowhere else.

## 2026-09-16 D24: a repository inside another discovered repository is not a scan target

`scan ~/ghq` reported 77 repositories where the tree holds about 70. The seven extra were
repositories inside repositories: submodules (a `.git` file pointing at `gitdir: …`), clones
made inside a checkout (`lightsound/noican/noican`, `gamehint/gaitalys-web/gaitalys-web`), and
vendored checkouts (`*/external/blackhole`). `walk` treated every directory holding `.git` as a
repository, so each of them got a row, a shape (`none`, mostly), and with `--packs` a
`not-subscribed` entry per pack, inflating the headline and the candidate list with projects
nobody would subscribe from this tree.

**Excluded from the walk, not folded into the parent.** A repository inside a repository is a
different project: its `AGENTS.md` instructs agents working in *it*, its rules are not the
parent's rules, and a sync into the parent must not read or write it. So by default `walk` stops
at its directory: it is neither its own entry nor part of the enclosing repository, and nothing
below it is read. Directories that are not repositories are descended into as before, and
`--max-depth` keeps counting from the scan root. What was cut is reported, not hidden:
`excludedNested` in `--json` (root, display name, enclosing repository, kind), a footer in the
text report (`3 nested repositories excluded (2 submodules, 1 nested clone)` and one line each),
and a footnote on the HTML page. `--include-nested` restores the old behavior for someone who
does want a row per nested checkout: every nested repository becomes its own entry, files are
attributed to the innermost repository, and `excludedNested` is empty.

**Kind.** `submodule` when `.git` is a file (how git checks out a submodule) or when the
enclosing repository's `.gitmodules` lists the path (submodules checked out by older git carry a
`.git` directory); `nested-clone` otherwise. The kind names the situation for the reader; it
changes nothing about the exclusion. `.gitmodules` is parsed for `path =` keys only, by a pure
function in `src/domain/nested.ts`, and read once per enclosing repository. The kinds are words
outside the status model (they are not a shape or a status) and are listed as such in
`docs/status-model.md`.

**What does not change.** `sync` reads GitHub trees, where a submodule is a `commit` entry that
`src/github/fs.ts` never presented as a directory, so the remote measurement was already free of
nested repositories. `schemaVersion` stays 1: `excludedNested` is a new field; `repos` keeps its
meaning and shrinks to what it always claimed to count.

| Decision | Chosen | Alternatives considered | Settled in round |
| --- | --- | --- | --- |
| What a nested repository is to the scan | Neither a target nor part of the parent: `walk` does not descend into it, and lists it in `excludedNested` | keep it as its own entry but drop it from the totals (the row is what inflates the candidate list); attribute its files to the parent (a different project's `AGENTS.md` would count toward the parent's budget and a sync could touch it); ignore it silently (a reader comparing to `ls` would find repositories missing) | 2 |
| Where the cut happens | In `walk`, at discovery, before the directory is read | post-filter `RepoReport`s in `scan.ts` (the nested trees are still walked and analyzed, and their files were attributed somewhere); `isIgnoredDirectory` (decides by name, cannot see `.git`) | 1 |
| How the kind is told | `.git` is a file → `submodule`; else `.gitmodules` of the nearest enclosing repository lists the path → `submodule`; else `nested-clone` | `.git` file only (misses submodules checked out by old git, which `.gitmodules` still lists); follow `gitdir:` into `.git/modules` (more I/O for the same answer); check every ancestor's `.gitmodules` (a submodule is registered in its direct superproject) | 2 |
| Where the kinds live in the vocabulary | Words outside the model, listed in `docs/status-model.md` with labels of the `-` → space rule, `NESTED_KIND_LABEL` in `labels.ts`, enforced by `tests/status-model.test.ts` | a fifth vocabulary (they are not a state anything transitions through); no glossary entry (every printed word is supposed to be in the glossary) | 1 |
| Report surface | `excludedNested: [...]` at the top of `--json`; a footer in the text report with the count, the kind breakdown, one line per excluded repository, and the flag; the same sentence as a footnote on the HTML page | a `totals.excludedNested` count next to `repos` (the list already carries the count, and a reader of the headline should not have to subtract); a section of their own (they are what the scan did not do, so they belong at the end); count only, no names (a reader comparing to `ls` needs the names) | 2 |
| Opt-in | `--include-nested`, restoring the previous behavior exactly | `--nested <exclude\|own\|parent>` (nobody asked for `parent`, and it is the option the first row rejects); no flag (a vendored checkout with its own rules is sometimes what someone wants to audit) | 1 |

**Structural check.** The constraint is "count repositories the way a person counts them". A
person counts a checkout once and does not count the projects it vendors, because the boundary
that matters is the one git draws: an enclosing `.git` owns everything below it except what
another `.git` owns. `walk` already knew both facts and only lacked the rule that the outer
boundary wins. Stopping at the inner `.git` is that rule, so the problem dissolves at the walk
and nothing downstream needs to know a repository was nested.

## Recording rule

Add an entry here whenever a decision changes what rulecheck writes, what it reports, or which
layer a kind of content belongs to. Add a fact to `tool-behavior.md` whenever a decision depends
on how a tool behaves. Add a value to [status-model.md](status-model.md) before adding it to a
type, a label table, or `--json`.

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

## 2026-09-14 D3: Personal pack in a private repo, wired by import and User Rule (superseded by D5, D6)

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
content` and files carrying another tool's managed markers are reported for a human.

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
  `not subscribed`, or for subscribers `blocked` (`both have content`, or a foreign/malformed
  marker in a root file the sync would write) else `eligible`. `blocked` therefore appears
  exactly where a write is pending, so every write is gated by "a human looks first" (D6), and
  `current` / `modified` rows stay quiet about markers (the repository's own `!` line and
  `totals.malformedMarkers` carry them). Comparison is by hash, not `rev`: a pack commit that
  touches other files leaves subscribers `current`.
- Foreign markers: a single-line HTML comment containing `managed`, `generated`, `autogenerated`
  or `do not edit`, or starting with `BEGIN` / `END` in capitals. Only root-pair files are
  checked, and only files the normalization would rewrite block insertion (a marked `CLAUDE.md`
  wrapper next to a canonical `AGENTS.md` does not).

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
bodies are read; settled by D11: it stays bare); no fan-out (`--all`, Step 5).

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

## Recording rule

Add an entry here whenever a decision changes what rulecheck writes, what it reports, or which
layer a kind of content belongs to. Add a fact to `tool-behavior.md` whenever a decision depends
on how a tool behaves.

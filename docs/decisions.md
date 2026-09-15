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

## Recording rule

Add an entry here whenever a decision changes what rulecheck writes, what it reports, or which
layer a kind of content belongs to. Add a fact to `tool-behavior.md` whenever a decision depends
on how a tool behaves.

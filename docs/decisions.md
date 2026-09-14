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
merge; local checkouts get it through normal `git pull`; teams need review. Auto-merge is an
option per repository (fine for solo repositories). Distribution status (current / outdated /
modified / eligible / blocked / not subscribed) is a first-class report, per repository with
`file:line`.

Shape normalization is a prerequisite and is itself a PR: deterministic cases (`none`,
`AGENTS.md only`, `CLAUDE.md only` via rename, reversed canonical) are automated; `both have
content` and files carrying another tool's managed markers are reported for a human.

Opt-in is per repository and explicit; ownership is not inferred from the GitHub owner because
committing rules to a shared repository makes them team rules.

## 2026-09-15 D7: Multiple named packs

A team has more than one shared rule set. A pack is a named `AGENTS.md` fragment; a repository
subscribes to zero or more packs; each pack is its own managed block identified by `source=`.
Block order in the file is the subscription order. Conflicts between packs are content, not
structure, and are out of scope for automation (a lint may point them out later).

## Recording rule

Add an entry here whenever a decision changes what rulecheck writes, what it reports, or which
layer a kind of content belongs to. Add a fact to `tool-behavior.md` whenever a decision depends
on how a tool behaves.

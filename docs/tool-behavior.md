# How each tool loads instruction files

Verified behavior of Cursor and Claude Code, with the evidence for each claim. rulecheck's budget
estimates and the recommended layout depend on these facts, so when a tool updates, re-verify the
items marked *undocumented* using the method at the end.

Last verified: 2026-09-15, Cursor 3.20.21 (macOS), Claude Code docs at code.claude.com.

## Cursor

### Project level

| File | Loaded | Notes | Evidence |
|---|---|---|---|
| `AGENTS.md` at root | always | | [docs](https://cursor.com/docs/rules) |
| `AGENTS.md` in subdirectories | when working on files under that directory | merged with parents | docs |
| `CLAUDE.md`, `CLAUDE.local.md` at root | always, regardless of frontmatter | requires "Include third-party Plugins, Skills, and other configs" (on by default) | [help](https://cursor.com/help/customization/rules.md) |
| `.cursor/rules/**/*.mdc` | per frontmatter (`alwaysApply`, `globs`, `description`) | **must start with `---` frontmatter**; a `.mdc` without it is dropped by the parser. `.md` in that directory is ignored | docs; app source `parseCursorRulesMdcContent` |
| `.cursorrules` | always | legacy | help |
| `@import` inside `AGENTS.md` / `CLAUDE.md` / `.mdc` | **probably not** | no resolution code found in the app; `@path` lines appear to be passed through as text. Not yet confirmed by probe | *undocumented*, app source |

### Ancestor walk (undocumented)

`LocalCursorRulesService.loadRulesFromDirAndAncestors` starts at the workspace root and walks up
through **every ancestor directory to `/`**. At each level it loads `.cursor/rules/**/*.mdc`
(following symlinks) and `AGENTS.md` (plus `CLAUDE.md` / `CLAUDE.local.md` with third-party
extensibility) as always-apply rules. The prompt assembler treats rules whose directory is *outside*
the workspace as always-applied (only rules *nested inside* the workspace are demoted to
per-file rules).

Consequences for a workspace under `~`:

- `~/AGENTS.md` and `~/CLAUDE.md` are loaded into every session. So is `~/ghq/AGENTS.md`,
  `~/ghq/github.com/<owner>/AGENTS.md`, and so on: an owner-level file applies to every repository
  of that owner without copying.
- `~/.cursor/rules/*.mdc` is loaded (the help page mentions this directory in one sentence as
  "user rule files ... stay on the machine and do not sync").

Caveats:

- Rules are read **once per window**. The file watcher covers only the workspace, so changes to
  ancestor files need **Developer: Reload Window**. A new chat in the same window does not pick them up.
- Not in the public docs. Verified on 3.20.21 by probe (below) and by reading the bundled source
  (`extensions/cursor-agent-host/dist/agent-host-daemon/dist/bin/daemon.cjs`, unminified, contains
  the doc comment "walking up through every ancestor directory"; the same logic is minified in
  `extensions/cursor-agent-exec/dist/main.js`).
- **Cloud Agents never see it.** The VM checks out code at `/workspace` and the home directory is
  `/home/ubuntu` ([staff forum answer](https://forum.cursor.com/t/cursor-cloud-agents-still-dont-read-cursor-rules/164186));
  the workspace is not under home, and the VM has no access to the local home directory ([docs](https://cursor.com/docs/cloud-agent)).

### User level

| Mechanism | Local | Cloud Agents | Other machines | On disk | Evidence |
|---|---|---|---|---|---|
| User Rules (Settings → Rules) | yes | **yes** | yes (account sync) | no | [cloud best practices](https://cursor.com/docs/cloud-agent/best-practices), [help](https://cursor.com/help/customization/rules.md) |
| `~/AGENTS.md`, `~/CLAUDE.md` via ancestor walk | yes | no | no | yes | *undocumented*, verified |
| `~/.cursor/rules/*.mdc` | yes | no (staff forum) | no | yes, needs frontmatter | help (one sentence), verified |
| Team Rules (dashboard) | yes | yes | yes | no | docs; Teams plan |
| `~/.claude/CLAUDE.md` | **no** | no | | | not read by Cursor; only `~/.claude/skills/` and `~/.claude/settings.json` hooks are read for compatibility |

User Rules are the only per-user channel that reaches Cloud Agents. They live in Cursor's account
storage, so no CLI can read them; the Cursor agent inside the app can (via the app-control tool).
Whether the Cursor CLI (`agent`) applies User Rules is not documented.

Rule frontmatter accepted by the parser but not documented: `metadata.environments`,
`metadata.disabledEnvironments` (values `cloud`, `local`), `metadata.scopedTo`. Staff mention
`.cursor/CLOUD.md` for cloud-only instructions ([forum](https://forum.cursor.com/t/is-there-a-way-to-add-rule-or-agent-md-only-for-cloud-agent/159595)).

## Claude Code

| Mechanism | Behavior | Evidence |
|---|---|---|
| `~/.claude/CLAUDE.md` | loaded in every session | [memory docs](https://code.claude.com/docs/en/memory) |
| `@path` imports | relative, absolute, and `@~/...` all resolve; one level shown here, recursion up to 5 hops; imports from user scope need no approval dialog, imports from project files pointing outside the project prompt once | docs |
| `CLAUDE.md` in ancestors of cwd | loaded (so `~/CLAUDE.md` applies to every project under home) | docs |
| `CLAUDE.md` in subdirectories | loaded on demand when files there are read | docs |
| `CLAUDE.local.md` | loaded, meant to be gitignored | docs |
| `.claude/rules/*.md` | loaded; `paths:` frontmatter scopes them; symlinks followed | docs |
| symlink `CLAUDE.md -> AGENTS.md` | works, but `@AGENTS.md` is recommended (Windows / `core.symlinks=false` turn the link into a 9-byte text file) | docs, community reports |
| Managed policy | `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS), `/etc/claude-code/CLAUDE.md` (Linux); cannot be excluded | docs |

### Claude Code on the web (cloud sessions)

Sessions run on a fresh Ubuntu 24.04 VM with a fresh clone of the repository. What carries over
([cloud-environments](https://code.claude.com/docs/en/cloud-environments), table "What carries over from your setup"):

| Source | Cloud session | Doc wording |
|---|---|---|
| repo `CLAUDE.md`, `.claude/rules/`, `.claude/settings.json` hooks, `.claude/skills|agents|commands` | yes | "Part of the clone" |
| `~/.claude/CLAUDE.md` | **no** | "Lives on your machine, not in the repo" |
| `~/.claude/settings.json`, `.claude/settings.local.json` | no | "not read. Both stay on your machine" |
| `~/.claude/skills/` | no, but skills enabled on claude.ai are synced at session start | "Cloud sessions automatically load skills you enable on claude.ai" |
| organization server-managed settings, including a managed `claudeMd` | yes | "Fetched from Anthropic's servers when the session starts" |
| Auto memory | no | "machine-local ... not shared across machines or cloud environments" |

There is **no documented per-user instruction channel** for cloud sessions (the equivalent of
Cursor's User Rules does not exist). The official advice is "To make your own configuration
available in cloud sessions, commit it to the repo." Hooks do fire in the cloud, from the repo and
from managed settings; `CLAUDE_CODE_REMOTE=true` identifies a cloud session.

Possible per-user workaround, **unverified**: a cloud environment has a setup script that "runs
when a new cloud session starts, before Claude Code launches", as root, and its filesystem is
snapshotted and reused. It could clone the personal pack and write `~/.claude/CLAUDE.md` with an
`@` import. Unknowns: whether a cloud session honors a `~/.claude/CLAUDE.md` that exists on the VM
(the docs only say the local one is not copied), and whether the GitHub proxy lets the setup
script clone a private repository that is not attached to the session ("GitHub API and
release-asset requests reach only repositories attached to the session"). Verify with a probe
marker before relying on it.

`--teleport` and Remote Control run on the local machine, so `~/.claude/*` applies normally there.

## GitHub API contracts `rulecheck sync` relies on

`src/github/gh.ts` talks to GitHub through `gh api`. The tests use an in-memory GitHub written
from the same understanding, so they cannot catch a wrong belief about the real API; this table
records which contracts have been exercised against api.github.com and which have not.

| Contract | Used for | Status | Evidence |
|---|---|---|---|
| `gh api` on a failing request prints the JSON error body on stdout and `gh: <message> (HTTP <status>)` on stderr; `getRef` treats 404 as "no such ref" | every "does this exist?" check | verified 2026-09-15 | `gh api repos/lightsound/rulecheck/git/ref/heads/nope` → stdout `{"message":"Not Found",...}`, stderr `gh: Not Found (HTTP 404)` |
| `GET git/ref/heads/<branch>` → `object.sha`; `GET git/commits/<sha>` → `tree.sha`, `message`; `GET git/trees/<sha>?recursive=1` → flat `tree[]` with `path`, `type`, `sha`, `mode`, and `truncated` | building the snapshot filesystem | verified 2026-09-15 | `scan --packs lightsound/rulecheck` and `sync lightsound/rulecheck --dry-run` read the real tree and blobs |
| `GET git/blobs/<sha>` → `content` base64 with embedded newlines, `encoding: "base64"` (`utf-8` is accepted too; anything else fails) | reading files | verified 2026-09-15 | blob of `CLAUDE.md`: `{"content":"QEFHRU5UUy5tZAo=\n","encoding":"base64","size":11}` |
| `GET pulls?state=open&head=<owner>%3A<branch>` finds the open pull request from a same-repository branch | reusing the open pull request on rerun | verified 2026-09-15 | returned [#5](https://github.com/lightsound/rulecheck/pull/5) for `lightsound:cursor/step3-sync-write-path-33c6` |
| `POST git/trees` with `base_tree` and entries `{path, mode: "100644", type: "blob", content}`; deletion as `{path, mode, type, sha: null}` | writing the root pair, removing `.claude/CLAUDE.md` in the `claude-only` normalization | **documented, not yet exercised** | [Create a tree](https://docs.github.com/rest/git/trees#create-a-tree): "sha ... use `null` to delete" |
| `POST git/commits`, `POST git/refs` (`{ref: "refs/heads/<b>", sha}`), `PATCH git/refs/heads/<b>` (`{sha, force: true}`), `POST pulls`, `PATCH pulls/<n>` | commit, branch, pull request | **documented, not yet exercised** | GitHub REST docs for Git Data and Pulls |
| Written paths always get mode `100644`; a base entry with `100755` or `120000` at that path is replaced by a regular file | writing `AGENTS.md` / `CLAUDE.md` | by design, unverified in the wild | a symlinked `CLAUDE.md -> AGENTS.md` reads as the text `AGENTS.md`, which the wrapper detector treats as a pointer, so the shape is `agents-canonical` and the link is left alone |

Re-verification: the first run of `sync` without `--dry-run` goes to a throwaway repository under
the operator's own account (one run per shape, `claude-only` with `.claude/CLAUDE.md` included
because it is the only deleting path), then the rows above move to "verified" with the run as
evidence. Repeat when `gh` changes its error output or GitHub changes the Git Data API.

## What this means for a personal instructions pack

- Claude Code (local, teleport, Remote Control): `~/.claude/CLAUDE.md` containing
  `@~/path/to/pack/AGENTS.md`. Zero copies, documented.
- Claude Code on the web: no per-user channel. Either accept that cloud sessions run without the
  personal pack, or verify the setup-script workaround above. Project instructions still apply.
- Cursor: one User Rule containing a copy of the pack, because it is the only channel that reaches
  Cloud Agents. Treat the copy as a generated artifact: sync from the file, never edit in place,
  and put the sync procedure next to the file (see `lightsound/agent-rules`).
- Do not combine the User Rule with `~/AGENTS.md`: local sessions would load the text twice.
- `~/AGENTS.md` (or `~/ghq/github.com/<owner>/AGENTS.md`) remains useful for **machine-local or
  owner-level** instructions that should not go to the cloud.

## Re-verification method

1. Create probe files with unique markers, one hypothesis per file (for example
   `~/.cursor/rules/b.mdc` with frontmatter, `~/.cursor/rules/e.mdc` without, `~/AGENTS.md`).
2. **Developer: Reload Window**, then open a new chat and ask, without tools:
   "List verbatim every line in your rules containing `PROBE-`; say `none` if there are none."
3. Which markers appear tells you which mechanisms load. Remove the probes afterwards.

Results on 2026-09-15 (Cursor 3.20.21): loaded = `.mdc` with frontmatter, `~/AGENTS.md`;
not loaded = `.mdc` without frontmatter (including a symlink to a plain markdown file), `.md`.
Whether an `@~/...` line inside an `.mdc` is expanded was not checked (only marker lines were
requested); add a marker inside the imported file next time.

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

## What this means for a personal instructions pack

- Claude Code: `~/.claude/CLAUDE.md` containing `@~/path/to/pack/AGENTS.md`. Zero copies, documented.
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

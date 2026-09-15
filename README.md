# rulecheck

Health check for AI coding agent instruction files across many repositories.

`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, `.claude/rules/*.md` accumulate quietly: one repo makes `AGENTS.md` canonical, the next makes `CLAUDE.md` canonical, a third has full content in both, and the same 77-line file ends up copied into four checkouts. rulecheck scans a directory tree, finds every git repository, and reports:

- **Shape** of each repository's root pair: `AGENTS.md` canonical, `CLAUDE.md` canonical, one side only, or both carrying content.
- **Duplicates**: identical instruction files across repositories.
- **Context budget**: approximate tokens Cursor and Claude Code load unconditionally at the repo root, including always-on `.cursor/rules` and resolved `@AGENTS.md` imports.
- **Scope** of each rule file: `alwaysApply`, globs, `paths`, nested.
- **Rot**: package scripts an instruction tells the agent to run that no `package.json` defines, and repository paths it points at that no longer exist. Each finding carries `file:line`.
- **Managed blocks**: `<!-- agent-rules:begin source=<pack> rev=<sha> hash=<sha256> -->` regions in `AGENTS.md`, with the body hash recomputed so an in-place edit shows as `MODIFIED`. Unpaired or incomplete markers are findings.
- **Skills**: `SKILL.md` directories under `.agents/skills`, `.claude/skills`, `.cursor/skills` (symlinked copies fold into their target), the `skills-ref` name/description checks, and each skill's relation to `skills-lock.json`. A lock entry whose directory is missing is a finding; a hash that differs from the lock is shown, not reported, because `npx skills` may record a snapshot hash that is not reproducible from disk.
- **Pack distribution** (`--packs <dir>`): for every repository and every pack in a pack repository checkout (`packs/<id>/AGENTS.md`, `subscriptions.json`), one of `current`, `outdated`, `modified`, `eligible`, `blocked` (with the `file:line` of the reason), `not subscribed`.
- **Personal layer**: what loads in every session regardless of repository. Claude Code: `~/.claude/CLAUDE.md`, its `@imports`, `~/.claude/rules/*.md`, `~/CLAUDE.md`, any managed policy file. Cursor: `~/AGENTS.md`, `~/CLAUDE.md`, always-apply `~/.cursor/rules/*.mdc` (loaded through an undocumented ancestor walk; local sessions only). Cursor User Rules in settings are not on disk and are not measured. See [docs/tool-behavior.md](docs/tool-behavior.md) for what each tool loads and how it was verified.

It is read-only. It never modifies scanned repositories.

## Usage

```sh
bun install
bun run dev scan ~/ghq                # text summary
bun run dev scan ~/ghq --json         # full report for tooling
bun run dev scan ~/ghq --all          # include repositories with no instruction files
bun run dev scan ~/ghq --no-personal  # skip the ~/.claude layer
bun run dev scan ~/ghq --packs ~/ghq/github.com/lightsound/agent-rules  # add the pack distribution report
```

### How rot detection decides

Precision is preferred over recall: a finding asks a human to act, so ambiguous text is skipped instead of guessed at.

- Scripts are taken from shell lines in fenced blocks and inline code: `bun run x`, `pnpm x`, `yarn x`, `npm run x`. Manager builtins (`bun install`, `pnpm dlx`) are not scripts. A script is unknown only if no `package.json` in the repository defines it; bare `bun x` is also accepted when `x` is a dependency or a `node_modules/.bin` entry.
- Paths are taken from inline code spans containing a `/`. URLs, absolute and `~` paths, globs, placeholders, scoped package names, and `owner/repo` pairs are ignored. A path is missing only when its first segment exists (so `acme/other-repo` is not a path) and it is not matched by the root `.gitignore`.
- Lines that assert absence ("has no `src/main.tsx`", "は存在しない") are skipped.
- Known limitation: paths the agent is expected to *create* (`write results to poc-results/x.md`) are reported as missing.

## Convention

rulecheck recommends and follows one convention for the root pair:

- `AGENTS.md` carries the content. Cursor, Codex, and most agents read it directly.
- `CLAUDE.md` contains exactly `@AGENTS.md`. Claude Code resolves the import; a prose pointer ("see AGENTS.md") does not load anything.
- Tool-specific scoping (glob-activated rules) stays in `.cursor/rules/*.mdc` or `.claude/rules/*.md`.

## Status

Early. The scanner, shape/duplicate/budget detectors, rot detection, the personal layer, managed-block detection, the skills inventory, and the pack distribution status work against real trees. The next step is the first write path: shared rule packs delivered into repositories as managed blocks, synced through pull requests. See [docs/roadmap.md](docs/roadmap.md) for the order, [docs/decisions.md](docs/decisions.md) for the reasoning, and [docs/tool-behavior.md](docs/tool-behavior.md) for the tool facts it rests on.

## Development

```sh
bun run check     # typecheck + lint + test
bun test
bun run lint:fix
```

Built with Bun, TypeScript, and Effect v4 (`effect/unstable/cli`).

## License

MIT

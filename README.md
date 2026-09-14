# rulecheck

Health check for AI coding agent instruction files across many repositories.

`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, `.claude/rules/*.md` accumulate quietly: one repo makes `AGENTS.md` canonical, the next makes `CLAUDE.md` canonical, a third has full content in both, and the same 77-line file ends up copied into four checkouts. rulecheck scans a directory tree, finds every git repository, and reports:

- **Shape** of each repository's root pair: `AGENTS.md` canonical, `CLAUDE.md` canonical, one side only, or both carrying content.
- **Duplicates**: identical instruction files across repositories.
- **Context budget**: approximate tokens Cursor and Claude Code load unconditionally at the repo root, including always-on `.cursor/rules` and resolved `@AGENTS.md` imports.
- **Scope** of each rule file: `alwaysApply`, globs, `paths`, nested.
- **Rot**: package scripts an instruction tells the agent to run that no `package.json` defines, and repository paths it points at that no longer exist. Each finding carries `file:line`.
- **Personal layer**: what loads in every session regardless of repository. Claude Code: `~/.claude/CLAUDE.md`, its `@imports`, `~/.claude/rules/*.md`, `~/CLAUDE.md`, any managed policy file. Cursor: `~/AGENTS.md`, `~/CLAUDE.md`, always-apply `~/.cursor/rules/*.mdc` (loaded through an undocumented ancestor walk; local sessions only). Cursor User Rules in settings are not on disk and are not measured. See [docs/tool-behavior.md](docs/tool-behavior.md) for what each tool loads and how it was verified.

It is read-only. It never modifies scanned repositories.

## Usage

```sh
bun install
bun run dev scan ~/ghq                # text summary
bun run dev scan ~/ghq --json         # full report for tooling
bun run dev scan ~/ghq --all          # include repositories with no instruction files
bun run dev scan ~/ghq --no-personal  # skip the ~/.claude layer
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

Early. The scanner, shape/duplicate/budget detectors, rot detection, and the personal layer work against real trees. The next step is distribution: shared rule packs delivered into repositories as managed blocks, synced through pull requests. See [docs/decisions.md](docs/decisions.md) for the reasoning and [docs/tool-behavior.md](docs/tool-behavior.md) for the tool facts it rests on.

## Development

```sh
bun run check     # typecheck + lint + test
bun test
bun run lint:fix
```

Built with Bun, TypeScript, and Effect v4 (`effect/unstable/cli`).

## License

MIT

# rulecheck

Health check for AI coding agent instruction files across many repositories.

`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, `.claude/rules/*.md` accumulate quietly: one repo makes `AGENTS.md` canonical, the next makes `CLAUDE.md` canonical, a third has full content in both, and the same 77-line file ends up copied into four checkouts. rulecheck scans a directory tree, finds every git repository, and reports:

- **Shape** of each repository's root pair: `AGENTS.md` canonical, `CLAUDE.md` canonical, one side only, or both carrying content.
- **Duplicates**: identical instruction files across repositories.
- **Context budget**: approximate tokens Cursor and Claude Code load unconditionally at the repo root, including always-on `.cursor/rules` and resolved `@AGENTS.md` imports.
- **Scope** of each rule file: `alwaysApply`, globs, `paths`, nested.

It is read-only. It never modifies scanned repositories.

## Usage

```sh
bun install
bun run dev scan ~/ghq          # text summary
bun run dev scan ~/ghq --json   # full report for tooling
bun run dev scan ~/ghq --all    # include repositories with no instruction files
```

## Convention

rulecheck recommends and follows one convention for the root pair:

- `AGENTS.md` carries the content. Cursor, Codex, and most agents read it directly.
- `CLAUDE.md` contains exactly `@AGENTS.md`. Claude Code resolves the import; a prose pointer ("see AGENTS.md") does not load anything.
- Tool-specific scoping (glob-activated rules) stays in `.cursor/rules/*.mdc` or `.claude/rules/*.md`.

## Status

Early. The scanner and the first detectors work against real trees; staleness detection (commands and paths mentioned in instructions that no longer exist) and structural fix commands are next.

## Development

```sh
bun run check     # typecheck + lint + test
bun test
bun run lint:fix
```

Built with Bun, TypeScript, and Effect v4 (`effect/unstable/cli`).

## License

MIT

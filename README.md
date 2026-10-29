# rulecheck

Health check for AI coding agent instruction files (AGENTS.md, CLAUDE.md, .cursor/rules)
across many repositories: scan, sync, and report. rulecheck is the engine behind
[RuleFleet](https://github.com/lightsound/rulefleet), the hosted GitHub App that is a view
and a runner over the same code.

## License

From 2026-10-29 this project is licensed under **FSL-1.1-MIT** (see [LICENSE](LICENSE) and
decision D34 in [docs/decisions.md](docs/decisions.md)).

Everything up to and including commit `f8691ce`, tagged `mit-final`, was released under the
MIT License, and that grant remains in effect for those versions. Later versions are
FSL-1.1-MIT; under the FSL terms, each version converts to MIT two years after it is made
available.

## Docs

Design and decisions live in [docs/](docs/): start with
[docs/roadmap.md](docs/roadmap.md) and [docs/decisions.md](docs/decisions.md).

Per D34, this repository will later move into the RuleFleet repository as
`packages/rulecheck` and be archived here.

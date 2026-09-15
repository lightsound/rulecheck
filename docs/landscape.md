# Competitive landscape

Survey of services and open source that overlap with rulecheck's plan: scanning many repositories
for agent instruction files (shape, duplicates, budget, rot), and distributing shared packs into
repositories as managed blocks through pull requests ([decisions.md](decisions.md) D4 to D7,
[roadmap.md](roadmap.md)). Maturity figures are GitHub stars and last push as read through the
GitHub API on the survey date; vendor docs as published on that date.

Surveyed: 2026-09-15. Re-survey when a vendor ships org-level instruction distribution into
repositories, or when a tool in area 1 or 2 passes roughly 1k stars.

Areas: **A1** lint / audit of instruction files, **A2** distribution of rules and skills across
repositories, **A3** enterprise governance of agent configuration, **A4** general multi-repo file
sync that could be repurposed.

## A1: Linting and auditing instruction files

Crowded, all young (created 2026), almost all single-repo and single-process. Only one scans a
tree of repositories.

| Name | What it does | Areas | Maturity | Gap versus rulecheck |
|---|---|---|---|---|
| [unrot](https://github.com/unrot-dev/unrot) (npm, formerly `agent-config-linter`) | Static linter: staleness (git), oversized, contradictions, broken refs, personal content in committed files, eager `@`-embeds. `unrot fleet gh:<org>` shallow-clones every repo of an org and prints one health report with letter grades, JSON output. Read-only. | A1 | 1 star, pushed 2026-09-10, v0.6.0 | Closest in *shape*: multi-repo, read-only, `file:line`. No shape classification (`AGENTS.md` / `CLAUDE.md` wrapper), no cross-repo duplicate detection, no per-tool budget model, no personal layer. Its [Phase 3 issue](https://github.com/unrot-dev/unrot/issues/5) sketches tagged shared blocks + source repo + PR-only sync, i.e. D4/D6, but nothing is built and the project has no visible adoption. |
| [agnix](https://github.com/agent-sh/agnix) | 454 rules across Claude Code, Codex, Cursor, Copilot, Gemini, Cline, MCP, `SKILL.md`; autofix; LSP; IDE plugins; GitHub Action. | A1 | 413 stars, pushed 2026-09-14 | Deepest single-repo validator (frontmatter, hooks, MCP schema). Single repo only, no budget or duplicate view across repos, no distribution. rulecheck should not compete on rule count. |
| [AgentLint](https://github.com/0xmariowu/AgentLint) (`agentlint-ai`) | Claude Code plugin + CLI auditing `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, Copilot instructions, CI and hooks as "the harness". | A1 | 56 stars, pushed 2026-07-24 | Runs inside one repo; LLM-assisted judgments. No multi-repo, no distribution. |
| [agentslint](https://github.com/toshi0607/agentslint) | CI linter: broken refs, stale commands, token budget (default 4k), `SKILL.md` frontmatter, `.claude/settings.json` schema, secrets. SARIF output. Explicitly precision-first. | A1 | 0 stars, pushed 2026-09-13 | Same precision philosophy as rulecheck, single repo, no shape/duplicate/distribution. Its SARIF and `github` formats are worth copying later for CI use. |
| [agents-lint](https://github.com/giacomo/agents-lint) | Zero-dependency: stale paths, dead npm scripts, framework staleness; also lints `~/.claude/projects/*/memory`. | A1 | 13 stars, pushed 2026-03-26 | Single repo, inactive since March. |
| [agenteval](https://github.com/lukasmetzler/agenteval) | Lint (token counter, overlap detector across files in one repo, bloat, dead sections, skill frontmatter) plus eval harness that scores agent runs against instruction changes. | A1 | 6 stars, pushed 2026-06-22 | Overlap detection is intra-repo only. The eval side is out of rulecheck's scope. |
| [ktlyman/linter](https://github.com/ktlyman/linter), [tokn](https://github.com/mahenarayan/tokn) | Scorecards (A–F) for instruction surfaces; tokn focuses on Copilot `.instructions.md` drift and `applyTo` globs matching nothing. | A1 | 0 stars each, pushed 2026-07 | Single repo. Grading is a presentation idea, not a moat. |
| [ai-harness-doctor](https://github.com/NieZhuZhu/ai-harness-doctor) | Audit + `plan` + write: consolidates scattered tool files into one `AGENTS.md` and turns the others into pointers; ships a 14-repo corpus (react, vscode, n8n...) showing 44 overlapping instruction files. | A1, edge of A2 | 2 stars, pushed 2026-08-12 | Writes to the local checkout (rulecheck's D6 forbids that). Single repo. Its corpus is a useful public benchmark for false-positive testing. |
| [agent-lens](https://github.com/tasszz2k/agent-lens) | TUI inventory of skills/rules/hooks/MCP across `~/.cursor`, `~/.claude` and projects under workspace roots; flags broken symlinks, `.cursorrules` next to `.cursor/rules`, `CLAUDE.md` + `AGENTS.md` conflicts. | A1 | 0 stars, pushed 2026-05-04 | Interactive viewer, no findings with `file:line`, no report. Overlaps rulecheck's personal layer only. |
| Skills validators: [skills-ref](https://github.com/agentskills/agentskills/tree/main/skills-ref) (official), [skillcheck](https://github.com/Sagargupta16/skillcheck), [skref](https://github.com/alephic-ai/skref), [SkillGate](https://github.com/charliechenye/SkillGate) | `SKILL.md` frontmatter/spec conformance (skills-ref is strict, clients are lenient; skillcheck tracks both), SARIF, GitHub Actions; SkillGate scans skills and MCP configs for risky capabilities. | A1 | agentskills spec repo 25.3k stars; validators 2–5 stars | Skills frontmatter validation is solved upstream. rulecheck's Skills step should call or mirror `skills-ref` semantics, not invent rules. None of them look across repositories. |
| [guideline-checker](https://github.com/chrysa/guideline-checker) | Extracts must/never rules from instruction files and lints *source code* against them. | adjacent | 0 stars, pushed 2026-09-14 | Different problem (enforcing rules on humans), not a competitor. |

## A2: Distributing rules and skills across repositories

Two families: **generators** that fan one source out to many *tool formats inside one repo*
(mature), and **cross-repo syncers** (immature). No product distributes a managed block into an
existing `AGENTS.md` with revision and drift status.

| Name | What it does | Areas | Maturity | Gap versus rulecheck |
|---|---|---|---|---|
| [ruler](https://github.com/intellectronica/ruler) | `.ruler/*.md` + `ruler.toml` → `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, Copilot, MCP settings; nested rules; `.gitignore` automation. | A2 (intra-repo) | 2.9k stars, pushed 2026-09-09 | One repository, one machine, generated files. Solves tool fan-out, which D2 makes unnecessary (`AGENTS.md` + `@AGENTS.md`). No cross-repo, no revision tracking, no PR. |
| [rulesync](https://github.com/dyoshikawa/rulesync) | `.rulesync/` → rules, commands, subagents, skills, MCP, hooks, permissions for ~20 tools; `--check` for CI; import from existing files. Retiring Gemini CLI → Antigravity mapping shows how fast targets churn. | A2 (intra-repo) | 1.4k stars, pushed 2026-09-14 | Same as ruler with broader feature matrix. Its `--check` (drift of generated files) is the intra-repo cousin of rulecheck's `modified` status. |
| [agents-md-sync](https://github.com/trick77/agents-md-sync) | Central template repo of fragments → composes whole `AGENTS.md` per target from local checkouts, per-repo addenda in `.agents/*.md`, commits on a tool-owned branch, force-pushes, opens/updates PR via adapter. Dry-run by default. | A2 (cross-repo) | 2 stars, pushed 2026-09-13 | Nearest functional overlap with D6. Differences: owns the *whole* file (addenda live in a side directory) instead of a marked block inside a human-owned file; needs local checkouts (D6 targets the remote); no status report (current / outdated / modified), no shape normalization, single template set (no named packs, D7). |
| [sync-rules](https://www.npmjs.com/package/sync-rules) | Central rules dir + globs → writes `AGENTS.md` and `CLAUDE.md` (`@AGENTS.md`) into each local project; also writes global files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`). | A2 (cross-repo, local) | npm only, no visible repo traction | Same canonical shape as D2. Local filesystem writes, no PR, no drift detection, whole-file overwrite. |
| [agentsync (mujinlabs)](https://github.com/mujinlabs/agentsync), [agentsync/rulesync (obielin)](https://github.com/obielin/agentsync) | One canonical file → mirrors (`CLAUDE.md`, Copilot, `.mdc`) with a CI drift check. | A2 (intra-repo) | 0–1 stars, pushed 2026-04/06 | Intra-repo mirrors; D2 avoids the mirrors entirely. |
| [vercel-labs/skills](https://github.com/vercel-labs/skills) (`npx skills`, skills.sh) | Installs skills from GitHub into `.agents/skills/` (symlinked into 70+ agents' dirs), project or global scope; `skills-lock.json` with source + `computedHash`; `skills check` for upstream updates; `experimental_install` restores from lock. Registry at skills.sh. | A2 (skills) | 31.6k stars, pushed 2026-09-14 | This *is* the package manager for skills, with a lockfile that already models source + revision + hash. It runs per repository from a developer machine; there is no fleet view ("which of my 76 repos are behind on skill X") and no PR-based update fan-out. rulecheck should read `skills-lock.json` rather than define its own skill manifest. |
| [agentskills-cli](https://github.com/mysticmind/agentskills-cli) | .NET port of `npx skills` adding NuGet/npm sources; shares lockfile format. | A2 (skills) | 3 stars | Confirms `skills-lock.json` as the de facto format. |
| [Agent Plugins](https://agent-plugins.org) standard (Cursor, OpenAI, Amazon, Microsoft, Vercel on the TSC) + [Cursor Marketplace / team marketplaces](https://cursor.com/docs/plugins) + [Claude Code plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) | Plugins bundle skills + MCP servers (portable core) and, per vendor, rules/hooks/commands. Team marketplaces (Cursor Teams/Enterprise) install plugins as Default Off / Default On / Required for a group; Claude Code private marketplaces via `/plugin marketplace add`, restrictable with `strictKnownMarketplaces`. | A2, A3 | Vendor-backed; `anthropics/claude-plugins-official` 36k stars, `cursor/community-plugins` 4k | Distribution unit is the *user/client install*, not the repository: a fresh clone in a cloud agent gets nothing unless the org's client policy installs the plugin. Claude Code plugins cannot ship `CLAUDE.md`/rules at all ([issue #21163](https://github.com/anthropics/claude-code/issues/21163) open). Repo-resident `AGENTS.md` remains the only vendor-neutral channel, which is D4's premise. |
| [cursor.directory](https://cursor.directory), skills.sh, [anthropics/skills](https://github.com/anthropics/skills) | Public catalogs of rules / skills. | A2 (registry) | cursor.directory ~88k contributors; anthropics/skills 176k stars | Discovery and copy-paste, not distribution or health. Not a competitor; a possible pack *source*. |

## A3: Enterprise governance of agent configuration

Every first-party vendor now ships org-level *policy* (MCP allow/deny, hooks, permissions) and
org-level *instructions*, but the instructions channel is client-side, per vendor, and does not
land in the repository.

| Vendor / product | What it covers | Areas | Maturity | Gap versus rulecheck |
|---|---|---|---|---|
| Anthropic, [Claude Code managed settings](https://code.claude.com/docs/en/admin-setup) | `managed-settings.json` / MDM / [server-managed](https://code.claude.com/docs/en/server-managed-settings) (Teams, Enterprise): `allowedMcpServers`, `deniedMcpServers`, `allowManagedMcpServersOnly`, `managed-mcp.json`, hooks, `strictKnownMarketplaces`, and a managed `claudeMd` string injected into every session. | A3 | Shipping; server-managed is org-wide only (no per-group yet) | `claudeMd` is one blob for the whole org, uniform, unversioned, invisible in the repo, Claude-only. Cloud (`claude.ai` web) sessions get only the repo clone plus server-managed settings (tool-behavior.md), so repo-resident content still matters. No health view of what repos actually contain. |
| Cursor, [Team Rules](https://cursor.com/docs/rules), [MCP Allowlist](https://cursor.com/docs/enterprise/model-and-integration-management), [team/enterprise hooks](https://cursor.com/docs/hooks) | Team Rules: dashboard text, optional glob, "Enforce" flag; precedence Team → Project → User. Enterprise: MCP allowlist by command/URL with per-server tool and network policy; hooks distributed from the dashboard to clients and cloud agents. | A3 | Teams / Enterprise plans | Team Rules are Cursor-only and dashboard-resident: Claude Code and Codex working on the same repo never see them. rulecheck's block reaches all tools but cannot be "enforced"; the two are complementary. |
| GitHub Copilot, [org custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-organization-instructions), [enterprise managed settings](https://docs.github.com/copilot/reference/enterprise-managed-settings-reference) | Org instructions apply to Copilot Chat on GitHub.com, code review and cloud agent (also picked up by VS Code when enabled). `managed-settings.json` in `.github-private`: MCP allow/deny, per-enterprise-team overridable keys. Copilot also reads `AGENTS.md`/`CLAUDE.md`. | A3 | GA | Same pattern: org instructions live in a vendor console, not in repos; no per-repo subscription; no view of drift between the console text and what repos carry. |
| OpenAI Codex, [managed configuration](https://developers.openai.com/codex/enterprise/managed-configuration) | `requirements.toml` (cloud-managed for Business/Enterprise, MDM, `/etc/codex`): approval policy, sandbox, MCP allowlist by name+identity, managed hooks, plugin marketplace sources. `AGENTS.md` layering `~/.codex` → repo → nested, 32 KiB cap. | A3 | Shipping | No org-level instruction channel at all; Codex depends entirely on repo `AGENTS.md`. The strongest argument for repository-resident distribution. |
| [Endor Labs Coding Agent Governance](https://docs.endorlabs.com/agent-governance/how-it-works), [Permit Coding Agents Gateway](https://www.permit.io/coding-agents-gateway), [MintMCP](https://www.mintmcp.com/blog/claude-code-monitoring), [Stacklok ToolHive](https://github.com/stacklok/toolhive) (2.2k stars), [Preloop](https://github.com/preloop/preloop) (61 stars), [agent-bom](https://github.com/msaad00/agent-bom) (31 stars) | Runtime governance: endpoint hooks or proxies for Claude Code / Cursor / Codex / Copilot, MCP gateways with tool-level RBAC, inventory of MCP servers found in agent config files, SIEM export, policy-as-code. | A3 (runtime) | Funded security vendors plus OSS control planes; active 2026-09 | All govern *what agents do at runtime*, not *what instructions repos carry*. Inventory of MCP config files is a thin overlap with a later rulecheck step (MCP/hooks reporting). Not competitors for Rules/Skills; potential integration targets. |

## A4: General multi-repo file sync

Mature, generic, and blind to Markdown semantics. Each could carry rulecheck's PR mechanics but
none knows what a managed block, a wrapper file, or a token budget is.

| Name | What it does | Maturity | Gap versus rulecheck |
|---|---|---|---|
| [repo-file-sync-action](https://github.com/BetaHuhn/repo-file-sync-action) and the maintained fork [step-security/repo-file-sync-action](https://github.com/step-security/repo-file-sync-action); [files-sync-action](https://github.com/wadackel/files-sync-action) | GitHub Action in a source repo: `sync.yml` maps files/dirs → target repos, opens PRs, labels for auto-merge, Nunjucks/EJS templating, fork-based mode. | BetaHuhn 367 stars, last push 2024-08 (stale); step-security fork active 2026-09; wadackel 36 stars | Whole-file replacement only; cannot merge a block into a file that also has repo-owned content. No status report, no eligibility check. Viable *transport* if rulecheck ever wants Actions-based delivery instead of `gh api`. |
| [multi-gitter](https://github.com/lindell/multi-gitter), [octoherd](https://github.com/octoherd/cli) | Run a script across N repos (GitHub, GitLab, Gitea, Bitbucket), open PRs, `status`, `merge`, `close`; octoherd is the JS-scripted equivalent. | 1.2k stars, pushed 2026-09-06; octoherd 100 stars | Generic executor. rulecheck's step 5 (`sync --all`) is a specialized multi-gitter run; the value is in the deterministic block writer and the status model, not in PR plumbing. Could wrap rulecheck as the script. |
| [Renovate](https://github.com/renovatebot/renovate) shareable presets | `extends: ["github>org/renovate-config"]` for Renovate *config*. Discussion [#24730](https://github.com/renovatebot/renovate/discussions/24730) proposes a `file` manager to keep arbitrary files in sync from a source repo with a pinned commit. | 22.5k stars; file manager not shipped | Presets are the mental model for packs and subscriptions (D7), and Renovate's PR cadence, dashboards and `rev` pinning are the UX rulecheck imitates. Renovate cannot merge a block into Markdown; if the `file` manager lands it would compete on whole-file sync only. |
| [Probot Settings / repository-settings app](https://github.com/repository-settings/app) | `.github/settings.yml` → repository settings via PRs, org-level defaults with `_extends`. | 1.1k stars, pushed 2026-09-10 | Governs repo *settings*, not file content. Its `_extends` inheritance is a good reference for pack inheritance if D7 ever grows it. |
| [Backstage](https://github.com/backstage/backstage) Scaffolder | Templates at repo creation time; catalog. | 34k stars | Creation-time only, no ongoing sync. Relevant only as a place where a future rulecheck status could surface. |

## Verdict

**Direct competitor:** none shipping. The closest is unrot: read-only fleet scan already, and a
Phase 3 plan that is D4/D6 almost verbatim (tagged blocks, source repo, PR-only, per-block opt-in).
It has one star and no timeline. agents-md-sync ships PR-based cross-repo sync but owns the whole
file and works from local checkouts. Everything else is either single-repo lint (agnix and a dozen
smaller ones) or intra-repo format fan-out (ruler, rulesync), which D2 makes unnecessary.

**Whitespace:** the combination rulecheck is building does not exist anywhere:

1. Fleet-wide *status*, not fleet-wide lint: shape per repo, cross-repo duplicate blocks, per-tool
   context budget, and per pack the state current / outdated / modified / eligible / blocked.
2. Managed block inside a human-owned `AGENTS.md`, with `source` / `rev` / `hash`, so a repo can
   carry team content and its own content in one file every tool reads. All syncers overwrite.
3. Remote-only delivery through PRs with measure-then-write (rot check of the pack against the
   target before the PR). Nobody else verifies the pack against the target repository.
4. Vendor-neutrality by construction. Every vendor's org-level instruction channel is client-side
   and vendor-specific (Cursor Team Rules, Claude `claudeMd`, Copilot org instructions), Codex has
   none, and cloud agents see only the clone. The repository is the one channel all four share;
   nobody is operating it as a distribution system.

**Do not rebuild:**

- Single-repo rule catalogs. agnix has 454 rules and an LSP; agentslint has SARIF. Keep
  rulecheck's rule set to what the fleet view needs (shape, budget, duplicates, rot, block status)
  and, if a per-file deep lint is wanted, shell out to or recommend agnix.
- `SKILL.md` validation. Use `skills-ref` semantics; report frontmatter validity, do not
  re-specify it.
- A skills manifest or registry. `skills-lock.json` (vercel-labs/skills) already records source
  and hash per skill and skills.sh is the registry; rulecheck's Skills step should read the lock
  and report fleet-wide drift against upstream.
- Tool-format fan-out (`.mdc`, Copilot instructions, `GEMINI.md`). ruler and rulesync do this;
  D2 says the canonical pair is enough.
- Runtime policy (MCP allowlists, hook enforcement). The vendors and the security vendors own it;
  rulecheck reports what config is committed, it does not enforce.
- PR plumbing beyond `gh api`. If fan-out needs scale, wrap multi-gitter or a GitHub App rather
  than reimplementing retries, rate limits and merge handling.

**Risk to watch:** a vendor adding "org instructions committed to repos as PRs" would erase point 4
for its own users; unrot or agents-md-sync adopting a marked-block model would erase point 2. Both
are cheap for them to build; rulecheck's defensible part is the status model and the
measure-then-write discipline, so those should land first (roadmap steps 2 and 3).

import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { reportFailure } from "./report/failure.ts";
import { renderText } from "./report/render.ts";
import { renderSync } from "./report/sync.ts";
import { resolvePacks } from "./scan/packs.ts";
import { scan } from "./scan/scan.ts";
import { sync } from "./sync/sync.ts";

const root = Argument.Directory("root", { mustExist: true }).pipe(
  Argument.withDescription("Directory to scan. Every git repository below it is inspected."),
  Argument.withDefault("."),
);

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit the full report as JSON instead of the text summary."),
  Flag.withDefault(false),
);

const all = Flag.Boolean("all").pipe(
  Flag.withAlias("a"),
  Flag.withDescription("Include repositories that have no instruction files."),
  Flag.withDefault(false),
);

const maxDepth = Flag.Int("max-depth").pipe(
  Flag.withDescription("Maximum directory depth to descend below root."),
  Flag.withDefault(12),
);

const personal = Flag.Boolean("personal").pipe(
  Flag.withDescription(
    "Include the personal layer (~/.claude/CLAUDE.md, its imports, ~/.claude/rules). Use --no-personal to skip.",
  ),
  Flag.withDefault(true),
);

const PACKS_DESCRIPTION =
  "Pack repository (packs/<id>/AGENTS.md, subscriptions.json): a local checkout directory, or owner/repo[@ref] read from GitHub via `gh api`.";

const packs = Flag.String("packs").pipe(
  Flag.withDescription(`${PACKS_DESCRIPTION} Adds the pack distribution report.`),
  Flag.optional,
);

const scanCommand = Command.make("scan", { root, json, all, maxDepth, personal, packs }, (config) =>
  Effect.gen(function* () {
    const home = config.personal ? (process.env.HOME ?? null) : null;
    const spec = Option.getOrNull(config.packs);
    const report = yield* scan(config.root, {
      maxDepth: config.maxDepth,
      home,
      packs: spec === null ? null : yield* resolvePacks(spec),
    });
    if (config.json) {
      yield* Console.log(JSON.stringify(report, null, 2));
      return;
    }
    yield* Console.log(renderText(report, { all: config.all }));
  }).pipe(Effect.catchTags({ PackSourceError: reportFailure, GitHubError: reportFailure })),
).pipe(
  Command.withDescription(
    "Find AGENTS.md, CLAUDE.md, .cursor/rules and related files across repositories and report their shape, duplicates, and context budget. Read-only.",
  ),
);

const target = Argument.String("repo").pipe(
  Argument.withDescription("Target repository on GitHub, as owner/repo."),
);

const pack = Flag.String("pack").pipe(
  Flag.withDescription(
    "Id of the pack to distribute (a packs/<id>/ directory in the pack repository).",
  ),
);

const syncPacks = Flag.String("packs").pipe(Flag.withDescription(PACKS_DESCRIPTION));

const base = Flag.String("base").pipe(
  Flag.withDescription(
    "Branch to base the change on. Defaults to the repository's default branch.",
  ),
  Flag.optional,
);

const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Measure and plan, print the diff, write nothing."),
  Flag.withDefault(false),
);

const syncCommand = Command.make(
  "sync",
  { repo: target, pack, packs: syncPacks, base, dryRun },
  (config) =>
    Effect.gen(function* () {
      const result = yield* sync({
        repo: config.repo,
        pack: config.pack,
        packs: config.packs,
        base: Option.getOrNull(config.base),
        dryRun: config.dryRun,
      });
      yield* Console.log(renderSync(result));
    }).pipe(
      Effect.catchTags({
        SyncRefused: reportFailure,
        PackSourceError: reportFailure,
        GitHubError: reportFailure,
      }),
    ),
).pipe(
  Command.withDescription(
    "Distribute a pack's AGENTS.md block into one GitHub repository as a pull request: re-scan the repository remotely, refuse when it is blocked or the block would introduce rot, otherwise push branch agent-rules/<pack> and open (or update) the pull request. Never writes to local checkouts.",
  ),
);

export const rulecheck = Command.make("rulecheck").pipe(
  Command.withDescription("Health check for AI coding agent instruction files."),
  Command.withSubcommands([scanCommand, syncCommand]),
);

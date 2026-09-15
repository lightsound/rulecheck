import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { renderText } from "./report/render.ts";
import { scan } from "./scan/scan.ts";

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

const packs = Flag.Directory("packs", { mustExist: true }).pipe(
  Flag.withDescription(
    "Checkout of the pack repository (packs/<id>/AGENTS.md, subscriptions.json). Adds the pack distribution report.",
  ),
  Flag.optional,
);

const scanCommand = Command.make("scan", { root, json, all, maxDepth, personal, packs }, (config) =>
  Effect.gen(function* () {
    const home = config.personal ? (process.env.HOME ?? null) : null;
    const report = yield* scan(config.root, {
      maxDepth: config.maxDepth,
      home,
      packs: Option.getOrNull(config.packs),
    });
    if (config.json) {
      yield* Console.log(JSON.stringify(report, null, 2));
      return;
    }
    yield* Console.log(renderText(report, { all: config.all }));
  }),
).pipe(
  Command.withDescription(
    "Find AGENTS.md, CLAUDE.md, .cursor/rules and related files across repositories and report their shape, duplicates, and context budget. Read-only.",
  ),
);

export const rulecheck = Command.make("rulecheck").pipe(
  Command.withDescription("Health check for AI coding agent instruction files."),
  Command.withSubcommands([scanCommand]),
);

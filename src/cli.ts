import { Console, Effect } from "effect";
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

const scanCommand = Command.make("scan", { root, json, all, maxDepth }, (config) =>
  Effect.gen(function* () {
    const report = yield* scan(config.root, { maxDepth: config.maxDepth });
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

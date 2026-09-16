import { Console, Effect, FileSystem, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import pkg from "../package.json" with { type: "json" };
import { reportFailure, reportIncomplete } from "./report/failure.ts";
import { renderHtml, renderSyncAllHtml } from "./report/html.ts";
import { renderText } from "./report/render.ts";
import { renderSync, renderSyncAll } from "./report/sync.ts";
import { resolvePacks } from "./scan/packs.ts";
import { scan } from "./scan/scan.ts";
import { syncAll } from "./sync/all.ts";
import { SyncFailed, SyncRefused, sync } from "./sync/sync.ts";

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

const html = Flag.File("html").pipe(
  Flag.withDescription(
    "Also write the report as a single self-contained HTML file (inline CSS, no scripts) at this path, for reading in a browser or printing.",
  ),
  Flag.optional,
);

/** The HTML report is output the user asked for, like stdout; it is the only file `scan` writes. */
const writeHtml = (path: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(path, content);
  });

const scanCommand = Command.make(
  "scan",
  { root, json, all, maxDepth, personal, packs, html },
  (config) =>
    Effect.gen(function* () {
      const home = config.personal ? (process.env.HOME ?? null) : null;
      const spec = Option.getOrNull(config.packs);
      const report = yield* scan(config.root, {
        maxDepth: config.maxDepth,
        home,
        packs: spec === null ? null : yield* resolvePacks(spec),
      });
      const htmlPath = Option.getOrNull(config.html);
      if (htmlPath !== null) {
        yield* writeHtml(htmlPath, renderHtml(report, { version: pkg.version, all: config.all }));
      }
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
  Argument.withDescription("Target repository on GitHub, as owner/repo. Omit with --all."),
  Argument.optional,
);

const pack = Flag.String("pack").pipe(
  Flag.withDescription(
    "Id of the pack to distribute (a packs/<id>/ directory in the pack repository). Required for one repository; with --all it restricts the run to that pack.",
  ),
  Flag.optional,
);

const syncPacks = Flag.String("packs").pipe(Flag.withDescription(PACKS_DESCRIPTION));

const syncAllFlag = Flag.Boolean("all").pipe(
  Flag.withDescription(
    "Run over every repository in subscriptions.json (one pull request per repository per pack). With --dry-run this is the remote distribution report.",
  ),
  Flag.withDefault(false),
);

const base = Flag.String("base").pipe(
  Flag.withDescription(
    "Branch to base the change on. Defaults to the repository's default branch. Not available with --all.",
  ),
  Flag.optional,
);

const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Measure and plan, print the diff, write nothing."),
  Flag.withDefault(false),
);

const syncCommand = Command.make(
  "sync",
  { repo: target, pack, packs: syncPacks, all: syncAllFlag, base, dryRun, html },
  (config) =>
    Effect.gen(function* () {
      const repo = Option.getOrNull(config.repo);
      const packId = Option.getOrNull(config.pack);
      const baseBranch = Option.getOrNull(config.base);
      if (config.all) {
        if (repo !== null || baseBranch !== null) {
          return yield* new SyncRefused({
            message:
              "--all takes no repository argument and no --base; each subscriber is synced on its default branch",
            status: null,
          });
        }
        const result = yield* syncAll({ packs: config.packs, pack: packId, dryRun: config.dryRun });
        const htmlPath = Option.getOrNull(config.html);
        if (htmlPath !== null) {
          yield* writeHtml(
            htmlPath,
            renderSyncAllHtml(result, {
              version: pkg.version,
              generatedAt: new Date().toISOString(),
            }),
          );
        }
        yield* Console.log(renderSyncAll(result));
        if (result.failed > 0) {
          return yield* reportIncomplete(
            `${result.failed} of ${result.rows.length} targets failed; see the rows marked failed`,
          );
        }
        return;
      }
      if (repo === null || packId === null) {
        return yield* new SyncRefused({
          message: "sync needs `<owner/repo> --pack <id>`, or `--all [--pack <id>]`",
          status: null,
        });
      }
      if (Option.isSome(config.html)) {
        return yield* new SyncRefused({
          message: "--html is available with --all only (the table is the report it renders)",
          status: null,
        });
      }
      const result = yield* sync({
        repo,
        pack: packId,
        packs: config.packs,
        base: baseBranch,
        dryRun: config.dryRun,
      });
      yield* Console.log(renderSync(result));
    }).pipe(
      Effect.catchTags({
        SyncRefused: reportFailure,
        SyncFailed: (e) => reportFailure(e.error),
        PackSourceError: reportFailure,
        GitHubError: reportFailure,
      }),
    ),
).pipe(
  Command.withDescription(
    "Distribute a pack's AGENTS.md block into GitHub repositories as pull requests: re-scan each repository remotely, refuse when it is blocked or the block would introduce rot, otherwise push branch agent-rules/<pack> and open (or update) the pull request. --all fans out over subscriptions.json; --all --dry-run is the remote distribution report. Never writes to local checkouts.",
  ),
);

export const rulecheck = Command.make("rulecheck").pipe(
  Command.withDescription("Health check for AI coding agent instruction files."),
  Command.withSubcommands([scanCommand, syncCommand]),
);

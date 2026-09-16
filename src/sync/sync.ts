import { Data, Effect, FileSystem, type Path, type Semaphore } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { foreignRegionDrift } from "../domain/block.ts";
import { statusLocation } from "../domain/pack.ts";
import { isRulecheckCommit, planSync, pullRequestText, type SyncPlan } from "../domain/sync.ts";
import type { Finding, Pack, PackStatusEntry, RepoReport } from "../domain/types.ts";
import {
  GitHub,
  type GitHubError,
  type GitHubService,
  type PullRequest,
  parseRepositorySpec,
  type RepositoryRef,
  repositoryName,
} from "../github/client.ts";
import {
  mountPath,
  repositorySnapshot,
  type Snapshot,
  snapshotFileSystem,
  withChanges,
} from "../github/fs.ts";
import { type LoadedPacks, type PackSourceError, resolvePacks } from "../scan/packs.ts";
import { scan } from "../scan/scan.ts";

/**
 * The write path (D10): measure the target on GitHub, plan the normalized root pair, measure the
 * planned tree, and only then create one commit, one branch (`agent-rules/<pack>`), and one pull
 * request through the GitHub API. An existing branch of that name is rewritten only when its tip
 * commit was written by rulecheck, and left alone when it already carries the planned content
 * with an open pull request (D14). Local checkouts are never touched.
 */

export interface SyncTargetOptions {
  /** `owner/repo`. */
  readonly repo: string;
  /** Branch to base the change on; the repository's default branch when null. */
  readonly base?: string | null;
  readonly dryRun: boolean;
  /** `--run-url`: the automated run issuing the write, linked from the pull request body (D23). */
  readonly runUrl?: string | null;
  /**
   * Serializes the write calls of concurrent targets (D14): GitHub asks for content-creating
   * requests not to run concurrently. Reads run in parallel regardless.
   */
  readonly writeLock?: Semaphore.Semaphore;
}

export interface SyncOptions extends SyncTargetOptions {
  readonly pack: string;
  /** `--packs`: directory or `owner/repo[@ref]`. */
  readonly packs: string;
}

/**
 * What one target's sync ended in (the sync outcomes of `docs/status-model.md`, less `refused`
 * and `failed`, which are errors of this path and become outcomes in `all.ts`). `status` is the
 * pack status measured on the base branch before anything else.
 */
export type SyncResult =
  | {
      /** The base branch already reads `current`; no branch or pull request was consulted. */
      readonly kind: "nothing-to-do";
      readonly repo: string;
      readonly status: PackStatusEntry;
    }
  | {
      /** Dry run: every check passed and this is what a real run would write. */
      readonly kind: "planned";
      readonly repo: string;
      readonly status: PackStatusEntry;
      readonly plan: SyncPlan;
      readonly base: string;
      readonly branch: string;
    }
  | {
      /** The tool-owned branch already carries the planned content and its pull request is open. */
      readonly kind: "up-to-date";
      readonly repo: string;
      readonly status: PackStatusEntry;
      readonly plan: SyncPlan;
      readonly base: string;
      readonly branch: string;
      readonly commit: string;
      readonly pullRequest: PullRequest;
    }
  | {
      /** `opened`: a new pull request; `updated`: the branch was rewritten under the open one. */
      readonly kind: "opened" | "updated";
      readonly repo: string;
      readonly status: PackStatusEntry;
      readonly plan: SyncPlan;
      readonly base: string;
      readonly branch: string;
      readonly commit: string;
      readonly pullRequest: PullRequest;
    };

/**
 * The sync did not write and says why. `status` is the pack status measured on the base branch
 * when the refusal came after that measurement (a `modified` or `blocked` row, rot the block
 * would introduce, a foreign branch); null when the target could not even be measured.
 */
export class SyncRefused extends Data.TaggedError("SyncRefused")<{
  readonly message: string;
  readonly status: PackStatusEntry | null;
}> {}

/**
 * GitHub failed after the base branch was measured (a read while checking the tool-owned branch,
 * or one of the write calls), so the measured status is known but the delivery is not. A
 * `GitHubError` before measurement escapes as itself: nothing about the target is known then.
 */
export class SyncFailed extends Data.TaggedError("SyncFailed")<{
  readonly error: GitHubError;
  readonly status: PackStatusEntry;
}> {}

export const branchFor = (pack: string): string => `agent-rules/${pack}`;

const ROOT_PAIR = ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"];

interface Measurement {
  readonly repo: RepoReport;
  readonly entry: PackStatusEntry;
  readonly contents: ReadonlyMap<string, string>;
}

/** Resolve `--packs`, pick the pack, and run the target path once. */
export const sync = (
  options: SyncOptions,
): Effect.Effect<
  SyncResult,
  SyncRefused | SyncFailed | PackSourceError | GitHubError | PlatformError,
  GitHub | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const loaded = yield* resolvePacks(options.packs);
    const pack = yield* selectPack(loaded, options.pack);
    return yield* syncTarget(options, loaded, pack);
  });

export const selectPack = (loaded: LoadedPacks, id: string): Effect.Effect<Pack, SyncRefused> => {
  const pack = loaded.packs.find((p) => p.id === id);
  return pack
    ? Effect.succeed(pack)
    : new SyncRefused({
        message: `pack \`${id}\` not found in ${loaded.source} (have: ${loaded.packs.map((p) => p.id).join(", ") || "none"})`,
        status: null,
      });
};

/**
 * One repository, one pack, packs already loaded. Measures the base branch first, so a block that
 * has merged reads `current` before any tool-owned branch or pull request is looked at.
 */
export const syncTarget = (
  options: SyncTargetOptions,
  loaded: LoadedPacks,
  pack: Pack,
): Effect.Effect<
  SyncResult,
  SyncRefused | SyncFailed | GitHubError | PlatformError,
  GitHub | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const parsed = parseRepositorySpec(options.repo);
    if (parsed === null || parsed.ref !== null) {
      return yield* new SyncRefused({
        message: `target must be owner/repo, got \`${options.repo}\``,
        status: null,
      });
    }
    const target = parsed.repo;
    const name = repositoryName(target);

    const base = options.base ?? (yield* github.getRepository(target)).defaultBranch;
    const baseSha = yield* github.getRef(target, `heads/${base}`);
    if (baseSha === null) {
      return yield* new SyncRefused({
        message: `branch \`${base}\` not found in ${name}`,
        status: null,
      });
    }

    const mount = mountPath(target);
    const snapshot = yield* repositorySnapshot(github, target, baseSha, mount);
    const before = yield* measure(snapshot, mount, name, loaded, pack);
    const context: Target = {
      github,
      options,
      loaded,
      pack,
      target,
      name,
      base,
      baseSha,
      snapshot,
      mount,
      before,
    };
    return yield* deliver(context).pipe(
      // The status is known from here on; a GitHub failure keeps it for the `sync --all` row.
      Effect.catchTag("GitHubError", (error) => new SyncFailed({ error, status: before.entry })),
    );
  });

/** One target after its base branch was measured. */
interface Target {
  readonly github: GitHubService;
  readonly options: SyncTargetOptions;
  readonly loaded: LoadedPacks;
  readonly pack: Pack;
  readonly target: RepositoryRef;
  readonly name: string;
  readonly base: string;
  readonly baseSha: string;
  readonly snapshot: Snapshot;
  readonly mount: string;
  readonly before: Measurement;
}

/** Decide, plan, measure again, and write (or report what would be written) for a measured target. */
const deliver = (
  context: Target,
): Effect.Effect<SyncResult, SyncRefused | GitHubError | PlatformError, Path.Path> =>
  Effect.gen(function* () {
    const { github, options, loaded, pack, target, name, base, baseSha, snapshot, mount, before } =
      context;
    // Every refusal from here on names the measured status, so a `sync --all` row shows it.
    const refuse = (message: string) => new SyncRefused({ message, status: before.entry });

    switch (before.entry.status) {
      case "current":
        return { kind: "nothing-to-do", repo: name, status: before.entry };
      case "not-subscribed":
        return yield* refuse(
          `${name} is not subscribed to \`${pack.id}\`; add it to subscriptions.json in ${loaded.source} first`,
        );
      case "modified":
        return yield* refuse(
          `${name} ${statusLocation(before.entry)}: block \`${pack.id}\` was edited in place (${before.entry.message}); a human must reconcile it`,
        );
      case "blocked":
        return yield* refuse(`${name} ${statusLocation(before.entry)}: ${before.entry.message}`);
      case "eligible":
      case "outdated":
        break;
    }

    const plan = planSync({
      shape: before.repo.shape,
      files: before.repo.files,
      contents: before.contents,
      blocks: before.repo.blocks,
      status: before.entry,
      pack,
      packOrder: loaded.packs.map((p) => p.id),
    });
    if ("reason" in plan) return yield* refuse(`${name}: ${plan.reason}`);

    const after = yield* measure(
      withChanges(snapshot, mount, plan.changes),
      mount,
      name,
      loaded,
      pack,
    );
    if (after.entry.status !== "current") {
      return yield* refuse(
        `${name}: the planned ${plan.blockFile} would read as ${after.entry.status} (${after.entry.message ?? "no detail"}); refusing to write`,
      );
    }
    // D15: the planner already asserted this on its changes; assert it again on the planned tree
    // as scanned, so the promise holds for what is written, not for what was intended.
    for (const path of ROOT_PAIR) {
      const drift = foreignRegionDrift(
        path,
        before.contents.get(path) ?? null,
        after.contents.get(path) ?? null,
      );
      if (drift !== null) return yield* refuse(`${name}: ${drift}; refusing to write`);
    }
    const introduced = newFindings(
      before.repo.findings,
      after.repo.findings,
      movesRootPairContent(plan),
    );
    if (introduced.length > 0) {
      const lines = introduced.map((f) => `  ${f.file}:${f.line}  ${f.message}`);
      return yield* refuse(
        `${name}: pack \`${pack.id}\` would introduce rot in this repository:\n${lines.join("\n")}`,
      );
    }

    const branch = branchFor(pack.id);
    const existing = yield* github.getRef(target, `heads/${branch}`);
    if (existing !== null) {
      const tip = yield* github.getCommit(target, existing);
      if (!isRulecheckCommit(tip.message)) {
        return yield* refuse(
          `${name}: branch \`${branch}\` exists but its tip commit (${existing.slice(0, 7)}) was not written by rulecheck; delete or rename the branch first`,
        );
      }
      // Idempotence (D14): the branch tip already holds every planned path as planned and its
      // pull request is open, so a rerun has nothing to deliver. A closed pull request or a stale
      // tip falls through to the rewrite.
      if (yield* treeMatchesPlan(github, target, tip.tree, plan)) {
        const open = yield* github.listOpenPullRequests(target, `${target.owner}:${branch}`);
        const pullRequest = open[0];
        if (pullRequest) {
          return {
            kind: "up-to-date",
            repo: name,
            status: before.entry,
            plan,
            base,
            branch,
            commit: existing,
            pullRequest,
          };
        }
      }
    }

    if (options.dryRun) {
      return { kind: "planned", repo: name, status: before.entry, plan, base, branch };
    }

    const writing = write(github, target, {
      baseSha,
      base,
      branch,
      branchExists: existing !== null,
      plan,
      pack,
      status: before.entry,
      runUrl: options.runUrl ?? null,
    });
    const gated = options.writeLock ? options.writeLock.withPermits(1)(writing) : writing;
    const { created, ...written } = yield* gated;
    return {
      kind: created ? "opened" : "updated",
      repo: name,
      status: before.entry,
      plan,
      base,
      branch,
      ...written,
    };
  });

/** Whether every planned path reads in `treeSha` exactly as the plan would write it. */
const treeMatchesPlan = (
  github: GitHubService,
  target: RepositoryRef,
  treeSha: string,
  plan: SyncPlan,
): Effect.Effect<boolean, GitHubError> =>
  Effect.gen(function* () {
    const tree = yield* github.getTree(target, treeSha);
    if (tree.truncated) return false;
    const decoder = new TextDecoder();
    for (const change of plan.changes) {
      const entry = tree.entries.find((e) => e.type === "blob" && e.path === change.path);
      if (change.after === null) {
        if (entry !== undefined) return false;
        continue;
      }
      if (entry === undefined) return false;
      const content = decoder.decode(yield* github.getBlob(target, entry.sha));
      if (content !== change.after) return false;
    }
    return true;
  });

/** Run the read-only scan over a snapshot and pick out the target's row for the pack. */
const measure = (
  snapshot: Snapshot,
  mount: string,
  name: string,
  loaded: LoadedPacks,
  pack: Pack,
): Effect.Effect<Measurement, SyncRefused | PlatformError, Path.Path> =>
  Effect.gen(function* () {
    const fs = snapshotFileSystem(snapshot);
    const report = yield* scan("/", { packs: loaded, home: null }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    const repo = report.repos.find((r) => r.root === mount);
    const entry = report.distribution?.entries.find(
      (e) => e.pack === pack.id && e.repo === repo?.name,
    );
    if (!repo || !entry) {
      return yield* new SyncRefused({
        message: `${name}: could not measure the repository tree`,
        status: null,
      });
    }
    const contents = new Map<string, string>();
    for (const file of repo.files) {
      if (!ROOT_PAIR.includes(file.relativePath)) continue;
      contents.set(file.relativePath, yield* fs.readFileString(file.path));
    }
    return { repo, entry, contents };
  });

/**
 * Whether the plan carries existing text from one root-pair file into another (`claude-only`,
 * `claude-canonical`, `both-full`): some root-pair file other than the one receiving the block
 * had content before and is rewritten or removed. A block update or a plain insert touches one
 * content file, and a wrapper created from nothing carries no text.
 */
function movesRootPairContent(plan: SyncPlan): boolean {
  return plan.changes.some(
    (change) =>
      change.path !== plan.blockFile && ROOT_PAIR.includes(change.path) && change.before !== null,
  );
}

/**
 * A finding is "known" by kind, value, and file. Only when the plan moves root-pair text does the
 * pair count as one file: rot that already existed in CLAUDE.md and travels into AGENTS.md must
 * not read as rot the pack introduced. Where nothing moves (an outdated block, a plain insert),
 * the same reference elsewhere in the pair does not excuse it in the block, and rot outside the
 * pair (a nested AGENTS.md, a rule file) never does.
 */
function findingKey(finding: Finding, pairIsOneFile: boolean): string {
  const scope = pairIsOneFile && ROOT_PAIR.includes(finding.file) ? "root-pair" : finding.file;
  return `${finding.kind}:${scope}:${finding.value}`;
}

function newFindings(
  before: ReadonlyArray<Finding>,
  after: ReadonlyArray<Finding>,
  pairIsOneFile: boolean,
): Finding[] {
  const known = new Set(before.map((f) => findingKey(f, pairIsOneFile)));
  return after.filter((f) => !known.has(findingKey(f, pairIsOneFile)));
}

interface WriteInput {
  readonly baseSha: string;
  readonly base: string;
  readonly branch: string;
  /** Whether `agent-rules/<pack>` already exists; ownership was verified by the caller. */
  readonly branchExists: boolean;
  readonly plan: SyncPlan;
  readonly pack: Pack;
  readonly status: PackStatusEntry;
  readonly runUrl: string | null;
}

/** The only function in rulecheck that issues GitHub writes. Every check has run by now. */
const write = (
  github: GitHubService,
  target: RepositoryRef,
  input: WriteInput,
): Effect.Effect<{ commit: string; pullRequest: PullRequest; created: boolean }, GitHubError> =>
  Effect.gen(function* () {
    const { baseSha, base, branch, plan, pack, status, runUrl } = input;
    const text = pullRequestText(plan, pack, status, runUrl);
    const baseCommit = yield* github.getCommit(target, baseSha);
    const tree = yield* github.createTree(
      target,
      baseCommit.tree,
      plan.changes.map((change) => ({ path: change.path, content: change.after })),
    );
    const commit = yield* github.createCommit(target, {
      message: `${text.title}\n\n${plan.actions.map((a) => `- ${a}`).join("\n")}`,
      tree,
      parents: [baseSha],
    });
    yield* github.setRef(target, `heads/${branch}`, commit, { create: !input.branchExists });

    const open = yield* github.listOpenPullRequests(target, `${target.owner}:${branch}`);
    const current = open[0];
    const pullRequest = current
      ? yield* github.updatePullRequest(target, current.number, text)
      : yield* github.createPullRequest(target, { ...text, head: branch, base });
    return { commit, pullRequest, created: current === undefined };
  });

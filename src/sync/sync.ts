import { Data, Effect, FileSystem, type Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { planSync, pullRequestText, type SyncPlan } from "../domain/sync.ts";
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
 * request through the GitHub API. Local checkouts are never touched.
 */

export interface SyncOptions {
  /** `owner/repo`. */
  readonly repo: string;
  readonly pack: string;
  /** `--packs`: directory or `owner/repo[@ref]`. */
  readonly packs: string;
  /** Branch to base the change on; the repository's default branch when null. */
  readonly base?: string | null;
  readonly dryRun: boolean;
}

export type SyncResult =
  | { readonly kind: "current"; readonly repo: string; readonly status: PackStatusEntry }
  | {
      readonly kind: "planned";
      readonly repo: string;
      readonly status: PackStatusEntry;
      readonly plan: SyncPlan;
      readonly base: string;
      readonly branch: string;
    }
  | {
      readonly kind: "written";
      readonly repo: string;
      readonly status: PackStatusEntry;
      readonly plan: SyncPlan;
      readonly base: string;
      readonly branch: string;
      readonly commit: string;
      readonly pullRequest: PullRequest;
      readonly pullRequestCreated: boolean;
    };

export class SyncRefused extends Data.TaggedError("SyncRefused")<{
  readonly message: string;
}> {}

export const branchFor = (pack: string): string => `agent-rules/${pack}`;

const ROOT_PAIR = ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"];

interface Measurement {
  readonly repo: RepoReport;
  readonly entry: PackStatusEntry;
  readonly contents: ReadonlyMap<string, string>;
}

export const sync = (
  options: SyncOptions,
): Effect.Effect<
  SyncResult,
  SyncRefused | PackSourceError | GitHubError | PlatformError,
  GitHub | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const parsed = parseRepositorySpec(options.repo);
    if (parsed === null || parsed.ref !== null) {
      return yield* new SyncRefused({
        message: `target must be owner/repo, got \`${options.repo}\``,
      });
    }
    const target = parsed.repo;
    const name = repositoryName(target);

    const loaded = yield* resolvePacks(options.packs);
    const pack = loaded.packs.find((p) => p.id === options.pack);
    if (!pack) {
      return yield* new SyncRefused({
        message: `pack \`${options.pack}\` not found in ${loaded.source} (have: ${loaded.packs.map((p) => p.id).join(", ") || "none"})`,
      });
    }

    const base = options.base ?? (yield* github.getRepository(target)).defaultBranch;
    const baseSha = yield* github.getRef(target, `heads/${base}`);
    if (baseSha === null) {
      return yield* new SyncRefused({ message: `branch \`${base}\` not found in ${name}` });
    }

    const mount = mountPath(target);
    const snapshot = yield* repositorySnapshot(github, target, baseSha, mount);
    const before = yield* measure(snapshot, mount, name, loaded, pack);

    switch (before.entry.status) {
      case "current":
        return { kind: "current", repo: name, status: before.entry };
      case "not-subscribed":
        return yield* new SyncRefused({
          message: `${name} is not subscribed to \`${pack.id}\`; add it to subscriptions.json in ${loaded.source} first`,
        });
      case "modified":
        return yield* new SyncRefused({
          message: `${name} ${where(before.entry)}: block \`${pack.id}\` was edited in place (${before.entry.message}); a human must reconcile it`,
        });
      case "blocked":
        return yield* new SyncRefused({
          message: `${name} ${where(before.entry)}: ${before.entry.message}`,
        });
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
    if ("reason" in plan) return yield* new SyncRefused({ message: `${name}: ${plan.reason}` });

    const after = yield* measure(
      withChanges(snapshot, mount, plan.changes),
      mount,
      name,
      loaded,
      pack,
    );
    if (after.entry.status !== "current") {
      return yield* new SyncRefused({
        message: `${name}: the planned ${plan.blockFile} would read as ${after.entry.status} (${after.entry.message ?? "no detail"}); refusing to write`,
      });
    }
    const introduced = newFindings(before.repo.findings, after.repo.findings);
    if (introduced.length > 0) {
      const lines = introduced.map((f) => `  ${f.file}:${f.line}  ${f.message}`);
      return yield* new SyncRefused({
        message: `${name}: pack \`${pack.id}\` would introduce rot in this repository:\n${lines.join("\n")}`,
      });
    }

    const branch = branchFor(pack.id);
    if (options.dryRun) {
      return { kind: "planned", repo: name, status: before.entry, plan, base, branch };
    }

    const written = yield* write(github, target, baseSha, base, branch, plan, pack, before.entry);
    return { kind: "written", repo: name, status: before.entry, plan, base, branch, ...written };
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
      return yield* new SyncRefused({ message: `${name}: could not measure the repository tree` });
    }
    const contents = new Map<string, string>();
    for (const file of repo.files) {
      if (!ROOT_PAIR.includes(file.relativePath)) continue;
      contents.set(file.relativePath, yield* fs.readFileString(file.path));
    }
    return { repo, entry, contents };
  });

function findingKey(finding: Finding): string {
  return `${finding.kind}:${finding.file}:${finding.value}`;
}

function newFindings(before: ReadonlyArray<Finding>, after: ReadonlyArray<Finding>): Finding[] {
  const known = new Set(before.map(findingKey));
  return after.filter((f) => !known.has(findingKey(f)));
}

function where(entry: PackStatusEntry): string {
  if (entry.file === null) return "";
  return entry.line === null ? entry.file : `${entry.file}:${entry.line}`;
}

const write = (
  github: GitHubService,
  target: RepositoryRef,
  baseSha: string,
  base: string,
  branch: string,
  plan: SyncPlan,
  pack: Pack,
  status: PackStatusEntry,
): Effect.Effect<
  { commit: string; pullRequest: PullRequest; pullRequestCreated: boolean },
  GitHubError
> =>
  Effect.gen(function* () {
    const text = pullRequestText(plan, pack, status);
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
    const existing = yield* github.getRef(target, `heads/${branch}`);
    yield* github.setRef(target, `heads/${branch}`, commit, { create: existing === null });

    const open = yield* github.listOpenPullRequests(target, `${target.owner}:${branch}`);
    const current = open[0];
    const pullRequest = current
      ? yield* github.updatePullRequest(target, current.number, text)
      : yield* github.createPullRequest(target, { ...text, head: branch, base });
    return { commit, pullRequest, pullRequestCreated: current === undefined };
  });

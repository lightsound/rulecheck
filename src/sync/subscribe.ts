import { Effect } from "effect";
import {
  planSubscriptionChanges,
  type SubscriptionChange,
  sameSubscriptions,
  subscriptionDiff,
} from "../domain/subscriptions.ts";
import { COMMIT_PREFIX, isRulecheckCommit } from "../domain/sync.ts";
import {
  GitHub,
  type GitHubError,
  type GitHubService,
  type PullRequest,
  parseRepositorySpec,
  type RepositoryRef,
  repositoryName,
} from "../github/client.ts";
import { SyncFailed, SyncRefused, type WriteLock } from "./sync.ts";

/**
 * The D25 subscriptions writer (D32): change which repositories `subscriptions.json` of the
 * pack repository lists, as one commit. `pull-request` mode writes the branch
 * `rulecheck/subscriptions` and one open pull request that carries every pending change (the
 * basket of m2-kickoff decision 5); `direct-commit` mode fast-forwards the base branch and
 * retries once on a head that moved. The order is `syncTarget`'s: measure (the file at the base
 * head, and the pending set on the tool-owned branch), plan, measure the plan, then write, the
 * write under the caller's `WriteLock`. Nothing here reads a subscriber; the pack repository is
 * the only repository touched.
 */

export const SUBSCRIPTIONS_PATH = "subscriptions.json";
export const SUBSCRIPTIONS_BRANCH = "rulecheck/subscriptions";
const COMMIT_SUBJECT = `${COMMIT_PREFIX} update subscriptions`;

export interface SubscribeOptions {
  /** The pack repository, `owner/repo`. */
  readonly source: string;
  /** Branch to change; the repository's default branch when null. */
  readonly base?: string | null;
  readonly changes: ReadonlyArray<SubscriptionChange>;
  readonly mode: "pull-request" | "direct-commit";
  readonly dryRun: boolean;
  /** The App run or page that issued the change, linked from the pull request body. */
  readonly runUrl?: string | null;
  readonly writeLock?: WriteLock;
}

export type SubscribeResult =
  | {
      /** The base file already encodes the requested state and nothing is pending. */
      readonly kind: "nothing-to-do";
      readonly source: string;
    }
  | {
      /** Dry run: what a real run would write. */
      readonly kind: "planned";
      readonly source: string;
      readonly text: string;
      /** Pending changes from the branch plus the applied ones, in that order. */
      readonly changes: ReadonlyArray<SubscriptionChange>;
      readonly base: string;
    }
  | {
      /** `rulecheck/subscriptions` already holds the planned text under an open pull request. */
      readonly kind: "up-to-date";
      readonly source: string;
      readonly text: string;
      readonly changes: ReadonlyArray<SubscriptionChange>;
      readonly base: string;
      readonly commit: string;
      readonly pullRequest: PullRequest;
    }
  | {
      readonly kind: "opened" | "updated";
      readonly source: string;
      readonly text: string;
      readonly changes: ReadonlyArray<SubscriptionChange>;
      readonly base: string;
      readonly commit: string;
      readonly pullRequest: PullRequest;
    }
  | {
      /** `direct-commit`: the base branch now points at this commit. */
      readonly kind: "committed";
      readonly source: string;
      readonly text: string;
      readonly changes: ReadonlyArray<SubscriptionChange>;
      readonly base: string;
      readonly commit: string;
    };

/** The pull request that carries pending changes; `runUrl` is the App page that wrote it. */
export function subscriptionPullRequestText(
  changes: ReadonlyArray<SubscriptionChange>,
  runUrl: string | null,
): { title: string; body: string } {
  const lines = changes.map(
    (c) =>
      `- ${c.op === "add" ? "subscribe" : "unsubscribe"} \`${c.repo}\` ${c.op === "add" ? "to" : "from"} \`${c.pack}\``,
  );
  return {
    title: COMMIT_SUBJECT,
    body: [
      `Managed by rulecheck. This branch carries every pending subscription change and is rewritten on each one; merge it to apply them, close it to drop them.`,
      "",
      "Changes:",
      ...lines,
      ...(runUrl === null ? [] : ["", `Written from [this page](${runUrl}).`]),
    ].join("\n"),
  };
}

/** `subscriptions.json` at a commit, or null when the commit has no such file. */
const readFileAt = (
  github: GitHubService,
  repo: RepositoryRef,
  commitSha: string,
): Effect.Effect<{ text: string | null; tree: string }, GitHubError> =>
  Effect.gen(function* () {
    const commit = yield* github.getCommit(repo, commitSha);
    const tree = yield* github.getTree(repo, commit.tree, { recursive: false });
    const entry = tree.entries.find((e) => e.type === "blob" && e.path === SUBSCRIPTIONS_PATH);
    if (entry === undefined) return { text: null, tree: commit.tree };
    const bytes = yield* github.getBlob(repo, entry.sha);
    return { text: new TextDecoder().decode(bytes), tree: commit.tree };
  });

interface Planned {
  readonly text: string;
  readonly changes: ReadonlyArray<SubscriptionChange>;
}

/** base text + pending + requested changes, measured again by parsing the result. */
const plan = (
  baseText: string | null,
  pending: ReadonlyArray<SubscriptionChange>,
  changes: ReadonlyArray<SubscriptionChange>,
  source: string,
): Effect.Effect<Planned, SyncRefused> =>
  Effect.gen(function* () {
    const planned = planSubscriptionChanges(baseText, [...pending, ...changes]);
    if ("reason" in planned) {
      return yield* new SyncRefused({ message: `${source}: ${planned.reason}`, status: null });
    }
    // Second measurement: the planned text must encode the net intent for every pair touched
    // (a pending add followed by a requested remove nets to "absent").
    const net = new Map<string, SubscriptionChange>();
    for (const change of planned.applied) net.set(`${change.pack}\u0000${change.repo}`, change);
    for (const change of net.values()) {
      const repos = planned.sets.get(change.pack) ?? [];
      const present = repos.includes(change.repo);
      if (present !== (change.op === "add")) {
        return yield* new SyncRefused({
          message: `${source}: the planned subscriptions.json does not reflect ${change.op} ${change.repo} for ${change.pack}; refusing to write`,
          status: null,
        });
      }
    }
    return { text: planned.text, changes: planned.applied };
  });

const commitFile = (
  github: GitHubService,
  repo: RepositoryRef,
  baseTree: string,
  parent: string,
  text: string,
  changes: ReadonlyArray<SubscriptionChange>,
): Effect.Effect<string, GitHubError> =>
  Effect.gen(function* () {
    const tree = yield* github.createTree(repo, baseTree, [
      { path: SUBSCRIPTIONS_PATH, content: text },
    ]);
    return yield* github.createCommit(repo, {
      message: `${COMMIT_SUBJECT}\n\n${changes.map((c) => `- ${c.op} ${c.repo} (${c.pack})`).join("\n")}`,
      tree,
      parents: [parent],
    });
  });

export const subscribe = (
  options: SubscribeOptions,
): Effect.Effect<SubscribeResult, SyncRefused | SyncFailed | GitHubError, GitHub> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const parsed = parseRepositorySpec(options.source);
    if (parsed === null || parsed.ref !== null) {
      return yield* new SyncRefused({
        message: `source must be owner/repo, got \`${options.source}\``,
        status: null,
      });
    }
    const repo = parsed.repo;
    const source = repositoryName(repo);
    const refuse = (message: string) =>
      new SyncRefused({ message: `${source}: ${message}`, status: null });
    // After the base is measured, a GitHub failure is a `SyncFailed` (status null: no pack status
    // is involved here), so a caller can tell "could not measure" from "could not deliver".
    const failed = (error: GitHubError) => new SyncFailed({ error, status: null });

    const info = yield* github.getRepository(repo);
    const base = options.base ?? info.defaultBranch;
    const baseSha = yield* github.getRef(repo, `heads/${base}`);
    if (baseSha === null) return yield* refuse(`branch \`${base}\` does not exist`);
    const baseFile = yield* readFileAt(github, repo, baseSha);

    if (options.mode === "direct-commit") {
      const planned = yield* plan(baseFile.text, [], options.changes, source);
      if (sameSubscriptions(baseFile.text, planned.text)) return { kind: "nothing-to-do", source };
      if (options.dryRun)
        return { kind: "planned", source, text: planned.text, changes: planned.changes, base };
      const write = Effect.gen(function* () {
        // First try on the measured head; on a head that moved, plan once more on top of the new
        // head (the file may have changed there) and try once; a second 422 is a refusal (D25).
        let head = baseSha;
        let file = baseFile;
        let current = planned;
        for (let attempt = 0; ; attempt++) {
          const commit = yield* commitFile(
            github,
            repo,
            file.tree,
            head,
            current.text,
            current.changes,
          ).pipe(Effect.mapError(failed));
          const moved = yield* github
            .setRef(repo, `heads/${base}`, commit, { create: false, force: false })
            .pipe(
              Effect.map(() => false),
              Effect.catch((error) =>
                error.status === 422 ? Effect.succeed(true) : Effect.fail(failed(error)),
              ),
            );
          if (!moved)
            return {
              kind: "committed" as const,
              source,
              text: current.text,
              changes: current.changes,
              base,
              commit,
            };
          if (attempt >= 1) {
            return yield* refuse(
              `branch \`${base}\` moved twice while writing subscriptions.json; retry`,
            );
          }
          const newHead = yield* github.getRef(repo, `heads/${base}`).pipe(Effect.mapError(failed));
          if (newHead === null)
            return yield* refuse(`branch \`${base}\` disappeared while writing`);
          head = newHead;
          file = yield* readFileAt(github, repo, head).pipe(Effect.mapError(failed));
          current = yield* plan(file.text, [], options.changes, source);
          if (sameSubscriptions(file.text, current.text)) {
            // Someone else landed the same change meanwhile.
            return { kind: "nothing-to-do" as const, source };
          }
        }
      });
      return yield* options.writeLock ? options.writeLock.withPermits(1)(write) : write;
    }

    // pull-request mode: the pending set lives on the tool-owned branch.
    const tipSha = yield* github.getRef(repo, `heads/${SUBSCRIPTIONS_BRANCH}`);
    let pending: ReadonlyArray<SubscriptionChange> = [];
    let tipText: string | null = null;
    if (tipSha !== null) {
      const tip = yield* github.getCommit(repo, tipSha);
      if (!isRulecheckCommit(tip.message)) {
        return yield* refuse(
          `branch \`${SUBSCRIPTIONS_BRANCH}\` exists but its tip commit (${tipSha.slice(0, 7)}) was not written by rulecheck; delete or rename the branch first`,
        );
      }
      tipText = (yield* readFileAt(github, repo, tipSha)).text;
      const diff = subscriptionDiff(baseFile.text, tipText);
      if (diff === null)
        return yield* refuse(
          `subscriptions.json on \`${SUBSCRIPTIONS_BRANCH}\` is not the expected object shape`,
        );
      pending = diff;
    }
    const planned = yield* plan(baseFile.text, pending, options.changes, source);
    const open = yield* github.listOpenPullRequests(repo, `${repo.owner}:${SUBSCRIPTIONS_BRANCH}`);
    const pullRequest = open[0];
    if (sameSubscriptions(baseFile.text, planned.text)) {
      if (pullRequest !== undefined) {
        return yield* refuse(
          `the requested state equals \`${base}\` while pull request #${pullRequest.number} (${pullRequest.url}) is open with pending changes; close it to drop them`,
        );
      }
      return { kind: "nothing-to-do", source };
    }
    if (tipSha !== null && pullRequest !== undefined && sameSubscriptions(tipText, planned.text)) {
      return {
        kind: "up-to-date",
        source,
        text: planned.text,
        changes: planned.changes,
        base,
        commit: tipSha,
        pullRequest,
      };
    }
    if (options.dryRun)
      return { kind: "planned", source, text: planned.text, changes: planned.changes, base };

    const text = subscriptionPullRequestText(planned.changes, options.runUrl ?? null);
    const write = Effect.gen(function* () {
      const commit = yield* commitFile(
        github,
        repo,
        baseFile.tree,
        baseSha,
        planned.text,
        planned.changes,
      );
      yield* github.setRef(repo, `heads/${SUBSCRIPTIONS_BRANCH}`, commit, {
        create: tipSha === null,
      });
      const result = pullRequest
        ? yield* github.updatePullRequest(repo, pullRequest.number, text)
        : yield* github.createPullRequest(repo, { ...text, head: SUBSCRIPTIONS_BRANCH, base });
      return {
        kind: pullRequest ? ("updated" as const) : ("opened" as const),
        source,
        text: planned.text,
        changes: planned.changes,
        base,
        commit,
        pullRequest: result,
      };
    }).pipe(Effect.mapError(failed));
    return yield* options.writeLock ? options.writeLock.withPermits(1)(write) : write;
  });

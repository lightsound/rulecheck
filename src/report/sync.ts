import { diffStats, unifiedDiff } from "../domain/diff.ts";
import { statusLocation } from "../domain/pack.ts";
import type { SyncPlan } from "../domain/sync.ts";
import type { SyncAllResult, SyncOutcome } from "../sync/all.ts";
import type { SyncResult } from "../sync/sync.ts";
import { renderFailure } from "./failure.ts";
import { OUTCOME_LABEL, OUTCOME_ORDER, STATUS_LABEL, UNMEASURED } from "./labels.ts";

/**
 * One target: the measured status, the outcome (`docs/status-model.md`), and its detail. The
 * status is always the pack status of the base branch; the outcome is what the sync did about it.
 */
export function renderSync(result: SyncResult): string {
  const out: string[] = [];
  const status = STATUS_LABEL[result.status.status];
  const outcome = OUTCOME_LABEL[result.kind];
  switch (result.kind) {
    case "nothing-to-do":
      out.push(
        `${result.repo}: block \`${result.status.pack}\` is ${status} (${statusLocation(result.status)}); ${outcome}`,
      );
      break;
    case "planned":
      out.push(
        `${result.repo}: ${status} (${result.status.message ?? ""}) -> ${outcome}; dry run, nothing written`,
      );
      out.push(
        `would push branch ${result.branch} on top of ${result.base} and open a pull request:`,
      );
      for (const action of result.plan.actions) out.push(`  - ${action}`);
      out.push("");
      for (const change of result.plan.changes) {
        out.push(unifiedDiff(change));
        out.push("");
      }
      break;
    case "up-to-date":
      out.push(`${result.repo}: ${status} -> ${outcome}; pull request ${result.pullRequest.url}`);
      out.push(
        `branch ${result.branch} (commit ${result.commit.slice(0, 7)}) already carries the planned change; nothing written`,
      );
      break;
    case "opened":
    case "updated":
      out.push(`${result.repo}: ${status} -> ${outcome} pull request ${result.pullRequest.url}`);
      out.push(
        `branch ${result.branch} (commit ${result.commit.slice(0, 7)}) on top of ${result.base}`,
      );
      for (const action of result.plan.actions) out.push(`  - ${action}`);
      break;
  }
  return out.join("\n").trimEnd();
}

/**
 * One row per target: repository, pack, the pack status measured on the default branch (`-` when
 * the target was never measured), and the outcome with its detail. Multi-line refusals keep their
 * detail lines indented.
 */
export function renderSyncAll(result: SyncAllResult): string {
  const out: string[] = [];
  const repoWidth = Math.max(10, ...result.rows.map((row) => row.target.repo.length));
  const packWidth = Math.max(4, ...result.rows.map((row) => row.target.pack.length));
  out.push(
    `Sync${result.dryRun ? " (dry run, nothing written)" : ""}: ${result.rows.length} targets from ${result.source}`,
  );
  out.push("");
  out.push(
    `  ${pad("repository", repoWidth)}  ${pad("pack", packWidth)}  ${pad("status", 14)}  outcome`,
  );
  for (const row of result.rows) {
    const [first, ...rest] = describe(row.outcome).split("\n");
    out.push(
      `  ${pad(row.target.repo, repoWidth)}  ${pad(row.target.pack, packWidth)}  ${pad(statusOf(row.outcome), 14)}  ${first ?? ""}`.trimEnd(),
    );
    for (const line of rest) out.push(`  ${" ".repeat(repoWidth + packWidth + 20)}${line.trim()}`);
  }
  out.push("");
  out.push(summary(result));
  return out.join("\n").trimEnd();
}

/** The pack status the target measured, or `-` when it never got that far. */
function statusOf(outcome: SyncOutcome): string {
  return outcome.status === null ? UNMEASURED : STATUS_LABEL[outcome.status.status];
}

/** The outcome label followed by its detail. */
function describe(outcome: SyncOutcome): string {
  const label = OUTCOME_LABEL[outcome.kind];
  switch (outcome.kind) {
    case "refused":
      return `${label}: ${outcome.message}`;
    case "failed":
      return `${label}: ${
        outcome.error._tag === "GitHubError"
          ? renderFailure(outcome.error).replace(/^rulecheck: /, "")
          : outcome.error.message
      }`;
    case "nothing-to-do":
      return `${label} (block at ${statusLocation(outcome.status)})`;
    case "up-to-date":
      return `${label} (PR #${outcome.pullRequest.number} open, ${outcome.pullRequest.url})`;
    case "planned":
      return `${label} ${diffSummary(outcome.plan)}: ${outcome.plan.actions.join("; ")}`;
    case "opened":
    case "updated":
      return `${label} PR #${outcome.pullRequest.number} (${outcome.pullRequest.url})`;
  }
}

function diffSummary(plan: SyncPlan): string {
  let added = 0;
  let removed = 0;
  for (const change of plan.changes) {
    const stats = diffStats(change);
    added += stats.added;
    removed += stats.removed;
  }
  return `+${added} -${removed}`;
}

/** Counts per outcome, in glossary order, skipping outcomes that did not occur. */
function summary(result: SyncAllResult): string {
  const parts = OUTCOME_ORDER.map((kind) => {
    const count = result.rows.filter((row) => row.outcome.kind === kind).length;
    return count === 0 ? null : `${count} ${OUTCOME_LABEL[kind]}`;
  }).filter((part) => part !== null);
  return `${result.rows.length} targets: ${parts.join(", ") || "none"}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

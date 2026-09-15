import { diffStats, unifiedDiff } from "../domain/diff.ts";
import type { SyncPlan } from "../domain/sync.ts";
import type { SyncAllResult, SyncAllRow } from "../sync/all.ts";
import type { SyncResult } from "../sync/sync.ts";
import { renderFailure } from "./failure.ts";

export function renderSync(result: SyncResult): string {
  const out: string[] = [];
  switch (result.kind) {
    case "current":
      out.push(
        `${result.repo}: block \`${result.status.pack}\` is current (${result.status.file}:${result.status.line}); nothing to do`,
      );
      break;
    case "planned":
      out.push(
        `${result.repo}: ${result.status.status} (${result.status.message ?? ""}); dry run, nothing written`,
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
      out.push(
        `${result.repo}: ${result.status.status} -> pull request ${result.pullRequest.url} is up to date`,
      );
      out.push(
        `branch ${result.branch} (commit ${result.commit.slice(0, 7)}) already carries the planned change; nothing written`,
      );
      break;
    case "written":
      out.push(`${result.repo}: ${result.status.status} -> pull request ${result.pullRequest.url}`);
      out.push(
        `${result.pullRequestCreated ? "opened" : "updated"} from ${result.branch} (commit ${result.commit.slice(0, 7)}) into ${result.base}`,
      );
      for (const action of result.plan.actions) out.push(`  - ${action}`);
      break;
  }
  return out.join("\n").trimEnd();
}

/**
 * One row per target: repository, pack, remote status, and what happened (or, in a dry run, what
 * would happen and the size of the diff). Multi-line refusals keep their detail lines indented.
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
    `  ${pad("repository", repoWidth)}  ${pad("pack", packWidth)}  ${pad("status", 14)}  ${result.dryRun ? "planned action" : "result"}`,
  );
  for (const row of result.rows) {
    const [first, ...rest] = describe(row).split("\n");
    out.push(
      `  ${pad(row.target.repo, repoWidth)}  ${pad(row.target.pack, packWidth)}  ${pad(statusOf(row), 14)}  ${first ?? ""}`.trimEnd(),
    );
    for (const line of rest) out.push(`  ${" ".repeat(repoWidth + packWidth + 20)}${line.trim()}`);
  }
  out.push("");
  out.push(summary(result));
  return out.join("\n").trimEnd();
}

const STATUS_LABEL: Record<string, string> = {
  current: "current",
  outdated: "outdated",
  modified: "modified",
  eligible: "eligible",
  blocked: "blocked",
  "not-subscribed": "not subscribed",
};

function statusOf(row: SyncAllRow): string {
  if (row.outcome.kind === "done") {
    return STATUS_LABEL[row.outcome.result.status.status] ?? row.outcome.result.status.status;
  }
  return row.outcome.kind === "refused" ? "refused" : "failed";
}

function describe(row: SyncAllRow): string {
  switch (row.outcome.kind) {
    case "refused":
      return row.outcome.message;
    case "failed":
      return row.outcome.error._tag === "GitHubError"
        ? renderFailure(row.outcome.error).replace(/^rulecheck: /, "")
        : row.outcome.error.message;
    case "done": {
      const result = row.outcome.result;
      switch (result.kind) {
        case "current":
          return "nothing to do";
        case "up-to-date":
          return `up to date (PR #${result.pullRequest.number} open, ${result.pullRequest.url})`;
        case "planned":
          return `${diffSummary(result.plan)}  would open or update a pull request: ${result.plan.actions.join("; ")}`;
        case "written":
          return `${result.pullRequestCreated ? "opened" : "updated"} PR #${result.pullRequest.number} (${result.pullRequest.url})`;
      }
    }
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

function summary(result: SyncAllResult): string {
  const counts = new Map<string, number>();
  const bump = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1);
  for (const row of result.rows) {
    if (row.outcome.kind !== "done") {
      bump(row.outcome.kind);
      continue;
    }
    switch (row.outcome.result.kind) {
      case "current":
        bump("current");
        break;
      case "up-to-date":
        bump("up to date");
        break;
      case "planned":
        bump("would write");
        break;
      case "written":
        bump(row.outcome.result.pullRequestCreated ? "opened" : "updated");
        break;
    }
  }
  const parts = [...counts.entries()].map(([label, count]) => `${count} ${label}`);
  return `${result.rows.length} targets: ${parts.join(", ") || "none"}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

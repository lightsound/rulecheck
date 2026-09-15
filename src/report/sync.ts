import { unifiedDiff } from "../domain/diff.ts";
import type { SyncResult } from "../sync/sync.ts";

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

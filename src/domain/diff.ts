/**
 * Minimal unified diff for `--dry-run` output. Instruction files are small, so a quadratic LCS is
 * fine; the point is a readable preview, not a patch that `git apply` accepts byte for byte.
 */

export interface FileChange {
  /** Repo-relative path, `/` separated. */
  readonly path: string;
  /** Null when the file does not exist before the change. */
  readonly before: string | null;
  /** Null when the change deletes the file. */
  readonly after: string | null;
}

type Op = { readonly kind: " " | "-" | "+"; readonly text: string };

function splitLines(text: string | null): string[] {
  if (text === null || text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lineOps(before: readonly string[], after: readonly string[]): Op[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j] = length of the longest common subsequence of before[i..] and after[j..], flattened.
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  const lcs = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        before[i] === after[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: " ", text: before[i] ?? "" });
      i += 1;
      j += 1;
    } else if (lcs(i + 1, j) >= lcs(i, j + 1)) {
      ops.push({ kind: "-", text: before[i] ?? "" });
      i += 1;
    } else {
      ops.push({ kind: "+", text: after[j] ?? "" });
      j += 1;
    }
  }
  for (; i < n; i += 1) ops.push({ kind: "-", text: before[i] ?? "" });
  for (; j < m; j += 1) ops.push({ kind: "+", text: after[j] ?? "" });
  return ops;
}

/** Added and removed line counts of one change, the `+N -M` of a summary row. */
export function diffStats(change: FileChange): { added: number; removed: number } {
  const ops = lineOps(splitLines(change.before), splitLines(change.after));
  return {
    added: ops.filter((op) => op.kind === "+").length,
    removed: ops.filter((op) => op.kind === "-").length,
  };
}

/** Unified diff of one file with `context` unchanged lines around each change. */
export function unifiedDiff(change: FileChange, context = 3): string {
  const before = splitLines(change.before);
  const after = splitLines(change.after);
  const ops = lineOps(before, after);
  const out: string[] = [
    `--- ${change.before === null ? "/dev/null" : `a/${change.path}`}`,
    `+++ ${change.after === null ? "/dev/null" : `b/${change.path}`}`,
  ];

  let index = 0;
  while (index < ops.length) {
    if (ops[index]?.kind === " ") {
      index += 1;
      continue;
    }
    const start = Math.max(0, index - context);
    let end = index;
    let lastChange = index;
    while (end < ops.length && end - lastChange <= context) {
      if (ops[end]?.kind !== " ") lastChange = end;
      end += 1;
    }
    end = Math.min(ops.length, lastChange + context + 1);

    const hunk = ops.slice(start, end);
    const oldStart = ops.slice(0, start).filter((op) => op.kind !== "+").length + 1;
    const newStart = ops.slice(0, start).filter((op) => op.kind !== "-").length + 1;
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) out.push(`${op.kind}${op.text}`);
    index = end;
  }
  return out.join("\n");
}

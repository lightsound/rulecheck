import { normalizeRepoName, parseSubscriptions } from "./pack.ts";

/**
 * The pure half of the D25 subscriptions writer (D32): what `subscriptions.json` should read
 * after a set of changes. The file is the D7 object `{ "<pack>": ["owner/repo", ...] }`; the
 * planner keeps key order, appends a missing pack key at the end, normalizes names with
 * `normalizeRepoName`, and prints two-space JSON with a trailing newline, the form
 * `lightsound/agent-rules` keeps. A change that would not change anything (adding a present
 * entry, removing an absent one) is dropped, not refused: the caller compares the planned text
 * with the current one to decide whether there is anything to write.
 */

export interface SubscriptionChange {
  readonly pack: string;
  /** `owner/repo`, any case; normalized before it is compared or written. */
  readonly repo: string;
  readonly op: "add" | "remove";
}

export type SubscriptionPlan =
  | {
      readonly text: string;
      /** The changes that altered the file, normalized, in input order. */
      readonly applied: ReadonlyArray<SubscriptionChange>;
      /** The sets the text encodes, for the caller's second measurement. */
      readonly sets: ReadonlyMap<string, ReadonlyArray<string>>;
    }
  | { readonly reason: string };

/** Serialize the D7 object as the pack repository formats it. */
export function renderSubscriptions(sets: ReadonlyMap<string, ReadonlyArray<string>>): string {
  const object: Record<string, ReadonlyArray<string>> = {};
  for (const [pack, repos] of sets) object[pack] = repos;
  return `${JSON.stringify(object, null, 2)}\n`;
}

/** Parse the file for the planner: a missing file is the empty object; a malformed one is null. */
export function readSubscriptions(text: string | null): Map<string, string[]> | null {
  if (text === null || text.trim() === "") return new Map();
  return parseSubscriptions(text);
}

export function planSubscriptionChanges(
  current: string | null,
  changes: ReadonlyArray<SubscriptionChange>,
): SubscriptionPlan {
  const sets = readSubscriptions(current);
  if (sets === null) {
    return { reason: "subscriptions.json is not an object of pack id to owner/repo arrays" };
  }
  const applied: SubscriptionChange[] = [];
  for (const change of changes) {
    if (change.pack.trim() === "") return { reason: "a change names an empty pack id" };
    const repo = normalizeRepoName(change.repo);
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      return { reason: `\`${change.repo}\` is not owner/repo` };
    }
    const repos = sets.get(change.pack) ?? [];
    const present = repos.some((r) => normalizeRepoName(r) === repo);
    if (change.op === "add") {
      if (present) continue;
      sets.set(change.pack, [...repos, repo]);
    } else {
      if (!present) continue;
      sets.set(
        change.pack,
        repos.filter((r) => normalizeRepoName(r) !== repo),
      );
    }
    applied.push({ pack: change.pack, repo, op: change.op });
  }
  return { text: renderSubscriptions(sets), applied, sets };
}

/**
 * The changes that turn `base` into `tip`: what a pending `rulecheck/subscriptions` branch
 * carries relative to the base branch. Both texts must parse; a malformed one yields null.
 */
export function subscriptionDiff(
  base: string | null,
  tip: string | null,
): SubscriptionChange[] | null {
  const from = readSubscriptions(base);
  const to = readSubscriptions(tip);
  if (from === null || to === null) return null;
  const changes: SubscriptionChange[] = [];
  const packs = new Set([...from.keys(), ...to.keys()]);
  for (const pack of packs) {
    const before = new Set((from.get(pack) ?? []).map(normalizeRepoName));
    const after = new Set((to.get(pack) ?? []).map(normalizeRepoName));
    for (const repo of after) if (!before.has(repo)) changes.push({ pack, repo, op: "add" });
    for (const repo of before) if (!after.has(repo)) changes.push({ pack, repo, op: "remove" });
  }
  return changes;
}

/** Whether two texts encode the same sets (key order and formatting aside). */
export function sameSubscriptions(a: string | null, b: string | null): boolean {
  const diff = subscriptionDiff(a, b);
  return diff !== null && diff.length === 0;
}

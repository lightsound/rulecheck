import type { CanonicalShape, PackStatus, SkillLockState } from "../domain/types.ts";
import type { SyncOutcome } from "../sync/all.ts";

/**
 * Text labels of the distribution state model, one table per vocabulary. `docs/status-model.md`
 * is the authoritative glossary; every identifier and label here must appear there, and a new
 * value is added to the glossary before it is added to a type. Identifiers whose label is not a
 * file name follow one rule: the label is the identifier with `-` replaced by a space.
 */

export const SHAPE_LABEL: Record<CanonicalShape, string> = {
  "agents-canonical": "AGENTS.md canonical",
  "agents-imported": "AGENTS.md via @import",
  "claude-canonical": "CLAUDE.md canonical",
  "agents-only": "AGENTS.md only",
  "claude-only": "CLAUDE.md only",
  "both-full": "both have content",
  none: "none",
};

export const STATUS_LABEL: Record<PackStatus, string> = {
  current: "current",
  outdated: "outdated",
  modified: "modified",
  eligible: "eligible",
  blocked: "blocked",
  "not-subscribed": "not subscribed",
};

export type SyncOutcomeKind = SyncOutcome["kind"];

/** In the order the `sync --all` summary lists them: quiet outcomes first, then writes, then the rest. */
export const OUTCOME_ORDER: ReadonlyArray<SyncOutcomeKind> = [
  "nothing-to-do",
  "up-to-date",
  "planned",
  "opened",
  "updated",
  "refused",
  "failed",
];

export const OUTCOME_LABEL: Record<SyncOutcomeKind, string> = {
  "nothing-to-do": "nothing to do",
  "up-to-date": "up to date",
  planned: "planned",
  opened: "opened",
  updated: "updated",
  refused: "refused",
  failed: "failed",
};

/** Per-skill relation to `skills-lock.json` (D9); listed in the glossary as a word outside the model. */
export const LOCK_STATE_LABEL: Record<SkillLockState, string> = {
  unlocked: "no lock entry",
  match: "matches lock",
  differs: "lock hash differs",
  locked: "locked",
};

/** Shown in the status column of `sync --all` when the target was never measured. */
export const UNMEASURED = "-";

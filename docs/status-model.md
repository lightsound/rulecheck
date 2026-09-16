# Status model

The authoritative glossary of the distribution state model: the words rulecheck uses for how a
repository arranges its root pair (**shape**), what a sync would do to that pair
(**normalization**), where a repository stands with respect to one pack (**pack status**), and
what one sync run ended in for one target (**sync outcome**). Decided in D17; the decisions that
gave each state its meaning are cited per row.

Rules:

- A new value in any of the four vocabularies is added here first, then to the type in
  `src/domain/types.ts` (or `src/sync/`), then to the label table in `src/report/labels.ts`
  (normalization labels: `describeNormalization` in `src/domain/pack.ts`).
  `tests/status-model.test.ts` fails when an identifier or label is missing here.
- **Identifier** is the string in code and in `scan --json`. **Label** is what the text reports
  print. For pack statuses and sync outcomes the label is the identifier with `-` replaced by a
  space and nothing else; shapes are labelled by file name; a normalization is labelled by the
  action sentence the `eligible` row prints.
- `scan --json` carries `"schemaVersion": 1`. The version is bumped when a field is renamed,
  removed, or changes meaning; a new field does not bump it. A report without the field predates
  version 1 (it carried `bothFull` where version 1 carries `normalization`).

## Surfaces

| Surface | Shape | Normalization | Pack status | Sync outcome |
| --- | --- | --- | --- | --- |
| `scan` (text) | per repository and the `Shapes` totals | inside the `eligible` row message | per pack, one row per repository, plus counts | — |
| `scan --json` | `repos[].shape`, `totals.shapes` | `repos[].normalization` | `distribution.entries[].status`, `distribution.counts` | — |
| `sync <owner/repo> --dry-run` | drives the plan; the status message names the normalization | in the status message and the planned actions | first line: the status measured on the base branch | `planned`, `up-to-date`, `nothing-to-do`; a refusal is one stderr line `rulecheck: refused: …` (exit 1) |
| `sync <owner/repo>` | same | same, plus the pull request body | same | `opened`, `updated`, `up-to-date`, `nothing-to-do`; refusal as above; a GitHub error is one stderr line (exit 1) |
| `sync --all --dry-run` | — | inside the `planned` detail | `status` column: the default-branch status, also for `refused` and `failed` rows; `-` when the target was never measured | `outcome` column and the summary line; the remote distribution report (D14) |
| `sync --all` | — | same | same | same, with `opened` / `updated` instead of `planned`; exit 1 only when a row is `failed` |

`scan` measures local checkouts (whatever branch each one is on); `sync` measures the default
branch on GitHub. When the two disagree, `sync --all --dry-run` is right (D14).

## Shape

How a repository arranges its root `AGENTS.md` / `CLAUDE.md` pair (`CLAUDE.md` or
`.claude/CLAUDE.md`). Type `CanonicalShape`; decided by `classifyShape` from the files present
and whether each is a pointer to the other (a wrapper: at most four short lines mentioning only
the other file) or, for `agents-imported`, carries an `@AGENTS.md` import line (D16).

| Identifier | Label | Definition | Normalization a sync applies | Decision |
| --- | --- | --- | --- | --- |
| `agents-canonical` | `AGENTS.md canonical` | `AGENTS.md` carries the content; `CLAUDE.md` is a wrapper pointing at it. The target shape of every sync. | `keep` | D2 |
| `agents-imported` | `AGENTS.md via @import` | Both files carry content and the root `CLAUDE.md` holds a line that is exactly `@AGENTS.md`, outside fenced code and multi-line comments. Canonical in effect; `CLAUDE.md` is never written. | `keep` | D16 |
| `claude-canonical` | `CLAUDE.md canonical` | `CLAUDE.md` carries the content; `AGENTS.md` is a wrapper pointing at it. | `move` | D6 |
| `agents-only` | `AGENTS.md only` | Only `AGENTS.md` exists at the root. | `add-wrapper` | D6 |
| `claude-only` | `CLAUDE.md only` | Only `CLAUDE.md` (or `.claude/CLAUDE.md`) exists at the root. | `move` | D6 |
| `both-full` | `both have content` | Both files carry content and `CLAUDE.md` has no import line. | `drop` or `merge`, by content | D12, D16 |
| `none` | `none` | Neither file exists at the root. | `create` | D6 |

Transitions: a shape changes when the root pair changes. A merged sync pull request moves every
shape to `agents-canonical`, except `agents-imported`, which it leaves as it is. A human can
move a repository between any two shapes.

## Normalization

What a sync does to the root pair besides inserting or updating the block. Type
`Normalization`; decided by `classifyNormalization` from the shape and, for `both-full`, the
files' content. Every repository has exactly one (`scan --json` `repos[].normalization`), also
when no pack is involved; it is executed only by a sync whose status is `eligible`. An `outdated`
block is replaced in place and normalizes nothing (D10).

The label is the sentence the `eligible` row prints (`describeNormalization`; `CLAUDE.md` stands
for whichever root Claude file the pair has). The plan's actions and the pull request body use
the same verbs.

| Identifier | Label (eligible-row message) | Definition | From shape | Decision |
| --- | --- | --- | --- | --- |
| `keep` | `insert block into AGENTS.md` | The pair already loads `AGENTS.md`; only `AGENTS.md` changes. For `agents-imported` the message adds `(CLAUDE.md already imports AGENTS.md; left untouched)`. | `agents-canonical`, `agents-imported` | D10, D16 |
| `add-wrapper` | `insert block into AGENTS.md, add CLAUDE.md wrapper` | The `CLAUDE.md` wrapper (`@AGENTS.md`) is created next to the existing `AGENTS.md`. | `agents-only` | D10 |
| `create` | `create AGENTS.md with the block and a CLAUDE.md wrapper` | Both files are created; `AGENTS.md` holds only the block. | `none` | D10 |
| `move` | `move CLAUDE.md content to AGENTS.md, add CLAUDE.md wrapper, insert block` | The content of `CLAUDE.md` becomes `AGENTS.md` (overwriting a pointer `AGENTS.md` if there is one); `CLAUDE.md` becomes the wrapper; a `.claude/CLAUDE.md` is removed and a root wrapper created. | `claude-only`, `claude-canonical` | D10 |
| `drop` | `CLAUDE.md repeats AGENTS.md: drop it, add CLAUDE.md wrapper, insert block into AGENTS.md` | The text `CLAUDE.md` adds beyond an import line is empty or appears verbatim in `AGENTS.md` outside managed blocks and foreign regions, so it is dropped and `CLAUDE.md` becomes the wrapper. Nothing is lost. | `both-full` | D12, D15 |
| `merge` | ``append CLAUDE.md content to AGENTS.md under `## Merged from CLAUDE.md`, add CLAUDE.md wrapper, insert block`` | The text `CLAUDE.md` adds is appended verbatim to `AGENTS.md` under `## Merged from CLAUDE.md`, before the first managed block; `CLAUDE.md` becomes the wrapper. Duplicates are left for review. | `both-full` | D12 |

## Pack status

Where one repository stands with respect to one pack's `AGENTS.md` block. Type `PackStatus`;
decided by `classifyPackStatus` (precedence in D9). A block with `source=<pack>` in a root-pair
file decides regardless of subscription; without a block the subscription list decides. Every
row carries `file:line` where it applies.

| Identifier | Label | Definition | Enters from | Leaves to | Decision |
| --- | --- | --- | --- | --- | --- |
| `not-subscribed` | `not subscribed` | No block for the pack and the repository is not in the pack's `subscriptions.json` list. | `eligible` / `blocked` when unsubscribed; any block state when the block is removed and the repository is not subscribed | `eligible` when subscribed; `current` when a block is placed by hand | D6, D7 |
| `eligible` | `eligible` | Subscribed, no block, and nothing stops the write; the message names the normalization the sync will apply. | `not-subscribed` on subscription; `blocked` when the marker problem is fixed; any block state when the block is removed | `current` when the sync's pull request merges; `blocked` when a marker problem appears in a file the sync would write; `not-subscribed` on unsubscription | D6, D12 |
| `blocked` | `blocked` | A write is pending (an insertion for a subscriber, or an update of an outdated block) and a human must act first: the file the sync would write carries a malformed `agent-rules` marker, an unpaired, nested, or file-level foreign marker, or a region the change would move or drop; or the outdated block sits inside a region or in an `agents-imported` `CLAUDE.md`. The message names the pending write. | `eligible` or `outdated` when the obstacle appears | `eligible` or `outdated` when it is removed; `current` / `modified` never block (no write is pending) | D9, D15, D16 |
| `current` | `current` | Block present, body untouched, `hash=` equals the pack's current body hash. Comparison is by hash, not `rev`. | `eligible` / `outdated` when the sync's pull request merges; `not-subscribed` when a block is placed by hand | `outdated` when the pack body changes; `modified` when a human edits the body; `eligible` / `not-subscribed` when the block is removed | D6, D9 |
| `outdated` | `outdated` | Block present, body untouched, but the pack's body hash has moved on; an update is pending. | `current` when the pack body changes; `blocked` when the obstacle is removed | `current` when the update pull request merges; `blocked` when an obstacle appears; `modified` when a human edits the body | D6, D9 |
| `modified` | `modified` | Block present but its body no longer matches the `hash=` it carries: a human edited it. The sync never overwrites it. | `current` / `outdated` on a human edit | `current` / `outdated` when a human restores the body or re-places the block; `eligible` / `not-subscribed` when the block is removed | D9, D10 |

A sync does not change the status by itself: opening a pull request leaves the default branch,
and therefore the status, as it was until the pull request merges.

One surface shows `eligible` and `blocked` for repositories whose measured status is
`not-subscribed`: the `Not subscribed (N)` candidate list of the `scan --html` page (D20). That
is a projection, not a measurement: `classifyIfSubscribed` (`src/domain/pack.ts`) runs
`classifyPackStatus` with the repository assumed subscribed, so the chip and message are what
the repository would read the moment it is added to `subscriptions.json`. It appears nowhere in
the text report or in `scan --json`, and the status counts do not include it.

### Next action per status

The `Next actions` list of the `scan --html` page (D21) prints one row per repository × pack
whose status asks someone to act, most urgent first, with a verb the status decides
(`STATUS_ACTION` in `src/report/labels.ts`) completed by the status message and `file:line`. The
verb adds no state: it names who moves the box in the lifecycle below, a human or a sync.

| Identifier | Verb | Completed by |
| --- | --- | --- |
| `modified` | `Review by hand` | the message (`body no longer matches its hash=`) and the block's `file:line` |
| `outdated` | `Run sync to update the block` | the rev change and the block's `file:line` |
| `blocked` | `Fix by hand, then sync` | the obstacle and its `file:line` |
| `eligible` | `Run sync` | the normalization sentence |
| `current`, `not-subscribed` | — | not listed: nothing to do |

## Sync outcome

What one sync run ended in for one target (one repository, one pack). Identifiers are the `kind`
of `SyncResult` (`src/sync/sync.ts`) and of `SyncOutcome` (`src/sync/all.ts`), which adds the
two ways the path ends without a result. Every outcome results from a pack status measured on the
base branch before anything else; an outcome never changes that status.

| Identifier | Label | Definition | Results from | Surfaces | Decision |
| --- | --- | --- | --- | --- | --- |
| `nothing-to-do` | `nothing to do` | The base branch already reads `current`; no branch or pull request is consulted, nothing is written. | `current` | every `sync` form | D10, D14 |
| `planned` | `planned` | Dry run: every check passed and the plan is what a real run would write; the row shows `+N -M`. | `eligible`, `outdated` | `--dry-run` only | D10 |
| `up-to-date` | `up to date` | The tool-owned branch `agent-rules/<pack>` already holds every planned path as planned and its pull request is open; nothing is written. | `eligible`, `outdated` | every `sync` form | D14 |
| `opened` | `opened` | One commit on the base head, the branch created or force-moved, and a new pull request opened. | `eligible`, `outdated` | `sync` without `--dry-run` | D10 |
| `updated` | `updated` | The branch was rewritten under an already open pull request, whose title and body were refreshed. | `eligible`, `outdated` | `sync` without `--dry-run` | D10, D14 |
| `refused` | `refused` | rulecheck declined to write and says why, with `file:line` where it applies. Results from the status when it is `not-subscribed`, `modified`, or `blocked`; from `eligible` / `outdated` when a later check fails (the planner refuses, the planned tree does not read `current`, a foreign region would change, the block would introduce a reference finding, or `agent-rules/<pack>` has a tip rulecheck did not write); or before measurement (bad target, missing base branch), in which case the status column reads `-`. Exit 0 in `--all`: a refusal is an answer, not a failure. | `not-subscribed`, `modified`, `blocked`, `eligible`, `outdated`, or unmeasured | `sync`: stderr `rulecheck: refused: …`, exit 1; `--all`: a row | D10, D14 |
| `failed` | `failed` | The target's truth is unknown: GitHub could not be read or written (404, 401, network, `gh` missing). When the failure came after the base branch was measured (a read while checking the tool-owned branch, or a write call), the row keeps the measured status (`SyncFailed`); when the target could not even be read, the status column reads `-`. `sync --all` exits 1 when any row is `failed`. | `eligible`, `outdated` (failure after measurement), or unmeasured | `sync`: stderr `rulecheck: GitHub … failed`, exit 1; `--all`: a row | D14, D17 |

`refused` and `blocked` are different things: `blocked` is a state of the repository (a human
must look before a write), `refused` is what a sync does about `blocked`, about `modified` and
`not-subscribed`, and about the checks that run after measurement. The `sync --all` row keeps
them apart: the `status` column shows the measured status and the `outcome` column starts with
`refused:`.

## Lifecycle

One repository against one pack. Pack statuses are boxes; sync outcomes are the labels on the
`eligible` / `outdated` loop and never move the box themselves.

```
                     subscribe                                       PR merges
  not-subscribed ───────────────► eligible ──────────────────────────────► current
        ▲                          │   ▲     sync: planned | opened |          │  ▲
        │ unsubscribe              │   │           updated | up-to-date        │  │ update PR merges
        │ (no block)               │   │     (status unchanged until merge)    │  │
        │                          ▼   │                                       ▼  │
        │                         blocked ◄─────────────────────────────── outdated
        │                  obstacle appears / is removed:            pack body changes
        │                  marker, region, block inside a region,    (hash= no longer the
        │                  block in an agents-imported CLAUDE.md     pack's hash)
        │
        └── block removed ◄── current | outdated | modified ──► modified
                                                           human edits the body;
                                                           only a human leaves it

  side states of a sync run (per target, status unchanged):
    refused   ← not-subscribed | modified | blocked | a check after measurement failed
    failed    ← GitHub unreadable or unwritable; status `-` unless measured before the failure
    nothing-to-do ← current
```

## Inconsistencies found in D17 and how they were resolved

| Found | Resolution |
| --- | --- |
| `current` was both a pack status and a `SyncResult` kind ("base already current, nothing written"). | The result kind is `nothing-to-do`, matching the label the reports already printed. |
| `SyncResult` kind `written` printed as two labels, `opened` or `updated`, via a boolean `pullRequestCreated`. | Two kinds, `opened` and `updated`; the boolean is gone. |
| `planned` was summarized as `would write` and its row said `would open or update a pull request`. | Label `planned`; the row reads `planned +N -M: <actions>`. |
| The `sync --all` `status` column showed `refused` or `failed` (outcomes) for rows without a result, and pack statuses for the others. | The column always shows the pack status; `SyncRefused` carries the measured status, so a `modified` or `blocked` refusal shows that status, and a GitHub error after measurement is a `SyncFailed` that keeps it too; `-` only when the target was never measured. The last column is `outcome` and starts with the outcome label. |
| `SyncOutcome` wrapped results in a `done` kind, so the outcome identifier lived two levels deep. | `SyncOutcome = SyncResult \| refused \| failed`; `outcome.kind` is the identifier. |
| Only `both-full` had normalization identifiers (`wrapper` / `merge` in `repos[].bothFull`, null elsewhere); the other shapes' normalizations were prose only, and the prose disagreed: the `eligible` row said `rename to AGENTS.md` (`claude-only`) and `swap the pair` (`claude-canonical`) while the plan's action for both said `move CLAUDE.md content to AGENTS.md`, and the planner runs the same code for both shapes. | `Normalization` with six identifiers on every repository (`repos[].normalization`); `rename` and `swap` are `move`; `wrapper` is `drop`, because `wrapper` also names the file every normalization ends with and collided with `add-wrapper`. D6's "`CLAUDE.md only` via rename" is superseded. |
| Label tables lived in `src/report/render.ts` and inline strings in `src/report/sync.ts`. | One module, `src/report/labels.ts`; the normalization sentences in `describeNormalization`. |
| `scan --json` was unversioned. | `schemaVersion: 1`. |

## Words outside the model that reuse a term

Not part of the four vocabularies; listed so nobody mistakes them for one.

- `ManagedBlock.modified` (boolean per block) and the `MODIFIED` tag on a block line in `scan`:
  the fact the pack status `modified` is derived from.
- `PersonalPackCopy.state`: `current` (a personal file equals the pack body) or `stale` (the
  pack's own source path with another hash), D13. A property of a personal file, not of a
  repository.
- `SkillLockState`: `unlocked`, `match`, `differs`, `locked` (labels `no lock entry`,
  `matches lock`, `lock hash differs`, `locked`), D9.
- `BlockIssueKind`: `malformed-marker`, `foreign-marker`; `FindingKind`: `unknown-script`,
  `missing-path`. Reasons a row is `blocked` or a sync is `refused`, not states.
- `SyncRefused` and `SyncFailed` (`src/sync/sync.ts`): the errors of the single-target path that
  `sync --all` turns into the `refused` and `failed` outcomes; both carry the measured status.
- `NestedRepoKind`: `submodule` (label `submodule`; `.git` is a file, or the enclosing
  repository's `.gitmodules` lists the path) and `nested-clone` (label `nested clone`; `.git` is
  a directory nobody lists), D24. Why a repository inside another repository was left out of
  `scan` (`excludedNested[].kind` in `--json`, the footer of the text report, the footnote of the
  HTML page). Not a status: an excluded repository has no shape and no pack status until
  `--include-nested` scans it as its own.

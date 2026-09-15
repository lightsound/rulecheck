import { Effect, type FileSystem, type Path, Semaphore } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { Pack } from "../domain/types.ts";
import type { GitHub, GitHubError } from "../github/client.ts";
import { type LoadedPacks, type PackSourceError, resolvePacks } from "../scan/packs.ts";
import { type SyncRefused, type SyncResult, selectPack, syncTarget } from "./sync.ts";

/**
 * Fan-out (D14): every repository in `subscriptions.json`, for one pack or for all of them, runs
 * the single-target path (`syncTarget`) in isolation. Each target is measured on the remote base
 * branch, so with `--dry-run` the run is the authoritative distribution report: local checkouts
 * play no part. Refusals (`modified`, `blocked`, rot, a foreign branch) are rows in the summary;
 * only a target whose outcome is unknown because GitHub could not be read or written counts as a
 * failure and makes the run exit non-zero.
 */

export interface SyncAllOptions {
  /** `--packs`: directory or `owner/repo[@ref]`. */
  readonly packs: string;
  /** Restrict the run to one pack; every loaded pack when null. */
  readonly pack: string | null;
  readonly dryRun: boolean;
}

export interface SyncTargetRef {
  readonly repo: string;
  readonly pack: string;
}

export type SyncOutcome =
  | { readonly kind: "done"; readonly result: SyncResult }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "failed"; readonly error: GitHubError | PlatformError };

export interface SyncAllRow {
  readonly target: SyncTargetRef;
  readonly outcome: SyncOutcome;
}

export interface SyncAllResult {
  readonly source: string;
  readonly dryRun: boolean;
  readonly rows: ReadonlyArray<SyncAllRow>;
  /** Targets whose outcome is unknown; the exit code is non-zero when this is positive. */
  readonly failed: number;
}

/** Targets are read in parallel up to this many at a time; writes are serialized (D14). */
export const CONCURRENCY = 3;

export const syncAll = (
  options: SyncAllOptions,
): Effect.Effect<
  SyncAllResult,
  SyncRefused | PackSourceError | GitHubError | PlatformError,
  GitHub | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const loaded = yield* resolvePacks(options.packs);
    const packs = options.pack === null ? loaded.packs : [yield* selectPack(loaded, options.pack)];
    const writeLock = yield* Semaphore.make(1);
    const rows = yield* Effect.forEach(
      targetsOf(packs),
      ({ repo, pack }) =>
        runTarget({ repo, dryRun: options.dryRun, writeLock }, loaded, pack).pipe(
          Effect.map((outcome) => ({ target: { repo, pack: pack.id }, outcome })),
        ),
      { concurrency: CONCURRENCY },
    );
    return {
      source: loaded.source,
      dryRun: options.dryRun,
      rows,
      failed: rows.filter((row) => row.outcome.kind === "failed").length,
    };
  });

/** Subscribers in `subscriptions.json` order, pack by pack; the same repository under two packs is two targets (D10). */
function targetsOf(packs: ReadonlyArray<Pack>): Array<{ repo: string; pack: Pack }> {
  const targets: Array<{ repo: string; pack: Pack }> = [];
  for (const pack of packs) {
    for (const repo of new Set(pack.subscribers)) targets.push({ repo, pack });
  }
  return targets;
}

const runTarget = (
  options: Parameters<typeof syncTarget>[0],
  loaded: LoadedPacks,
  pack: Pack,
): Effect.Effect<SyncOutcome, never, GitHub | FileSystem.FileSystem | Path.Path> =>
  syncTarget(options, loaded, pack).pipe(
    Effect.map((result): SyncOutcome => ({ kind: "done", result })),
    Effect.catchTags({
      SyncRefused: (e) => Effect.succeed<SyncOutcome>({ kind: "refused", message: e.message }),
      GitHubError: (error) => Effect.succeed<SyncOutcome>({ kind: "failed", error }),
      PlatformError: (error) => Effect.succeed<SyncOutcome>({ kind: "failed", error }),
    }),
  );

import { Console, Data, Effect, Runtime } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { GitHubError } from "../github/client.ts";
import type { PackSourceError } from "../scan/packs.ts";
import type { SyncRefused } from "../sync/sync.ts";

/**
 * Expected failures (a refused sync, a bad `--packs`, a GitHub API answer) are printed as one
 * message on stderr and exit with code 1. The runtime's own error log with a stack trace stays
 * for defects.
 */

class Reported extends Data.TaggedError("Reported") {
  override readonly [Runtime.errorReported] = false;
  override readonly [Runtime.errorExitCode] = 1;
}

export function renderFailure(error: SyncRefused | PackSourceError | GitHubError): string {
  switch (error._tag) {
    case "SyncRefused":
      return `rulecheck: refused: ${error.message}`;
    case "PackSourceError":
      return `rulecheck: ${error.message}`;
    case "GitHubError":
      return `rulecheck: GitHub ${error.operation} failed${error.status === null ? "" : ` (HTTP ${error.status})`}: ${error.message}`;
  }
}

export const reportFailure = (
  error: SyncRefused | PackSourceError | GitHubError,
): Effect.Effect<never, Reported> =>
  Console.error(renderFailure(error)).pipe(Effect.andThen(new Reported()));

/** The `--html` file could not be written; the stdout report has already been printed. */
export const reportUnwritable = (
  path: string,
  error: PlatformError,
): Effect.Effect<never, Reported> =>
  Console.error(`rulecheck: could not write ${path}: ${error.message}`).pipe(
    Effect.andThen(new Reported()),
  );

/** A run that finished but whose report contains targets GitHub could not answer for (D14). */
export const reportIncomplete = (message: string): Effect.Effect<never, Reported> =>
  Console.error(`rulecheck: ${message}`).pipe(Effect.andThen(new Reported()));

import { Effect, Layer } from "effect";
import { GitHub, GitHubError } from "./client.ts";
import {
  errorMessageOf,
  makeGitHub,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "./transport.ts";

/**
 * The GitHub CLI as a `Transport`: every request is one `gh api` call, so authentication, hosts,
 * and tokens stay with `gh auth` and rulecheck never holds a credential. `gh` is spawned with
 * this process's environment, so a `GH_TOKEN` variable (the form GitHub Actions uses, D23)
 * authenticates it without any `gh auth login` state. This is the one module that spawns a
 * process; the hosted App never imports it (D26).
 */

export interface GhResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run `gh <args>` with `stdin` piped in. Injected so the layer can be tested without a process.
 * Every failure of the returned effect reaches `ghTransport` as `unknown` and becomes the
 * "could not run gh" `GitHubError`; interrupting it kills the spawned `gh`.
 */
export type GhRunner = (
  args: ReadonlyArray<string>,
  stdin: string | null,
) => Effect.Effect<GhResult, unknown>;

export const bunGhRunner: GhRunner = (args, stdin) =>
  Effect.try({
    try: () =>
      Bun.spawn(["gh", ...args], {
        stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
      }),
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap((proc) =>
      Effect.all(
        [
          Effect.tryPromise({ try: () => new Response(proc.stdout).text(), catch: (c) => c }),
          Effect.tryPromise({ try: () => new Response(proc.stderr).text(), catch: (c) => c }),
          Effect.tryPromise({ try: () => proc.exited, catch: (c) => c }),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(([stdout, stderr, exitCode]) => ({ exitCode, stdout, stderr })),
        // A wait that ends early — interrupted or failed on one branch — would otherwise abandon
        // the spawned `gh`. `kill` on an already-exited process is a no-op.
        Effect.ensuring(Effect.sync(() => proc.kill())),
      ),
    ),
  );

export const layerGh = (run: GhRunner = bunGhRunner): Layer.Layer<GitHub> =>
  Layer.succeed(GitHub, makeGitHub(ghTransport(run)));

/**
 * `gh api` hides the response line and headers, so a successful call is reported as `200` with
 * no headers, and a failed one takes its status from the `gh: <message> (HTTP <status>)` line on
 * stderr. When `gh` printed the API's JSON error body on stdout that body is passed through;
 * otherwise the stderr line becomes the body's `message`, so the client maps both the same way.
 */
export const ghTransport = (run: GhRunner = bunGhRunner): Transport => ({
  request: Effect.fn("gh.request")(function* ({
    method,
    path,
    body,
  }: TransportRequest): Effect.fn.Return<TransportResponse, GitHubError> {
    const args = ["api", "-X", method, "-H", "Accept: application/vnd.github+json", path];
    if (body !== null) args.push("--input", "-");
    const result = yield* run(args, body === null ? null : JSON.stringify(body)).pipe(
      Effect.mapError(
        (cause) =>
          new GitHubError({
            operation: `${method} ${path}`,
            status: null,
            message: `could not run gh (${String(cause)}); install the GitHub CLI and run \`gh auth login\` or set GH_TOKEN`,
          }),
      ),
    );
    if (result.exitCode === 0) {
      return { status: 200, headers: {}, body: result.stdout } satisfies TransportResponse;
    }

    const status = /HTTP (\d{3})/.exec(result.stderr)?.[1];
    const stderr = result.stderr.trim();
    if (status === undefined) {
      return yield* new GitHubError({
        operation: `${method} ${path}`,
        status: null,
        message: stderr.length > 0 ? stderr : `gh exited with ${result.exitCode}`,
      });
    }
    const errorBody =
      errorMessageOf(result.stdout) !== null
        ? result.stdout
        : JSON.stringify({ message: stderr.length > 0 ? stderr : `HTTP ${status}` });
    return { status: Number(status), headers: {}, body: errorBody };
  }),
});

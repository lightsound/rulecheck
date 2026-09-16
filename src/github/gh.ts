import { Effect, Layer } from "effect";
import { GitHub, GitHubError } from "./client.ts";
import { errorMessageOf, makeGitHub, type Transport, type TransportResponse } from "./transport.ts";

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

/** Run `gh <args>` with `stdin` piped in. Injected so the layer can be tested without a process. */
export type GhRunner = (args: ReadonlyArray<string>, stdin: string | null) => Promise<GhResult>;

export const bunGhRunner: GhRunner = async (args, stdin) => {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

export const layerGh = (run: GhRunner = bunGhRunner): Layer.Layer<GitHub> =>
  Layer.succeed(GitHub, makeGitHub(ghTransport(run)));

/**
 * `gh api` hides the response line and headers, so a successful call is reported as `200` with
 * no headers, and a failed one takes its status from the `gh: <message> (HTTP <status>)` line on
 * stderr. When `gh` printed the API's JSON error body on stdout that body is passed through;
 * otherwise the stderr line becomes the body's `message`, so the client maps both the same way.
 */
export const ghTransport = (run: GhRunner = bunGhRunner): Transport => ({
  request: ({ method, path, body }) =>
    Effect.gen(function* () {
      const args = ["api", "-X", method, "-H", "Accept: application/vnd.github+json", path];
      if (body !== null) args.push("--input", "-");
      const result = yield* Effect.tryPromise({
        try: () => run(args, body === null ? null : JSON.stringify(body)),
        catch: (cause) =>
          new GitHubError({
            operation: `${method} ${path}`,
            status: null,
            message: `could not run gh (${String(cause)}); install the GitHub CLI and run \`gh auth login\` or set GH_TOKEN`,
          }),
      });
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

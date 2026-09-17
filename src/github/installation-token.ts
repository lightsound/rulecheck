import { Effect } from "effect";
import { GitHubError } from "./client.ts";
import { type FetchTransportOptions, fetchTransport } from "./fetch.ts";
import { errorMessageOf, retryAfterOf, type Transport } from "./transport.ts";

/**
 * Installation tokens for a GitHub App (app-design §4, D26): a short-lived RS256 JWT signed with
 * the App's private key through WebCrypto (`crypto.subtle`, present on Bun, Node, and workerd),
 * exchanged at `POST /app/installations/{id}/access_tokens` for a one-hour token that is cached
 * until five minutes before it expires. Nothing here reads a file or an environment variable:
 * the key arrives as a string, and the caller keeps it wherever its runtime keeps secrets.
 *
 * GitHub downloads the key as PKCS#1 (`BEGIN RSA PRIVATE KEY`); `crypto.subtle.importKey` takes
 * RSA keys as PKCS#8 only, so the key is converted once (`openssl pkcs8 -topk8 -nocrypt`) before
 * it is stored, and a PKCS#1 header is refused with a message that names the command.
 */

/**
 * The mint is one more `fetchTransport` request, so it takes every transport option except the
 * token (which is the JWT): the `access_tokens` response reports its quota through the same
 * `onRateLimit`, and a secondary limit on the mint waits through the same `sleep` and cap.
 */
export interface InstallationTokenOptions extends Omit<FetchTransportOptions, "token"> {
  readonly appId: string | number;
  /** The App's private key as a PKCS#8 PEM (`BEGIN PRIVATE KEY`). */
  readonly privateKey: string;
  readonly installationId: string | number;
  /** Clock in milliseconds since the epoch; default `Date.now`. Injected by tests. */
  readonly now?: () => number;
}

/** Refresh this long before `expires_at`, so a token handed out is good for a whole job. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** JWT lifetime; GitHub allows at most ten minutes, and clocks drift. */
const JWT_LIFETIME_SECONDS = 9 * 60;
const JWT_BACKDATE_SECONDS = 60;

const PKCS1_HEADER = /-----BEGIN RSA PRIVATE KEY-----/;
const ENCRYPTED_HEADER = /-----BEGIN ENCRYPTED PRIVATE KEY-----/;
const PKCS8_BLOCK = /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/;

/**
 * A token provider for `fetchTransport({ token })`: mints on first use, then returns the cached
 * token until it is five minutes from expiry. Concurrent first calls may each mint; a token
 * minted twice is two valid tokens, not an error.
 */
export function installationToken(
  options: InstallationTokenOptions,
): Effect.Effect<string, GitHubError> {
  const now = options.now ?? Date.now;
  const operation = "installationToken";
  let key: CryptoKey | null = null;
  let cached: { readonly token: string; readonly expiresAt: number } | null = null;

  const signingKey = Effect.suspend(() =>
    key !== null
      ? Effect.succeed(key)
      : importPrivateKey(options.privateKey).pipe(
          Effect.tap((imported) =>
            Effect.sync(() => {
              key = imported;
            }),
          ),
        ),
  );

  const mint = Effect.gen(function* () {
    const jwt = yield* appJwt(String(options.appId), yield* signingKey, now());
    const {
      appId: _appId,
      privateKey: _privateKey,
      installationId: _id,
      now: _now,
      ...transportOptions
    } = options;
    const transport = fetchTransport({ ...transportOptions, token: Effect.succeed(jwt) });
    const response = yield* transport.request({
      method: "POST",
      path: `app/installations/${options.installationId}/access_tokens`,
      body: null,
    });
    if (response.status >= 400) {
      const retryAfter = retryAfterOf(response.headers);
      return yield* new GitHubError({
        operation,
        status: response.status,
        message:
          errorMessageOf(response.body) ??
          `installation ${options.installationId}: HTTP ${response.status}`,
        ...(retryAfter === null ? {} : { retryAfter }),
      });
    }
    const data = yield* Effect.try({
      try: () => JSON.parse(response.body) as Record<string, unknown>,
      catch: () =>
        new GitHubError({ operation, status: response.status, message: "non-JSON token response" }),
    });
    const token = typeof data.token === "string" ? data.token : null;
    const expiresAt =
      typeof data.expires_at === "string" ? Date.parse(data.expires_at) : Number.NaN;
    if (token === null || Number.isNaN(expiresAt)) {
      return yield* new GitHubError({
        operation,
        status: response.status,
        message: "token response has no `token` and `expires_at`",
      });
    }
    cached = { token, expiresAt };
    return token;
  });

  return Effect.suspend(() =>
    cached !== null && now() < cached.expiresAt - REFRESH_MARGIN_MS
      ? Effect.succeed(cached.token)
      : mint,
  );
}

/** `fetchTransport` authenticated as an installation of the App. */
export function installationTokenTransport(options: InstallationTokenOptions): Transport {
  return fetchTransport({ ...options, token: installationToken(options) });
}

/** Import a PKCS#8 PEM as an RS256 signing key. */
export function importPrivateKey(pem: string): Effect.Effect<CryptoKey, GitHubError> {
  const operation = "importPrivateKey";
  if (PKCS1_HEADER.test(pem)) {
    return new GitHubError({
      operation,
      status: null,
      message:
        "the App private key is PKCS#1 (`BEGIN RSA PRIVATE KEY`), which WebCrypto cannot import; convert it once with `openssl pkcs8 -topk8 -nocrypt -in <key>.pem` and store the output",
    });
  }
  if (ENCRYPTED_HEADER.test(pem)) {
    return new GitHubError({
      operation,
      status: null,
      message:
        "the App private key is encrypted; store an unencrypted PKCS#8 key (`openssl pkcs8 -topk8 -nocrypt`)",
    });
  }
  const block = PKCS8_BLOCK.exec(pem)?.[1];
  if (block === undefined) {
    return new GitHubError({
      operation,
      status: null,
      message: "the App private key is not a PEM `BEGIN PRIVATE KEY` block",
    });
  }
  return Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "pkcs8",
        base64ToBytes(block.replace(/\s/g, "")),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    catch: (cause) =>
      new GitHubError({
        operation,
        status: null,
        message: `the App private key could not be imported (${cause instanceof Error ? cause.message : String(cause)})`,
      }),
  });
}

/** The App JWT GitHub expects: `iss` is the App id, valid from one minute ago for nine minutes. */
export function appJwt(
  appId: string,
  key: CryptoKey,
  nowMs: number,
): Effect.Effect<string, GitHubError> {
  const seconds = Math.floor(nowMs / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        iat: seconds - JWT_BACKDATE_SECONDS,
        exp: seconds + JWT_LIFETIME_SECONDS,
        iss: appId,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  return Effect.tryPromise({
    try: async () => {
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
    },
    catch: (cause) =>
      new GitHubError({
        operation: "appJwt",
        status: null,
        message: `could not sign the App JWT (${cause instanceof Error ? cause.message : String(cause)})`,
      }),
  });
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

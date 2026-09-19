import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { hashBlockBody } from "../src/domain/block.ts";
import { GitHub, GitHubError, type GitHubService } from "../src/github/client.ts";
import { fetchTransport, secondaryLimitDelay } from "../src/github/fetch.ts";
import { MAX_TREE_LISTINGS, repositorySnapshot } from "../src/github/fs.ts";
import { ghTransport } from "../src/github/gh.ts";
import {
  appJwt,
  importPrivateKey,
  installationToken,
  installationTokenTransport,
} from "../src/github/installation-token.ts";
import {
  makeGitHub,
  parseRateLimit,
  type RateLimit,
  retryAfterOf,
  type TransportResponse,
} from "../src/github/transport.ts";
import { renderSyncAll } from "../src/report/sync.ts";
import { syncAll } from "../src/sync/all.ts";
import { sync } from "../src/sync/sync.ts";
import { type FakeRepoInput, fakeGitHub, fakeRest, ghRunnerOver } from "./fake-github.ts";

const repo = { owner: "acme", name: "r" };
const runP = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const flip = <A, E>(effect: Effect.Effect<A, E>) => runP(effect.pipe(Effect.flip));

type Canned = { status: number; body?: unknown; headers?: Record<string, string> };

const headersOf = (call: { init: RequestInit } | undefined): Record<string, string> =>
  (call?.init.headers as Record<string, string> | undefined) ?? {};

/** A `fetch` answering by `<METHOD> <path>` from a script; each key is consumed in order. */
function scripted(script: Record<string, Canned | Canned[]>, baseUrl = "https://api.github.com") {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const remaining = new Map(
    Object.entries(script).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]] as const),
  );
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    seen.push({ url, init });
    const key = `${init.method ?? "GET"} ${url.slice(baseUrl.length + 1)}`;
    const next = remaining.get(key)?.shift();
    if (!next)
      return new Response(JSON.stringify({ message: `no script for ${key}` }), { status: 599 });
    return new Response(
      next.body === undefined
        ? null
        : typeof next.body === "string"
          ? next.body
          : JSON.stringify(next.body),
      { status: next.status, headers: next.headers ?? {} },
    );
  };
  return { fetch, seen };
}

describe("fetchTransport", () => {
  test("sends the token, accept, and agent headers, joins baseUrl, and parses the reply", async () => {
    const { fetch, seen } = scripted(
      {
        "GET repos/acme/r": { status: 200, body: { default_branch: "trunk" } },
        "POST repos/acme/r/git/trees": { status: 201, body: { sha: "t1" } },
        "GET repos/acme/r/git/ref/heads/missing": { status: 404, body: { message: "Not Found" } },
        "PATCH repos/acme/r/git/refs/heads/x": { status: 200, body: "" },
      },
      "https://ghe.example/api/v3",
    );
    const github = makeGitHub(
      fetchTransport({
        token: Effect.succeed("tok"),
        fetch,
        baseUrl: "https://ghe.example/api/v3/",
        userAgent: "rulecheck-test",
      }),
    );
    expect(await runP(github.getRepository(repo))).toEqual({ defaultBranch: "trunk", size: 0 });
    expect(seen[0]?.url).toBe("https://ghe.example/api/v3/repos/acme/r");
    const headers = headersOf(seen[0]);
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers.accept).toBe("application/vnd.github+json");
    expect(headers["user-agent"]).toBe("rulecheck-test");
    expect(headers["content-type"]).toBeUndefined();

    expect(await runP(github.createTree(repo, "b", [{ path: "a", content: "x" }]))).toBe("t1");
    expect(headersOf(seen[1])["content-type"]).toBe("application/json");
    expect(JSON.parse(String(seen[1]?.init.body))).toEqual({
      base_tree: "b",
      tree: [{ path: "a", mode: "100644", type: "blob", content: "x" }],
    });
    expect(await runP(github.getRef(repo, "heads/missing"))).toBeNull();
    await runP(github.setRef(repo, "heads/x", "abc", { create: false, force: false }));
    expect(JSON.parse(String(seen[3]?.init.body))).toEqual({ sha: "abc", force: false });
  });

  test("an HTTP error is a GitHubError with the API's message and status", async () => {
    const { fetch } = scripted({
      "GET repos/acme/r/git/commits/c": { status: 401, body: { message: "Bad credentials" } },
      "GET repos/acme/r/git/commits/html": { status: 502, body: "<html>bad gateway</html>" },
      "GET repos/acme/r/git/commits/junk": { status: 200, body: "not json" },
    });
    const github = makeGitHub(fetchTransport({ token: Effect.succeed("t"), fetch }));
    expect(await flip(github.getCommit(repo, "c"))).toMatchObject({
      _tag: "GitHubError",
      status: 401,
      message: "Bad credentials",
      operation: "getCommit",
    });
    expect(await flip(github.getCommit(repo, "html"))).toMatchObject({
      status: 502,
      message: "HTTP 502",
    });
    expect((await flip(github.getCommit(repo, "junk"))).message).toBe(
      "GitHub API returned non-JSON output",
    );
  });

  test("a network failure or a token that cannot be minted is a GitHubError with status null", async () => {
    const down = makeGitHub(
      fetchTransport({
        token: Effect.succeed("t"),
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    );
    expect(await flip(down.getRepository(repo))).toMatchObject({
      operation: "getRepository",
      status: null,
      message: "could not reach https://api.github.com (ECONNREFUSED)",
    });
    const { fetch, seen } = scripted({});
    const noToken = makeGitHub(
      fetchTransport({
        token: new GitHubError({ operation: "token", status: null, message: "no key" }),
        fetch,
      }),
    );
    expect((await flip(noToken.getRepository(repo))).message).toBe("no key");
    expect(seen).toEqual([]);
  });

  test("a secondary rate limit is retried once after the advertised delay", async () => {
    const slept: number[] = [];
    const sleep = (seconds: number) =>
      Effect.sync(() => {
        slept.push(seconds);
      });
    const limited = {
      status: 403,
      body: { message: "You have exceeded a secondary rate limit." },
      headers: { "retry-after": "7", "x-ratelimit-remaining": "4000" },
    };
    const { fetch, seen } = scripted({
      "GET repos/acme/r": [limited, { status: 200, body: { default_branch: "main" } }],
      "GET repos/acme/r/git/ref/heads/main": [limited, limited, limited],
    });
    const github = makeGitHub(fetchTransport({ token: Effect.succeed("t"), fetch, sleep }));
    expect(await runP(github.getRepository(repo))).toEqual({ defaultBranch: "main", size: 0 });
    expect(slept).toEqual([7]);
    expect(seen).toHaveLength(2);

    // Still limited after the one retry: the error carries the wait, and no third call is made.
    const failure = await flip(github.getRef(repo, "heads/main"));
    expect(failure).toMatchObject({ status: 403, retryAfter: 7 });
    expect(slept).toEqual([7, 7]);
    expect(seen).toHaveLength(4);
  });

  test("a secondary limit without retry-after waits a minute; a delay over the cap is handed back", async () => {
    const slept: number[] = [];
    const sleep = (seconds: number) =>
      Effect.sync(() => {
        slept.push(seconds);
      });
    const { fetch, seen } = scripted({
      "GET repos/acme/r": [
        { status: 429, body: { message: "abuse detection mechanism triggered" } },
        { status: 200, body: { default_branch: "main" } },
      ],
      "GET repos/acme/slow": [
        {
          status: 403,
          body: { message: "secondary rate limit" },
          headers: { "retry-after": "300" },
        },
      ],
    });
    const github = makeGitHub(
      fetchTransport({ token: Effect.succeed("t"), fetch, sleep, maxRetryDelaySeconds: 120 }),
    );
    expect(await runP(github.getRepository(repo))).toEqual({ defaultBranch: "main", size: 0 });
    expect(slept).toEqual([60]);
    const slow = await flip(github.getRepository({ owner: "acme", name: "slow" }));
    expect(slow).toMatchObject({ status: 403, retryAfter: 300 });
    expect(slept).toEqual([60]);
    expect(seen).toHaveLength(3);
  });

  test("an exhausted primary quota is not retried; retryAfter is the time to the reset", async () => {
    const now = Math.floor(Date.now() / 1000);
    const slept: number[] = [];
    const seenLimits: RateLimit[] = [];
    const { fetch, seen } = scripted({
      "GET repos/acme/r": {
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(now + 1800),
          "x-ratelimit-resource": "core",
        },
      },
    });
    const github = makeGitHub(
      fetchTransport({
        token: Effect.succeed("t"),
        fetch,
        sleep: (s) => Effect.sync(() => void slept.push(s)),
        onRateLimit: (limit) => Effect.sync(() => void seenLimits.push(limit)),
      }),
    );
    const failure = await flip(github.getRepository(repo));
    expect(failure.status).toBe(403);
    expect(failure.retryAfter).toBeGreaterThanOrEqual(1795);
    expect(failure.retryAfter).toBeLessThanOrEqual(1800);
    expect(slept).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seenLimits).toEqual([
      { limit: 5000, remaining: 0, reset: now + 1800, resource: "core" },
    ]);
  });

  test("quota helpers", () => {
    const headers = {
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "12",
      "x-ratelimit-reset": "1000",
    };
    expect(parseRateLimit(headers)).toEqual({
      limit: 5000,
      remaining: 12,
      reset: 1000,
      resource: null,
    });
    expect(parseRateLimit({})).toBeNull();
    expect(retryAfterOf({ "retry-after": "5" })).toBe(5);
    expect(retryAfterOf({ ...headers, "x-ratelimit-remaining": "0" }, 400)).toBe(600);
    expect(retryAfterOf(headers, 400)).toBeNull();
    const response = (status: number, headers: Record<string, string>, body = "{}") =>
      ({ status, headers, body }) satisfies TransportResponse;
    expect(secondaryLimitDelay(response(500, { "retry-after": "5" }))).toBeNull();
    expect(secondaryLimitDelay(response(429, { "retry-after": "5" }))).toBe(5);
    expect(secondaryLimitDelay(response(403, {}, '{"message":"Forbidden"}'))).toBeNull();
  });
});

describe("installationToken", () => {
  async function testKey() {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const base64 = Buffer.from(der)
      .toString("base64")
      .replace(/(.{64})/g, "$1\n");
    return {
      pem: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`,
      publicKey: pair.publicKey,
    };
  }
  const fromBase64Url = (text: string) =>
    Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");

  test("signs a JWT GitHub accepts: RS256, iss = app id, iat one minute back, exp nine minutes ahead", async () => {
    const { pem, publicKey } = await testKey();
    const key = await runP(importPrivateKey(pem));
    const nowMs = 1_700_000_000_000;
    const jwt = await runP(appJwt("12345", key, nowMs));
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(fromBase64Url(header ?? "").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(fromBase64Url(payload ?? "").toString())).toEqual({
      iat: 1_700_000_000 - 60,
      exp: 1_700_000_000 + 540,
      iss: "12345",
    });
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      fromBase64Url(signature ?? ""),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(verified).toBe(true);
  });

  test("mints against /app/installations/{id}/access_tokens and caches until five minutes before expiry", async () => {
    const { pem } = await testKey();
    let now = Date.parse("2026-09-16T10:00:00Z");
    const expiresAt = "2026-09-16T11:00:00Z";
    let minted = 0;
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetch = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      minted += 1;
      return new Response(JSON.stringify({ token: `ghs_${minted}`, expires_at: expiresAt }), {
        status: 201,
      });
    };
    const token = installationToken({
      appId: 7,
      privateKey: pem,
      installationId: 99,
      fetch,
      now: () => now,
    });
    expect(await runP(token)).toBe("ghs_1");
    expect(seen[0]?.url).toBe("https://api.github.com/app/installations/99/access_tokens");
    expect(seen[0]?.init.method).toBe("POST");
    expect(headersOf(seen[0]).authorization).toMatch(/^Bearer eyJ/);
    expect(await runP(token)).toBe("ghs_1");
    now = Date.parse("2026-09-16T10:54:59Z");
    expect(await runP(token)).toBe("ghs_1");
    now = Date.parse("2026-09-16T10:55:00Z");
    expect(await runP(token)).toBe("ghs_2");
    expect(minted).toBe(2);
  });

  test("refuses a PKCS#1 key naming the openssl command, and other non-PKCS#8 input", async () => {
    const pkcs1 = await flip(
      importPrivateKey("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n"),
    );
    expect(pkcs1.message).toContain("openssl pkcs8 -topk8 -nocrypt");
    expect(pkcs1.message).toContain("PKCS#1");
    const encrypted = await flip(
      importPrivateKey(
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIE\n-----END ENCRYPTED PRIVATE KEY-----\n",
      ),
    );
    expect(encrypted.message).toContain("-nocrypt");
    expect((await flip(importPrivateKey("not a key"))).message).toContain("BEGIN PRIVATE KEY");
    const garbage = await flip(
      importPrivateKey("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"),
    );
    expect(garbage.message).toContain("could not be imported");
    // The provider fails the same way and never calls the API.
    let called = false;
    const token = installationToken({
      appId: 1,
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
      installationId: 2,
      fetch: async () => {
        called = true;
        return new Response("{}");
      },
    });
    expect((await flip(token)).message).toContain("openssl pkcs8");
    expect(called).toBe(false);
  });

  test("a rejected mint and a malformed token response are GitHubErrors", async () => {
    const { pem } = await testKey();
    const denied = installationToken({
      appId: 1,
      privateKey: pem,
      installationId: 2,
      fetch: async () =>
        new Response(JSON.stringify({ message: "Integration not found" }), { status: 404 }),
    });
    expect(await flip(denied)).toMatchObject({ status: 404, message: "Integration not found" });
    const odd = installationToken({
      appId: 1,
      privateKey: pem,
      installationId: 2,
      fetch: async () => new Response(JSON.stringify({ nope: true }), { status: 201 }),
    });
    expect((await flip(odd)).message).toContain("expires_at");
  });

  test("the mint reports its quota through onRateLimit and retries a secondary limit through the injected sleep", async () => {
    const { pem } = await testKey();
    const slept: number[] = [];
    const seenLimits: RateLimit[] = [];
    const { fetch, seen } = scripted({
      "POST app/installations/2/access_tokens": [
        {
          status: 403,
          body: { message: "You have exceeded a secondary rate limit." },
          headers: {
            "retry-after": "9",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4000",
            "x-ratelimit-reset": "1000",
          },
        },
        {
          status: 201,
          body: { token: "ghs_minted", expires_at: "2999-01-01T00:00:00Z" },
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "3999",
            "x-ratelimit-reset": "1000",
            "x-ratelimit-resource": "core",
          },
        },
      ],
    });
    let now = 1_700_000_000_000;
    const token = installationToken({
      appId: 1,
      privateKey: pem,
      installationId: 2,
      fetch,
      now: () => now,
      userAgent: "rulefleet",
      sleep: (s) =>
        Effect.sync(() => {
          slept.push(s);
          now += s * 1000;
        }),
      onRateLimit: (limit) => Effect.sync(() => void seenLimits.push(limit)),
    });
    expect(await runP(token)).toBe("ghs_minted");
    expect(slept).toEqual([9]);
    expect(seen).toHaveLength(2);
    expect(headersOf(seen[0])["user-agent"]).toBe("rulefleet");
    // The retry signs a fresh JWT rather than re-sending the one signed before the wait.
    const iatOf = (call: { init: RequestInit } | undefined) =>
      JSON.parse(
        fromBase64Url(
          headersOf(call)
            .authorization?.replace(/^Bearer /, "")
            .split(".")[1] ?? "",
        ).toString(),
      ).iat as number;
    expect(iatOf(seen[1])).toBe(iatOf(seen[0]) + 9);
    expect(seenLimits).toEqual([
      { limit: 5000, remaining: 4000, reset: 1000, resource: null },
      { limit: 5000, remaining: 3999, reset: 1000, resource: "core" },
    ]);

    // A mint delay over the cap is not waited out: the error carries the wait instead.
    const capped = installationToken({
      appId: 1,
      privateKey: pem,
      installationId: 3,
      fetch: scripted({
        "POST app/installations/3/access_tokens": {
          status: 403,
          body: { message: "secondary rate limit" },
          headers: { "retry-after": "300" },
        },
      }).fetch,
      sleep: (s) => Effect.sync(() => void slept.push(s)),
      maxRetryDelaySeconds: 120,
    });
    expect(await flip(capped)).toMatchObject({ status: 403, retryAfter: 300 });
    expect(slept).toEqual([9]);
  });

  test("installationTokenTransport authenticates API calls with the minted token", async () => {
    const { pem } = await testKey();
    const fake = fakeGitHub({ "acme/r": { files: { "AGENTS.md": "# R\n" } } });
    const rest = fakeRest(fake);
    const authorizations: string[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      authorizations.push((init.headers as Record<string, string>).authorization ?? "");
      if (url.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_installation", expires_at: "2999-01-01T00:00:00Z" }),
          { status: 201 },
        );
      }
      return rest(url, init);
    };
    const github = makeGitHub(
      installationTokenTransport({ appId: 1, privateKey: pem, installationId: 2, fetch }),
    );
    expect(await runP(github.getRepository(repo))).toEqual({ defaultBranch: "main", size: 0 });
    expect(authorizations[0]).toMatch(/^Bearer eyJ/);
    expect(authorizations[1]).toBe("Bearer ghs_installation");
  });
});

describe("repositorySnapshot on a truncated tree", () => {
  const files = {
    "AGENTS.md": "# Big\n",
    "CLAUDE.md": "@AGENTS.md\n",
    "package.json": "{}",
    "src/main.ts": "",
    "src/lib/a.ts": "",
    "src/lib/b.ts": "",
    "docs/guide/intro.md": "",
    ".cursor/rules/style.mdc": "---\nalwaysApply: true\n---\nx\n",
    "node_modules/dep/CLAUDE.md": "ignored\n",
    "node_modules/dep/index.js": "",
  };

  test("lists subtrees one by one, skips ignored directories, and yields the same files", async () => {
    const complete = fakeGitHub({ "acme/big": { files } });
    const truncating = fakeGitHub({ "acme/big": { files } }, { truncateTreesAbove: 2 });
    const big = { owner: "acme", name: "big" };
    const paths = async (fake: typeof complete) => {
      const sha = (await runP(fake.service.getRef(big, "heads/main"))) ?? "";
      const listings: string[] = [];
      const counting: GitHubService = {
        ...fake.service,
        getTree: (r, tree, options) => {
          listings.push(options?.recursive === false ? "shallow" : "recursive");
          return fake.service.getTree(r, tree, options);
        },
      };
      const snapshot = await runP(repositorySnapshot(counting, big, sha));
      return { paths: [...snapshot.keys()].sort(), listings };
    };
    const whole = await paths(complete);
    const pieced = await paths(truncating);
    expect(whole.listings).toEqual(["recursive"]);
    // Root (truncated: 10 entries) listed one level; .cursor and docs fit; src (3 entries) is
    // truncated again and listed one level; src/lib fits.
    expect(pieced.listings).toEqual([
      "recursive",
      "shallow",
      "recursive",
      "recursive",
      "recursive",
      "shallow",
      "recursive",
    ]);
    expect(pieced.paths).toEqual(whole.paths.filter((path) => !path.includes("/node_modules/")));
    expect(pieced.paths).toContain("/github.com/acme/big/src/lib/b.ts");
    expect(pieced.paths).toContain("/github.com/acme/big/.cursor/rules/style.mdc");
  });

  test("the sync measures a truncated repository like any other", async () => {
    const packs: FakeRepoInput = {
      files: {
        "packs/base/AGENTS.md": "- Use Bun.\n",
        "subscriptions.json": JSON.stringify({ base: ["acme/big"] }),
      },
    };
    const fake = fakeGitHub(
      { "acme/agent-rules": packs, "acme/big": { files } },
      { truncateTreesAbove: 3 },
    );
    const result = await Effect.runPromise(
      sync({ repo: "acme/big", pack: "base", packs: "acme/agent-rules", dryRun: true }).pipe(
        Effect.provide(Layer.mergeAll(BunServices.layer, fake.layer)),
      ),
    );
    expect(result.kind).toBe("planned");
    if (result.kind === "planned") expect(result.status.status).toBe("eligible");
  });

  test("a tree that keeps truncating gives up at the listing budget instead of spending the quota", async () => {
    let calls = 0;
    const bottomless: GitHubService = {
      ...fakeGitHub({}).service,
      getCommit: () => Effect.succeed({ tree: "t", message: "" }),
      getTree: (_r, sha, options) => {
        calls += 1;
        return Effect.succeed(
          options?.recursive === false
            ? {
                entries: [
                  { path: "deeper", mode: "040000", type: "tree" as const, sha: `${sha}/deeper` },
                ],
                truncated: false,
              }
            : { entries: [], truncated: true },
        );
      },
    };
    const failure = await flip(repositorySnapshot(bottomless, repo, "c"));
    expect(failure.message).toBe(
      `the tree of acme/r needs more than ${MAX_TREE_LISTINGS} listings; it is too large to snapshot`,
    );
    expect(calls).toBe(MAX_TREE_LISTINGS);
  });
});

describe("setRef force", () => {
  test("force: false is a fast-forward-only update; the fake answers 422 when the ref moved", async () => {
    const fake = fakeGitHub({ "acme/r": { files: { a: "1\n" } } });
    const main = (await runP(fake.service.getRef(repo, "heads/main"))) ?? "";
    const tree = (await runP(fake.service.getCommit(repo, main))).tree;
    const child = await runP(
      fake.service.createCommit(repo, { message: "child", tree, parents: [main] }),
    );
    const orphan = await runP(
      fake.service.createCommit(repo, { message: "orphan", tree, parents: [] }),
    );
    await runP(fake.service.setRef(repo, "heads/main", child, { create: false, force: false }));
    expect(await runP(fake.service.getRef(repo, "heads/main"))).toBe(child);
    const rejected = await flip(
      fake.service.setRef(repo, "heads/main", orphan, { create: false, force: false }),
    );
    expect(rejected).toMatchObject({ status: 422, message: "Update is not a fast forward" });
    await runP(fake.service.setRef(repo, "heads/main", orphan, { create: false }));
    expect(await runP(fake.service.getRef(repo, "heads/main"))).toBe(orphan);
  });
});

/**
 * The write path against one object store through its three fronts: the fake service, the fake
 * behind GitHub's REST surface over `fetchTransport`, and the same REST surface behind a `gh`
 * runner over `ghTransport`. Every front must produce the same commits, files, rows, and text.
 */
describe("one store, three fronts", () => {
  const BODY = "- Respond in Japanese.\n- Use Bun.";
  const block = (source: string, body: string, rev: string) =>
    `<!-- agent-rules:begin source=${source} rev=${rev} hash=${hashBlockBody(body)} -->\n${body}\n<!-- agent-rules:end -->`;
  const repos = (): Record<string, FakeRepoInput> => ({
    "acme/agent-rules": {
      files: {
        "packs/base/AGENTS.md": `${BODY}\n`,
        "subscriptions.json": JSON.stringify({
          base: ["acme/eligible", "acme/modified", "acme/gone", "acme/utf8"],
        }),
      },
    },
    "acme/eligible": {
      files: {
        "AGENTS.md": "# E\n\n- entry: `src/main.ts`\n",
        "CLAUDE.md": "@AGENTS.md\n",
        "src/main.ts": "",
      },
    },
    "acme/modified": {
      files: {
        "AGENTS.md": `# M\n\n${block("base", BODY, "aaaaaaa").replace("Use Bun", "Use npm")}\n`,
        "CLAUDE.md": "@AGENTS.md\n",
      },
    },
    "acme/utf8": { files: { "AGENTS.md": "# Ünïcödé — 日本語\n", "CLAUDE.md": "@AGENTS.md\n" } },
  });

  const fronts: Array<[string, (fake: ReturnType<typeof fakeGitHub>) => GitHubService]> = [
    ["fake service", (fake) => fake.service],
    [
      "fetchTransport over REST",
      (fake) => makeGitHub(fetchTransport({ token: Effect.succeed("t"), fetch: fakeRest(fake) })),
    ],
    ["ghTransport over REST", (fake) => makeGitHub(ghTransport(ghRunnerOver(fakeRest(fake))))],
  ];

  const outputs = new Map<string, string>();

  test.each(fronts)("%s: sync --all --dry-run, then the writes", async (name, front) => {
    const fake = fakeGitHub(repos());
    const github = front(fake);
    const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | GitHub>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(Layer.mergeAll(BunServices.layer, Layer.succeed(GitHub, github))),
        ),
      );
    const rev =
      (await run(github.getRef({ owner: "acme", name: "agent-rules" }, "heads/main"))) ?? "";

    const dry = await run(syncAll({ packs: "acme/agent-rules", pack: null, dryRun: true }));
    const table = renderSyncAll(dry).replaceAll(rev.slice(0, 7), "<rev>");
    expect(dry.rows.map((row) => `${row.target.repo}:${row.outcome.kind}`)).toEqual([
      "acme/eligible:planned",
      "acme/modified:refused",
      "acme/gone:failed",
      "acme/utf8:planned",
    ]);
    const gone = dry.rows[2]?.outcome;
    if (gone?.kind === "failed")
      expect(gone.error).toMatchObject({ _tag: "GitHubError", status: 404 });
    expect(fake.calls).toEqual([]);
    outputs.set(name, table);

    const written = await run(syncAll({ packs: "acme/agent-rules", pack: null, dryRun: false }));
    expect(written.rows.map((row) => row.outcome.kind)).toEqual([
      "opened",
      "refused",
      "failed",
      "opened",
    ]);
    expect(fake.fileAt("acme/eligible", "heads/agent-rules/base", "AGENTS.md")).toBe(
      `# E\n\n- entry: \`src/main.ts\`\n\n${block("base", BODY, rev)}\n`,
    );
    expect(fake.fileAt("acme/utf8", "heads/agent-rules/base", "AGENTS.md")).toBe(
      `# Ünïcödé — 日本語\n\n${block("base", BODY, rev)}\n`,
    );
    expect(fake.pulls("acme/eligible").map((p) => p.url)).toEqual([
      "https://github.com/acme/eligible/pull/1",
    ]);
    expect(fake.calls).toEqual([
      "createTree acme/eligible AGENTS.md",
      "createCommit acme/eligible",
      "setRef acme/eligible heads/agent-rules/base create",
      "createPullRequest acme/eligible agent-rules/base -> main",
      "createTree acme/utf8 AGENTS.md",
      "createCommit acme/utf8",
      "setRef acme/utf8 heads/agent-rules/base create",
      "createPullRequest acme/utf8 agent-rules/base -> main",
    ]);
  });

  test("the three fronts print the same dry-run table", () => {
    const [first = "", ...rest] = [...outputs.values()];
    expect(outputs.size).toBe(3);
    expect(first).toContain("acme/eligible");
    for (const other of rest) expect(other).toBe(first);
  });
});

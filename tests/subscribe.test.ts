import { describe, expect, test } from "bun:test";
import { Effect, Semaphore } from "effect";
import {
  planSubscriptionChanges,
  sameSubscriptions,
  subscriptionDiff,
} from "../src/domain/subscriptions.ts";
import { GitHub } from "../src/github/client.ts";
import {
  SUBSCRIPTIONS_BRANCH,
  type SubscribeOptions,
  type SubscribeResult,
  subscribe,
} from "../src/sync/subscribe.ts";
import { type SyncFailed, SyncRefused } from "../src/sync/sync.ts";
import { fakeGitHub } from "./fake-github.ts";

const FILE = `${JSON.stringify({ base: ["lightsound/alpha", "lightsound/beta"], personal: ["lightsound/alpha"] }, null, 2)}\n`;

const source = (
  files: Record<string, string> = {
    "subscriptions.json": FILE,
    "packs/base/AGENTS.md": "# base\n",
  },
) => fakeGitHub({ "lightsound/agent-rules": { files } });

const run = (fake: ReturnType<typeof fakeGitHub>, options: Partial<SubscribeOptions>) =>
  Effect.runPromise(
    subscribe({
      source: "lightsound/agent-rules",
      changes: [],
      mode: "pull-request",
      dryRun: false,
      ...options,
    }).pipe(
      Effect.provide(fake.layer),
      Effect.map((result) => ({ kind: "result" as const, result })),
      Effect.catchTag("SyncRefused", (e: SyncRefused) =>
        Effect.succeed({ kind: "refused" as const, message: e.message }),
      ),
      Effect.catchTag("SyncFailed", (e: SyncFailed) =>
        Effect.succeed({ kind: "failed" as const, message: e.error.message }),
      ),
    ),
  );

const sets = (text: string | null) => {
  const parsed = JSON.parse(text ?? "{}") as Record<string, string[]>;
  return parsed;
};

const writes = (fake: ReturnType<typeof fakeGitHub>) =>
  fake.calls.filter((c) =>
    /^(createTree|createCommit|setRef|createPullRequest|updatePullRequest)/.test(c),
  );

describe("planSubscriptionChanges", () => {
  test("adds and removes, keeps key order, appends a new pack key, normalizes names, drops no-ops", () => {
    const planned = planSubscriptionChanges(FILE, [
      { pack: "base", repo: "LightSound/Gamma.git", op: "add" },
      { pack: "base", repo: "lightsound/alpha", op: "add" },
      { pack: "personal", repo: "lightsound/alpha", op: "remove" },
      { pack: "personal", repo: "lightsound/zeta", op: "remove" },
      { pack: "team", repo: "lightsound/delta", op: "add" },
    ]);
    if ("reason" in planned) throw new Error(planned.reason);
    expect(sets(planned.text)).toEqual({
      base: ["lightsound/alpha", "lightsound/beta", "lightsound/gamma"],
      personal: [],
      team: ["lightsound/delta"],
    });
    expect(planned.applied.map((c) => `${c.op} ${c.pack} ${c.repo}`)).toEqual([
      "add base lightsound/gamma",
      "remove personal lightsound/alpha",
      "add team lightsound/delta",
    ]);
    expect(planned.text.endsWith("\n")).toBe(true);
    expect(planned.text).toContain('  "base": [\n    "lightsound/alpha"');
  });

  test("a no-op change plans a byte-identical file (the pack repository's own formatting)", () => {
    const planned = planSubscriptionChanges(FILE, [
      { pack: "base", repo: "lightsound/alpha", op: "add" },
    ]);
    expect("text" in planned && planned.text).toBe(FILE);
    expect("applied" in planned && planned.applied).toEqual([]);
  });

  test("an absent file plans a new one; a malformed file or a bad name is a reason", () => {
    const fresh = planSubscriptionChanges(null, [{ pack: "base", repo: "o/r", op: "add" }]);
    expect("text" in fresh && sets(fresh.text)).toEqual({ base: ["o/r"] });
    expect(planSubscriptionChanges("[1,2]", [])).toHaveProperty("reason");
    expect(planSubscriptionChanges("{", [])).toHaveProperty("reason");
    expect(
      planSubscriptionChanges(FILE, [{ pack: "base", repo: "nope", op: "add" }]),
    ).toHaveProperty("reason");
  });

  test("subscriptionDiff and sameSubscriptions compare sets, not text", () => {
    const tip = `${JSON.stringify({ personal: ["lightsound/alpha", "lightsound/beta"], base: ["lightsound/beta"] })}\n`;
    expect(subscriptionDiff(FILE, tip)).toEqual([
      { pack: "base", repo: "lightsound/alpha", op: "remove" },
      { pack: "personal", repo: "lightsound/beta", op: "add" },
    ]);
    expect(sameSubscriptions(FILE, JSON.stringify(JSON.parse(FILE)))).toBe(true);
    expect(sameSubscriptions(FILE, tip)).toBe(false);
    expect(subscriptionDiff(FILE, "nope")).toBeNull();
  });
});

describe("subscribe, pull-request mode", () => {
  test("an add opens one pull request on rulecheck/subscriptions from the base head; a dry run writes nothing", async () => {
    const fake = source();
    const dry = await run(fake, {
      changes: [{ pack: "base", repo: "lightsound/gamma", op: "add" }],
      dryRun: true,
    });
    expect(dry.kind === "result" && dry.result.kind).toBe("planned");
    expect(writes(fake)).toEqual([]);

    const live = await run(fake, {
      changes: [{ pack: "base", repo: "lightsound/gamma", op: "add" }],
      runUrl: "https://rulefleet.com/i/1/packs/base",
    });
    if (live.kind !== "result" || live.result.kind !== "opened")
      throw new Error(JSON.stringify(live));
    expect(live.result.pullRequest.number).toBe(1);
    expect(
      sets(
        fake.fileAt(
          "lightsound/agent-rules",
          `heads/${SUBSCRIPTIONS_BRANCH}`,
          "subscriptions.json",
        ),
      ),
    ).toEqual({
      base: ["lightsound/alpha", "lightsound/beta", "lightsound/gamma"],
      personal: ["lightsound/alpha"],
    });
    // The base branch is untouched.
    expect(fake.fileAt("lightsound/agent-rules", "heads/main", "subscriptions.json")).toBe(FILE);
    const pr = fake.pulls("lightsound/agent-rules")[0];
    expect(pr?.body).toContain("- subscribe `lightsound/gamma` to `base`");
    expect(pr?.body).toContain("Written from [this page](https://rulefleet.com/i/1/packs/base)");
    expect(
      fake.commitAt("lightsound/agent-rules", `heads/${SUBSCRIPTIONS_BRANCH}`).message,
    ).toStartWith("chore(agent-rules): update subscriptions");
  });

  test("a second submission carries the pending set: one branch, one pull request, both changes", async () => {
    const fake = source();
    await run(fake, { changes: [{ pack: "base", repo: "lightsound/gamma", op: "add" }] });
    const second = await run(fake, {
      changes: [{ pack: "personal", repo: "lightsound/alpha", op: "remove" }],
    });
    if (second.kind !== "result" || second.result.kind !== "updated")
      throw new Error(JSON.stringify(second));
    expect(second.result.changes.map((c) => `${c.op} ${c.pack} ${c.repo}`)).toEqual([
      "add base lightsound/gamma",
      "remove personal lightsound/alpha",
    ]);
    expect(
      sets(
        fake.fileAt(
          "lightsound/agent-rules",
          `heads/${SUBSCRIPTIONS_BRANCH}`,
          "subscriptions.json",
        ),
      ),
    ).toEqual({
      base: ["lightsound/alpha", "lightsound/beta", "lightsound/gamma"],
      personal: [],
    });
    expect(fake.pulls("lightsound/agent-rules")).toHaveLength(1);
    expect(fake.pulls("lightsound/agent-rules")[0]?.body).toContain(
      "unsubscribe `lightsound/alpha` from `personal`",
    );
    // The branch was rebuilt on the base head, not stacked on its own tip.
    const mainSha = (await Effect.runPromise(
      fake.service.getRef({ owner: "lightsound", name: "agent-rules" }, "heads/main"),
    )) as string;
    expect(
      fake.commitAt("lightsound/agent-rules", `heads/${SUBSCRIPTIONS_BRANCH}`).parents,
    ).toEqual([mainSha]);
  });

  test("resubmitting the same state is up-to-date and writes nothing; emptying the pending set is a refusal naming the pull request", async () => {
    const fake = source();
    await run(fake, { changes: [{ pack: "base", repo: "lightsound/gamma", op: "add" }] });
    const before = writes(fake).length;
    const again = await run(fake, {
      changes: [{ pack: "base", repo: "lightsound/gamma", op: "add" }],
    });
    expect(again.kind === "result" && again.result.kind).toBe("up-to-date");
    expect(writes(fake).length).toBe(before);

    const undo = await run(fake, {
      changes: [{ pack: "base", repo: "lightsound/gamma", op: "remove" }],
    });
    expect(undo.kind).toBe("refused");
    expect(undo.kind === "refused" && undo.message).toContain("pull request #1");
    expect(undo.kind === "refused" && undo.message).toContain("close it to drop them");
  });

  test("no change against the base with no branch is nothing-to-do; a foreign tip on the branch is a refusal", async () => {
    const fake = source();
    const none = await run(fake, {
      changes: [{ pack: "base", repo: "lightsound/alpha", op: "add" }],
    });
    expect(none.kind === "result" && none.result.kind).toBe("nothing-to-do");
    expect(writes(fake)).toEqual([]);

    // A human pushed the branch name: its tip was not written by rulecheck.
    fake.moveRef("lightsound/agent-rules", `heads/${SUBSCRIPTIONS_BRANCH}`, "heads/main");
    const foreign = await run(fake, {
      changes: [{ pack: "base", repo: "lightsound/gamma", op: "add" }],
    });
    expect(foreign.kind).toBe("refused");
    expect(foreign.kind === "refused" && foreign.message).toContain("was not written by rulecheck");
  });

  test("an absent file plans a new one; an invalid file is a refusal; a bad source spec is a refusal", async () => {
    const fresh = source({ "packs/base/AGENTS.md": "# base\n" });
    const opened = await run(fresh, {
      changes: [{ pack: "base", repo: "lightsound/gamma", op: "add" }],
    });
    expect(opened.kind === "result" && opened.result.kind).toBe("opened");
    expect(
      sets(
        fresh.fileAt(
          "lightsound/agent-rules",
          `heads/${SUBSCRIPTIONS_BRANCH}`,
          "subscriptions.json",
        ),
      ),
    ).toEqual({ base: ["lightsound/gamma"] });

    const invalid = source({ "subscriptions.json": '["not", "an", "object"]\n' });
    const refused = await run(invalid, {
      changes: [{ pack: "base", repo: "lightsound/gamma", op: "add" }],
    });
    expect(refused.kind).toBe("refused");
    expect(writes(invalid)).toEqual([]);

    const spec = await run(source(), { source: "lightsound/agent-rules@main", changes: [] });
    expect(spec.kind === "refused" && spec.message).toContain("owner/repo");
  });
});

describe("subscribe, direct-commit mode", () => {
  test("lands one fast-forward commit on the base branch", async () => {
    const fake = source();
    const result = await run(fake, {
      mode: "direct-commit",
      changes: [{ pack: "base", repo: "lightsound/gamma", op: "add" }],
    });
    if (result.kind !== "result" || result.result.kind !== "committed")
      throw new Error(JSON.stringify(result));
    expect(sets(fake.fileAt("lightsound/agent-rules", "heads/main", "subscriptions.json"))).toEqual(
      {
        base: ["lightsound/alpha", "lightsound/beta", "lightsound/gamma"],
        personal: ["lightsound/alpha"],
      },
    );
    expect(fake.pulls("lightsound/agent-rules")).toEqual([]);
    expect(fake.calls.filter((c) => c.startsWith("setRef"))).toEqual([
      "setRef lightsound/agent-rules heads/main force",
    ]);
    expect(
      await run(fake, {
        mode: "direct-commit",
        changes: [{ pack: "base", repo: "lightsound/gamma", op: "add" }],
      }),
    ).toMatchObject({
      result: { kind: "nothing-to-do" },
    });
  });

  test("a head that moves during the write is re-read and planned again once; both changes land; a second move is a refusal", async () => {
    const fake = source();
    // Another writer lands a different change between our commit and our setRef.
    let moved = 0;
    const racing = {
      ...fake.service,
      setRef: (repo, name, sha, options) =>
        Effect.gen(function* () {
          if (name === "heads/main" && moved === 0) {
            moved++;
            yield* Effect.provide(
              subscribe({
                source: "lightsound/agent-rules",
                mode: "direct-commit",
                dryRun: false,
                changes: [{ pack: "personal", repo: "lightsound/beta", op: "add" }],
              }),
              fake.layer,
            ).pipe(Effect.orDie);
          }
          return yield* fake.service.setRef(repo, name, sha, options);
        }),
    } satisfies typeof fake.service;
    const result = await Effect.runPromise(
      subscribe({
        source: "lightsound/agent-rules",
        mode: "direct-commit",
        dryRun: false,
        changes: [{ pack: "base", repo: "lightsound/gamma", op: "add" }],
      }).pipe(Effect.provideService(GitHub, racing)),
    );
    expect(result.kind).toBe("committed");
    expect(sets(fake.fileAt("lightsound/agent-rules", "heads/main", "subscriptions.json"))).toEqual(
      {
        base: ["lightsound/alpha", "lightsound/beta", "lightsound/gamma"],
        personal: ["lightsound/alpha", "lightsound/beta"],
      },
    );

    // Every attempt races: the second 422 is a refusal, and main holds only the racer's changes.
    const always = {
      ...fake.service,
      setRef: (repo, name, sha, options) =>
        Effect.gen(function* () {
          if (name === "heads/main") {
            yield* Effect.provide(
              subscribe({
                source: "lightsound/agent-rules",
                mode: "direct-commit",
                dryRun: false,
                changes: [
                  { pack: "personal", repo: `lightsound/racer-${fake.calls.length}`, op: "add" },
                ],
              }),
              fake.layer,
            ).pipe(Effect.orDie);
          }
          return yield* fake.service.setRef(repo, name, sha, options);
        }),
    } satisfies typeof fake.service;
    const refused = await Effect.runPromise(
      subscribe({
        source: "lightsound/agent-rules",
        mode: "direct-commit",
        dryRun: false,
        changes: [{ pack: "base", repo: "lightsound/delta", op: "add" }],
      }).pipe(
        Effect.provideService(GitHub, always),
        Effect.map((r): SubscribeResult | SyncRefused => r),
        Effect.catchTag("SyncRefused", (e: SyncRefused) => Effect.succeed(e)),
      ),
    );
    expect(refused).toBeInstanceOf(SyncRefused);
    expect((refused as SyncRefused).message).toContain("moved twice");
    expect(
      sets(fake.fileAt("lightsound/agent-rules", "heads/main", "subscriptions.json")).base,
    ).not.toContain("lightsound/delta");
  });

  test("the write runs under the caller's WriteLock", async () => {
    const fake = source();
    const semaphore = await Effect.runPromise(Semaphore.make(1));
    let held = 0;
    let overlap = false;
    const lock = {
      withPermits:
        (n: number) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          semaphore.withPermits(n)(
            Effect.gen(function* () {
              if (held > 0) overlap = true;
              held++;
              const value = yield* effect;
              held--;
              return value;
            }),
          ),
    };
    await Promise.all(
      ["gamma", "delta"].map((repo) =>
        run(fake, {
          mode: "direct-commit",
          writeLock: lock,
          changes: [{ pack: "base", repo: `lightsound/${repo}`, op: "add" }],
        }),
      ),
    );
    expect(overlap).toBe(false);
    expect(
      sets(fake.fileAt("lightsound/agent-rules", "heads/main", "subscriptions.json")).base,
    ).toEqual(["lightsound/alpha", "lightsound/beta", "lightsound/gamma", "lightsound/delta"]);
  });
});

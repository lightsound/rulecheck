import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
// Self-references through the package name resolve via the `exports` map, exactly as a consumer
// that depends on `github:lightsound/rulecheck#<sha>` imports them (m1-kickoff §3).
import { STATUS_ORDER } from "rulecheck/domain/pack";
import { GitHub } from "rulecheck/github/client";
import { fetchTransport } from "rulecheck/github/fetch";
import { mountPath } from "rulecheck/github/fs";
import { makeGitHub } from "rulecheck/github/transport";
import { renderHtml } from "rulecheck/report/html";
import { STATUS_LABEL } from "rulecheck/report/labels";
import { scan } from "rulecheck/scan/scan";
import { syncTarget } from "rulecheck/sync/sync";
import pkg from "../package.json" with { type: "json" };

describe("package.json exports", () => {
  test("exposes the subpaths the App imports, pointing at the .ts sources", () => {
    expect(pkg.exports).toEqual({
      "./domain/*": "./src/domain/*.ts",
      "./scan/*": "./src/scan/*.ts",
      "./sync/*": "./src/sync/*.ts",
      "./report/html": "./src/report/html.ts",
      "./report/labels": "./src/report/labels.ts",
      "./report/render": "./src/report/render.ts",
      "./report/sync": "./src/report/sync.ts",
      "./github/*": "./src/github/*.ts",
      "./package.json": "./package.json",
    });
  });

  test("the self-referenced modules are the same objects as the relative imports", async () => {
    const relative = await import("../src/domain/pack.ts");
    expect(STATUS_ORDER).toBe(relative.STATUS_ORDER);
    expect(STATUS_LABEL.current).toBe("current");
    expect(mountPath({ owner: "acme", name: "r" })).toBe("/github.com/acme/r");
    expect(typeof scan).toBe("function");
    expect(typeof syncTarget).toBe("function");
    expect(typeof renderHtml).toBe("function");
    const layer = Layer.succeed(
      GitHub,
      makeGitHub(fetchTransport({ token: Effect.succeed("t"), fetch: async () => new Response() })),
    );
    expect(Layer.isLayer(layer)).toBe(true);
  });
});

test("the package manifest is importable, so a host can print rulecheck's version", async () => {
  const manifest = (await import("rulecheck/package.json")) as { version: string };
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
});

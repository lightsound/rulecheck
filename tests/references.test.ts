import { describe, expect, test } from "bun:test";
import { extractReferences, parseManifest, scriptsOf } from "../src/domain/references.ts";

const refs = (content: string) =>
  extractReferences(content).map((r) => `${r.kind}:${r.value}@${r.line}`);

describe("extractReferences: scripts", () => {
  test("explicit run in fenced blocks and inline code", () => {
    const content = [
      "Run the checks:",
      "```sh",
      "bun run check",
      "$ npm run lint:fix",
      "pnpm run build && yarn run test:e2e",
      "```",
      "Then `bun run dev` to start.",
    ].join("\n");
    expect(refs(content)).toEqual([
      "script:check@3",
      "script:lint:fix@4",
      "script:build@5",
      "script:test:e2e@5",
      "script:dev@7",
    ]);
  });

  test("bare manager subcommands are scripts unless they are builtins", () => {
    expect(refs("```\nbun dev\nbun test\nbun install\npnpm typecheck\nyarn add x\n```")).toEqual([
      "script:dev@2",
      "script:typecheck@5",
    ]);
  });

  test("records whether run was explicit", () => {
    const out = extractReferences("```\nbun run dev\nbun dev\n```");
    expect(out.map((r) => r.explicitRun)).toEqual([true, false]);
  });

  test("npm without run is never a script reference", () => {
    expect(refs("```\nnpm start\nnpm test\nnpm dev\n```")).toEqual([]);
  });

  test("file arguments are not scripts", () => {
    expect(refs("```\nbun run src/main.ts\nbun src/index.ts\nbun run ./script.js\n```")).toEqual(
      [],
    );
  });

  test("comments and shell noise are skipped", () => {
    expect(refs("```\n# bun run nope\ncd apps/web && bun run dev\n```")).toEqual(["script:dev@3"]);
  });
});

describe("extractReferences: paths", () => {
  test("inline repo paths with a slash are references", () => {
    expect(
      refs("Edit `src/domain/classify.ts` and `./apps/web/` then `.cursor/rules/x.mdc`."),
    ).toEqual(["path:src/domain/classify.ts@1", "path:apps/web/@1", "path:.cursor/rules/x.mdc@1"]);
  });

  test("urls, absolute, home, scoped packages, globs, domains are ignored", () => {
    const content = [
      "`https://example.com/x` `/etc/hosts` `~/.claude/CLAUDE.md` `@effect/platform-bun`",
      "`src/**/*.ts` `<owner>/<repo>` `github.com/foo/bar` `node_modules/x/y`",
    ].join("\n");
    expect(refs(content)).toEqual([]);
  });

  test("paths inside fenced blocks are not collected (tree diagrams)", () => {
    expect(refs("```\nsrc/\n  domain/types.ts\n```")).toEqual([]);
  });

  test("paths on lines that assert absence are skipped", () => {
    expect(refs("Start mode has no `src/main.tsx`; keep `src/App.tsx`.")).toEqual([]);
    expect(refs("`src/legacy/` は存在しない。")).toEqual([]);
    expect(refs("Edit `src/App.tsx`.")).toEqual(["path:src/App.tsx@1"]);
  });

  test("single-segment names are not paths", () => {
    expect(refs("`package.json` `README.md` `src`")).toEqual([]);
  });
});

describe("scriptsOf", () => {
  test("reads script names", () => {
    expect([...scriptsOf('{"scripts":{"dev":"x","build":"y"}}')].sort()).toEqual(["build", "dev"]);
  });

  test("tolerates garbage", () => {
    expect(scriptsOf("not json").size).toBe(0);
    expect(scriptsOf('{"name":"x"}').size).toBe(0);
  });
});

describe("parseManifest", () => {
  test("collects unscoped dependency names from every dependency field", () => {
    const manifest = parseManifest(
      '{"dependencies":{"effect":"4"},"devDependencies":{"@biomejs/biome":"2"},"peerDependencies":{"typescript":"7"}}',
    );
    expect([...manifest.dependencies].sort()).toEqual(["biome", "effect", "typescript"]);
  });
});

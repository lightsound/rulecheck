import { describe, expect, test } from "bun:test";
import { classifyNestedRepo, parseGitmodulesPaths } from "../src/domain/nested.ts";

describe("parseGitmodulesPaths", () => {
  test("reads every path key, ignoring url and branch", () => {
    const content = [
      '[submodule "lib"]',
      "\tpath = vendor/lib",
      "\turl = https://github.com/acme/lib.git",
      "\tbranch = main",
      '[submodule "docs"]',
      "  path = ./docs/site/",
      "  url = ../docs.git",
      "",
    ].join("\n");
    expect(parseGitmodulesPaths(content)).toEqual(["vendor/lib", "docs/site"]);
  });

  test("unquotes git-config values and cuts trailing comments", () => {
    const content = [
      '[submodule "spaced"]',
      '\tpath = "external/my lib"',
      '[submodule "hash"]',
      '\tpath = "external/a#b" ; the quotes keep the hash',
      '[submodule "commented"]',
      "\tpath = external/plain # vendored",
      '[submodule "escaped"]',
      '\tpath = "external/q\\"uote"',
    ].join("\n");
    expect(parseGitmodulesPaths(content)).toEqual([
      "external/my lib",
      "external/a#b",
      "external/plain",
      'external/q"uote',
    ]);
  });

  test("an empty or keyless file lists nothing", () => {
    expect(parseGitmodulesPaths("")).toEqual([]);
    expect(parseGitmodulesPaths("path = loose\n")).toEqual([]);
  });
});

describe("classifyNestedRepo", () => {
  test("a .git file is a submodule, a listed directory too, anything else a nested clone", () => {
    expect(classifyNestedRepo(true, false)).toBe("submodule");
    expect(classifyNestedRepo(false, true)).toBe("submodule");
    expect(classifyNestedRepo(false, false)).toBe("nested-clone");
  });
});

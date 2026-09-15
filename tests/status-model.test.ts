import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { describeNormalization } from "../src/domain/pack.ts";
import type { Normalization } from "../src/domain/types.ts";
import { OUTCOME_LABEL, OUTCOME_ORDER, SHAPE_LABEL, STATUS_LABEL } from "../src/report/labels.ts";

/**
 * `docs/status-model.md` is the authoritative glossary (D17): every identifier and label in the
 * code must appear there. A new value fails here until the glossary names it, and the
 * `satisfies` below fails to typecheck when `Normalization` grows without this list.
 */
const GLOSSARY = readFileSync(new URL("../docs/status-model.md", import.meta.url), "utf8");

const NORMALIZATIONS = {
  keep: 0,
  "add-wrapper": 0,
  create: 0,
  move: 0,
  drop: 0,
  merge: 0,
} satisfies Record<Normalization, 0>;

function expectInGlossary(identifier: string, label: string): void {
  expect(GLOSSARY).toContain(`\`${identifier}\``);
  expect(GLOSSARY).toContain(label);
}

describe("docs/status-model.md", () => {
  test("names every shape identifier and label", () => {
    for (const [id, label] of Object.entries(SHAPE_LABEL)) expectInGlossary(id, `\`${label}\``);
  });

  test("names every pack status identifier and label; labels are the identifier with spaces", () => {
    for (const [id, label] of Object.entries(STATUS_LABEL)) {
      expectInGlossary(id, `\`${label}\``);
      expect(label).toBe(id.replaceAll("-", " "));
    }
  });

  test("names every sync outcome identifier and label, in summary order", () => {
    for (const [id, label] of Object.entries(OUTCOME_LABEL)) {
      expectInGlossary(id, `\`${label}\``);
      expect(label).toBe(id.replaceAll("-", " "));
    }
    const ordered: string[] = [...OUTCOME_ORDER].sort();
    expect(ordered).toEqual(Object.keys(OUTCOME_LABEL).sort());
  });

  test("names every normalization identifier and its eligible-row sentence", () => {
    for (const id of Object.keys(NORMALIZATIONS) as Normalization[]) {
      expectInGlossary(id, describeNormalization(id, "CLAUDE.md"));
    }
  });

  test("states the JSON schema version the scan emits", () => {
    expect(GLOSSARY).toContain('`"schemaVersion": 1`');
  });
});

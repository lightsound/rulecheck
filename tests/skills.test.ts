import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  checkSkillFrontmatter,
  computeSkillHash,
  detectSkill,
  parseSkillsLock,
  reconcileSkills,
} from "../src/domain/skills.ts";
import type { InstalledSkill } from "../src/domain/types.ts";

describe("detectSkill", () => {
  test("recognizes SKILL.md under the three agent directories", () => {
    expect(detectSkill(".agents/skills/pdf/SKILL.md")).toEqual({
      name: "pdf",
      agentDir: ".agents",
      dir: ".agents/skills/pdf",
    });
    expect(detectSkill(".claude/skills/pdf/SKILL.md")?.agentDir).toBe(".claude");
    expect(detectSkill(".cursor/skills/pdf/SKILL.md")?.agentDir).toBe(".cursor");
  });

  test("ignores other layouts", () => {
    expect(detectSkill("skills/pdf/SKILL.md")).toBeNull();
    expect(detectSkill(".claude/skills/SKILL.md")).toBeNull();
    expect(detectSkill(".claude/skills/pdf/nested/SKILL.md")).toBeNull();
    expect(detectSkill(".claude/skills/pdf/README.md")).toBeNull();
    expect(detectSkill("packages/a/.claude/skills/pdf/SKILL.md")).toBeNull();
  });
});

describe("computeSkillHash", () => {
  test("matches the skills-lock.json algorithm: sorted path then bytes", () => {
    const files = [
      { relativePath: "scripts/run.sh", content: Buffer.from("echo\n") },
      { relativePath: "SKILL.md", content: Buffer.from("---\nname: x\n---\n") },
    ];
    // `localeCompare` order, as in vercel-labs/skills: `scripts/run.sh` sorts before `SKILL.md`.
    const expected = createHash("sha256")
      .update("scripts/run.sh")
      .update(Buffer.from("echo\n"))
      .update("SKILL.md")
      .update(Buffer.from("---\nname: x\n---\n"))
      .digest("hex");
    expect(computeSkillHash(files)).toBe(expected);
    expect(computeSkillHash([...files].reverse())).toBe(expected);
  });
});

const LOCK = `{
  "version": 1,
  "skills": {
    "pdf": {
      "source": "anthropics/skills",
      "sourceType": "github",
      "skillPath": "skills/pdf/SKILL.md",
      "computedHash": "aaa"
    },
    "local-tool": {
      "source": "./tools/local-tool",
      "sourceType": "local",
      "computedHash": "bbb"
    }
  }
}
`;

describe("parseSkillsLock", () => {
  test("reads entries with their line numbers", () => {
    expect(parseSkillsLock(LOCK)).toEqual([
      {
        name: "local-tool",
        source: "./tools/local-tool",
        sourceType: "local",
        computedHash: "bbb",
        line: 10,
      },
      {
        name: "pdf",
        source: "anthropics/skills",
        sourceType: "github",
        computedHash: "aaa",
        line: 4,
      },
    ]);
  });

  test("rejects text that is not a lock file", () => {
    expect(parseSkillsLock("not json")).toBeNull();
    expect(parseSkillsLock('{"skills":{}}')).toBeNull();
    expect(parseSkillsLock('{"version":1,"skills":{}}')).toEqual([]);
  });
});

describe("checkSkillFrontmatter", () => {
  test("accepts a spec-conformant skill", () => {
    const content =
      "---\nname: pdf-tools\ndescription: >\n  Work with PDF files.\n  Use when asked.\nlicense: MIT\nmetadata:\n  author: me\n---\n# Body\n";
    expect(checkSkillFrontmatter(content, "pdf-tools")).toEqual({ name: "pdf-tools", errors: [] });
  });

  test("reports the skills-ref name and description rules", () => {
    const content = "---\nname: PDF_Tools\ndescription: ''\nversion: 1\n---\n";
    const { name, errors } = checkSkillFrontmatter(content, "pdf");
    expect(name).toBe("PDF_Tools");
    expect(errors).toEqual([
      "name must be lowercase",
      "name may only contain letters, digits, and hyphens",
      "directory `pdf` must match name `PDF_Tools`",
      "field `description` must be a non-empty string",
    ]);
  });

  test("client-specific fields are not an error", () => {
    const content =
      "---\nname: task\ndescription: Run a task.\nargument-hint: <id>\ndisable-model-invocation: true\n---\n";
    expect(checkSkillFrontmatter(content, "task").errors).toEqual([]);
  });

  test("missing frontmatter and missing name", () => {
    expect(checkSkillFrontmatter("# no frontmatter\n", "x").errors).toEqual([
      "SKILL.md must start with YAML frontmatter",
    ]);
    expect(checkSkillFrontmatter("---\ndescription: d\n---\n", "x")).toEqual({
      name: null,
      errors: ["field `name` must be a non-empty string"],
    });
  });
});

type SkillInput = Omit<InstalledSkill, "lockState">;

function skill(overrides: Pick<SkillInput, "name" | "agentDir" | "hash">): SkillInput {
  return {
    relativePath: `${overrides.agentDir}/skills/${overrides.name}`,
    frontmatterName: overrides.name,
    files: 1,
    links: [],
    ...overrides,
  };
}

describe("reconcileSkills", () => {
  const lock = parseSkillsLock(LOCK) ?? [];

  test("no lock file: inventory only, nothing judged", () => {
    const inventory = reconcileSkills(
      [skill({ name: "pdf", agentDir: ".claude", hash: "zzz" })],
      null,
    );
    expect(inventory.lock).toBeNull();
    expect(inventory.issues).toEqual([]);
    expect(inventory.skills[0]?.lockState).toBeNull();
  });

  test("lock state per skill; only a missing directory is a finding", () => {
    const inventory = reconcileSkills(
      [
        skill({ name: "pdf", agentDir: ".agents", hash: "changed" }),
        skill({ name: "extra", agentDir: ".cursor", hash: "x" }),
      ],
      lock,
    );
    expect(inventory.skills.map((s) => `${s.name}=${s.lockState}`)).toEqual([
      "pdf=differs",
      "extra=unlocked",
    ]);
    expect(inventory.issues.map((i) => `${i.kind}:${i.skill}@${i.file}:${i.line}`)).toEqual([
      "missing:local-tool@skills-lock.json:10",
    ]);
  });

  test("match, and entries without a hash", () => {
    const pdf = skill({ name: "pdf", agentDir: ".agents", hash: "aaa" });
    expect(reconcileSkills([pdf], lock).skills[0]?.lockState).toBe("match");
    const noHash = [
      { name: "pdf", source: "s", sourceType: "github", computedHash: null, line: 4 },
    ];
    expect(reconcileSkills([pdf], noHash).skills[0]?.lockState).toBe("locked");
  });
});

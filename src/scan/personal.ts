import { Effect, FileSystem, Path } from "effect";
import { extractClaudeImports } from "../domain/classify.ts";
import type { FileKind, InstructionFile, PersonalLayer } from "../domain/types.ts";
import { analyzeFile } from "./analyze.ts";

/** Where Claude Code reads an organization-wide CLAUDE.md that users cannot exclude. */
const MANAGED_POLICY_PATHS: ReadonlyArray<string> = [
  "/Library/Application Support/ClaudeCode/CLAUDE.md",
  "/etc/claude-code/CLAUDE.md",
];

/**
 * Collect the instruction files that load in every session from the user's home.
 *
 * Claude Code: `~/.claude/CLAUDE.md`, one level of its `@imports`, `~/.claude/rules/*.md`, the
 * managed policy file, and `~/CLAUDE.md` via the ancestor walk.
 *
 * Cursor: `~/AGENTS.md`, `~/CLAUDE.md`, and always-apply `~/.cursor/rules/*.mdc` via its ancestor
 * walk, for any workspace under home.
 */
export const scanPersonal = (
  home: string,
): Effect.Effect<PersonalLayer, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const claudeDir = path.join(home, ".claude");
    const files: InstructionFile[] = [];
    let claudeCodeTokens = 0;
    let cursorTokens = 0;

    const exists = (target: string) =>
      fs.exists(target).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)));

    const analyze = (input: {
      readonly path: string;
      readonly relativePath: string;
      readonly kind: FileKind;
      readonly depth: number;
    }) =>
      analyzeFile(fs, input).pipe(
        // "Wrapper of a sibling AGENTS.md" is a repository concept. `~/CLAUDE.md` beside
        // `~/AGENTS.md` is the one place it also applies at home.
        Effect.map((analyzed) =>
          input.relativePath === "~/CLAUDE.md"
            ? analyzed
            : {
                ...analyzed,
                file: { ...analyzed.file, wrapperTarget: null, wrapperUsesImport: false },
              },
        ),
      );

    // Claude Code: ~/.claude/CLAUDE.md and its imports
    const rootClaude = path.join(claudeDir, "CLAUDE.md");
    if (yield* exists(rootClaude)) {
      const analyzed = yield* analyze({
        path: rootClaude,
        relativePath: "~/.claude/CLAUDE.md",
        kind: "claude-md",
        depth: 0,
      });
      files.push(analyzed.file);
      claudeCodeTokens += analyzed.file.tokens;

      for (const target of extractClaudeImports(analyzed.content)) {
        const resolved = target.startsWith("~/")
          ? path.join(home, target.slice(2))
          : path.resolve(claudeDir, target);
        if (!(yield* exists(resolved))) continue;
        const imported = yield* analyze({
          path: resolved,
          relativePath: target.startsWith("~/") ? target : `~/.claude/${target}`,
          kind: "imported-md",
          depth: 0,
        });
        files.push(imported.file);
        claudeCodeTokens += imported.file.tokens;
      }
    }

    // Claude Code: ~/.claude/rules/*.md
    const rulesDir = path.join(claudeDir, "rules");
    const ruleNames = yield* fs
      .readDirectory(rulesDir)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed<Array<string>>([])));
    for (const name of ruleNames.filter((n) => n.endsWith(".md")).sort()) {
      const analyzed = yield* analyze({
        path: path.join(rulesDir, name),
        relativePath: `~/.claude/rules/${name}`,
        kind: "claude-rule",
        depth: 1,
      });
      files.push(analyzed.file);
      if ((analyzed.file.frontmatter?.paths.length ?? 0) === 0)
        claudeCodeTokens += analyzed.file.tokens;
    }

    // Both tools: ~/AGENTS.md (Cursor only) and ~/CLAUDE.md (Cursor and Claude Code) via ancestor walk
    const homeAgents = path.join(home, "AGENTS.md");
    let homeAgentsFile: InstructionFile | null = null;
    if (yield* exists(homeAgents)) {
      const analyzed = yield* analyze({
        path: homeAgents,
        relativePath: "~/AGENTS.md",
        kind: "agents-md",
        depth: 0,
      });
      homeAgentsFile = analyzed.file;
      files.push(analyzed.file);
      cursorTokens += analyzed.file.tokens;
    }

    const homeClaude = path.join(home, "CLAUDE.md");
    if (yield* exists(homeClaude)) {
      const analyzed = yield* analyze({
        path: homeClaude,
        relativePath: "~/CLAUDE.md",
        kind: "claude-md",
        depth: 0,
      });
      files.push(analyzed.file);
      cursorTokens += analyzed.file.tokens;
      claudeCodeTokens += analyzed.file.tokens;
      if (analyzed.file.wrapperUsesImport && homeAgentsFile) {
        claudeCodeTokens += homeAgentsFile.tokens;
      }
    }

    // Cursor: ~/.cursor/rules/**/*.mdc (always-apply ones count toward the budget)
    const cursorRulesDir = path.join(home, ".cursor", "rules");
    const cursorRuleNames = yield* fs
      .readDirectory(cursorRulesDir)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed<Array<string>>([])));
    for (const name of cursorRuleNames.filter((n) => n.endsWith(".mdc")).sort()) {
      const analyzed = yield* analyze({
        path: path.join(cursorRulesDir, name),
        relativePath: `~/.cursor/rules/${name}`,
        kind: "cursor-rule",
        depth: 1,
      });
      files.push(analyzed.file);
      if (analyzed.file.frontmatter?.alwaysApply === true) cursorTokens += analyzed.file.tokens;
    }

    // Claude Code: managed policy
    let managedPolicyPath: string | null = null;
    for (const candidate of MANAGED_POLICY_PATHS) {
      if (yield* exists(candidate)) {
        managedPolicyPath = candidate;
        const analyzed = yield* analyze({
          path: candidate,
          relativePath: candidate,
          kind: "claude-md",
          depth: 0,
        });
        files.push(analyzed.file);
        claudeCodeTokens += analyzed.file.tokens;
        break;
      }
    }

    return {
      home,
      files,
      claudeCodeTokens,
      cursorTokens,
      managedPolicyPath,
    } satisfies PersonalLayer;
  });

import { Effect, FileSystem, Path } from "effect";
import { extractClaudeImports } from "../domain/classify.ts";
import type { InstructionFile, PersonalLayer } from "../domain/types.ts";
import { analyzeFile } from "./analyze.ts";

/** Where Claude Code reads an organization-wide CLAUDE.md that users cannot exclude. */
const MANAGED_POLICY_PATHS: ReadonlyArray<string> = [
  "/Library/Application Support/ClaudeCode/CLAUDE.md",
  "/etc/claude-code/CLAUDE.md",
];

/**
 * Collect the instruction files Claude Code loads in every session from the user's home:
 * `~/.claude/CLAUDE.md`, one level of its `@imports`, `~/.claude/rules/*.md`, and the managed
 * policy file when present.
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

    const exists = (target: string) =>
      fs.exists(target).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)));

    const rootClaude = path.join(claudeDir, "CLAUDE.md");
    if (yield* exists(rootClaude)) {
      const analyzed = yield* analyzeFile(fs, {
        path: rootClaude,
        relativePath: "CLAUDE.md",
        kind: "claude-md",
        depth: 0,
      });
      // "Wrapper of a sibling AGENTS.md" is a repository concept; the global file has no sibling.
      files.push({ ...analyzed.file, wrapperTarget: null, wrapperUsesImport: false });
      claudeCodeTokens += analyzed.file.tokens;

      for (const target of extractClaudeImports(analyzed.content)) {
        const resolved = target.startsWith("~/")
          ? path.join(home, target.slice(2))
          : path.resolve(claudeDir, target);
        if (!(yield* exists(resolved))) continue;
        const imported = yield* analyzeFile(fs, {
          path: resolved,
          relativePath: target,
          kind: "imported-md",
          depth: 0,
        });
        files.push(imported.file);
        claudeCodeTokens += imported.file.tokens;
      }
    }

    const rulesDir = path.join(claudeDir, "rules");
    const ruleNames = yield* fs
      .readDirectory(rulesDir)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed<Array<string>>([])));
    for (const name of ruleNames.filter((n) => n.endsWith(".md")).sort()) {
      const analyzed = yield* analyzeFile(fs, {
        path: path.join(rulesDir, name),
        relativePath: `rules/${name}`,
        kind: "claude-rule",
        depth: 1,
      });
      files.push(analyzed.file);
      if ((analyzed.file.frontmatter?.paths.length ?? 0) === 0)
        claudeCodeTokens += analyzed.file.tokens;
    }

    let managedPolicyPath: string | null = null;
    for (const candidate of MANAGED_POLICY_PATHS) {
      if (yield* exists(candidate)) {
        managedPolicyPath = candidate;
        const analyzed = yield* analyzeFile(fs, {
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

    return { home, files, claudeCodeTokens, managedPolicyPath } satisfies PersonalLayer;
  });

import { createHash } from "node:crypto";
import { Effect, type FileSystem } from "effect";
import {
  detectWrapperTarget,
  importsAgentsMd,
  parseFrontmatter,
  usesClaudeImport,
} from "../domain/classify.ts";
import { countTokens } from "../domain/tokens.ts";
import type { FileKind, InstructionFile } from "../domain/types.ts";

export interface AnalyzedFile {
  readonly file: InstructionFile;
  readonly content: string;
}

/** Read one instruction file and compute everything the report needs about it. Unreadable files count as empty. */
export const analyzeFile = (
  fs: FileSystem.FileSystem,
  input: {
    readonly path: string;
    readonly relativePath: string;
    readonly kind: FileKind;
    readonly depth: number;
  },
): Effect.Effect<AnalyzedFile> =>
  Effect.gen(function* () {
    const content = yield* fs
      .readFileString(input.path)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")));
    const trimmed = content.trim();
    const wrapperTarget = detectWrapperTarget(content);
    const file: InstructionFile = {
      path: input.path,
      relativePath: input.relativePath,
      kind: input.kind,
      depth: input.depth,
      bytes: Buffer.byteLength(content, "utf8"),
      lines: trimmed.length === 0 ? 0 : trimmed.split("\n").length,
      tokens: countTokens(content),
      contentHash: createHash("sha256").update(trimmed).digest("hex"),
      wrapperTarget,
      wrapperUsesImport: wrapperTarget !== null && usesClaudeImport(content, wrapperTarget),
      // Only the root CLAUDE.md: Claude Code resolves a relative import against the importing
      // file's directory, so `@AGENTS.md` in `.claude/CLAUDE.md` points at `.claude/AGENTS.md`.
      importsAgentsMd: input.relativePath === "CLAUDE.md" && importsAgentsMd(content),
      frontmatter:
        input.kind === "cursor-rule" || input.kind === "claude-rule"
          ? parseFrontmatter(content)
          : null,
    };
    return { file, content };
  });

import { normalizeBody, parseBlocks } from "./block.ts";
import { classifyBothFull, claudeContentBeyondImport } from "./classify.ts";
import type { FileChange } from "./diff.ts";
import type {
  CanonicalShape,
  InstructionFile,
  ManagedBlock,
  Pack,
  PackStatusEntry,
} from "./types.ts";

/**
 * The plan a sync would carry out on one repository for one pack (D10): the normalized root pair
 * with the pack's block inserted or updated. Pure; the caller supplies the files as they are on
 * the base branch and applies the resulting changes remotely.
 */

export const WRAPPER_CONTENT = "@AGENTS.md\n";

export interface SyncPlan {
  readonly changes: ReadonlyArray<FileChange>;
  /** Human-readable steps, one per normalization action, for the pull request body. */
  readonly actions: ReadonlyArray<string>;
  /** Path of the file that carries the block after the change, and the block's first line there. */
  readonly blockFile: string;
  readonly blockLine: number;
}

export interface SyncRefusal {
  readonly reason: string;
}

export interface SyncPlanInput {
  readonly shape: CanonicalShape;
  readonly files: ReadonlyArray<InstructionFile>;
  /** Content of every root-pair file present, keyed by repo-relative path. */
  readonly contents: ReadonlyMap<string, string>;
  readonly blocks: ReadonlyArray<ManagedBlock>;
  readonly status: PackStatusEntry;
  readonly pack: Pack;
  /** Pack ids in subscription order (`subscriptions.json` key order). Decides block order. */
  readonly packOrder: ReadonlyArray<string>;
}

const ROOT_CLAUDE = ["CLAUDE.md", ".claude/CLAUDE.md"] as const;

/** Render a block as the D9 markers around the normalized body. */
export function renderBlock(pack: Pack): string | null {
  const block = pack.files.find((f) => f.kind === "agents-block");
  if (!block) return null;
  const rev = pack.rev ? ` rev=${pack.rev}` : "";
  return [
    `<!-- agent-rules:begin source=${pack.id}${rev} hash=${block.hash} -->`,
    normalizeBody(block.body),
    "<!-- agent-rules:end -->",
  ].join("\n");
}

export function planSync(input: SyncPlanInput): SyncPlan | SyncRefusal {
  const rendered = renderBlock(input.pack);
  if (rendered === null) return { reason: `pack \`${input.pack.id}\` has no AGENTS.md block` };

  switch (input.status.status) {
    case "outdated":
      return planUpdate(input, rendered);
    case "eligible":
      return planInsert(input, rendered);
    default:
      return {
        reason: `status is ${input.status.status}; only eligible and outdated repositories are written`,
      };
  }
}

function planUpdate(input: SyncPlanInput, rendered: string): SyncPlan | SyncRefusal {
  const block = input.blocks.find(
    (b) =>
      b.source === input.pack.id &&
      (b.file === "AGENTS.md" || ROOT_CLAUDE.includes(b.file as never)),
  );
  const before = block ? input.contents.get(block.file) : undefined;
  if (!block || before === undefined) {
    return {
      reason: `status is outdated but no block for \`${input.pack.id}\` was found in the root pair`,
    };
  }
  const lines = before.split("\n");
  lines.splice(block.line - 1, block.endLine - block.line + 1, ...rendered.split("\n"));
  return {
    changes: [{ path: block.file, before, after: lines.join("\n") }],
    actions: [`update block \`${input.pack.id}\` in ${block.file}`],
    blockFile: block.file,
    blockLine: block.line,
  };
}

function planInsert(input: SyncPlanInput, rendered: string): SyncPlan | SyncRefusal {
  const has = (path: string) => input.contents.has(path);
  const wrapperChange = (): FileChange => ({
    path: "CLAUDE.md",
    before: input.contents.get("CLAUDE.md") ?? null,
    after: WRAPPER_CONTENT,
  });

  switch (input.shape) {
    case "none": {
      if (has("AGENTS.md") || ROOT_CLAUDE.some(has)) return unexpected("none");
      const inserted = insertBlock("", rendered, input);
      return {
        changes: [{ path: "AGENTS.md", before: null, after: inserted.content }, wrapperChange()],
        actions: [
          `create AGENTS.md with block \`${input.pack.id}\``,
          "create CLAUDE.md wrapper (`@AGENTS.md`)",
        ],
        blockFile: "AGENTS.md",
        blockLine: inserted.line,
      };
    }
    case "agents-only": {
      const before = input.contents.get("AGENTS.md");
      if (before === undefined || ROOT_CLAUDE.some(has)) return unexpected("agents-only");
      const inserted = insertBlock(before, rendered, input);
      return {
        changes: [{ path: "AGENTS.md", before, after: inserted.content }, wrapperChange()],
        actions: [
          `insert block \`${input.pack.id}\` into AGENTS.md`,
          "create CLAUDE.md wrapper (`@AGENTS.md`)",
        ],
        blockFile: "AGENTS.md",
        blockLine: inserted.line,
      };
    }
    case "agents-canonical": {
      const before = input.contents.get("AGENTS.md");
      if (before === undefined) return unexpected("agents-canonical");
      const inserted = insertBlock(before, rendered, input);
      return {
        changes: [{ path: "AGENTS.md", before, after: inserted.content }],
        actions: [`insert block \`${input.pack.id}\` into AGENTS.md`],
        blockFile: "AGENTS.md",
        blockLine: inserted.line,
      };
    }
    case "claude-only":
    case "claude-canonical": {
      const present = ROOT_CLAUDE.filter(has);
      const contentFile = present[0];
      if (present.length !== 1 || contentFile === undefined) {
        return { reason: "both CLAUDE.md and .claude/CLAUDE.md exist; keep one before syncing" };
      }
      const claudeContent = input.contents.get(contentFile) ?? "";
      const agentsBefore = input.contents.get("AGENTS.md") ?? null;
      if (input.shape === "claude-only" && agentsBefore !== null) return unexpected("claude-only");
      if (input.shape === "claude-canonical") {
        const wrapper = input.files.find((f) => f.relativePath === "AGENTS.md");
        if (wrapper?.wrapperTarget !== "CLAUDE.md") return unexpected("claude-canonical");
      }
      const inserted = insertBlock(claudeContent, rendered, input);
      const changes: FileChange[] = [
        { path: "AGENTS.md", before: agentsBefore, after: inserted.content },
      ];
      const actions = [
        `move ${contentFile} content to AGENTS.md`,
        `insert block \`${input.pack.id}\` into AGENTS.md`,
      ];
      if (contentFile === "CLAUDE.md") {
        changes.push({ path: "CLAUDE.md", before: claudeContent, after: WRAPPER_CONTENT });
        actions.push("replace CLAUDE.md with the wrapper (`@AGENTS.md`)");
      } else {
        changes.push({ path: contentFile, before: claudeContent, after: null });
        changes.push({ path: "CLAUDE.md", before: null, after: WRAPPER_CONTENT });
        actions.push(`remove ${contentFile}`, "create CLAUDE.md wrapper (`@AGENTS.md`)");
      }
      return { changes, actions, blockFile: "AGENTS.md", blockLine: inserted.line };
    }
    case "both-full": {
      const present = ROOT_CLAUDE.filter(has);
      const claudeFile = present[0];
      const agentsBefore = input.contents.get("AGENTS.md");
      if (present.length !== 1 || claudeFile === undefined) {
        return { reason: "both CLAUDE.md and .claude/CLAUDE.md exist; keep one before syncing" };
      }
      if (agentsBefore === undefined) return unexpected("both-full");
      const claudeContent = input.contents.get(claudeFile) ?? "";
      const normalization = classifyBothFull(agentsBefore, claudeContent);
      const actions: string[] = [];
      let agentsContent = agentsBefore;
      if (normalization === "merge") {
        agentsContent = mergeClaudeContent(agentsBefore, claudeContentBeyondImport(claudeContent));
        actions.push(
          `append ${claudeFile} content to AGENTS.md under \`${MERGED_HEADING}\` (verbatim, before any managed block; duplicates or conflicts with the text above it are left for review)`,
        );
      } else {
        actions.push(`drop ${claudeFile} content, which AGENTS.md already contains`);
      }
      const inserted = insertBlock(agentsContent, rendered, input);
      const changes: FileChange[] = [
        { path: "AGENTS.md", before: agentsBefore, after: inserted.content },
      ];
      actions.push(`insert block \`${input.pack.id}\` into AGENTS.md`);
      if (claudeFile === "CLAUDE.md") {
        changes.push({ path: "CLAUDE.md", before: claudeContent, after: WRAPPER_CONTENT });
        actions.push("replace CLAUDE.md with the wrapper (`@AGENTS.md`)");
      } else {
        changes.push({ path: claudeFile, before: claudeContent, after: null });
        changes.push({ path: "CLAUDE.md", before: null, after: WRAPPER_CONTENT });
        actions.push(`remove ${claudeFile}`, "create CLAUDE.md wrapper (`@AGENTS.md`)");
      }
      return { changes, actions, blockFile: "AGENTS.md", blockLine: inserted.line };
    }
  }
}

/** Heading under which a merged CLAUDE.md lands in AGENTS.md (D12). */
export const MERGED_HEADING = "## Merged from CLAUDE.md";

/**
 * Append `extra` (CLAUDE.md beyond its import, see `claudeContentBeyondImport`) to `agents` under
 * `MERGED_HEADING`: before the first managed block so project text stays ahead of distributed
 * text, otherwise at the end. The text is copied verbatim; nothing is deduplicated.
 */
export function mergeClaudeContent(agents: string, extra: string): string {
  const section = [MERGED_HEADING, "", extra];
  const first = parseBlocks("", agents).blocks[0];
  if (first) {
    const lines = agents.split("\n");
    const previous = lines[first.line - 2];
    const leading = previous !== undefined && previous.trim().length > 0 ? [""] : [];
    lines.splice(first.line - 1, 0, ...leading, ...section, "");
    return lines.join("\n");
  }
  const head = agents.replace(/\s+$/, "");
  const body = section.join("\n");
  return head.length === 0 ? `${body}\n` : `${head}\n\n${body}\n`;
}

function unexpected(shape: CanonicalShape): SyncRefusal {
  return { reason: `root files do not match shape \`${shape}\`; rescan the repository` };
}

/**
 * Insert `rendered` into `content`: before the first existing block of a pack that comes later in
 * subscription order, otherwise at the end. Returns the new content and the block's first line.
 */
function insertBlock(
  content: string,
  rendered: string,
  input: SyncPlanInput,
): { content: string; line: number } {
  const order = new Map(input.packOrder.map((id, index) => [id, index] as const));
  const own = order.get(input.pack.id) ?? Number.POSITIVE_INFINITY;
  const later = parseBlocks("", content).blocks.find(
    (b) => (order.get(b.source) ?? Number.POSITIVE_INFINITY) > own,
  );

  if (later) {
    const lines = content.split("\n");
    lines.splice(later.line - 1, 0, ...rendered.split("\n"), "");
    return { content: lines.join("\n"), line: later.line };
  }

  const head = content.replace(/\s+$/, "");
  if (head.length === 0) return { content: `${rendered}\n`, line: 1 };
  return { content: `${head}\n\n${rendered}\n`, line: head.split("\n").length + 2 };
}

/**
 * Every commit rulecheck writes starts with this prefix. Before the tool-owned branch is
 * force-moved, its tip commit must carry it; otherwise a human or another tool put the branch
 * there and the sync refuses (D10).
 */
export const COMMIT_PREFIX = "chore(agent-rules):";

export function isRulecheckCommit(message: string): boolean {
  return message.startsWith(COMMIT_PREFIX);
}

/** Title and body of the pull request that carries a plan. */
export function pullRequestText(
  plan: SyncPlan,
  pack: Pack,
  status: PackStatusEntry,
): { title: string; body: string } {
  const block = pack.files.find((f) => f.kind === "agents-block");
  const update = status.status === "outdated";
  const title = `${COMMIT_PREFIX} ${update ? "update" : "add"} \`${pack.id}\` instruction block`;
  // An update replaces the block in place and leaves the shape of the root pair as it was.
  const shapeCheck = update
    ? "its existing block was replaced in place (the shape of the root pair is unchanged)"
    : "its root pair is `AGENTS.md` canonical (already, or by the changes above)";
  const body = [
    `Managed by rulecheck. This branch is rewritten on every sync; edit the pack \`${pack.id}\`, not this branch.`,
    "",
    `- pack: \`${pack.id}\``,
    `- rev: \`${pack.rev ?? "unknown"}\``,
    `- hash: \`${block?.hash ?? "unknown"}\``,
    `- block: ${plan.blockFile}:${plan.blockLine}`,
    "",
    "Changes:",
    ...plan.actions.map((action) => `- ${action}`),
    "",
    `Checks passed before this pull request was opened: the repository is subscribed, ${shapeCheck}, and the block adds no reference to a script or path that does not exist here.`,
  ].join("\n");
  return { title, body };
}

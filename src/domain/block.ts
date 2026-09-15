import { createHash } from "node:crypto";
import type { BlockIssue, ForeignRegion, ManagedBlock } from "./types.ts";

/**
 * Managed blocks (decisions D4, D7, D9):
 *
 *     <!-- agent-rules:begin source=<pack-id> rev=<git sha> hash=<sha256 of body> -->
 *     ...
 *     <!-- agent-rules:end -->
 *
 * Markers occupy a whole line. `source` and `hash` are required, `rev` is optional, other
 * `key=value` attributes are ignored. Blocks do not nest; a second `begin` before an `end`, an
 * `end` without a `begin`, or a `begin` without an `end` is reported as a malformed marker and the
 * enclosing text is not treated as a block.
 */

const BEGIN = /^\s*<!--\s*agent-rules:begin\b([^>]*?)-->\s*$/;
const END = /^\s*<!--\s*agent-rules:end\s*-->\s*$/;
const ANY_MARKER = /^\s*<!--\s*agent-rules:/;
const ATTRIBUTE = /([A-Za-z][A-Za-z0-9_-]*)=("[^"]*"|'[^']*'|\S+)/g;

/**
 * Hash of a block body, the value written to `hash=`.
 *
 * Line endings are normalized to `\n` and surrounding blank lines are dropped before hashing, so
 * a checkout with `autocrlf` or an editor that adds a final newline does not turn a distributed
 * block into a `modified` one (D9).
 */
export function hashBlockBody(body: string): string {
  return createHash("sha256").update(normalizeBody(body)).digest("hex");
}

export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").trim();
}

export interface ParsedBlocks {
  readonly blocks: ReadonlyArray<ManagedBlock>;
  readonly issues: ReadonlyArray<BlockIssue>;
}

function parseAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of text.matchAll(ATTRIBUTE)) {
    const key = match[1] ?? "";
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    attributes.set(key, value);
  }
  return attributes;
}

interface OpenBlock {
  readonly line: number;
  readonly source: string;
  readonly hash: string;
  readonly rev: string | null;
}

/** Find every managed block in `content`. `file` is only carried into the results. */
export function parseBlocks(file: string, content: string): ParsedBlocks {
  const blocks: ManagedBlock[] = [];
  const issues: BlockIssue[] = [];
  const malformed = (line: number, message: string) =>
    issues.push({ kind: "malformed-marker", file, line, message });

  const lines = content.split("\n");
  let open: OpenBlock | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const lineNumber = index + 1;

    const begin = BEGIN.exec(rawLine);
    if (begin) {
      if (open) {
        malformed(
          lineNumber,
          `\`agent-rules:begin\` inside the block opened at line ${open.line}; blocks do not nest`,
        );
        open = null;
      }
      const attributes = parseAttributes(begin[1] ?? "");
      const source = attributes.get("source");
      const hash = attributes.get("hash");
      if (!source || !hash) {
        malformed(lineNumber, `\`agent-rules:begin\` is missing ${source ? "hash=" : "source="}`);
        continue;
      }
      open = { line: lineNumber, source, hash, rev: attributes.get("rev") ?? null };
      continue;
    }

    if (END.test(rawLine)) {
      if (!open) {
        malformed(lineNumber, "`agent-rules:end` without a matching `agent-rules:begin`");
        continue;
      }
      const body = lines.slice(open.line, index).join("\n");
      const bodyHash = hashBlockBody(body);
      blocks.push({
        file,
        source: open.source,
        rev: open.rev,
        hash: open.hash,
        bodyHash,
        line: open.line,
        endLine: lineNumber,
        body,
        modified: open.hash !== bodyHash,
      });
      open = null;
      continue;
    }

    if (ANY_MARKER.test(rawLine) && rawLine.includes("-->")) {
      malformed(lineNumber, `unrecognized \`agent-rules:\` marker: ${rawLine.trim()}`);
    }
  }

  if (open) malformed(open.line, "`agent-rules:begin` without a matching `agent-rules:end`");

  return { blocks, issues };
}

/**
 * Markers of other tools in a file rulecheck would write (D9, D15).
 *
 * Two kinds of single-line HTML comment are recognized; our own `agent-rules:` markers are not
 * foreign.
 *
 * - **Region markers** open or close a region another generator owns. Vocabularies: a comment
 *   starting with `BEGIN` / `END` in capitals (`<!-- BEGIN_TF_DOCS -->`, `<!-- END: foo -->`), or
 *   one whose last token is `start` / `begin` / `end` joined to a name by `:`, `-` or `_`
 *   (`<!-- generated:task-matrix:start -->`, `<!-- convex-ai-end -->`). The name is the rest of
 *   the comment, compared case-insensitively. A `start` followed by the `end` of the same name,
 *   with no other region marker between them, is a well-formed region: opaque, never written,
 *   and every line inside it is ignored by this detection (a "Managed by X. Do not edit inside
 *   this block" line inside a region describes the region, not the file).
 * - **File-level markers** are comments containing `managed`, `generated`, `autogenerated` or
 *   `do not edit` (any case) that are not region markers: the whole file is generated.
 *
 * Every region marker that does not form a well-formed region (unpaired, nested, mismatched
 * name) and every file-level marker outside a region is an issue: the file is blocked.
 */
const SINGLE_LINE_COMMENT = /^\s*<!--([^>]*)-->\s*$/;
const FOREIGN_WORDS = /\b(?:managed|generated|autogenerated|do not edit)\b/i;
const REGION_PREFIX = /^(BEGIN|END)(?![a-z])(.*)$/s;
const REGION_SUFFIX = /^(.*\S)[:_-](start|begin|end)$/is;

type MarkerRole = "start" | "end" | "file";

interface Marker {
  readonly role: MarkerRole;
  /** Region name as written in the marker (`generated:task-matrix`); empty for file-level markers. */
  readonly name: string;
  /** `name` case-folded with separators normalized; start and end must agree on it. */
  readonly key: string;
  /** The marker line as written, trimmed, for messages. */
  readonly raw: string;
}

function regionMarker(role: MarkerRole, name: string, raw: string): Marker {
  const display = name.replace(/^[\s:_-]+/, "").trim();
  return { role, name: display, key: display.replace(/\s+/g, " ").toLowerCase(), raw };
}

function classifyMarker(rawLine: string): Marker | null {
  if (ANY_MARKER.test(rawLine)) return null;
  const comment = SINGLE_LINE_COMMENT.exec(rawLine);
  if (!comment) return null;
  const text = (comment[1] ?? "").trim();
  const raw = rawLine.trim();
  const prefix = REGION_PREFIX.exec(text);
  if (prefix) return regionMarker(prefix[1] === "BEGIN" ? "start" : "end", prefix[2] ?? "", raw);
  const suffix = REGION_SUFFIX.exec(text);
  if (suffix) {
    const role = (suffix[2] ?? "").toLowerCase() === "end" ? "end" : "start";
    return regionMarker(role, suffix[1] ?? "", raw);
  }
  if (FOREIGN_WORDS.test(text)) return { role: "file", name: "", key: "", raw };
  return null;
}

export interface ForeignMarkers {
  readonly regions: ReadonlyArray<ForeignRegion>;
  readonly issues: ReadonlyArray<BlockIssue>;
}

export function findForeignMarkers(file: string, content: string): ForeignMarkers {
  const regions: ForeignRegion[] = [];
  const issues: BlockIssue[] = [];
  const issue = (line: number, message: string) =>
    issues.push({ kind: "foreign-marker", file, line, message });

  let open: { line: number; marker: Marker } | null = null;
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const marker = classifyMarker(lines[index] ?? "");
    if (!marker) continue;
    const line = index + 1;

    if (open) {
      if (marker.role === "end" && marker.key === open.marker.key) {
        regions.push({ file, name: open.marker.name, line: open.line, endLine: line });
        open = null;
      } else if (marker.role === "end") {
        issue(
          line,
          `region marker ${marker.raw} does not close the region started at line ${open.line} (${open.marker.raw})`,
        );
      } else if (marker.role === "start") {
        issue(
          line,
          `region marker ${marker.raw} opens inside the region started at line ${open.line}; nested regions are not supported`,
        );
      }
      // A file-level marker inside a region describes the region: opaque.
      continue;
    }

    switch (marker.role) {
      case "start":
        open = { line, marker };
        break;
      case "end":
        issue(line, `unpaired region marker ${marker.raw} has no opening marker`);
        break;
      case "file":
        issue(line, `another tool marks the whole file (no closing marker): ${marker.raw}`);
        break;
    }
  }
  if (open) {
    issue(
      open.line,
      `unpaired region marker ${open.marker.raw} has no closing marker; the region it opens cannot be told from the rest of the file`,
    );
  }
  issues.sort((a, b) => a.line - b.line);
  return { regions, issues };
}

/** Lines of every well-formed region in `content`, markers included, in file order. */
function regionTexts(content: string): ReadonlyArray<{ name: string; text: string }> {
  const lines = content.split("\n");
  return findForeignMarkers("", content).regions.map((region) => ({
    name: region.name,
    text: lines.slice(region.line - 1, region.endLine).join("\n"),
  }));
}

/**
 * Whether rewriting a file from `before` to `after` keeps every foreign region as it was: same
 * regions, same order, same bytes (D15). Returns null when it does, otherwise the reason. A
 * removed file (`after === null`) keeps nothing.
 */
export function foreignRegionDrift(
  file: string,
  before: string | null,
  after: string | null,
): string | null {
  if (before === null) return null;
  const expected = regionTexts(before);
  if (expected.length === 0) return null;
  if (after === null) {
    return `${file} would be removed together with the region \`${expected[0]?.name ?? ""}\` another tool owns`;
  }
  const actual = regionTexts(after);
  if (actual.length !== expected.length) {
    return `${file} would carry ${actual.length} foreign region(s) instead of ${expected.length}`;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index];
    const got = actual[index];
    if (!want || !got) continue;
    if (want.name !== got.name || want.text !== got.text) {
      return `${file}: the region \`${want.name}\` another tool owns would change`;
    }
  }
  return null;
}

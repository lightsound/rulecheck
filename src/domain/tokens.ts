import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

let encoder: Tiktoken | null = null;

/**
 * Count tokens with the o200k_base vocabulary.
 *
 * Vendors do not publish their exact tokenizers for Claude or Cursor's models, so this is an
 * approximation. It is stable across runs, which is what matters for comparing files and repos.
 */
export function countTokens(text: string): number {
  if (!encoder) encoder = new Tiktoken(o200k_base);
  return encoder.encode(text, "all").length;
}

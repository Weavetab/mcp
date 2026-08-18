import type { ActionElement } from "../cdp/walker.js";

const MAX_LABEL_LENGTH = 500;

// Comprehensive zero-width and invisible Unicode blocklist for prompt injection
// defense: LRM/RLM, line/paragraph separators, bidi isolates, combining grapheme
// joiner, variation selectors, and en/em/thin/hair spaces.
const INVISIBLE_CHAR_REGEX = /[\u200B-\u200F\uFEFF\u00AD\u2060\u180E\u00A0\u2028\u2029\u2066-\u2069\u034F\uFE00-\uFE0F\u2000-\u200A]/;

function isLikelySuspicious(label: string): boolean {
  if (label.length > MAX_LABEL_LENGTH) return true;
  // NFKC normalization collapses homoglyph/ligature attacks before checking
  const normalized = label.normalize("NFKC");
  if (INVISIBLE_CHAR_REGEX.test(normalized)) return true;
  // Excessive whitespace: more than 5 consecutive spaces/tabs not at start/end
  if (/[ \t]{6,}/.test(normalized.trim())) return true;
  return false;
}

export function filterHidden(elements: ActionElement[]): ActionElement[] {
  return elements.filter((el) => !isLikelySuspicious(el.label));
}

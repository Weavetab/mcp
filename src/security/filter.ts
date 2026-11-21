import type { ActionElement } from "../cdp/walker.js";

const MAX_LABEL_LENGTH = 500;

const INVISIBLE_CHAR_REGEX = /[\u200B-\u200F\uFEFF\u00AD\u2060\u180E\u2028\u2029\u202A-\u202E\u2066-\u2069\u034F\uFE00-\uFE0E\u2000-\u200A\u{E0000}-\u{E007F}]/u;
const INVISIBLE_CHAR_GLOBAL_REGEX = /[\u200B-\u200F\uFEFF\u00AD\u2060\u180E\u2028\u2029\u202A-\u202E\u2066-\u2069\u034F\uFE00-\uFE0E\u2000-\u200A\u{E0000}-\u{E007F}]/gu;

export function stripInvisibleChars(text: string): string {
  if (!text || typeof text !== "string") return text;
  return text.replace(INVISIBLE_CHAR_GLOBAL_REGEX, "");
}

function isLikelySuspicious(label: string): boolean {
  if (!label || typeof label !== "string") return false;
  if (label.length > MAX_LABEL_LENGTH) return true;
  if (INVISIBLE_CHAR_REGEX.test(label)) return true;
  const normalized = label.normalize("NFKC");
  if (INVISIBLE_CHAR_REGEX.test(normalized)) return true;
  if (/[ \t]{6,}/.test(normalized.trim())) return true;
  return false;
}

export function filterHidden(text: string): boolean;
export function filterHidden(elements: ActionElement[]): ActionElement[];
export function filterHidden(input: string | ActionElement[]): boolean | ActionElement[] {
  if (typeof input === "string") {
    return isLikelySuspicious(input);
  }
  return input.filter((el) => !isLikelySuspicious(el.label));
}

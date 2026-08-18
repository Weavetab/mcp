// src/intelligence/hints.ts
// JIT knowledge hints (Rule 16).
// Reads ~/.weavetab/knowledge/[domain].md and returns max-20-token hint.
// Call appendKnowledgeHint() from any tool when you discover a site-specific quirk.

import { readFile } from "fs/promises";
import { join } from "path";
import { GLOBAL_CONFIG_DIR } from "../config/loader.js";

const KNOWLEDGE_DIR = join(GLOBAL_CONFIG_DIR, "knowledge");

/**
 * Read a domain-specific knowledge hint.
 * Returns the first non-empty line from the file, trimmed to 20 tokens (≈120 chars).
 * Returns undefined if no file exists for this domain.
 */
export async function readKnowledgeHint(
  hostname: string
): Promise<string | undefined> {
  const safe = hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  const filePath = join(KNOWLEDGE_DIR, `${safe}.md`);
  try {
    const content = await readFile(filePath, "utf-8");
    const firstLine = content.split("\n").find((l) => l.trim().length > 0);
    if (!firstLine) return undefined;
    // Trim to ~120 chars (~20 tokens)
    return firstLine.trim().slice(0, 120);
  } catch {
    return undefined;
  }
}

/**
 * Append a discovery note to the domain knowledge file.
 * Called automatically by healing.ts after recovering a lost element (Rule 16).
 */
export async function appendKnowledgeHint(
  hostname: string,
  note: string
): Promise<void> {
  const { appendFile } = await import("fs/promises");
  const safe = hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  const filePath = join(KNOWLEDGE_DIR, `${safe}.md`);
  const timestamp = new Date().toISOString().slice(0, 10);
  await appendFile(filePath, `\n[${timestamp}] ${note.trim()}\n`, "utf-8");
}

import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import path, { join } from "path";
import { GLOBAL_CONFIG_DIR } from "../config/loader.js";

const KNOWLEDGE_DIR = join(GLOBAL_CONFIG_DIR, "knowledge");
const MAX_HINT_LINES = 20;
const MAX_HINT_CHARS = 150;

function getKnowledgeFilePath(hostname: string): string {
  const safe =
    hostname
      .replace(/^\.+/, "")
      .replace(/\.\.+/g, "_")
      .replace(/[^a-zA-Z0-9.-]/g, "_")
      .replace(/^\.+/, "")
      .replace(/\.\.+/g, "_") || "unknown";
  const file = `${safe}.md`;
  const resolvedBase = path.resolve(KNOWLEDGE_DIR);
  const fullPath = path.resolve(resolvedBase, file);
  if (!fullPath.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Invalid knowledge hint path for hostname: ${hostname}`);
  }
  return fullPath;
}

export async function readKnowledgeHint(hostname: string): Promise<string | undefined> {
  const filePath = getKnowledgeFilePath(hostname);
  try {
    const content = await readFile(filePath, "utf-8");
    const nonEmpty = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (nonEmpty.length === 0) return undefined;
    const latest = nonEmpty[nonEmpty.length - 1]!;
    return latest.slice(0, MAX_HINT_CHARS);
  } catch {
    return undefined;
  }
}

export async function appendKnowledgeHint(hostname: string, note: string): Promise<void> {
  const trimmedNote = note.trim();
  if (!trimmedNote) return;

  await mkdir(KNOWLEDGE_DIR, { recursive: true });
  const filePath = getKnowledgeFilePath(hostname);

  let existingLines: string[] = [];
  try {
    const raw = await readFile(filePath, "utf-8");
    existingLines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {}

  const normalize = (line: string) => line.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, "").trim();
  const deduped = existingLines.filter((l) => normalize(l) !== trimmedNote);

  const timestamp = new Date().toISOString().slice(0, 10);
  deduped.push(`[${timestamp}] ${trimmedNote}`);

  const capped = deduped.slice(-MAX_HINT_LINES);
  const payload = capped.join("\n") + "\n";

  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, payload, "utf-8");
  try {
    await rename(tmp, filePath);
  } catch {
    await writeFile(filePath, payload, "utf-8");
    try {
      await unlink(tmp);
    } catch {}
  }
}

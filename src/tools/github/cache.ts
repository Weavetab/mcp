import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { Config } from "../../config/loader.js";
import { getConfigGithubCacheTtlMs } from "../../config/loader.js";

const CACHE_DIR = join(homedir(), ".weavetab-system", "github_cache");

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
  url: string;
}

export interface GithubRepoCache {
  owner: string;
  repo: string;
  default_branch: string;
  description: string | null;
  language: string | null;
  file_tree: TreeEntry[];
  readme_snippet: string;
  analyzed_at: number;
}

function getCacheFile(owner: string, repo: string): string {
  const safeOwner = owner.replace(/[^a-zA-Z0-9.-]/g, "_");
  const safeRepo = repo.replace(/[^a-zA-Z0-9.-]/g, "_");
  return join(CACHE_DIR, `${safeOwner}_${safeRepo}.json`);
}

export async function loadRepoCache(owner: string, repo: string, config: Config): Promise<GithubRepoCache | null> {
  try {
    const content = await readFile(getCacheFile(owner, repo), "utf-8");
    const data = JSON.parse(content) as GithubRepoCache;
    const ttl = getConfigGithubCacheTtlMs(config) ?? (30 * 60 * 1000);

    if (Date.now() - data.analyzed_at > ttl) {
      return null; // Stale cache
    }

    return data;
  } catch {
    return null;
  }
}

export async function saveRepoCache(data: GithubRepoCache): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(getCacheFile(data.owner, data.repo), JSON.stringify(data), "utf-8");
}

import CDP from "chrome-remote-interface";
import type { Config } from "../../config/loader.js";
import { getRepoContext, isGithubError } from "./repoContext.js";
import { loadRepoCache, saveRepoCache, GithubRepoCache, TreeEntry } from "./cache.js";
import { canMakeApiCall, handleApiResponse } from "./rateLimiter.js";

export async function githubAnalyze(session: CDP.Client, config: Config, repoSlug?: string) {
  const context = await getRepoContext(session, repoSlug);
  if (isGithubError(context)) return context;

  const { owner, repo } = context;

  // Check cache
  const cached = await loadRepoCache(owner, repo, config);
  if (cached) {
    return cached;
  }

  // Check rate limit before proceeding
  const rateLimitCheck = canMakeApiCall();
  if (isGithubError(rateLimitCheck)) return rateLimitCheck;

  // 1. Fetch repo metadata
  const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const repoRes = await fetch(repoUrl, {
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "Weavetab-MCP"
    }
  });

  const handledRepoRes = handleApiResponse(repoRes);
  if (isGithubError(handledRepoRes)) return handledRepoRes;

  if (repoRes.status === 404) {
    return {
      error: "REPO_NOT_FOUND",
      message: "Repository not found or not accessible. Note: Only public repositories are supported."
    };
  }

  if (!repoRes.ok) {
    return {
      error: "API_ERROR",
      message: `GitHub API error: ${repoRes.statusText}`
    };
  }

  const repoData = await repoRes.json();
  const default_branch = repoData.default_branch || "main";
  const description = repoData.description || null;
  const language = repoData.language || null;

  // Check rate limit again just in case
  const rateLimitCheck2 = canMakeApiCall();
  if (isGithubError(rateLimitCheck2)) return rateLimitCheck2;

  // 2. Fetch file tree
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${default_branch}?recursive=1`;
  const treeRes = await fetch(treeUrl, {
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "Weavetab-MCP"
    }
  });

  const handledTreeRes = handleApiResponse(treeRes);
  if (isGithubError(handledTreeRes)) return handledTreeRes;

  let file_tree: TreeEntry[] = [];
  if (treeRes.ok) {
    const treeData = await treeRes.json();
    if (treeData.tree && Array.isArray(treeData.tree)) {
      // Pick flat structure - it's more compact and easy to grep
      file_tree = treeData.tree.map((t: any) => ({
        path: t.path,
        mode: t.mode,
        type: t.type,
        sha: t.sha,
        size: t.size,
        url: t.url
      }));
    }
  }

  // 3. Fetch README (raw)
  let readme_snippet = "";
  // Check common README paths
  const possibleReadmes = ["README.md", "README", "readme.md", "Readme.md", "README.txt"];
  const readmeEntry = file_tree.find(f => possibleReadmes.includes(f.path));
  
  if (readmeEntry) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${default_branch}/${readmeEntry.path}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const rawRes = await fetch(rawUrl, { signal: controller.signal });
      clearTimeout(timeout);
      
      if (rawRes.ok) {
        const fullReadme = await rawRes.text();
        // Truncate snippet to first 100 lines
        const lines = fullReadme.split('\n');
        readme_snippet = lines.slice(0, 100).join('\n');
        if (lines.length > 100) {
          readme_snippet += "\n\n... (truncated)";
        }
      }
    } catch {
      // ignore
    }
  }

  const cacheData: GithubRepoCache = {
    owner,
    repo,
    default_branch,
    description,
    language,
    file_tree,
    readme_snippet,
    analyzed_at: Date.now()
  };

  await saveRepoCache(cacheData);
  return cacheData;
}

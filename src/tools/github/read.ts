import CDP from "chrome-remote-interface";
import type { Config } from "../../config/loader.js";
import { getRepoContext, isGithubError } from "./repoContext.js";
import { loadRepoCache } from "./cache.js";
import { githubAnalyze } from "./analyze.js";

export async function githubRead(session: CDP.Client, args: { repo?: string, paths: string[], line_range?: [number, number] }, config: Config) {
  const context = await getRepoContext(session, args.repo);
  if (isGithubError(context)) return context;

  const { owner, repo } = context;

  // Check cache to get default_branch and file_tree
  let cached = await loadRepoCache(owner, repo, config);
  if (!cached) {
    // We need cache to get default_branch. Call analyze first.
    const analyzeResult = await githubAnalyze(session, config, args.repo);
    if (isGithubError(analyzeResult)) {
      return analyzeResult;
    }
    cached = analyzeResult as any;
  }

  const default_branch = cached!.default_branch;
  const file_tree = cached!.file_tree;

  const results: any[] = [];
  const warnings: string[] = [];

  const fetchPromises = args.paths.map(async (rawPath) => {
    // Sanitize path
    const path = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (path.includes('..') || path.includes('\0')) {
      return { path: rawPath, error: "INVALID_PATH", message: "Path traversal or null bytes detected." };
    }

    // Check if path exists in tree
    const exists = file_tree.some(entry => entry.path === path);
    if (!exists) {
      warnings.push(`Path '${path}' was not found in the cached file tree. Branch contents may differ.`);
    }

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${default_branch}/${path}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(rawUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        return { path, error: "FETCH_FAILED", status: res.status, message: res.statusText };
      }

      const content = await res.text();
      const lines = content.split('\n');
      const total_lines = lines.length;

      let returnedContent = content;
      let truncated = false;

      if (args.line_range && Array.isArray(args.line_range) && args.line_range.length === 2) {
        const start = Math.max(0, args.line_range[0] - 1); // 1-indexed to 0-indexed
        const end = Math.min(total_lines, args.line_range[1]);
        returnedContent = lines.slice(start, end).join('\n');
        truncated = (start > 0 || end < total_lines);
      } else if (total_lines > 200) {
        returnedContent = lines.slice(0, 200).join('\n');
        truncated = true;
      }

      return {
        path,
        total_lines,
        truncated,
        content: returnedContent
      };
    } catch (err: any) {
      return { path, error: "FETCH_ERROR", message: err.message };
    }
  });

  const pathResults = await Promise.all(fetchPromises);

  return {
    warnings: warnings.length > 0 ? warnings : undefined,
    files: pathResults
  };
}

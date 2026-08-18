import CDP from "chrome-remote-interface";

export interface RepoContext {
  owner: string;
  repo: string;
}

export type GithubToolError = {
  error: string;
  message: string;
  [key: string]: any;
};

/**
 * Parse a repo slug from a string that can be:
 *  - "owner/repo"
 *  - "https://github.com/owner/repo[/anything]"
 *
 * Returns null (instead of throwing) for any non-string input so callers
 * never encounter `TypeError: slug.trim is not a function`.
 */
function parseRepoSlug(slug: unknown): { owner: string; repo: string } | null {
  // ── Enterprise guard: reject any non-string at runtime ─────────────────────
  // Zod marks `repo` as optional(string), but MCP argument dispatch can
  // forward an object / number / null when the model omits the field in some
  // call patterns.  Checking typeof here is the only safe boundary.
  if (typeof slug !== "string") return null;

  const trimmed = slug.trim();
  if (!trimmed) return null;

  // Full GitHub URL
  try {
    const u = new URL(trimmed);
    if (u.hostname === "github.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) return { owner: parts[0]!, repo: parts[1]! };
    }
  } catch { /* not a URL — fall through to shorthand parse */ }

  // "owner/repo" shorthand
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length >= 2) return { owner: parts[0]!, repo: parts[1]! };
  return null;
}

/**
 * Resolve the current GitHub repo context.
 *
 * @param session  - CDP session
 * @param repoSlug - Optional "owner/repo" or full GitHub URL. When provided,
 *                   the function uses it directly instead of reading the tab URL.
 *                   If the browser is not already on GitHub it navigates there.
 */
export async function getRepoContext(
  session: CDP.Client,
  repoSlug?: unknown
): Promise<RepoContext | GithubToolError> {
  // ── Runtime type normalisation ────────────────────────────────────────────
  // `repoSlug` is declared optional(string) in the Zod schema, but callers
  // such as server.ts cast `(args as any).repo`, meaning any JS value can
  // arrive here.  Normalise to string | undefined before any string ops.
  const slugStr: string | undefined =
    typeof repoSlug === "string" && repoSlug.trim() !== ""
      ? repoSlug.trim()
      : undefined;

  // If a repo slug was explicitly given, prefer it over the current tab URL.
  if (slugStr) {
    const parsed = parseRepoSlug(slugStr);
    if (!parsed) {
      return {
        error: "INVALID_REPO_SLUG",
        message: `Cannot parse a GitHub owner/repo from "${slugStr}". Use "owner/repo" or a full github.com URL.`
      };
    }

    // Check whether the browser is already on a matching GitHub page.
    // If not, navigate there so downstream tools that read the DOM work correctly.
    try {
      const { result } = await session.Runtime.evaluate({
        expression: 'window.location.href',
        returnByValue: true,
      });
      const currentUrl = (typeof result.value === "string" ? result.value : "");
      const isOnMatchingRepo = currentUrl.includes(`github.com/${parsed.owner}/${parsed.repo}`);
      if (!isOnMatchingRepo) {
        const targetUrl = `https://github.com/${parsed.owner}/${parsed.repo}`;
        await session.Page.navigate({ url: targetUrl });
        // Wait briefly for the page to start loading
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch { /* non-fatal — proceed with parsed slug */ }

    return parsed;
  }

  // No slug given: read from current tab URL (original behaviour)
  let urlStr: string;
  try {
    const { result } = await session.Runtime.evaluate({
      expression: 'window.location.href',
      returnByValue: true,
    });
    urlStr = result.value;
  } catch (err) {
    return {
      error: "CONTEXT_ERROR",
      message: "Failed to evaluate window.location.href on the active tab."
    };
  }

  if (!urlStr) {
    return {
      error: "CONTEXT_ERROR",
      message: "Active tab URL is empty."
    };
  }

  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return {
      error: "INVALID_URL",
      message: "Active tab URL is invalid."
    };
  }

  if (url.hostname !== "github.com") {
    return {
      error: "NOT_ON_GITHUB_REPO",
      message: "Navigate to a GitHub repository first, or pass a 'repo' argument (e.g. \"owner/repo\")."
    };
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    return {
      error: "NOT_ON_GITHUB_REPO",
      message: "Navigate to a specific GitHub repository first (e.g. github.com/owner/repo)."
    };
  }

  const owner = parts[0]!;
  const repo = parts[1]!;

  return { owner, repo };
}

export function isGithubError(result: any): result is GithubToolError {
  return result && typeof result === "object" && "error" in result && "message" in result;
}

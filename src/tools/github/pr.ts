import CDP from "chrome-remote-interface";
import { getRepoContext, isGithubError } from "./repoContext.js";
import { canMakeApiCall, handleApiResponse } from "./rateLimiter.js";

export async function githubGetPr(session: CDP.Client, args: { repo?: string, number?: number }) {
  const context = await getRepoContext(session, args.repo);
  if (isGithubError(context)) return context;

  const { owner, repo } = context;

  const rateLimitCheck = canMakeApiCall();
  if (isGithubError(rateLimitCheck)) return rateLimitCheck;

  const headers = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "Weavetab-MCP"
  };

  if (args.number) {
    const prUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${args.number}`;
    const prRes = await fetch(prUrl, { headers });
    const handledPrRes = handleApiResponse(prRes);
    if (isGithubError(handledPrRes)) return handledPrRes;

    if (!prRes.ok) {
      return { error: "FETCH_FAILED", status: prRes.status, message: `Failed to fetch PR #${args.number}` };
    }

    const prData = await prRes.json();

    let files_changed: string[] = [];
    const rateLimitCheck2 = canMakeApiCall();
    if (!isGithubError(rateLimitCheck2)) {
      const filesUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${args.number}/files`;
      const filesRes = await fetch(filesUrl, { headers });
      const handledFilesRes = handleApiResponse(filesRes);
      if (!isGithubError(handledFilesRes) && filesRes.ok) {
        const filesData = await filesRes.json();
        files_changed = filesData.map((f: any) => f.filename);
      }
    }

    let comments = [];
    if (prData.comments > 0) {
      const rateLimitCheck3 = canMakeApiCall();
      if (!isGithubError(rateLimitCheck3)) {
        const commentsUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${args.number}/comments`;
        const commentsRes = await fetch(commentsUrl, { headers });
        const handledCommentsRes = handleApiResponse(commentsRes);
        if (!isGithubError(handledCommentsRes) && commentsRes.ok) {
          const commentsData = await commentsRes.json();
          comments = commentsData.map((c: any) => ({
            id: c.id,
            user: c.user?.login,
            body: c.body,
            created_at: c.created_at
          }));
        }
      }
    }

    return {
      number: prData.number,
      title: prData.title,
      state: prData.state,
      user: prData.user?.login,
      body: prData.body,
      created_at: prData.created_at,
      merged: prData.merged,
      mergeable: prData.mergeable,
      additions: prData.additions,
      deletions: prData.deletions,
      changed_files: prData.changed_files,
      files: files_changed,
      comments
    };
  }

  // Else list recent PRs
  const listUrl = `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&per_page=10`;
  const listRes = await fetch(listUrl, { headers });
  const handledListRes = handleApiResponse(listRes);
  if (isGithubError(handledListRes)) return handledListRes;

  if (!listRes.ok) {
    return { error: "FETCH_FAILED", status: listRes.status, message: "Failed to list PRs" };
  }

  const listData = await listRes.json();
  return listData.map((pr: any) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    user: pr.user?.login,
    created_at: pr.created_at,
    updated_at: pr.updated_at
  }));
}

import CDP from "chrome-remote-interface";
import { getRepoContext, isGithubError } from "./repoContext.js";
import { canMakeApiCall, handleApiResponse } from "./rateLimiter.js";

export async function githubIssues(session: CDP.Client, args: { repo?: string, search?: string, number?: number, labels?: string[], state?: 'open'|'closed'|'all', limit?: number }) {
  const context = await getRepoContext(session, args.repo);
  if (isGithubError(context)) return context;

  const { owner, repo } = context;

  const rateLimitCheck = canMakeApiCall();
  if (isGithubError(rateLimitCheck)) return rateLimitCheck;

  const headers = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "Weavetab-MCP"
  };

  // If number is provided, fetch specific issue + comments
  if (args.number) {
    const issueUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${args.number}`;
    const issueRes = await fetch(issueUrl, { headers });
    const handledIssueRes = handleApiResponse(issueRes);
    if (isGithubError(handledIssueRes)) return handledIssueRes;

    if (!issueRes.ok) {
      return { error: "FETCH_FAILED", status: issueRes.status, message: `Failed to fetch issue #${args.number}` };
    }

    const issueData = await issueRes.json();

    let comments = [];
    if (issueData.comments > 0) {
      const rateLimitCheck2 = canMakeApiCall();
      if (!isGithubError(rateLimitCheck2)) {
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
      number: issueData.number,
      title: issueData.title,
      state: issueData.state,
      user: issueData.user?.login,
      body: issueData.body,
      created_at: issueData.created_at,
      labels: issueData.labels?.map((l: any) => l.name),
      comments
    };
  }

  // Else list issues
  let urlStr = `https://api.github.com/repos/${owner}/${repo}/issues?per_page=${args.limit || 5}`;
  if (args.state) urlStr += `&state=${args.state}`;
  if (args.labels && args.labels.length > 0) urlStr += `&labels=${args.labels.join(',')}`;

  // GitHub Search API is different from Issues API. If search is provided, we should use search API.
  if (args.search) {
    let q = `repo:${owner}/${repo} is:issue ${args.search}`;
    if (args.state && args.state !== 'all') q += ` is:${args.state}`;
    if (args.labels) args.labels.forEach(l => q += ` label:"${l}"`);
    
    urlStr = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=${args.limit || 5}`;
  }

  const listRes = await fetch(urlStr, { headers });
  const handledListRes = handleApiResponse(listRes);
  if (isGithubError(handledListRes)) return handledListRes;

  if (!listRes.ok) {
    return { error: "FETCH_FAILED", status: listRes.status, message: "Failed to list/search issues" };
  }

  const listData = await listRes.json();
  const items = args.search ? listData.items : listData;

  return items.map((i: any) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    user: i.user?.login,
    labels: i.labels?.map((l: any) => l.name),
    created_at: i.created_at,
    comments_count: i.comments
  }));
}

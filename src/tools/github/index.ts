import CDP from "chrome-remote-interface";
import type { Config } from "../../config/loader.js";
import { githubAnalyze } from "./analyze.js";
import { githubRead } from "./read.js";
import { githubIssues } from "./issues.js";
import { githubGetPr } from "./pr.js";

export { githubAnalyze, githubRead, githubIssues, githubGetPr };

export interface BrowserGithubArgs {
  action: "analyze" | "read" | "issues" | "pr";
  repo?: string;
  paths?: string[];
  line_range?: [number, number];
  number?: number;
  search?: string;
  labels?: string[];
  state?: "open" | "closed" | "all";
  limit?: number;
}

export async function browserGithub(
  session: CDP.Client,
  args: BrowserGithubArgs,
  cfg: Config
) {
  switch (args.action) {
    case "analyze":
      return await githubAnalyze(session, cfg, args.repo);

    case "read": {
      const paths = args.paths || [];
      if (!paths.length) {
        return {
          error: "MISSING_PATHS",
          message: "action 'read' requires 'paths' parameter with at least one file path."
        };
      }
      return await githubRead(session, { repo: args.repo, paths, line_range: args.line_range }, cfg);
    }

    case "issues":
      return await githubIssues(session, {
        repo: args.repo,
        search: args.search,
        number: args.number,
        labels: args.labels,
        state: args.state,
        limit: args.limit
      });

    case "pr":
      return await githubGetPr(session, {
        repo: args.repo,
        number: args.number
      });

    default:
      return {
        error: "INVALID_ACTION",
        message: `Unknown action: ${(args as any).action}. Must be 'analyze', 'read', 'issues', or 'pr'.`
      };
  }
}

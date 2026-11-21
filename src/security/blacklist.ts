import * as path from "node:path";
import type { Config, PolicyMode, Role } from "../config/loader.js";
import { getConfigPolicies, getConfigBlock, getConfigAllow, getOutputDir } from "../config/loader.js";

export interface AllowResult {
  allowed: true;
  mode?: PolicyMode;
}

export interface BlockResult {
  allowed: false;
  reason: string;
  mode?: PolicyMode;
}

export interface AuditResult {
  allowed: true;
  mode: "audit-only";
}

export interface ReadOnlyResult {
  allowed: true;
  mode: "read-only";
}

export type DomainCheckResult = AllowResult | BlockResult | AuditResult | ReadOnlyResult;

export function extractHostname(url: string): string {
  const raw = (url || "").trim();
  if (!raw) return "";
  let host = raw;
  try {
    if (raw.includes("://")) {
      host = new URL(raw).hostname;
    } else if (!raw.startsWith("about:") && !raw.startsWith("javascript:") && !raw.startsWith("data:")) {
      host = new URL(`http://${raw}`).hostname;
    } else {
      return "";
    }
  } catch {
    host = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").split(/[/?#:]/)[0] || "";
  }
  return host.toLowerCase().replace(/\.+$/, "");
}

export function matchesPattern(url: string, pattern: string): boolean {
  const host = extractHostname(url);
  const cleanPat = (pattern || "").trim().toLowerCase().replace(/\.+$/, "");
  if (!host || !cleanPat) return false;

  const wildcardCount = (cleanPat.match(/\*/g) || []).length;
  if (wildcardCount > 5) return false;

  if (wildcardCount === 0) {
    return host === cleanPat || host.endsWith("." + cleanPat);
  }

  const escaped = cleanPat
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
    .replace(/\*/g, ".*");
  try {
    return new RegExp(`^${escaped}$`, "i").test(host);
  } catch {
    return false;
  }
}

function scorePolicySpecificity(hostname: string, pattern: string): [number, number, number] {
  const pat = pattern.trim().toLowerCase().replace(/\.+$/, "");
  if (!pat.includes("*")) {
    if (hostname === pat) return [3, pat.length, 0];
    return [2, pat.length, 0];
  }
  const literalLen = pat.replace(/\*/g, "").length;
  const stars = (pat.match(/\*/g) || []).length;
  return [1, literalLen, -stars];
}

export const READ_ONLY_TOOLS = new Set([
  "browser_map",
  "browser_find",
  "browser_scrape",
  "browser_console",
  "browser_inspect",
  "browser_snapshot",
  "browser_screenshot",
  "browser_pdf",
  "browser_cookies",
  "browser_tabs",
  "browser_wait",
  "browser_pattern_learn",
  "browser_detect",
]);

export const ROLE_TOOL_ALLOW: Record<string, Set<string>> = {
  admin: new Set(["*"]),
  operator: new Set(["*"]),
  viewer: new Set([
    "browser_map",
    "browser_find",
    "browser_scrape",
    "browser_console",
    "browser_inspect",
    "browser_snapshot",
    "browser_screenshot",
    "browser_pdf",
    "browser_cookies",
    "browser_tabs",
    "browser_wait",
    "browser_pattern_learn",
    "browser_detect",
  ]),
  automation: new Set(["*"]),
  system: new Set([
    "browser_thoughts",
    "browser_detect",
    "browser_performance",
    "browser_checkpoint",
    "browser_pattern_learn",
  ]),
};

export function checkReadOnlyAction(
  toolName: string,
  args?: Record<string, unknown>,
  currentUrl?: string,
  config?: Config
): { allowed: boolean; reason?: string } {
  if (!args || typeof args !== "object") return { allowed: true };

  if (toolName === "browser_cookies") {
    const action = (args.action as string | undefined) ?? "get";
    if (action !== "get" && action !== "list") {
      return {
        allowed: false,
        reason: `Action '${action}' on 'browser_cookies' is not permitted in viewer/read-only mode (only 'get'/'list' allowed).`,
      };
    }
    if (typeof args.url === "string" && args.url.trim()) {
      const reqHost = extractHostname(args.url);
      const curHost = currentUrl ? extractHostname(currentUrl) : "";
      if (!reqHost || (curHost && reqHost !== curHost)) {
        return {
          allowed: false,
          reason: `Cross-origin cookie access ('${args.url}') is not permitted in viewer/read-only mode.`,
        };
      }
      if (config) {
        const urlCheck = checkDomain(args.url, config);
        if (!urlCheck.allowed) {
          return { allowed: false, reason: urlCheck.reason };
        }
      }
    }
  } else if (toolName === "browser_tabs") {
    const action = (args.action as string | undefined) ?? "list";
    if (action !== "list" && action !== "list_windows") {
      return {
        allowed: false,
        reason: `Action '${action}' on 'browser_tabs' is not permitted in viewer/read-only mode (only 'list'/'list_windows' allowed).`,
      };
    }
  } else if (toolName === "browser_snapshot") {
    const action = (args.action as string | undefined) ?? "capture";
    if (action !== "capture") {
      return {
        allowed: false,
        reason: `Action '${action}' on 'browser_snapshot' is not permitted in viewer/read-only mode (only 'capture' allowed).`,
      };
    }
    const rawFile = (args.filePath ?? args.filename) as string | undefined;
    if (typeof rawFile === "string" && rawFile.trim()) {
      const trimmed = rawFile.trim();
      if (trimmed.split(/[\\/]/).includes("..")) {
        return {
          allowed: false,
          reason: "Path traversal in 'browser_snapshot' filePath is not permitted in viewer/read-only mode.",
        };
      }
      if (path.isAbsolute(trimmed)) {
        const snapDir = path.resolve(getOutputDir("snapshots", config));
        const resolved = path.resolve(trimmed);
        if (resolved !== snapDir && !resolved.startsWith(snapDir + path.sep)) {
          return {
            allowed: false,
            reason: `Snapshot filePath must be confined inside snapshotDir (${snapDir}) in viewer/read-only mode.`,
          };
        }
      }
    }
  } else if (toolName === "browser_console") {
    const action = (args.action as string | undefined) ?? "read";
    if (action !== "read") {
      return {
        allowed: false,
        reason: `Action '${action}' on 'browser_console' is not permitted in viewer/read-only mode (only 'read' allowed).`,
      };
    }
  } else if (toolName === "browser_pattern_learn") {
    const action = (args.action as string | undefined) ?? "learn";
    if (action !== "get") {
      return {
        allowed: false,
        reason: `Action '${action}' on 'browser_pattern_learn' is not permitted in viewer/read-only mode (only 'get' allowed).`,
      };
    }
  }

  return { allowed: true };
}

export function isToolAllowedForRole(
  role: Role | string,
  toolName: string,
  args?: Record<string, unknown>,
  currentUrl?: string,
  config?: Config
): { allowed: boolean; reason?: string } {
  if (role === "automation" && toolName === "browser_thoughts") {
    return {
      allowed: false,
      reason: "Role 'automation' does not have permission to use 'browser_thoughts'. Automation agents must be non-interactive.",
    };
  }
  const allowed = Object.hasOwn(ROLE_TOOL_ALLOW, role) ? ROLE_TOOL_ALLOW[role] : undefined;
  if (!allowed) {
    return { allowed: false, reason: `Unknown or unauthorized role '${role}'.` };
  }
  if (!allowed.has("*") && !allowed.has(toolName)) {
    return {
      allowed: false,
      reason: `Role '${role}' does not have permission to use '${toolName}'. ${
        role === "viewer"
          ? "Viewer role only permits read-only tools (map/find/scrape/console/inspect/snapshot/screenshot/pdf/cookies/tabs/wait/pattern_learn/detect)."
          : ""
      }`.trim(),
    };
  }
  if (role === "viewer") {
    const actCheck = checkReadOnlyAction(toolName, args, currentUrl, config);
    if (!actCheck.allowed) return actCheck;
  }
  return { allowed: true };
}

export function isToolAllowedInMode(
  toolName: string,
  mode: PolicyMode,
  args?: Record<string, unknown>,
  currentUrl?: string,
  config?: Config
): { allowed: boolean; reason?: string } {
  switch (mode) {
    case "allow":
    case "audit-only":
      return { allowed: true };
    case "deny":
      return { allowed: false, reason: "Domain is denied" };
    case "read-only":
      if (!READ_ONLY_TOOLS.has(toolName)) {
        return {
          allowed: false,
          reason: `Tool '${toolName}' is not allowed in read-only mode. Only read-only inspection tools are permitted.`,
        };
      }
      return checkReadOnlyAction(toolName, args, currentUrl, config);
  }
}

export function checkDomain(url: string, config: Config): DomainCheckResult;
export function checkDomain(
  url: string,
  toolName: string,
  config: Config,
  toolArgs?: Record<string, unknown>
): DomainCheckResult;
export function checkDomain(
  url: string,
  configOrTool: Config | string,
  maybeConfig?: Config,
  toolArgs?: Record<string, unknown>
): DomainCheckResult {
  const toolName = typeof configOrTool === "string" ? configOrTool : undefined;
  const config = typeof configOrTool === "string" ? maybeConfig! : configOrTool;
  const hostname = extractHostname(url);
  if (!hostname) return { allowed: true };

  const policies = getConfigPolicies(config) || [];
  const matched = policies
    .filter((p) => p && typeof p.pattern === "string" && matchesPattern(hostname, p.pattern))
    .map((policy, idx) => ({
      policy,
      idx,
      score: scorePolicySpecificity(hostname, policy.pattern),
    }))
    .sort((a, b) => {
      if (b.score[0] !== a.score[0]) return b.score[0] - a.score[0];
      if (b.score[1] !== a.score[1]) return b.score[1] - a.score[1];
      if (b.score[2] !== a.score[2]) return b.score[2] - a.score[2];
      return a.idx - b.idx;
    });

  if (matched.length > 0) {
    const top = matched[0]!.policy;
    const mode = (top.mode as string) === "audit" ? "audit-only" : top.mode;
    switch (mode) {
      case "deny":
        return { allowed: false, reason: `Domain denied by policy: ${top.pattern}`, mode: "deny" };
      case "audit-only":
        return { allowed: true, mode: "audit-only" };
      case "read-only":
        if (toolName && toolName !== "browser_navigate") {
          const toolCheck = isToolAllowedInMode(toolName, "read-only", toolArgs, url, config);
          if (!toolCheck.allowed) {
            return { allowed: false, reason: toolCheck.reason!, mode: "read-only" };
          }
        }
        return { allowed: true, mode: "read-only" };
      case "allow":
        return { allowed: true, mode: "allow" };
    }
  }

  for (const pattern of getConfigAllow(config) || []) {
    if (matchesPattern(hostname, pattern)) {
      return { allowed: true, mode: "allow" };
    }
  }

  for (const pattern of getConfigBlock(config) || []) {
    if (matchesPattern(hostname, pattern)) {
      return { allowed: false, reason: `Domain blocked by config: ${pattern}`, mode: "deny" };
    }
  }

  return { allowed: true };
}

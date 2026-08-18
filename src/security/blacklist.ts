import type { Config, PolicyEntry, PolicyMode } from "../config/loader.js";
import { getConfigPolicies, getConfigBlock } from "../config/loader.js";

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

// Escape all regex metacharacters (including `?`) before replacing `*` with `.*`,
// then guard against patterns that produce >3 `.*` segments. This prevents both
// `?` being treated as an optional quantifier and catastrophic backtracking from
// patterns like `*.*.*.*.*.*`.
function matchesPattern(url: string, pattern: string): boolean {
  // Limit wildcard count to prevent ReDoS from patterns like *.*.*.*.*.*.*.*
  const wildcardCount = (pattern.match(/\*/g) || []).length;
  if (wildcardCount > 5) return false;

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")  // escape ALL regex metacharacters (including ?)
    .replace(/\\\*/g, ".*");                  // only then expand * → .*
  try {
    return new RegExp(`^${escaped}$`, "i").test(extractHostname(url));
  } catch {
    return false;
  }
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function checkDomain(url: string, config: Config): DomainCheckResult {
  const hostname = extractHostname(url);

  // Phase 7c: Check explicit policies first (most specific wins)
  for (const policy of getConfigPolicies(config)) {
    if (matchesPattern(hostname, policy.pattern)) {
      switch (policy.mode) {
        case "deny":
          return { allowed: false, reason: `Domain denied by policy: ${policy.pattern}`, mode: "deny" };
        case "audit-only":
          return { allowed: true, mode: "audit-only" };
        case "read-only":
          return { allowed: true, mode: "read-only" };
        case "allow":
          return { allowed: true, mode: "allow" };
      }
    }
  }

  // Legacy blocklist check (backward compatible)
  for (const pattern of getConfigBlock(config)) {
    if (matchesPattern(hostname, pattern)) {
      return { allowed: false, reason: `Domain blocked by config: ${pattern}`, mode: "deny" };
    }
  }

  return { allowed: true };
}

const READ_ONLY_TOOLS = new Set([
  "browser_map", "browser_find", "browser_scrape", "browser_console",
  "browser_eval", "browser_inspect", "browser_snapshot", "browser_pdf",
  "browser_cookies",
]);

const WRITE_TOOLS = new Set([
  "browser_click", "browser_type", "browser_key", "browser_navigate",
  "browser_scroll", "browser_dialog", "browser_pointer", "browser_select",
  "browser_upload", "browser_storage", "browser_network_intercept",
  "browser_viewport", "browser_clipboard", "browser_canvas",
  "browser_automation", "browser_recording",
]);

export function isToolAllowedInMode(toolName: string, mode: PolicyMode): { allowed: boolean; reason?: string } {
  switch (mode) {
    case "allow":
      return { allowed: true };
    case "deny":
      return { allowed: false, reason: "Domain is denied" };
    case "audit-only":
      return { allowed: true };
    case "read-only":
      if (READ_ONLY_TOOLS.has(toolName)) {
        return { allowed: true };
      }
      return { allowed: false, reason: `Tool '${toolName}' is not allowed in read-only mode. Only map/find/scrape/console/eval/inspect/snapshot/pdf/cookies are permitted.` };
  }
}

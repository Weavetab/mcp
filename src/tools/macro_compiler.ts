import type { TrailEntry as TrailStep } from "../intelligence/trail.js";
import type { AnyBurstStep } from "./burst.js";
import { logDebug } from "../audit/logger.js";

/**
 * Universal parameter extractor — tries ALL known parameter key patterns plus
 * runtime introspection to find the args container regardless of the source
 * code path that produced the trail entry.
 */
function extractArgs(step: TrailStep): Record<string, unknown> {
  const s = step as any;

  // 1. Known parameter key patterns (ordered by specificity)
  const knownKeys = [
    'arguments', 'args', 'mcp_arguments', 'input',
    'params', 'parameters', 'tool_args', 'toolInput',
    'data', 'payload', 'options',
  ];
  for (const key of knownKeys) {
    const val = s[key];
    if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
      return val;
    }
  }

  // 2. Runtime introspection: find the first own property that looks like
  // a params container (non-null object, not a standard metadata key).
  const metaKeys = new Set([
    'tool', 'result', 'timestamp', 'type', 'id',
    'status', 'error', 'duration', 'startTime', 'endTime',
    'session', 'tabId', 'targetId',
  ]);
  for (const key of Object.keys(s)) {
    if (metaKeys.has(key)) continue;
    const val = s[key];
    if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
      logDebug(`[macro_compiler] Found unknown param key "${key}" on step ${step.tool}`);
      return val;
    }
  }

  // 3. Totally empty — log the shape for debugging
  logDebug(`[macro_compiler] Could not extract args from step ${step.tool}, shape: ${Object.keys(s).join(',')}`);
  return {};
}

/**
 * Compiles a sequence of successful trail steps into a single burst macro.
 * This skips intermediate DOM reads for faster execution.
 */
export function compileTraceToMacro(steps: TrailStep[]): AnyBurstStep[] {
  const macro: AnyBurstStep[] = [];
  let lastKey = "";
  const BURST_TOOLS = new Set([
    "browser_click", "browser_type", "browser_navigate", "browser_go",
    "browser_key", "browser_scroll", "browser_wait", "browser_select",
    "browser_pointer", "browser_eval", "browser_console", "browser_find",
    "browser_fill", "browser_type_secret", "browser_inspect",
    "browser_screenshot", "browser_storage", "browser_cookies",
    "browser_highlight", "browser_scrape",
    "browser_canvas", "browser_performance", "browser_snapshot",
    "browser_pdf", "browser_dialog", "browser_upload", "browser_automation",
    "browser_viewport", "browser_clipboard", "browser_detect",
    "browser_macro_compile", "browser_reset_loop_counter", "browser_recording",
    "browser_fill", "type_and_send", "navigate_and_read",
    "click_and_wait", "scroll_and_read",
  ]);

  steps.forEach((step, idx) => {
    if (step.result && !step.result.success) return;

    if (step.tool === "browser_map") {
      if (idx === steps.length - 1) {
        macro.push({ tool: "browser_map", args: step.input || {} });
      }
      return;
    }

    if (BURST_TOOLS.has(step.tool)) {
      const args = extractArgs(step);
      // Dedupe consecutive identical steps (same tool + same args)
      const key = `${step.tool}:${JSON.stringify(args)}`;
      if (key !== lastKey) {
        macro.push({ tool: step.tool as any, args });
        lastKey = key;
      }
    }
  });

  return macro;
}

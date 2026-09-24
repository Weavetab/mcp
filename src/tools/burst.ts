/**
 * Weavetab — tools/burst.ts
 * Executes multiple tool calls serially in one round-trip, with per-step delta checking.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import { weaveClick } from "./click.js";
import { weaveType } from "./type.js";
import { weaveNavigate } from "./navigate.js";
import { weaveKey } from "./key.js";
import { browserScroll } from "./scroll.js";
import { browserWait } from "./wait.js";
import { browserMap } from "./read.js";
import { browserEval } from "./eval.js";
import { browserSelect } from "./select.js";
import { browserPointer } from "./pointer.js";
import { browserConsole } from "./console.js";
import { browserFind } from "./find.js";
import { browserFill } from "./fill.js";
import { weaveTypeSecret } from "./type_secret.js";
import { browserInspect } from "./inspect.js";
import { browserStorage } from "./storage.js";
import { browserCookies } from "./cookies.js";
import { browserHighlight } from "./highlight.js";
import { browserScrape } from "./scrape.js";
import { logAction } from "../audit/logger.js";
import { cacheActionMap } from "../state/cache.js";
import { buildActionMap } from "../cdp/walker.js";
import { sessionRegistry } from "../state/session.js";
import type { Config } from "../config/loader.js";
import { getConfigAgentId, getConfigBrowserType, getConfigMaxTabs } from "../config/loader.js";
import type { ReadOptions } from "./read.js";
import { sendToExtension } from "../cdp/helpers.js";
import { resetLoopCounter, getTrail, type TrailEntry } from "../intelligence/trail.js";

export interface BurstStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface BurstMacroStep {
  tool: "type_and_send" | "navigate_and_read" | "click_and_wait" | "scroll_and_read" | "fill_form" | "drag_and_drop" | "hover_and_read" | string;
  args: Record<string, unknown>;
}

export type AnyBurstStep = BurstStep | BurstMacroStep;

export interface BurstOptions {
  steps?: AnyBurstStep[];
  actions?: AnyBurstStep[];
  compile_from_history?: boolean;
  history_limit?: number;
  dry_run?: boolean;
  stop_on_error?: boolean;
  batch?: boolean;
  app?: string;
}

export interface BurstStepResult {
  step: number;
  tool: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface BurstResult {
  success: boolean;
  steps_completed: number;
  results: BurstStepResult[];
  aborted: boolean;
  abort_reason?: string;
  compiled_steps?: AnyBurstStep[];
  message?: string;
}

function extractTarget(params: any): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  if (!params || typeof params !== "object") return target;
  if (params.ref !== undefined) target.ref = params.ref;
  if (params.id !== undefined) target.id = params.id;
  if (params.target !== undefined) {
    if (typeof params.target === "string" && params.target.startsWith("w:")) target.ref = params.target;
    else target.selector = params.target;
  }
  if (params.selector !== undefined) target.selector = params.selector;
  if (params.label !== undefined) target.label = params.label;
  if (params.x !== undefined) target.x = params.x;
  if (params.y !== undefined) target.y = params.y;
  return target;
}

function expandMacro(step: BurstMacroStep): BurstStep[] {
  const args = step.args || {};
  if (step.tool === "type_and_send") {
    const { text, pressEnter = true } = args as any;
    const target = extractTarget(args);
    if (text === undefined) {
      throw new Error("type_and_send failed: text is required");
    }
    const typeArgs: Record<string, unknown> = { ...target, text, noRetry: true };
    const steps: BurstStep[] = [{ tool: "browser_type", args: typeArgs }];
    if (pressEnter) steps.push({ tool: "browser_key", args: { key: "Enter" } });
    return steps;
  }
  if (step.tool === "navigate_and_read") {
    const { url } = args as any;
    return [
      { tool: "browser_go", args: { url } },
      { tool: "browser_map", args: {} },
    ];
  }
  if (step.tool === "click_and_wait") {
    const { wait_for, wait_value, wait_after, waitAfter } = args as any;
    const target = extractTarget(args);
    const clickArgs: Record<string, unknown> = {
      ...target,
      waitForNetwork: true,
      waitAfter: wait_after ?? waitAfter ?? 500,
    };
    const steps: BurstStep[] = [{ tool: "browser_click", args: clickArgs }];
    if (wait_for) {
      steps.push({ tool: "browser_wait", args: { wait_for, value: wait_value } });
    }
    return steps;
  }
  if (step.tool === "scroll_and_read") {
    const { direction, distance } = args as any;
    return [
      { tool: "browser_scroll", args: { direction, distance } },
      { tool: "browser_map", args: {} },
    ];
  }
  if (step.tool === "fill_form") {
    const { fields, submit } = args as any;
    const steps: BurstStep[] = [];
    if (Array.isArray(fields)) {
      for (const f of fields) {
        if (f && typeof f === "object") {
          const target = extractTarget(f);
          steps.push({ tool: "browser_fill", args: { ...target, value: f.value } });
        }
      }
    } else if (fields && typeof fields === "object") {
      for (const [key, value] of Object.entries(fields)) {
        const target = key.startsWith("w:") ? { ref: key } : { id: key };
        steps.push({ tool: "browser_fill", args: { ...target, value } });
      }
    }
    if (submit) {
      steps.push({ tool: "browser_key", args: { key: "Enter" } });
    }
    return steps;
  }
  if (step.tool === "drag_and_drop") {
    const { end_id, end_ref, end_x, end_y } = args as any;
    const target = extractTarget(args);
    const pointerArgs: Record<string, unknown> = { action: "drag_and_drop", ...target };
    if (end_ref) pointerArgs.end_ref = end_ref;
    if (end_id) pointerArgs.end_id = end_id;
    if (end_x !== undefined) pointerArgs.end_x = end_x;
    if (end_y !== undefined) pointerArgs.end_y = end_y;
    return [{ tool: "browser_pointer", args: pointerArgs }];
  }
  if (step.tool === "hover_and_read") {
    const { holdMs = 300 } = args as any;
    const target = extractTarget(args);
    return [
      { tool: "browser_pointer", args: { action: "hover", holdMs, ...target } },
      { tool: "browser_map", args: {} },
    ];
  }
  return [];
}

function normalizeRawSteps(raw: unknown[]): AnyBurstStep[] {
  const norm: AnyBurstStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const tool = (entry.tool || entry.action) as string;
    if (!tool) continue;
    let stepArgs: Record<string, unknown> = {};
    if (entry.args && typeof entry.args === "object" && !Array.isArray(entry.args)) {
      stepArgs = { ...(entry.args as Record<string, unknown>) };
    }
    for (const [k, v] of Object.entries(entry)) {
      if (k === "tool" || k === "args") continue;
      if (stepArgs[k] === undefined) stepArgs[k] = v;
    }
    norm.push({ tool, args: stepArgs });
  }
  return norm;
}

function extractArgs(step: TrailEntry): Record<string, unknown> {
  const s = step as any;
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

  const metaKeys = new Set([
    'tool', 'result', 'timestamp', 'type', 'id',
    'status', 'error', 'duration', 'startTime', 'endTime',
    'session', 'tabId', 'targetId',
  ]);
  for (const key of Object.keys(s)) {
    if (metaKeys.has(key)) continue;
    const val = s[key];
    if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
      return val;
    }
  }

  return {};
}

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
  "browser_recording",
  "type_and_send", "navigate_and_read", "click_and_wait",
  "scroll_and_read", "fill_form", "drag_and_drop", "hover_and_read",
]);

export function compileTraceToMacro(steps: TrailEntry[]): AnyBurstStep[] {
  const macro: AnyBurstStep[] = [];
  let lastKey = "";

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
      const key = `${step.tool}:${JSON.stringify(args)}`;
      if (key !== lastKey) {
        macro.push({ tool: step.tool as any, args });
        lastKey = key;
      }
    }
  });

  return macro;
}

export async function browserBurst(
  session: CDP.Client,
  args: BurstOptions,
  config: Config
): Promise<BurstResult> {
  let rawSteps = args.steps || args.actions;
  let compiledSteps: AnyBurstStep[] | undefined;

  if (args.compile_from_history) {
    const trail = getTrail();
    const limit = args.history_limit ?? 20;
    const slice = limit > 0 ? trail.slice(-limit) : trail;
    compiledSteps = compileTraceToMacro(slice);

    if (args.dry_run) {
      return {
        success: true,
        steps_completed: 0,
        results: [],
        aborted: false,
        compiled_steps: compiledSteps,
        message: `compiled ${compiledSteps.length} macro steps from history`,
      };
    }

    if (!rawSteps || rawSteps.length === 0) {
      rawSteps = compiledSteps;
    }
  }

  const normalized = normalizeRawSteps(rawSteps || []);
  if (normalized.length === 0) {
    return {
      success: true,
      steps_completed: 0,
      results: [],
      aborted: false,
      compiled_steps: compiledSteps,
      message: args.compile_from_history ? "no actionable steps found in history" : "no steps provided",
    };
  }

  const steps: BurstStep[] = [];
  const MACRO_TOOLS = new Set(["type_and_send", "navigate_and_read", "click_and_wait", "scroll_and_read", "fill_form", "drag_and_drop", "hover_and_read"]);
  for (const step of normalized) {
    if (MACRO_TOOLS.has(step.tool)) {
      steps.push(...expandMacro(step as BurstMacroStep));
    } else {
      steps.push({
        tool: step.tool,
        args: JSON.parse(JSON.stringify(step.args || {})),
      });
    }
  }

  const { batch, stop_on_error } = args;
  const stopOnError = stop_on_error !== false;

  if (batch) {
    for (const step of steps) {
      if (step.args.fast === undefined) step.args.fast = true;
    }
  }

  const results: BurstStepResult[] = [];
  let stepsCompleted = 0;

  await sendToExtension(session, {
    type: 'Weavetab_STATE',
    hud: { action: `running ${steps.length} steps ${batch ? 'in batch' : 'in sequence'}...` },
  });

  resetLoopCounter("burst");

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    let result: unknown;
    let stepError: string | undefined;

    try {
      switch (step.tool) {
        case "browser_click":
          result = await weaveClick(session, step.args as any, config);
          break;
        case "browser_type":
          result = await weaveType(session, step.args as any, config);
          break;
        case "browser_go":
        case "browser_navigate":
          result = await weaveNavigate(session, (step.args as any).url, config, undefined, false, false, args.app);
          break;
        case "browser_key":
          result = await weaveKey(session, step.args as any, config);
          break;
        case "browser_scroll":
          result = await browserScroll(session, step.args as any, config);
          break;
        case "browser_wait":
          result = await browserWait(session, step.args as any, config);
          break;
        case "browser_map": {
          const mapTargetId = sessionRegistry.getActive(getConfigAgentId(config), args.app)?.targetId || "default";
          result = await browserMap(session, step.args as ReadOptions, mapTargetId, config);
          break;
        }
        case "browser_eval":
          result = await browserEval(session, step.args as any, config);
          break;
        case "browser_select":
          result = await browserSelect(session, step.args as any, config);
          break;
        case "browser_pointer":
          result = await browserPointer(session, step.args as any, config);
          break;
        case "browser_console": {
          let targetId = "default";
          const active = sessionRegistry.getActive(getConfigAgentId(config), args.app);
          if (active) targetId = active.targetId;
          result = await browserConsole(session, step.args as any, config, targetId);
          break;
        }
        case "browser_find":
          result = await browserFind(session, step.args as any, config);
          break;
        case "browser_fill":
          result = await browserFill(session, step.args as any, config);
          break;
        case "browser_type_secret":
          result = await weaveTypeSecret(session, step.args as any, config);
          break;
        case "browser_screenshot": {
          const { browserScreenshot } = await import("./screenshot.js");
          result = await browserScreenshot(session, step.args as any, config);
          break;
        }
        case "browser_inspect":
          result = await browserInspect(session, step.args as any, config);
          break;
        case "browser_storage":
          result = await browserStorage(session, step.args as any, config);
          break;
        case "browser_cookies":
          result = await browserCookies(session, step.args as any, config);
          break;
        case "browser_highlight":
          result = await browserHighlight(session, step.args as any, config);
          break;
        case "browser_scrape":
          result = await browserScrape(session, step.args as any, config);
          break;
        case "browser_canvas": {
          const { browserCanvas } = await import("./canvas.js");
          result = await browserCanvas(session, step.args as any, config);
          break;
        }
        case "browser_performance": {
          const { browserPerformance } = await import("./performance.js");
          result = await browserPerformance(session, config);
          break;
        }
        case "browser_snapshot": {
          const { browserSnapshot } = await import("./snapshot.js");
          result = await browserSnapshot(session, step.args as any, config);
          break;
        }
        case "browser_pdf": {
          const { browserPdf } = await import("./pdf.js");
          result = await browserPdf(session, step.args as any, config);
          break;
        }
        case "browser_dialog": {
          const { browserDialog } = await import("./dialog.js");
          result = await browserDialog(session, step.args as any);
          break;
        }
        case "browser_upload": {
          const { browserUpload } = await import("./upload.js");
          result = await browserUpload(session, step.args as any, config);
          break;
        }
        case "browser_viewport": {
          const { browserViewport } = await import("./viewport.js");
          result = await browserViewport(session, step.args as any, config);
          break;
        }
        case "browser_clipboard": {
          const { browserClipboard } = await import("./clipboard.js");
          result = await browserClipboard(session, step.args as any, config);
          break;
        }
        case "browser_detect": {
          const { detectBrowsers } = await import("./browser_detect.js");
          result = detectBrowsers(getConfigBrowserType(config));
          break;
        }
        case "browser_recording": {
          const { browserRecording } = await import("./recording.js");
          result = await browserRecording(session, step.args as any, config);
          break;
        }
        case "browser_automation": {
          const { browserAutomation } = await import("./automation.js");
          result = await browserAutomation(session, step.args as any, config);
          break;
        }
        default:
          stepError = `Unknown tool "${step.tool}"`;
      }

      if (stepError) {
        results.push({ step: i + 1, tool: step.tool, success: false, error: stepError });
        stepsCompleted++;
        logAction("browser_burst", `step_${i + 1}`, `error: ${stepError}`);
        if (stopOnError) {
          await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: '' } });
          return {
            success: false,
            steps_completed: stepsCompleted,
            results,
            aborted: true,
            abort_reason: `halted on step ${i + 1} (${step.tool}): ${stepError}`,
            compiled_steps: compiledSteps,
          };
        }
        continue;
      }

      const resultObj = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      const isError = resultObj.success === false;
      const errDetail = (resultObj.message as string) || (resultObj.stuck_hint as string) || undefined;

      results.push({
        step: i + 1,
        tool: step.tool,
        success: !isError,
        result: isError ? undefined : result,
        error: isError ? errDetail : undefined,
      });
      stepsCompleted++;

      if (isError && stopOnError) {
        logAction("browser_burst", `step_${i + 1}`, `halted on error: ${errDetail}`);
        await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: '' } });
        return {
          success: false,
          steps_completed: stepsCompleted,
          results,
          aborted: true,
          abort_reason: `halted on step ${i + 1} (${step.tool}): ${errDetail ?? "action failed"}`,
          compiled_steps: compiledSteps,
        };
      }
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      logAction("browser_burst", `step_${i + 1}`, `exception: ${errMsg}`);
      results.push({ step: i + 1, tool: step.tool, success: false, error: `Exception: ${errMsg}` });
      stepsCompleted++;
      if (stopOnError) {
        await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: '' } });
        return {
          success: false,
          steps_completed: stepsCompleted,
          results,
          aborted: true,
          abort_reason: `exception on step ${i + 1} (${step.tool}): ${errMsg}`,
          compiled_steps: compiledSteps,
        };
      }
    }

    logAction("browser_burst", `step_${i + 1}/${steps.length}`, step.tool);
  }

  if (batch) {
    const targetId = sessionRegistry.getActive(getConfigAgentId(config))?.targetId || "default";
    const map = await buildActionMap(session, { lite: true }, targetId);
    cacheActionMap(targetId, map);
  }

  await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: '' } });

  const allPassed = results.length > 0 && results.every(r => r.success);

  return {
    success: allPassed,
    steps_completed: stepsCompleted,
    results,
    aborted: false,
    compiled_steps: compiledSteps,
  };
}

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
import { resetLoopCounter } from "../intelligence/trail.js";

export interface BurstStep {
  tool: "browser_click" | "browser_type" | "browser_go" | "browser_navigate" | "browser_key" | "browser_scroll" | "browser_wait" | "browser_map" | "browser_pointer" | "browser_eval" | "browser_select" | "browser_console" | "browser_find" | "browser_fill" | "browser_type_secret" | "browser_screenshot" | "browser_inspect" | "browser_storage" | "browser_cookies" | "browser_highlight" | "browser_scrape" | "browser_canvas" | "browser_performance" | "browser_snapshot" | "browser_pdf" | "browser_dialog" | "browser_upload" | "browser_viewport" | "browser_clipboard" | "browser_detect" | "browser_recording" | "browser_automation";
  args: Record<string, unknown>;
}

/** Macro step types — expanded server-side into multiple primitive calls. */
export interface BurstMacroStep {
  tool: "type_and_send" | "navigate_and_read" | "click_and_wait" | "scroll_and_read" | "fill_form" | "drag_and_drop" | "hover_and_read";
  args: Record<string, unknown>;
}

export type AnyBurstStep = BurstStep | BurstMacroStep;

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
}

/**
 * Expand a macro step into primitive BurstSteps.
 */
function expandMacro(step: BurstMacroStep): BurstStep[] {
  if (step.tool === "type_and_send") {
    const { x, y, text, id, label, pressEnter = true } = step.args as any;
    
    if (!id && !label && x === undefined && y === undefined) {
      throw new Error("type_and_send macro failed: no target specified (requires id, label, or x/y)");
    }
    if (text === undefined) {
      throw new Error("type_and_send macro failed: text argument is required");
    }

    const typeArgs: Record<string, unknown> = { text, noRetry: true };
    if (x !== undefined) typeArgs.x = x;
    if (y !== undefined) typeArgs.y = y;
    if (id) typeArgs.id = id;
    if (label) typeArgs.label = label;
    const steps: BurstStep[] = [{ tool: "browser_type", args: typeArgs }];
    if (pressEnter) steps.push({ tool: "browser_key", args: { key: "Enter" } });
    return steps;
  }
  if (step.tool === "navigate_and_read") {
    const { url } = step.args as any;
    return [
      { tool: "browser_go", args: { url } },
      { tool: "browser_map", args: {} },
    ];
  }
  if (step.tool === "click_and_wait") {
    const { id, label, wait_for, wait_value, x, y } = step.args as any;
    const clickArgs: Record<string, unknown> = {};
    if (id) clickArgs.id = id;
    if (label) clickArgs.label = label;
    if (x !== undefined) clickArgs.x = x;
    if (y !== undefined) clickArgs.y = y;
    clickArgs.waitForNetwork = true;
    clickArgs.waitAfter = 500;
    return [
      { tool: "browser_click", args: clickArgs },
    ];
  }
  if (step.tool === "scroll_and_read") {
    const { direction, distance } = step.args as any;
    return [
      { tool: "browser_scroll", args: { direction, distance } },
      { tool: "browser_map", args: {} },
    ];
  }
  if (step.tool === "fill_form") {
    const { fields, submit } = step.args as any;
    const steps: BurstStep[] = [];
    if (fields && typeof fields === "object") {
      for (const [id, value] of Object.entries(fields)) {
        steps.push({ tool: "browser_fill", args: { id, value } });
      }
    }
    if (submit) {
      steps.push({ tool: "browser_key", args: { key: "Enter" } });
    }
    return steps;
  }
  if (step.tool === "drag_and_drop") {
    const { id, end_id, x, y, end_x, end_y, label } = step.args as any;
    const pointerArgs: Record<string, unknown> = { action: "drag_and_drop" };
    if (id) pointerArgs.ref = id;
    if (end_id) pointerArgs.end_ref = end_id;
    if (label) pointerArgs.label = label;
    if (x !== undefined) pointerArgs.x = x;
    if (y !== undefined) pointerArgs.y = y;
    if (end_x !== undefined) pointerArgs.end_x = end_x;
    if (end_y !== undefined) pointerArgs.end_y = end_y;
    return [{ tool: "browser_pointer", args: pointerArgs }];
  }
  if (step.tool === "hover_and_read") {
    const { id, label, x, y, holdMs = 300 } = step.args as any;
    const pointerArgs: Record<string, unknown> = { action: "hover", holdMs };
    if (id) pointerArgs.ref = id;
    if (label) pointerArgs.label = label;
    if (x !== undefined) pointerArgs.x = x;
    if (y !== undefined) pointerArgs.y = y;
    return [
      { tool: "browser_pointer", args: pointerArgs },
      { tool: "browser_map", args: {} },
    ];
  }
  return [];
}

export async function browserBurst(
  session: CDP.Client,
  args: { steps: AnyBurstStep[]; batch?: boolean; app?: string },
  config: Config
): Promise<BurstResult> {
  if (!args.steps || args.steps.length === 0) {
    return { success: true, steps_completed: 0, results: [], aborted: false };
  }
  // Expand macro steps into primitive steps first
  const steps: BurstStep[] = [];
  const MACRO_TOOLS = new Set(["type_and_send", "navigate_and_read", "click_and_wait", "scroll_and_read", "fill_form", "drag_and_drop", "hover_and_read"]);
  for (const step of args.steps) {
    if (MACRO_TOOLS.has(step.tool)) {
      steps.push(...expandMacro(step as BurstMacroStep));
    } else {
      steps.push({
        tool: step.tool as any,
        args: JSON.parse(JSON.stringify(step.args || {}))
      });
    }
  }
  const { batch } = args;

  // Inject fast: true if batch mode is on, unless explicitly set to false
  if (batch) {
    for (const step of steps) {
      if (step.args.fast === undefined) {
        step.args.fast = true;
      }
    }
  }

  const results: BurstStepResult[] = [];
  let stepsCompleted = 0;

  await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: `running ${steps.length} steps ${batch ? 'in batch' : 'in sequence'}...` } });
  
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
        continue;
      }

      const resultObj = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      const isError = resultObj.success === false;

      results.push({
        step: i + 1,
        tool: step.tool,
        success: !isError,
        result: isError ? undefined : result,
        error: isError ? (resultObj.message as string) || (resultObj.stuck_hint as string) || undefined : undefined,
      });
      stepsCompleted++;
    } catch (err: any) {
      logAction("browser_burst", `step_${i + 1}`, `exception: ${err?.message ?? err}`);
      results.push({ step: i + 1, tool: step.tool, success: false, error: `Exception: ${err?.message ?? String(err)}` });
      stepsCompleted++;
    }

    logAction("browser_burst", `step_${i + 1}/${steps.length}`, step.tool);
  }

  // If batch was used, update cache once at the end
  if (batch) {
    const targetId = sessionRegistry.getActive(getConfigAgentId(config))?.targetId || "default";
    const map = await buildActionMap(session, { lite: true }, targetId);
    cacheActionMap(targetId, map);
  }

  await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: '' } });

  const anySuccess = results.some(r => r.success);

  return {
    success: anySuccess,
    steps_completed: stepsCompleted,
    results,
    aborted: false,
  };
}

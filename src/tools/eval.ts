/**
 * Weavetab — tools/eval.ts
 * browser_eval: Run arbitrary sandboxed JS via Runtime.evaluate.
 * Special command: expression "Weavetab.usage()" returns session metrics.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { sendToExtension } from "../cdp/helpers.js";
import { SessionSecretTracker } from "../security/secrets.js";
import { sessionRegistry } from "../state/session.js";
import { getConfigAgentId } from "../config/loader.js";

export interface EvalOptions {
  expression: string;
  timeout?: number;
}

export async function browserEval(
  session: CDP.Client,
  options: EvalOptions,
  _config: Config
): Promise<{ success: boolean; result: any; type: string; error?: string; url?: string; title?: string }> {
  const { expression, timeout = 3000 } = options;  // Reduced from 5000ms

  if (!expression) throw new Error("browser_eval requires an 'expression'");

  let targetId = "default";
  const active = sessionRegistry.getActive(getConfigAgentId(_config));
  if (active) targetId = active.targetId;

  sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: 'evaluating...' } }).catch(() => {});

  // Always capture current page state so agent can detect navigation
  let currentUrl = "";
  let pageTitle = "";
  try {
    const { frameTree } = await session.Page.getFrameTree();
    currentUrl = frameTree.frame.url;
    try {
      const titleRes = await session.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
      if (titleRes?.result?.value) {
        pageTitle = titleRes.result.value as string;
      }
    } catch {}
    if (!pageTitle) {
      const { result: t } = await session.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
      pageTitle = (t?.value as string) || "";
    }
  } catch { /* non-fatal */ }

  // Special intercept: Weavetab.usage() — returns in-process session metrics
  if (expression.trim() === "Weavetab.usage()") {
    const { getUsageStats } = await import("../sensors/pacing.js");
    return { success: true, result: getUsageStats(), type: "object", url: currentUrl, title: pageTitle };
  }

  let evalExpr = expression.trim();
  const isFunctionDecl = /^(?:async\s+)?function\b/.test(evalExpr) || /^(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>\s*\{/.test(evalExpr);
  const isAlreadyIIFE = /^\s*\((?:async\s+)?function/.test(evalExpr) || /^\s*\((?:async\s*)?\(/.test(evalExpr);
  if (!isAlreadyIIFE && isFunctionDecl) {
    evalExpr = `(${evalExpr})`;
  }

  let result: any, exceptionDetails: any;
  const res1 = await session.Runtime.evaluate({
    expression: evalExpr,
    returnByValue: true,
    awaitPromise: true,
    timeout
  });

  result = res1.result;
  exceptionDetails = res1.exceptionDetails;

  if (exceptionDetails && exceptionDetails.exception?.description?.includes('SyntaxError: Illegal return statement')) {
    evalExpr = `(async function(){\n${expression}\n})()`;
    const res2 = await session.Runtime.evaluate({
      expression: evalExpr,
      returnByValue: true,
      awaitPromise: true,
      timeout
    });
    result = res2.result;
    exceptionDetails = res2.exceptionDetails;
  }

  if (exceptionDetails) {
    sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: '' } }).catch(() => {});
    return {
      success: false,
      result: null,
      type: "error",
      error: SessionSecretTracker.redact(targetId, exceptionDetails.exception?.description || exceptionDetails.text || ""),
      url: currentUrl,
      title: pageTitle,
    };
  }

  sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: '' } }).catch(() => {});

  // When the expression returns undefined (e.g., el.click(), void functions, or IIFEs with no return),
  // result.value is undefined and result.description is unhelpfully a type string.
  // Return a clear message so agents know the eval succeeded — it just returned no value.
  const rawResult = result.type === 'undefined'
    ? "(eval returned undefined. append ; 'ok' or return a string explicitly.)"
    : result.value !== undefined ? result.value : result.description;
  const redactedResult = typeof rawResult === 'string' 
    ? SessionSecretTracker.redact(targetId, rawResult) 
    : rawResult;

  return {
    success: true,
    result: redactedResult,
    type: result.type,
    url: currentUrl,
    title: pageTitle,
  };
}


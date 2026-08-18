/**
 * Weavetab — sensors/guard.ts
 * guardedAction pipeline: element readiness, DOM stability wait, and navigation await.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";

// ─── Poll utility ─────────────────────────────────────────────────────────────

export interface PollOptions {
  timeout: number;
  interval: number;
}

export async function pollUntil(
  predicate: () => Promise<boolean>,
  opts: PollOptions
): Promise<void> {
  const deadline = Date.now() + opts.timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(opts.interval);
  }
  throw new Error(`pollUntil: timed out after ${opts.timeout}ms`);
}

// sleep is ONLY permitted inside the auto-wait pipeline — never in tool handlers
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── DOM checks (all run inside CDP Runtime.callFunction for speed) ───────────

import { waitForNetworkIdle } from "./wait.js";

async function isElementReady(
  session: CDP.Client,
  backendNodeId: number
): Promise<boolean> {
  try {
    const { nodeIds } = await session.DOM.pushNodesByBackendIdsToFrontend({
      backendNodeIds: [backendNodeId],
    });
    if (!nodeIds[0]) return false;
    const { object } = await session.DOM.resolveNode({ nodeId: nodeIds[0] });
    if (!object?.objectId) return false;
    const { result } = await session.Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: `function() {
        if (this.disabled || this.getAttribute('aria-disabled') === 'true') return false;
        const r = this.getBoundingClientRect();
        const s = window.getComputedStyle(this);
        if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
        const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return topEl !== null && (topEl === this || this.contains(topEl));
      }`,
      returnByValue: true,
    });
    return result?.value === true;
  } catch {
    return false;
  }
}

// ─── DOM stability (waits for no mutations for quietPeriod ms) ────────────────

export async function waitForDOMStable(
  session: CDP.Client,
  quietPeriod = 50,  // Reduced from 100ms
  timeout = 800,    // Reduced from 1500ms
  fast = false
): Promise<void> {
  // Fast path: skip stability check entirely when fast=true
  if (fast) return Promise.resolve();

  const result = await session.Runtime.evaluate({
    expression: `(function(quiet, timeout) {
      return new Promise((resolve) => {
        let timer;
        const obs = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => { obs.disconnect(); resolve(true); }, quiet);
        });
        obs.observe(document.body, { childList: true, subtree: true, attributes: true });
        timer = setTimeout(() => { obs.disconnect(); resolve(true); }, quiet);
        setTimeout(() => { obs.disconnect(); resolve(true); }, timeout);
      });
    })(${quietPeriod}, ${timeout})`,
    awaitPromise: true,
    returnByValue: true,
  }).catch(() => ({ result: { value: true } }));
  
  return Promise.resolve();
}


// ─── guardedAction — the mandatory wrapper for every CDP interaction ──────────
//
// Rule 9: Every CDP interaction goes through this pipeline:
// 1. DOM existence check
// 2. Visibility check
// 3. Interactability check
// 4. DOM stability wait (150ms quiet period for SPA re-renders)
// Then fires the action.
//
// Manual sleeps in tool handlers are BANNED. This is the only place they live.

export async function guardedAction(
  session: CDP.Client,
  backendNodeId: number,
  action: () => Promise<void>,
  label = "unknown",
  postActionPipeline?: () => Promise<void>,
  fast = false
): Promise<void> {
  // Fast path: minimal checks when fast=true
  if (fast) {
    // Quick single check (no polling)
    const ready = await isElementReady(session, backendNodeId);
    if (!ready) {
      throw new Error(`guardedAction: element "${label}" not ready (fast mode)`);
    }
    await action();
    if (postActionPipeline) await postActionPipeline();
    return;
  }

  // 1. Single-pass check: existence, visibility, and interactability
  await pollUntil(() => isElementReady(session, backendNodeId), {
    timeout: 800,  // Reduced from 1500ms
    interval: 30,  // Reduced from 50ms
  }).catch(() => {
    throw new Error(`guardedAction: element "${label}" not ready (missing, hidden, or blocked) after 0.8s`);
  });

  // 2. DOM stability pre-action
  await waitForDOMStable(session, 50, 600);  // Reduced from 100/1000

  // 3. Fire
  await action();

  // 4. Post-action — DOM stability + network idle (parallel, shorter)
  await Promise.all([
    waitForDOMStable(session, 50, 800),  // Reduced from 100/1500
    waitForNetworkIdle(session, 200, 800).catch(() => {}),  // Reduced from 300/1500
    postActionPipeline ? postActionPipeline() : Promise.resolve(),
  ]);
}

// ─── Page weight detection — smart timeout scaling ────────────────────────────

export interface PageWeight {
  level: "light" | "medium" | "heavy";
  elementCount: number;
  imageCount: number;
  scriptCount: number;
  iframeCount: number;
  suggestedTimeout: number;
}

export async function detectPageWeight(session: CDP.Client): Promise<PageWeight> {
  try {
    const { result } = await session.Runtime.evaluate({
      expression: `(function() {
        const all = document.querySelectorAll('*');
        const images = document.querySelectorAll('img, picture, svg');
        const scripts = document.querySelectorAll('script');
        const iframes = document.querySelectorAll('iframe, frame');
        return JSON.stringify({
          elementCount: all.length,
          imageCount: images.length,
          scriptCount: scripts.length,
          iframeCount: iframes.length
        });
      })()`,
      returnByValue: true,
    });
    const data = JSON.parse(result.value as string);
    const { elementCount, imageCount, scriptCount, iframeCount } = data;

    // Weight scoring heuristic
    let score = 0;
    score += Math.min(elementCount / 500, 10);       // 0-10: 0 to 5000+ elements
    score += Math.min(imageCount / 10, 5);            // 0-5:  0 to 50+ images
    score += Math.min(scriptCount / 5, 3);            // 0-3:  0 to 15+ scripts
    score += Math.min(iframeCount, 2);                // 0-2:  0+ iframes

    const level = score < 5 ? "light" : score < 12 ? "medium" : "heavy";
    const baseTimeout = 8000;
    const suggestedTimeout = Math.min(
      Math.round(baseTimeout + score * 1500),
      60000
    );

    return { level, elementCount, imageCount, scriptCount, iframeCount, suggestedTimeout };
  } catch {
    return {
      level: "light",
      elementCount: 0,
      imageCount: 0,
      scriptCount: 0,
      iframeCount: 0,
      suggestedTimeout: 10000,
    };
  }
}

// ─── Navigation wait — used after clicks that trigger navigation ──────────────

export async function awaitNavigation(
  session: CDP.Client,
  timeout = 6000  // Reduced from 10000ms
): Promise<void> {
  // Poll readyState instead of consuming one-shot event
  await pollUntil(async () => {
    const { result } = await session.Runtime.evaluate({
      expression: `document.readyState`,
      returnByValue: true,
    }).catch(() => ({ result: { value: 'loading' } }));
    return result?.value === 'complete' || result?.value === 'interactive';
  }, { timeout, interval: 50 }).catch(() => {  // Reduced interval from 100ms
    throw new Error(`Navigation timeout after ${timeout}ms`);
  });

  // After DOM content fires, detect page weight for post-load stability wait
  const weight = await detectPageWeight(session);
  const stabilityTimeout = weight.level === "heavy" ? 3000 : weight.level === "medium" ? 2000 : 1000;  // Reduced from 5000/3000/2000

  await waitForDOMStable(session, 50, stabilityTimeout);  // Reduced quiet period from 100ms
}

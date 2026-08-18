import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — tools/wait.ts
 * Smart wait framework: polls/observes until condition is met or timeout expires.
 * Supports: element, text, url, stable, network, auto
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import { sessionRegistry } from "../state/session.js";
import { logAction } from "../audit/logger.js";
import { sendToExtension } from "../cdp/helpers.js";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";

export interface WaitResult {
  success: boolean;
  found: boolean;
  elapsed_ms: number;
  matched_value: string;
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

// ── Auto-route: guess the best wait mode from the value string ─────────────
function autoDetectMode(value: string): "url" | "element" | "text" {
  if (/^https?:\/\//.test(value) || value.includes("://") || value.startsWith("*")) return "url";
  if (/^[.#\[]/.test(value) || /^[a-z]+\[/.test(value) || value.includes(" > ")) return "element";
  return "text";
}

// ── Wait for element via MutationObserver injected into page ──────────────
async function waitForElement(
  session: CDP.Client,
  selector: string,
  timeout: number
): Promise<{ found: boolean; elapsed_ms: number }> {
  const start = Date.now();
  const res = await session.Runtime.evaluate({
    expression: `(function(sel, timeout) {
      return new Promise((resolve) => {
        // Check immediately first
        const existing = document.querySelector(sel) ||
          (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
        if (existing) { return resolve({ found: true, tag: existing.tagName }); }

        const obs = new MutationObserver(() => {
          const el = document.querySelector(sel) ||
            (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
          if (el) { obs.disconnect(); clearTimeout(tid); resolve({ found: true, tag: el.tagName }); }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        const tid = setTimeout(() => { obs.disconnect(); resolve({ found: false }); }, timeout);
      });
    })(${JSON.stringify(selector)}, ${timeout})`,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeout + 2000,
  }).catch(() => null);

  const found = res?.result?.value?.found === true;
  return { found, elapsed_ms: Date.now() - start };
}

// ── Wait for text via polling + MutationObserver ──────────────────────────
async function waitForText(
  session: CDP.Client,
  text: string,
  timeout: number
): Promise<{ found: boolean; elapsed_ms: number }> {
  const start = Date.now();
  const res = await session.Runtime.evaluate({
    expression: `(function(needle, timeout) {
      return new Promise((resolve) => {
        const check = () => {
          const body = document.body?.innerText ?? document.body?.textContent ?? '';
          if (body.includes(needle)) return true;
          // Also check visible value attributes
          const inputs = document.querySelectorAll('input, textarea');
          for (const inp of inputs) {
            if ((inp.value || '').includes(needle)) return true;
          }
          return false;
        };
        if (check()) return resolve({ found: true });

        const obs = new MutationObserver(() => {
          if (check()) { obs.disconnect(); clearTimeout(tid); resolve({ found: true }); }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        const tid = setTimeout(() => { obs.disconnect(); resolve({ found: false }); }, timeout);
      });
    })(${JSON.stringify(text)}, ${timeout})`,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeout + 2000,
  }).catch(() => null);

  const found = res?.result?.value?.found === true;
  return { found, elapsed_ms: Date.now() - start };
}

// ── Wait for URL via polling (Page.getFrameTree) ──────────────────────────
async function waitForUrl(
  session: CDP.Client,
  pattern: string,
  timeout: number
): Promise<{ found: boolean; elapsed_ms: number; matched_value: string }> {
  const start = Date.now();
  const interval = 150;

  while (Date.now() - start < timeout) {
    try {
      const { frameTree } = await session.Page.getFrameTree();
      const currentUrl = frameTree.frame.url;
      if (globMatch(pattern, currentUrl) || currentUrl.includes(pattern)) {
        return { found: true, elapsed_ms: Date.now() - start, matched_value: currentUrl };
      }
    } catch { /* navigation in progress, keep polling */ }
    await sleep(interval);
  }

  return { found: false, elapsed_ms: Date.now() - start, matched_value: "" };
}

// ── Wait for network idle (no pending requests for quietMs) ───────────────
async function waitForNetwork(
  session: CDP.Client,
  timeout: number,
  quietMs = 500
): Promise<{ found: boolean; elapsed_ms: number }> {
  const start = Date.now();

  try {
    await session.Network.enable({});
  } catch { /* already enabled */ }

  return new Promise<{ found: boolean; elapsed_ms: number }>((resolve) => {
    let pending = 0;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    const finish = (found: boolean) => {
      if (done) return;
      done = true;
      if (quietTimer) clearTimeout(quietTimer);
      try {
        (session as any).removeListener("Network.requestWillBeSent", onRequest);
        (session as any).removeListener("Network.loadingFinished", onComplete);
        (session as any).removeListener("Network.loadingFailed", onComplete);
      } catch { /* ignore */ }
      resolve({ found, elapsed_ms: Date.now() - start });
    };

    const resetQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (pending <= 0) {
        quietTimer = setTimeout(() => finish(true), quietMs);
      }
    };

    resetQuiet();

    const onRequest = () => {
      pending++;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = null;
    };

    const onComplete = () => {
      pending = Math.max(0, pending - 1);
      resetQuiet();
    };

    session.on("Network.requestWillBeSent", onRequest);
    session.on("Network.loadingFinished", onComplete);
    session.on("Network.loadingFailed", onComplete);

    // Overall timeout guard
    setTimeout(() => finish(false), timeout);
  });
}

// ── Main export ───────────────────────────────────────────────────────────
export async function browserWait(
  session: CDP.Client,
  args: {
    for: "element" | "text" | "url" | "stable" | "network" | "auto";
    value?: string;
    timeout?: number;
  },
  config: Config
): Promise<WaitResult> {
  const { for: waitFor, value = "", timeout: rawTimeout = 8000 } = args;
  const timeout = Math.max(1000, rawTimeout);
  const start = Date.now();

  let targetId = "default";
  const active = sessionRegistry.getActive(getConfigAgentId(config));
  if (active) targetId = active.targetId;

  sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: `waiting for ${waitFor}...` } }).catch(() => {});

  try {
    // ── Auto-detect mode ─────────────────────────────────────────────────
    if (waitFor === "auto") {
      const detected = autoDetectMode(value);
      return browserWait(session, { for: detected, value, timeout }, config);
    }

    // ── Element wait (MutationObserver) ───────────────────────────────────
    if (waitFor === "element") {
      const { found, elapsed_ms } = await waitForElement(session, value, timeout);
      logAction("browser_wait", "element", found ? `found: ${value}` : `timeout after ${elapsed_ms}ms`);
      return { success: found, found, elapsed_ms, matched_value: found ? value : "" };
    }

    // ── Text wait (MutationObserver) ──────────────────────────────────────
    if (waitFor === "text") {
      const { found, elapsed_ms } = await waitForText(session, value, timeout);
      logAction("browser_wait", "text", found ? `found: "${value}"` : `timeout after ${elapsed_ms}ms`);
      return { success: found, found, elapsed_ms, matched_value: found ? value : "" };
    }

    // ── URL wait (polling) ────────────────────────────────────────────────
    if (waitFor === "url") {
      const { found, elapsed_ms, matched_value } = await waitForUrl(session, value, timeout);
      logAction("browser_wait", "url", found ? `matched: ${matched_value}` : `timeout after ${elapsed_ms}ms`);
      return { success: found, found, elapsed_ms, matched_value };
    }

    // ── Stable DOM wait ───────────────────────────────────────────────────
    if (waitFor === "stable") {
      const { waitForDOMStable } = await import("../sensors/guard.js");
      await waitForDOMStable(session, 500, timeout);
      const elapsed = Date.now() - start;
      logAction("browser_wait", "stable", `DOM settled after ${elapsed}ms`);
      return { success: true, found: true, elapsed_ms: elapsed, matched_value: "stable" };
    }

    // ── Network idle wait ─────────────────────────────────────────────────
    if (waitFor === "network") {
      const { found, elapsed_ms } = await waitForNetwork(session, timeout);
      logAction("browser_wait", "network", found ? `network idle after ${elapsed_ms}ms` : `timeout after ${elapsed_ms}ms`);
      return { success: true, found, elapsed_ms, matched_value: found ? "network-idle" : "" };
    }
  } catch (e) {
    logDebug(`[Weavetab] Error in browserWait(${waitFor}): ${e}`);
  }

  const elapsed = Date.now() - start;
  logAction("browser_wait", waitFor, `timeout/error after ${elapsed}ms`);
  return { success: false, found: false, elapsed_ms: elapsed, matched_value: "" };
}

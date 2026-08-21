import { logDebug } from "../audit/logger.js";
// src/overlay/ghost.ts
// Phase 3: Ghost Presence — Human-like movement, typing, and reading.
// Phase 3.7.1: Adaptive speed, visual feedback, cursor trail options.
// Uses __wt_cursor() and __wt_thought()/__wt_clearThought() — no showBubble().

import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { getConfigHeadless, getConfigVisuals } from "../config/loader.js";

export interface CursorOptions {
  trail?: "off" | "subtle" | "full";
  opacity?: number;
  speed?: "human" | "fast" | "instant";
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// Gaussian random generator (Box-Muller transform)
function randomGaussian(mean: number, stdDev: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  num = num / 10.0 + 0.5;
  if (num > 1 || num < 0) return randomGaussian(mean, stdDev);
  return mean + (num - 0.5) * 2 * stdDev;
}

import { sendToExtension } from "../cdp/helpers.js";

function wtCursor(session: CDP.Client, x: number, y: number, state: string, opts?: CursorOptions) {
  recordCursorPosition(x, y);
  const trail = opts?.trail && opts.trail !== "off" ? getCursorTrail(opts.trail === "full" ? 20 : 8) : undefined;
  sendToExtension(session, { type: 'Weavetab_STATE', cursor: { x, y, trail }, state }).catch(() => {});
}

let _wanderActive = false;

export async function ensureInitialCursorPosition(session: CDP.Client): Promise<{ x: number; y: number }> {
  if (currentX >= 0 && currentY >= 0) {
    return { x: currentX, y: currentY };
  }
  try {
    const layout = await session.Page.getLayoutMetrics().catch(() => null);
    if (layout?.visualViewport?.clientWidth && layout?.visualViewport?.clientHeight) {
      currentX = Math.round(layout.visualViewport.clientWidth / 2);
      currentY = Math.round(layout.visualViewport.clientHeight / 2);
    } else {
      const evalRes = await session.Runtime.evaluate({
        expression: `({ x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) })`,
        returnByValue: true
      }).catch(() => null);
      if (evalRes?.result?.value?.x && evalRes?.result?.value?.y) {
        currentX = evalRes.result.value.x;
        currentY = evalRes.result.value.y;
      } else {
        currentX = 640;
        currentY = 400;
      }
    }
  } catch {
    currentX = 640;
    currentY = 400;
  }
  wtCursor(session, currentX, currentY, "idle");
  return { x: currentX, y: currentY };
}

async function wtThought(session: CDP.Client, text: string) {
  await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: text } }).catch(() => {});

  if (currentX < 0 || currentY < 0) {
    await ensureInitialCursorPosition(session);
  }

  // Add realistic wandering movement connected to thoughts (non-racing)
  if (currentX > 0 && currentY > 0 && !_wanderActive && Math.random() > 0.3) {
    _wanderActive = true;
    const startX = currentX;
    const startY = currentY;
    const wanderDistance = 10 + Math.random() * 25;
    const angle = Math.random() * Math.PI * 2;
    const tx = Math.max(20, startX + Math.cos(angle) * wanderDistance);
    const ty = Math.max(20, startY + Math.sin(angle) * wanderDistance);
    
    const steps = 12;
    const waypoints = [];
    const cp1X = startX + (tx - startX) * 0.3;
    const cp1Y = startY + (ty - startY) * 0.3;
    const cp2X = startX + (tx - startX) * 0.7;
    const cp2Y = startY + (ty - startY) * 0.7;
    
    for (let i = 1; i <= steps; i++) {
        let t = i / steps;
        t = 1 - Math.pow(1 - t, 3);
        waypoints.push({
            x: Math.round(cubicBezier(t, startX, cp1X, cp2X, tx)),
            y: Math.round(cubicBezier(t, startY, cp1Y, cp2Y, ty))
        });
    }
    
    sendToExtension(session, {
        type: 'Weavetab_STATE',
        cursor: { waypoints, duration_ms: steps * 25, x: startX, y: startY },
        state: "thinking"
    }).catch(() => {});
    
    (async () => {
        try {
          for (let i = 1; i <= steps; i++) {
              if (!_wanderActive) break;
              const x = waypoints[i-1].x;
              const y = waypoints[i-1].y;
              await session.Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" }).catch(()=>{});
              currentX = x;
              currentY = y;
              await new Promise(r => setTimeout(r, 25));
          }
        } finally {
          _wanderActive = false;
        }
    })();
  }
}

async function wtClearThought(session: CDP.Client) {
  await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: '' } }).catch(() => {});
}

// ─── 1. Human Typing Simulation ───────────────────────────────────────────────

export interface BurstProfile {
  groupSize: [number, number];   // [min, max] chars per burst group
  interCharMin: number;          // ms
  interCharMax: number;  
  interGroupMin: number;         // ms pause between groups
  interGroupMax: number;
}

export const BURST_PROFILES: Record<"fast" | "normal" | "deliberate", BurstProfile> = {
  fast: {
    groupSize: [3, 5],
    interCharMin: 15,
    interCharMax: 30,
    interGroupMin: 40,
    interGroupMax: 80,
  },
  normal: {
    groupSize: [2, 4],
    interCharMin: 40,
    interCharMax: 70,
    interGroupMin: 60,
    interGroupMax: 150,
  },
  deliberate: {
    groupSize: [1, 2],
    interCharMin: 80,
    interCharMax: 140,
    interGroupMin: 100,
    interGroupMax: 250,
  },
};

export type GhostProfile = "human" | "fast" | "instant";

// Common bigrams typed ~35% faster (muscle memory)
const FAST_BIGRAMS = new Set([
  'th','he','in','er','an','re','on','at','en','nd','ti','es','or','te',
  'of','ed','is','it','al','ar','st','to','nt','ng','se','ha','as','ou',
  'io','le','ve','co','me','de','hi','ri','ro','ic','ne','ea','ra','ce',
]);

// Gaussian sample — Box-Muller, clamped to reasonable range
function gaussianDelay(mean: number, sd: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(20, Math.min(mean * 4.5, mean + n * sd));
}

export async function ghostType(
  session: CDP.Client,
  rawText: string,
  config: Config,
  /** CSS selector of the target field — used to re-verify focus every N chars */
  targetSelector?: string,
  profileName?: "fast" | "normal" | "deliberate"
) {
  if (!rawText) return;

  const resolvedProfile = profileName || "normal";

  if (getConfigHeadless(config)) {
    // Non-human: fast insertText line by line, no simulation
    const lines = rawText.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!;
      if (line) {
        await session.Input.insertText({ text: line }).catch(async () => {
          for (const ch of line) {
            await session.Input.dispatchKeyEvent({ type: "keyDown", text: ch });
            await session.Input.dispatchKeyEvent({ type: "keyUp" });
          }
        });
      }
      if (li < lines.length - 1) {
        await session.Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await session.Input.dispatchKeyEvent({ type: "keyUp",   key: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      }
    }
    return;
  }

  // ── Realistic human burst-typing ───────────────────────────────────────────
  // Use Input.insertText per burst group instead of per-character
  // dispatchKeyEvent pairs. This eliminates character dropping caused by
  // Chrome's event coalescing on Windows while preserving all human-like
  // timing simulation (delays, pauses, cursor jitter, bigram speedup).

  const p = BURST_PROFILES[resolvedProfile];
  let wordsSinceBreak = 0;
  let wordCharCount = 0;
  let prevChar = '';

  if (currentX < 0 || currentY < 0) {
    await ensureInitialCursorPosition(session);
  }

  wtCursor(session, currentX, currentY, "typing");

  let currentGroupSize = Math.floor(Math.random() * (p.groupSize[1] - p.groupSize[0] + 1)) + p.groupSize[0];
  let charsTypedInGroup = 0;
  let groupBuffer = '';

  async function flushGroup() {
    if (!groupBuffer) return;
    await session.Input.insertText({ text: groupBuffer });
    groupBuffer = '';
  }

  for (let i = 0; i < rawText.length; i++) {
    const char = rawText[i]!;

    // ── Newline: flush buffer + dispatch Enter key ───────────────────────
    if (char === '\n' || char === '\r') {
      await flushGroup();
      await session.Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await session.Input.dispatchKeyEvent({ type: "keyUp",   key: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      prevChar = char;
      wordCharCount = 0;
      charsTypedInGroup = 0;
      currentGroupSize = Math.floor(Math.random() * (p.groupSize[1] - p.groupSize[0] + 1)) + p.groupSize[0];
      await sleep(gaussianDelay(190, 65));
      continue;
    }

    // ── Cursor jitter while typing (moved to content.js) ───────────────────

    // ── Typo-and-correct (flush + dispatchKeyEvent ────────────────────────
    const typoRate = typeof (config as any).typoRate === 'number' ? (config as any).typoRate : 0;
    if (typoRate > 0 && Math.random() < typoRate && /[a-zA-Z]/.test(char)) {
      await flushGroup();
      const offset = Math.random() > 0.5 ? 1 : -1;
      const typoChar = String.fromCharCode(char.toLowerCase().charCodeAt(0) + offset);
      if (/[a-z]/.test(typoChar)) {
        await session.Input.dispatchKeyEvent({ type: "keyDown", text: typoChar });
        await session.Input.dispatchKeyEvent({ type: "keyUp" });
        await sleep(gaussianDelay(115, 38));
        await session.Input.dispatchKeyEvent({ type: "keyDown", key: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
        await session.Input.dispatchKeyEvent({ type: "keyUp",   key: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
        await sleep(gaussianDelay(75, 22));
      }
    }

    // ── Add character to burst buffer ──────────────────────────────────────
    groupBuffer += char;
    charsTypedInGroup++;

    // ── Compute delay ──────────────────────────────────────────────────────
    let charDelay = Math.random() * (p.interCharMax - p.interCharMin) + p.interCharMin;

    const bigram = (prevChar + char).toLowerCase();
    if (FAST_BIGRAMS.has(bigram)) charDelay *= 0.62;

    // ── Word boundary: flush group + pause ─────────────────────────────────
    if (char === ' ' || char === '\t') {
      await flushGroup();
      wordCharCount = 0;
      wordsSinceBreak++;
      await sleep(charDelay + (Math.random() * 50 + 20));

      if (rawText.length > 80 && wordsSinceBreak >= 12 && Math.random() < 0.20) {
        wtThought(session, `typing ${rawText.slice(0, 18).trim()}...`);
        await sleep(380 + Math.random() * 520);
        wordsSinceBreak = 0;
      }
      prevChar = char;
      charsTypedInGroup = 0;
      currentGroupSize = Math.floor(Math.random() * (p.groupSize[1] - p.groupSize[0] + 1)) + p.groupSize[0];
      continue;
    }

    // ── Punctuation: flush group + pause ────────────────────────────────────
    if (/[.,!?;:]/.test(char)) {
      await flushGroup();
      wordCharCount = 0;
      await sleep(charDelay + (Math.random() * 150 + 100));
      prevChar = char;
      charsTypedInGroup = 0;
      currentGroupSize = Math.floor(Math.random() * (p.groupSize[1] - p.groupSize[0] + 1)) + p.groupSize[0];
      continue;
    }

    // ── Group boundary: flush buffer + pause ────────────────────────────────
    if (charsTypedInGroup >= currentGroupSize) {
      await flushGroup();
      const groupPause = Math.random() * (p.interGroupMax - p.interGroupMin) + p.interGroupMin;
      await sleep(groupPause);
      charsTypedInGroup = 0;
      currentGroupSize = Math.floor(Math.random() * (p.groupSize[1] - p.groupSize[0] + 1)) + p.groupSize[0];
    } else {
      await sleep(charDelay);
    }

    // ── Periodic focus verification (every 5 chars) ───────────────────────
    if (targetSelector && i > 0 && i % 5 === 0) {
      const focusOk = await session.Runtime.evaluate({
        expression: `(function(sel) {
          try {
            const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
            return el ? document.activeElement === el || el.contains(document.activeElement) : true;
          } catch(e) { return true; }
        })(${JSON.stringify(targetSelector)})`,
        returnByValue: true,
      }).catch(() => ({ result: { value: true } }));
      if (focusOk?.result?.value === false) {
        await flushGroup();
        const coords = await session.Runtime.evaluate({
          expression: `(function(sel){
            const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
          })(${JSON.stringify(targetSelector)})`,
          returnByValue: true,
        }).catch(() => null);
        const c = coords?.result?.value as { x: number; y: number } | null;
        if (c) {
          await session.Input.dispatchMouseEvent({ type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
          await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
          await sleep(60);
        }
      }
    }

    prevChar = char;
  }

  // Flush any remaining buffered characters
  await flushGroup();

  wtCursor(session, currentX, currentY, "idle");

  // Short pause after typing (human reviews what they typed)
  await sleep(180 + Math.random() * 280);
}

// ─── 2. Ghost Cursor (Bezier Paths & Overshoot) ──────────────────────────────

let currentX = -1;
let currentY = -1;

function cubicBezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return (u*u*u*p0) + (3*u*u*t*p1) + (3*u*t*t*p2) + (t*t*t*p3);
}

let _firstMoveDone = false;

export async function ghostMove(
  session: CDP.Client,
  targetX: number,
  targetY: number,
  config: Config,
  label?: string,
  profile?: GhostProfile,
  cursorOpts?: Pick<CursorOptions, "trail" | "opacity">
) {
  _wanderActive = false; // Stop any ongoing thought wander immediately

  if (currentX < 0 || currentY < 0) {
    await ensureInitialCursorPosition(session);
  }

  const resolvedProfile = profile || (getConfigHeadless(config) ? "instant" : "human");

  if (resolvedProfile === "instant") {
    await session.Input.dispatchMouseEvent({ type: "mouseMoved", x: targetX, y: targetY, button: "none" });
    currentX = targetX;
    currentY = targetY;
    wtCursor(session, targetX, targetY, "hover", cursorOpts);
    recordCursorPosition(targetX, targetY);
    await session.Runtime.evaluate({
      expression: `(function(){
        var el = document.elementFromPoint(${targetX}, ${targetY});
        if (el) {
          el.dispatchEvent(new MouseEvent('mouseover', {bubbles:true,cancelable:true,clientX:${targetX},clientY:${targetY}}));
          el.dispatchEvent(new MouseEvent('mouseenter', {bubbles:false,cancelable:true,clientX:${targetX},clientY:${targetY}}));
        }
      })()`
    }).catch(() => {});
    return;
  }

  if (resolvedProfile === "fast") {
    const steps = 6;
    const startX = currentX;
    const startY = currentY;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(startX + (targetX - startX) * t);
      const y = Math.round(startY + (targetY - startY) * t);
      await session.Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" });
      currentX = x;
      currentY = y;
      wtCursor(session, x, y, "moving", cursorOpts);
      await sleep(6);
    }
    currentX = targetX;
    currentY = targetY;
    wtCursor(session, targetX, targetY, "hover", cursorOpts);
    recordCursorPosition(targetX, targetY);
    await session.Input.dispatchMouseEvent({ type: "mouseMoved", x: targetX, y: targetY, button: "none" });
    return;
  }

  if (!_firstMoveDone) {
    logDebug(`[Weavetab Ghost] First mouse move from (${currentX}, ${currentY}) → (${targetX}, ${targetY}) — CDP session active`);
    _firstMoveDone = true;
  }

  const dx = targetX - currentX;
  const dy = targetY - currentY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance < 4) {
    currentX = targetX;
    currentY = targetY;
    await session.Input.dispatchMouseEvent({ type: "mouseMoved", x: targetX, y: targetY, button: "none" });
    wtCursor(session, targetX, targetY, "hover", cursorOpts);
    recordCursorPosition(targetX, targetY);
    return;
  }

  wtCursor(session, currentX, currentY, label && distance >= 150 ? "searching" : "idle", cursorOpts);
  if (label && distance >= 150 && getConfigVisuals(config) !== false) {
    wtThought(session, `moving to ${label.slice(0, 40)}...`);
    await sleep(60 + Math.random() * 80);
  }

  // Smooth, natural human hand curve
  const duration = Math.max(120, Math.min(380, 80 + Math.sqrt(distance) * 12));
  const steps = Math.max(8, Math.min(24, Math.floor(duration / 16)));
  const stepDelay = Math.max(10, Math.floor(duration / steps));

  // Gentle perpendicular curvature (arcing motion)
  const nx = -dy / distance;
  const ny = dx / distance;
  const maxArc = Math.min(45, distance * 0.15);
  const arcSign = (Math.random() > 0.5 ? 1 : -1);
  const arcAmount = maxArc * arcSign * (0.4 + Math.random() * 0.6);

  const cp1X = currentX + dx * 0.3 + nx * arcAmount;
  const cp1Y = currentY + dy * 0.3 + ny * arcAmount;
  const cp2X = currentX + dx * 0.7 + nx * (arcAmount * 0.6);
  const cp2Y = currentY + dy * 0.7 + ny * (arcAmount * 0.6);

  const waypoints = [];
  for (let i = 1; i <= steps; i++) {
    const rawT = i / steps;
    // Cubic ease-out for natural deceleration
    const t = 1 - Math.pow(1 - rawT, 3);

    waypoints.push({
      x: Math.round(cubicBezier(t, currentX, cp1X, cp2X, targetX)),
      y: Math.round(cubicBezier(t, currentY, cp1Y, cp2Y, targetY))
    });
  }

  // Pre-announce waypoints for smooth client-side interpolation
  sendToExtension(session, {
    type: 'Weavetab_STATE',
    cursor: { waypoints, duration_ms: steps * stepDelay, x: currentX, y: currentY },
    state: "moving"
  }).catch(() => {});

  for (let i = 1; i <= steps; i++) {
    const pt = waypoints[i - 1];
    await session.Input.dispatchMouseEvent({ type: "mouseMoved", x: pt.x, y: pt.y, button: "none" }).catch(() => {});
    currentX = pt.x;
    currentY = pt.y;
    await sleep(stepDelay);
  }

  currentX = targetX;
  currentY = targetY;
  wtCursor(session, targetX, targetY, "hover", cursorOpts);
  recordCursorPosition(targetX, targetY);
  if (label) wtClearThought(session);
  await session.Input.dispatchMouseEvent({ type: "mouseMoved", x: targetX, y: targetY, button: "none" }).catch(() => {});

  await session.Runtime.evaluate({
    expression: `(function(){
      var el = document.elementFromPoint(${targetX}, ${targetY});
      if (el) {
        el.dispatchEvent(new MouseEvent('mouseover', {bubbles:true,cancelable:true,view:window,clientX:${targetX},clientY:${targetY}}));
        el.dispatchEvent(new MouseEvent('mouseenter', {bubbles:false,cancelable:true,view:window,clientX:${targetX},clientY:${targetY}}));
      }
    })()`
  }).catch(() => {});
}

// ─── 3. Reading Simulation ───────────────────────────────────────────────────

let readingPromise: Promise<void> | null = null;

/** Cancel simulated reading so actions don't wait 15s. */
export function cancelReading(): void {
  readingPromise = null;
}

export function startReadingSimulation(session: CDP.Client, wordCount: number, config: Config) {
  if (getConfigHeadless(config)) return;

  const readTimeMs = Math.min((wordCount / 200) * 60000, 3000);
  if (readTimeMs < 300) return;

  readingPromise = (async () => {
    const startTime = Date.now();
    let lastScrollTime = startTime;

    wtThought(session, "reading the page...");

    while (Date.now() - startTime < readTimeMs) {
      const now = Date.now();

      if (Math.random() < 0.1) {
        currentX += randomGaussian(0, 3);
        currentY += randomGaussian(0, 3);
        await session.Input.dispatchMouseEvent({ type: "mouseMoved", x: currentX, y: currentY, button: "none" }).catch(() => {});
        wtCursor(session, currentX, currentY, "reading");
      }

      if (now - lastScrollTime > 1500 && Math.random() < 0.5) {
        const totalScroll = randomGaussian(150, 50);
        const scrollSteps = Math.floor(totalScroll / 5);
        for (let i = 0; i < scrollSteps; i++) {
          await session.Input.dispatchMouseEvent({
            type: "mouseWheel",
            x: currentX, y: currentY,
            deltaX: 0, deltaY: 5
          }).catch(() => {});
          await sleep(16);
        }
        lastScrollTime = Date.now();
      }

      await sleep(100);
    }
    readingPromise = null;
    wtClearThought(session);
  })();
}

export async function waitForReading() {
  // Never block actions on reading simulation — it made clicks/types feel frozen
  cancelReading();
}

// ─── 4. Visual Feedback for Action Results ─────────────────────────────────────
// Shows a brief visual indicator (success checkmark / failure X) via the HUD.

export async function ghostResult(
  session: CDP.Client,
  success: boolean,
  actionType: string,
  detail?: string
): Promise<void> {
  const icon = success ? "✓" : "✗";
  const label = detail ? `${icon} ${actionType}: ${detail}` : `${icon} ${actionType}`;
  await wtThought(session, label);
  await sleep(success ? 400 : 800);
  if (success) {
    await wtClearThought(session);
  }
}

// ─── 5. Cursor Trail Customization ─────────────────────────────────────────────
// Stores the last N cursor positions so the extension can render a trail.

const cursorHistory: { x: number; y: number; t: number }[] = [];
const MAX_TRAIL_LENGTH = 20;

export function recordCursorPosition(x: number, y: number): void {
  cursorHistory.push({ x, y, t: Date.now() });
  if (cursorHistory.length > MAX_TRAIL_LENGTH) {
    cursorHistory.shift();
  }
}

export function getCursorTrail(length?: number): { x: number; y: number; t: number }[] {
  const n = length ?? cursorHistory.length;
  return cursorHistory.slice(-n);
}

export function clearCursorTrail(): void {
  cursorHistory.length = 0;
}

// ─── 6. Action and Lifecycle Hooks ─────────────────────────────────────────────

export async function ghostClick(session: CDP.Client, x: number, y: number, options?: any) {
  await session.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: options?.clickCount || 1, ...options });
  
  sendToExtension(session, {
    type: 'Weavetab_STATE',
    ripple: { x, y },
    state: 'clicking'
  }).catch(() => {});
}

export function ghostWait(session: CDP.Client) {
  const x = currentX >= 0 ? currentX : 640;
  const y = currentY >= 0 ? currentY : 400;
  wtCursor(session, x, y, "waiting");
}

export function ghostIdle(session: CDP.Client) {
  const x = currentX >= 0 ? currentX : 640;
  const y = currentY >= 0 ? currentY : 400;
  wtCursor(session, x, y, "idle");
}

import { logDebug } from "../audit/logger.js";
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { getCachedConfig, getConfigHeadless } from "../config/loader.js";
import { sendToExtension } from "../cdp/helpers.js";

export interface CursorOptions {
  trail?: "off" | "subtle" | "full";
  opacity?: number;
  speed?: "human" | "fast" | "instant";
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomGaussian(mean: number, stdDev: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  num = num / 10.0 + 0.5;
  if (num > 1 || num < 0) return randomGaussian(mean, stdDev);
  return mean + (num - 0.5) * 2 * stdDev;
}

function wtCursor(session: CDP.Client, x: number, y: number, state: string, opts?: CursorOptions) {
  recordCursorPosition(x, y);
  if (getConfigHeadless(getCachedConfig())) return;
  const trail = opts?.trail && opts.trail !== "off" ? getCursorTrail(opts.trail === "full" ? 20 : 8) : undefined;
  sendToExtension(session, { type: "Weavetab_STATE", cursor: { x, y, trail }, state }).catch(() => {});
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
        returnByValue: true,
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
  if (getConfigHeadless(getCachedConfig())) return;
  await sendToExtension(session, { type: "Weavetab_STATE", hud: { action: text } }).catch(() => {});

  if (currentX < 0 || currentY < 0) {
    await ensureInitialCursorPosition(session);
  }

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
        y: Math.round(cubicBezier(t, startY, cp1Y, cp2Y, ty)),
      });
    }

    sendToExtension(session, {
      type: "Weavetab_STATE",
      cursor: { waypoints, duration_ms: steps * 25, x: startX, y: startY },
      state: "thinking",
    }).catch(() => {});

    (async () => {
      try {
        for (let i = 1; i <= steps; i++) {
          if (!_wanderActive) break;
          const x = waypoints[i - 1]!.x;
          const y = waypoints[i - 1]!.y;
          await session.Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" }).catch(() => {});
          currentX = x;
          currentY = y;
          await new Promise((r) => setTimeout(r, 25));
        }
      } finally {
        _wanderActive = false;
      }
    })();
  }
}

async function wtClearThought(session: CDP.Client) {
  if (getConfigHeadless(getCachedConfig())) return;
  await sendToExtension(session, { type: "Weavetab_STATE", hud: { action: "" } }).catch(() => {});
}

export interface BurstProfile {
  groupSize: [number, number];
  interCharMin: number;
  interCharMax: number;
  interGroupMin: number;
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

const FAST_BIGRAMS = new Set([
  "th","he","in","er","an","re","on","at","en","nd","ti","es","or","te",
  "of","ed","is","it","al","ar","st","to","nt","ng","se","ha","as","ou",
  "io","le","ve","co","me","de","hi","ri","ro","ic","ne","ea","ra","ce",
]);

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
  targetSelector?: string,
  profileName?: "fast" | "normal" | "deliberate"
) {
  if (!rawText) return;

  const text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const resolvedProfile = profileName || "normal";

  if (getConfigHeadless(config)) {
    const lines = text.split("\n");
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
        await session.Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      }
    }
    return;
  }

  const p = BURST_PROFILES[resolvedProfile];
  let wordsSinceBreak = 0;
  let prevChar = "";

  if (currentX < 0 || currentY < 0) {
    await ensureInitialCursorPosition(session);
  }

  wtCursor(session, currentX, currentY, "typing");

  let currentGroupSize = Math.floor(Math.random() * (p.groupSize[1] - p.groupSize[0] + 1)) + p.groupSize[0];
  let charsTypedInGroup = 0;
  let groupBuffer = "";

  async function flushGroup() {
    if (!groupBuffer) return;
    await session.Input.insertText({ text: groupBuffer });
    groupBuffer = "";
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (char === "\n") {
      await flushGroup();
      await session.Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await session.Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      prevChar = char;
      charsTypedInGroup = 0;
      currentGroupSize = Math.floor(Math.random() * (p.groupSize[1] - p.groupSize[0] + 1)) + p.groupSize[0];
      await sleep(gaussianDelay(190, 65));
      continue;
    }

    const typoRate = typeof (config as any).typoRate === "number" ? (config as any).typoRate : 0;
    if (typoRate > 0 && Math.random() < typoRate && /[a-zA-Z]/.test(char)) {
      await flushGroup();
      const offset = Math.random() > 0.5 ? 1 : -1;
      const typoChar = String.fromCharCode(char.toLowerCase().charCodeAt(0) + offset);
      if (/[a-z]/.test(typoChar)) {
        await session.Input.dispatchKeyEvent({ type: "keyDown", text: typoChar });
        await session.Input.dispatchKeyEvent({ type: "keyUp" });
        await sleep(gaussianDelay(115, 38));
        await session.Input.dispatchKeyEvent({ type: "keyDown", key: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
        await session.Input.dispatchKeyEvent({ type: "keyUp", key: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
        await sleep(gaussianDelay(75, 22));
      }
    }

    groupBuffer += char;
    charsTypedInGroup++;

    let charDelay = Math.random() * (p.interCharMax - p.interCharMin) + p.interCharMin;
    const bigram = (prevChar + char).toLowerCase();
    if (FAST_BIGRAMS.has(bigram)) charDelay *= 0.62;

    if (char === " " || char === "\t") {
      await flushGroup();
      wordsSinceBreak++;
      await sleep(charDelay + (Math.random() * 50 + 20));

      if (text.length > 80 && wordsSinceBreak >= 12 && Math.random() < 0.20) {
        wtThought(session, "typing...");
        await sleep(380 + Math.random() * 520);
        wordsSinceBreak = 0;
      }
      prevChar = char;
      charsTypedInGroup = 0;
      currentGroupSize = Math.floor(Math.random() * (p.groupSize[1] - p.groupSize[0] + 1)) + p.groupSize[0];
      continue;
    }

    if (/[.,!?;:]/.test(char)) {
      await flushGroup();
      await sleep(charDelay + (Math.random() * 150 + 100));
      prevChar = char;
      charsTypedInGroup = 0;
      currentGroupSize = Math.floor(Math.random() * (p.groupSize[1] - p.groupSize[0] + 1)) + p.groupSize[0];
      continue;
    }

    if (charsTypedInGroup >= currentGroupSize) {
      await flushGroup();
      const groupPause = Math.random() * (p.interGroupMax - p.interGroupMin) + p.interGroupMin;
      await sleep(groupPause);
      charsTypedInGroup = 0;
      currentGroupSize = Math.floor(Math.random() * (p.groupSize[1] - p.groupSize[0] + 1)) + p.groupSize[0];
    } else {
      await sleep(charDelay);
    }

    if (targetSelector && i > 0 && i % 5 === 0) {
      const focusOk = await session.Runtime.evaluate({
        expression: `(function(sel) {
          try {
            const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
            if (!el) return true;
            if (document.activeElement === el || el.contains(document.activeElement)) return true;
            if (typeof el.focus === 'function') el.focus({ preventScroll: true });
            return false;
          } catch(e) { return true; }
        })(${JSON.stringify(targetSelector)})`,
        returnByValue: true,
      }).catch(() => ({ result: { value: true } }));
      if (focusOk?.result?.value === false) {
        await sleep(20);
        await flushGroup();
      }
    }

    prevChar = char;
  }

  await flushGroup();
  wtCursor(session, currentX, currentY, "idle");
  await sleep(180 + Math.random() * 280);
}

let currentX = -1;
let currentY = -1;

function cubicBezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
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
  _wanderActive = false;

  if (currentX < 0 || currentY < 0) {
    await ensureInitialCursorPosition(session);
  }

  const resolvedProfile = profile || (getConfigHeadless(config) ? "instant" : "human");

  if (resolvedProfile === "instant") {
    await session.Input.dispatchMouseEvent({ type: "mouseMoved", x: targetX, y: targetY, button: "none" });
    currentX = targetX;
    currentY = targetY;
    wtCursor(session, targetX, targetY, "hover", cursorOpts);
    await session.Runtime.evaluate({
      expression: `(function(){
        var el = document.elementFromPoint(${targetX}, ${targetY});
        if (el) {
          el.dispatchEvent(new MouseEvent('mouseover', {bubbles:true,cancelable:true,clientX:${targetX},clientY:${targetY}}));
          el.dispatchEvent(new MouseEvent('mouseenter', {bubbles:false,cancelable:true,clientX:${targetX},clientY:${targetY}}));
        }
      })()`,
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
    await session.Input.dispatchMouseEvent({ type: "mouseMoved", x: targetX, y: targetY, button: "none" });
    return;
  }

  if (!_firstMoveDone) {
    logDebug(`[Weavetab Ghost] First mouse move from (${currentX}, ${currentY}) -> (${targetX}, ${targetY})`);
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
    return;
  }

  wtCursor(session, currentX, currentY, label && distance >= 150 ? "searching" : "idle", cursorOpts);
  if (label && distance >= 150) {
    wtThought(session, `moving to ${label.slice(0, 40)}...`);
    await sleep(60 + Math.random() * 80);
  }

  const duration = Math.max(120, Math.min(380, 80 + Math.sqrt(distance) * 12));
  const steps = Math.max(8, Math.min(24, Math.floor(duration / 16)));
  const stepDelay = Math.max(10, Math.floor(duration / steps));

  const nx = -dy / distance;
  const ny = dx / distance;
  const maxArc = Math.min(45, distance * 0.15);
  const arcSign = Math.random() > 0.5 ? 1 : -1;
  const arcAmount = maxArc * arcSign * (0.4 + Math.random() * 0.6);

  const cp1X = currentX + dx * 0.3 + nx * arcAmount;
  const cp1Y = currentY + dy * 0.3 + ny * arcAmount;
  const cp2X = currentX + dx * 0.7 + nx * (arcAmount * 0.6);
  const cp2Y = currentY + dy * 0.7 + ny * (arcAmount * 0.6);

  const waypoints = [];
  for (let i = 1; i <= steps; i++) {
    const rawT = i / steps;
    const t = 1 - Math.pow(1 - rawT, 3);
    waypoints.push({
      x: Math.round(cubicBezier(t, currentX, cp1X, cp2X, targetX)),
      y: Math.round(cubicBezier(t, currentY, cp1Y, cp2Y, targetY)),
    });
  }

  if (!getConfigHeadless(config)) {
    sendToExtension(session, {
      type: "Weavetab_STATE",
      cursor: { waypoints, duration_ms: steps * stepDelay, x: currentX, y: currentY },
      state: "moving",
    }).catch(() => {});
  }

  for (let i = 1; i <= steps; i++) {
    const pt = waypoints[i - 1]!;
    await session.Input.dispatchMouseEvent({ type: "mouseMoved", x: pt.x, y: pt.y, button: "none" }).catch(() => {});
    currentX = pt.x;
    currentY = pt.y;
    await sleep(stepDelay);
  }

  currentX = targetX;
  currentY = targetY;
  wtCursor(session, targetX, targetY, "hover", cursorOpts);
  if (label) wtClearThought(session);
  await session.Input.dispatchMouseEvent({ type: "mouseMoved", x: targetX, y: targetY, button: "none" }).catch(() => {});

  await session.Runtime.evaluate({
    expression: `(function(){
      var el = document.elementFromPoint(${targetX}, ${targetY});
      if (el) {
        el.dispatchEvent(new MouseEvent('mouseover', {bubbles:true,cancelable:true,view:window,clientX:${targetX},clientY:${targetY}}));
        el.dispatchEvent(new MouseEvent('mouseenter', {bubbles:false,cancelable:true,view:window,clientX:${targetX},clientY:${targetY}}));
      }
    })()`,
  }).catch(() => {});
}

let readingPromise: Promise<void> | null = null;
let readingCancelled = false;
let readingGeneration = 0;

export function cancelReading(): void {
  readingCancelled = true;
  readingGeneration++;
  readingPromise = null;
}

export function startReadingSimulation(session: CDP.Client, wordCount: number, config: Config) {
  if (getConfigHeadless(config)) return;

  const readTimeMs = Math.min((wordCount / 200) * 60000, 3000);
  if (readTimeMs < 300) return;

  readingCancelled = false;
  const gen = ++readingGeneration;

  readingPromise = (async () => {
    const startTime = Date.now();
    let lastScrollTime = startTime;

    wtThought(session, "reading the page...");

    while (!readingCancelled && gen === readingGeneration && Date.now() - startTime < readTimeMs) {
      const now = Date.now();

      if (Math.random() < 0.1) {
        if (readingCancelled || gen !== readingGeneration) break;
        currentX += randomGaussian(0, 3);
        currentY += randomGaussian(0, 3);
        await session.Input.dispatchMouseEvent({ type: "mouseMoved", x: currentX, y: currentY, button: "none" }).catch(() => {});
        if (readingCancelled || gen !== readingGeneration) break;
        wtCursor(session, currentX, currentY, "reading");
      }

      if (now - lastScrollTime > 1500 && Math.random() < 0.5) {
        const totalScroll = randomGaussian(150, 50);
        const scrollSteps = Math.floor(totalScroll / 5);
        for (let i = 0; i < scrollSteps; i++) {
          if (readingCancelled || gen !== readingGeneration) break;
          await session.Input.dispatchMouseEvent({
            type: "mouseWheel",
            x: currentX,
            y: currentY,
            deltaX: 0,
            deltaY: 5,
          }).catch(() => {});
          await sleep(16);
        }
        lastScrollTime = Date.now();
      }

      await sleep(100);
    }
    if (gen === readingGeneration) {
      readingPromise = null;
      wtClearThought(session);
    }
  })();
}

export async function waitForReading() {
  cancelReading();
}

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

export async function ghostClick(session: CDP.Client, x: number, y: number, options?: any) {
  await session.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: options?.clickCount || 1, ...options });

  if (!getConfigHeadless(getCachedConfig())) {
    sendToExtension(session, {
      type: "Weavetab_STATE",
      ripple: { x, y },
      state: "clicking",
    }).catch(() => {});
  }
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

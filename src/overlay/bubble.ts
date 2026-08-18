// src/overlay/bubble.ts
// Phase 3.7.3: Thought bubble — categorized progress, step tracking, time estimates.
// Sends structured messages to content.js via sendToExtension.

import CDP from "chrome-remote-interface";
import { sendToExtension } from "../cdp/helpers.js";

export type ThoughtCategory = "planning" | "acting" | "verifying" | "done" | "error";

export interface BubbleOptions {
  text: string;
  category?: ThoughtCategory;
  step?: number;
  stepTotal?: number;
  estimatedMs?: number;
  icon?: string;
}

export async function showBubble(
  session: CDP.Client,
  icon: string,
  text: string,
  durationMs?: number,
  opts?: Partial<BubbleOptions>
): Promise<void> {
  const payload: Record<string, unknown> = {
    type: 'Weavetab_THOUGHT',
    text,
    icon,
    active: true,
  };
  if (opts?.category) payload.category = opts.category;
  if (opts?.step !== undefined) payload.step = opts.step;
  if (opts?.stepTotal !== undefined) payload.stepTotal = opts.stepTotal;
  if (opts?.estimatedMs !== undefined) payload.estimatedMs = opts.estimatedMs;
  await sendToExtension(session, payload).catch(() => {});
}

export async function showProgress(
  session: CDP.Client,
  text: string,
  step: number,
  stepTotal: number,
  category: ThoughtCategory = "acting",
  estimatedMs?: number
): Promise<void> {
  await showBubble(session, "→", text, undefined, {
    category,
    step,
    stepTotal,
    estimatedMs,
  });
}

export async function hideBubble(session: CDP.Client): Promise<void> {
  await sendToExtension(session, {
    type: 'Weavetab_CLEAR_THOUGHT',
  }).catch(() => {});
}

export async function injectBubbleScripts(_session: CDP.Client): Promise<void> {}
export async function openOverlayTab(_session: CDP.Client): Promise<void> {}
export function startBubbleProcess(_humanMode?: boolean): void {}

import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — anticaptcha/integration.ts
 * Integration layer: auto-detects and solves CAPTCHAs during tool operations.
 * Falls back to clear user instructions only when all automated approaches fail.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import { detectCaptcha, isCaptchaBlocking, quickCaptchaCheck, type CaptchaDetection } from "./detector.js";
import { solveCaptcha, type CaptchaSolution } from "./solver.js";
import { sendToExtension } from "../cdp/helpers.js";

export interface CaptchaIntervention {
  detected: boolean;
  detection?: CaptchaDetection;
  solution?: CaptchaSolution;
  actionTaken: "auto_solved" | "user_guided" | "not_blocking" | "failed" | "none";
  /** Human-readable message to surface to the agent */
  userMessage?: string;
  /** True only when all automated approaches have failed AND user must act */
  human_needed: boolean;
}

/**
 * Main entry point. Call this when a tool suspects CAPTCHA interference.
 * Always attempts automated solving first. Only sets human_needed:true as last resort.
 */
export async function handleCaptchaIntervention(
  session: CDP.Client,
  context: "navigation" | "click" | "form_submit" | "general"
): Promise<CaptchaIntervention> {
  try {
    const detection = await detectCaptcha(session);

    if (!detection.detected) {
      return { detected: false, actionTaken: "none", human_needed: false };
    }

    logDebug(`[Weavetab AntiCaptcha] Detected: ${detection.type} (${detection.interactionType}, conf=${detection.confidence.toFixed(2)})`);

    // Invisible CAPTCHAs don't block — just note it
    if (detection.interactionType === "none") {
      await notify(session, `Auto-handling ${detection.type}…`);
      const solution = await solveCaptcha(session, detection);
      return {
        detected: true,
        detection,
        solution,
        actionTaken: "auto_solved",
        human_needed: false,
        userMessage: `Invisible CAPTCHA (${detection.type}) handled automatically.`,
      };
    }

    const isBlocking = await isCaptchaBlocking(session);
    if (!isBlocking) {
      return {
        detected: true,
        detection,
        actionTaken: "not_blocking",
        human_needed: false,
        userMessage: `${detection.type} CAPTCHA present but not blocking the current action.`,
      };
    }

    // Attempt automated solve
    await notify(session, `Solving ${detection.type} (${detection.interactionType})…`);
    const solution = await solveCaptcha(session, detection);

    if (solution.solved) {
      await notify(session, `✓ CAPTCHA solved`);
      logDebug(`[Weavetab AntiCaptcha] Solved via ${solution.method} (conf=${solution.confidence})`);
      return {
        detected: true,
        detection,
        solution,
        actionTaken: "auto_solved",
        human_needed: false,
        userMessage: `CAPTCHA solved automatically (${solution.method}).`,
      };
    }

    // Automated solve failed
    if (solution.requiresUserIntervention) {
      await notify(session, `CAPTCHA needs you`);
      logDebug(`[Weavetab AntiCaptcha] Needs user: ${solution.userInstructions}`);
      return {
        detected: true,
        detection,
        solution,
        actionTaken: "user_guided",
        human_needed: true,
        userMessage: `⚠ CAPTCHA requires your input: ${solution.userInstructions}`,
      };
    }

    return {
      detected: true,
      detection,
      solution,
      actionTaken: "failed",
      human_needed: true,
      userMessage: `CAPTCHA solving failed. ${solution.userInstructions || "Please solve it manually."}`,
    };

  } catch (error) {
    logDebug("[Weavetab AntiCaptcha] Intervention error:", error);
    return {
      detected: false,
      actionTaken: "failed",
      human_needed: false,
    };
  }
}

/**
 * Lightweight pre-check before performing an action.
 * Returns true if a CAPTCHA is present and needs solving before proceeding.
 */
export async function shouldPauseFoCaptcha(session: CDP.Client): Promise<boolean> {
  try {
    const quick = await quickCaptchaCheck(session);
    if (!quick) return false;
    return await isCaptchaBlocking(session);
  } catch {
    return false;
  }
}

async function notify(session: CDP.Client, msg: string): Promise<void> {
  await sendToExtension(session, {
    type: "Weavetab_STATE",
    hud: { action: msg },
  }).catch(() => {});
}

/**
 * CAPTCHA-aware navigation wrapper.
 */
export async function navigateWithCaptchaHandling(
  session: CDP.Client,
  navigateFn: () => Promise<void>
): Promise<{ success: boolean; captchaIntervention?: CaptchaIntervention }> {
  try {
    await navigateFn();
    await new Promise((r) => setTimeout(r, 1500));

    const post = await handleCaptchaIntervention(session, "navigation");
    if (post.human_needed) {
      return { success: false, captchaIntervention: post };
    }
    return { success: true, captchaIntervention: post };
  } catch (err) {
    logDebug("[Weavetab AntiCaptcha] navigateWithCaptchaHandling error:", err);
    return { success: false };
  }
}
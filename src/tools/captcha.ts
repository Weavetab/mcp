/**
 * Weavetab — tools/captcha.ts
 * Dedicated browser_captcha tool for autonomous CAPTCHA detection and solving.
 *
 * Actions:
 *   detect        → Identify CAPTCHA type, interaction method, and confidence
 *   solve         → Attempt full autonomous solve (slider drag, hold, checkbox, invisible)
 *   wait_for_user → Show HUD prompt and poll until CAPTCHA is gone (120s timeout)
 *   status        → Quick check: is a CAPTCHA currently blocking?
 *
 * Zero API keys. All solving via CDP mouse simulation.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import { detectCaptcha, quickCaptchaCheck, isCaptchaBlocking } from "../anticaptcha/detector.js";
import { solveCaptcha } from "../anticaptcha/solver.js";
import { sendToExtension } from "../cdp/helpers.js";
import { logAction } from "../audit/logger.js";
import type { Config } from "../config/loader.js";

export interface CaptchaToolResult {
  success: boolean;
  action: string;
  captcha_detected: boolean;
  captcha_type?: string;
  interaction_type?: string;
  difficulty?: string;
  confidence?: number;
  /** True only when human input is truly required after all automated attempts */
  human_needed: boolean;
  solved?: boolean;
  solve_method?: string;
  message: string;
  /** Specific instructions for the user when human_needed is true */
  user_instructions?: string;
  /** What the agent should do next */
  next_action?: string;
  execution_ms: number;
}

export async function browserCaptcha(
  session: CDP.Client,
  args: {
    action: "detect" | "solve" | "wait_for_user" | "status";
    timeout?: number;
  },
  _config: Config
): Promise<CaptchaToolResult> {
  const t0 = Date.now();
  const { action, timeout = 120000 } = args;

  try {
    switch (action) {
      // ── detect ─────────────────────────────────────────────────────────────
      case "detect": {
        const detection = await detectCaptcha(session);

        logAction("browser_captcha", "detect", detection.type);

        if (!detection.detected) {
          return {
            success: true,
            action: "detect",
            captcha_detected: false,
            human_needed: false,
            message: "No CAPTCHA detected on this page.",
            next_action: "Continue with your task.",
            execution_ms: Date.now() - t0,
          };
        }

        return {
          success: true,
          action: "detect",
          captcha_detected: true,
          captcha_type: detection.type,
          interaction_type: detection.interactionType,
          difficulty: detection.difficulty,
          confidence: detection.confidence,
          human_needed: false,
          message: `CAPTCHA detected: ${detection.type} (${detection.interactionType}, ${Math.round(detection.confidence * 100)}% confidence)`,
          next_action: `Call browser_captcha({ action: "solve" }) to attempt automated solving.`,
          execution_ms: Date.now() - t0,
        };
      }

      // ── solve ───────────────────────────────────────────────────────────────
      case "solve": {
        const detection = await detectCaptcha(session);

        if (!detection.detected) {
          return {
            success: true,
            action: "solve",
            captcha_detected: false,
            human_needed: false,
            message: "No CAPTCHA found — nothing to solve.",
            next_action: "Continue with your task.",
            execution_ms: Date.now() - t0,
          };
        }

        await sendToExtension(session, {
          type: "Weavetab_STATE",
          hud: { action: `Solving ${detection.type} (${detection.interactionType})…` },
        }).catch(() => {});

        logAction("browser_captcha", "solve", `${detection.type}/${detection.interactionType}`);

        const solution = await solveCaptcha(session, detection);

        if (solution.solved) {
          await sendToExtension(session, {
            type: "Weavetab_STATE",
            hud: { action: `✓ CAPTCHA solved` },
          }).catch(() => {});

          return {
            success: true,
            action: "solve",
            captcha_detected: true,
            captcha_type: detection.type,
            interaction_type: detection.interactionType,
            confidence: solution.confidence,
            human_needed: false,
            solved: true,
            solve_method: solution.method,
            message: `CAPTCHA solved automatically using ${solution.method}.`,
            next_action: "Continue with your task. Wait ~500ms for page to settle if needed.",
            execution_ms: Date.now() - t0,
          };
        }

        // Automated failed — should user be notified?
        if (solution.requiresUserIntervention) {
          const isVisionAssisted = solution.method === "vision_assisted";

          await sendToExtension(session, {
            type: "Weavetab_STATE",
            hud: { action: isVisionAssisted ? `AI Vision required` : `CAPTCHA needs you` },
          }).catch(() => {});

          return {
            success: false,
            action: "solve",
            captcha_detected: true,
            captcha_type: detection.type,
            interaction_type: detection.interactionType,
            human_needed: !isVisionAssisted,
            solved: false,
            solve_method: solution.method,
            message: isVisionAssisted
              ? "Automated DOM solve skipped. This CAPTCHA requires your visual intelligence to solve."
              : "Automated solve attempted but CAPTCHA requires human interaction.",
            user_instructions: solution.userInstructions,
            next_action: isVisionAssisted
              ? "Take a screenshot to view the CAPTCHA, then use browser_click or browser_type to solve it yourself. Do not ask the user for help."
              : `Call browser_thought({ action: "question", message: "${solution.userInstructions}" }) to ask the user to complete it, then call browser_captcha({ action: "wait_for_user" }).`,
            execution_ms: Date.now() - t0,
          };
        }

        return {
          success: false,
          action: "solve",
          captcha_detected: true,
          captcha_type: detection.type,
          human_needed: false,
          solved: false,
          message: "Automated solve failed. Retry or call wait_for_user.",
          next_action: `Retry browser_captcha({ action: "solve" }) once, then escalate to browser_captcha({ action: "wait_for_user" }).`,
          execution_ms: Date.now() - t0,
        };
      }

      // ── wait_for_user ───────────────────────────────────────────────────────
      case "wait_for_user": {
        await sendToExtension(session, {
          type: "Weavetab_STATE",
          hud: { action: "⏳ Waiting for CAPTCHA to be solved…" },
        }).catch(() => {});

        logAction("browser_captcha", "wait_for_user", "polling");

        const pollInterval = 1500;
        const maxPolls = Math.floor(timeout / pollInterval);
        let elapsed = 0;

        for (let i = 0; i < maxPolls; i++) {
          await new Promise((r) => setTimeout(r, pollInterval));
          elapsed += pollInterval;

          const stillBlocking = await quickCaptchaCheck(session);
          if (!stillBlocking) {
            await sendToExtension(session, {
              type: "Weavetab_STATE",
              hud: { action: "✓ CAPTCHA cleared" },
            }).catch(() => {});

            return {
              success: true,
              action: "wait_for_user",
              captcha_detected: false,
              human_needed: false,
              solved: true,
              message: `CAPTCHA cleared after ${Math.round(elapsed / 1000)}s.`,
              next_action: "Continue with your task.",
              execution_ms: Date.now() - t0,
            };
          }
        }

        return {
          success: false,
          action: "wait_for_user",
          captcha_detected: true,
          human_needed: true,
          solved: false,
          message: `CAPTCHA still present after ${Math.round(timeout / 1000)}s wait.`,
          user_instructions: "The CAPTCHA was not completed in time. Please solve it and let me know.",
          next_action: "Ask the user to complete the CAPTCHA, then retry.",
          execution_ms: Date.now() - t0,
        };
      }

      // ── status ──────────────────────────────────────────────────────────────
      case "status": {
        const blocking = await isCaptchaBlocking(session);
        return {
          success: true,
          action: "status",
          captcha_detected: blocking,
          human_needed: false,
          message: blocking ? "CAPTCHA is currently blocking the page." : "No blocking CAPTCHA.",
          next_action: blocking
            ? `Call browser_captcha({ action: "solve" }) to attempt automated solving.`
            : "Continue with your task.",
          execution_ms: Date.now() - t0,
        };
      }

      default:
        return {
          success: false,
          action: action,
          captcha_detected: false,
          human_needed: false,
          message: `Unknown action: ${action}. Use detect, solve, wait_for_user, or status.`,
          execution_ms: Date.now() - t0,
        };
    }
  } catch (err) {
    return {
      success: false,
      action,
      captcha_detected: false,
      human_needed: false,
      message: `browser_captcha error: ${err instanceof Error ? err.message : String(err)}`,
      execution_ms: Date.now() - t0,
    };
  }
}

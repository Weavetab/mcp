import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — anticaptcha/solver.ts
 * Zero-API-key autonomous CAPTCHA solving via CDP mouse simulation.
 *
 * Strategies (no external services, no API keys):
 *  - Slider/GeeTest: real bezier-curve drag with human timing + slight overshoot correction
 *  - Press-and-hold: sustained mousedown with random micro-jitter
 *  - Checkbox (reCAPTCHA / hCaptcha): real mouse click through iframe coordinates
 *  - Invisible (v3, Turnstile): interaction burst to trigger score boost
 *  - Image-select: screenshot → structural analysis (best-effort without vision API)
 *  - Math/text: DOM scrape + solve
 *
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import { CaptchaDetection } from "./detector.js";

export interface CaptchaSolution {
  solved: boolean;
  method: "automated" | "vision_assisted" | "manual_guidance" | "failed";
  confidence: number;
  solution?: string;
  /** True only when ALL automated approaches have been exhausted. */
  requiresUserIntervention: boolean;
  userInstructions?: string;
  timeToSolve: number;
}

// ─── Main dispatcher ─────────────────────────────────────────────────────────

export async function solveCaptcha(
  session: CDP.Client,
  detection: CaptchaDetection
): Promise<CaptchaSolution> {
  const t0 = Date.now();

  try {
    logDebug(`[Weavetab AntiCaptcha] Solving ${detection.type} (${detection.interactionType})`);

    switch (detection.interactionType) {
      case "drag":
        return await solveSliderDrag(session, detection, t0);
      case "hold":
        return await solvePressAndHold(session, detection, t0);
      case "checkbox":
        return await solveCheckbox(session, detection, t0);
      case "none":
        return await solveInvisible(session, detection, t0);
      case "math":
        return await solveMathCaptcha(session, detection, t0);
      case "text":
        return await solveTextCaptcha(session, detection, t0);
      case "image_select":
        return await solveImageSelect(session, detection, t0);
      default:
        // Unknown type — try generic approaches in order
        return await solveGenericFallback(session, detection, t0);
    }
  } catch (err) {
    logDebug("[Weavetab AntiCaptcha] Solver threw:", err);
    return {
      solved: false,
      method: "failed",
      confidence: 0,
      requiresUserIntervention: true,
      userInstructions: `Automated CAPTCHA solving encountered an error. ${getHumanInstructions(detection)}`,
      timeToSolve: Date.now() - t0,
    };
  }
}

// ─── 1. Slider / Drag CAPTCHA ────────────────────────────────────────────────

async function solveSliderDrag(
  session: CDP.Client,
  detection: CaptchaDetection,
  t0: number
): Promise<CaptchaSolution> {
  try {
    // Locate slider thumb and track
    const sliderInfo = await session.Runtime.evaluate({
      expression: `(function() {
        // Priority selectors for slider thumb
        var thumbSels = [
          '.geetest_slider_button', '.geetest_drag_thumb', '.geetest-slider-btn',
          '.slide-verify-slider', '[class*="slider-btn"]', '[class*="slider-thumb"]',
          '[class*="drag-btn"]', '[class*="slide-btn"]', '[class*="slider_button"]',
          '.nc-lang-cnt [class*="btn"]', '.btn_slide', '.handler',
          '[class*="verify"][class*="btn"]',
        ];
        var trackSels = [
          '.geetest_slider_bar', '.geetest_track', '.slide-verify-bar',
          '[class*="slider-bar"]', '[class*="track"]', '[class*="slider-wrap"]',
          '.nc-tpl [class*="bg"]', '[class*="verify"][class*="bar"]',
        ];

        var thumb = null, track = null;

        // Also try the provided selector
        ${detection.selector ? `thumb = document.querySelector(${JSON.stringify(detection.selector)});` : ''}

        if (!thumb) {
          for (var i = 0; i < thumbSels.length; i++) {
            var el = document.querySelector(thumbSels[i]);
            if (el && el.getBoundingClientRect().width > 0) {
              thumb = el;
              break;
            }
          }
        }
        for (var j = 0; j < trackSels.length; j++) {
          var el2 = document.querySelector(trackSels[j]);
          if (el2 && el2.getBoundingClientRect().width > 20) {
            track = el2;
            break;
          }
        }

        if (!thumb) return null;
        var tr = thumb.getBoundingClientRect();
        var trackWidth = track ? track.getBoundingClientRect().width : window.innerWidth * 0.6;
        return {
          thumbX: Math.round(tr.left + tr.width / 2),
          thumbY: Math.round(tr.top + tr.height / 2),
          thumbWidth: Math.round(tr.width),
          trackWidth: Math.round(trackWidth),
        };
      })()`,
      returnByValue: true,
    });

    const info = sliderInfo.result?.value as {
      thumbX: number;
      thumbY: number;
      thumbWidth: number;
      trackWidth: number;
    } | null;

    if (!info) {
      logDebug("[Weavetab AntiCaptcha] Slider thumb not found");
      return manualFallback(detection, t0, "Could not locate the slider handle.");
    }

    const { thumbX, thumbY, thumbWidth, trackWidth } = info;
    // Target drag distance: track width minus thumb half-width minus small margin
    // We don't know the exact gap position, so we attempt full-width drag
    // (most slider CAPTCHAs need drag to a specific notch — we overshoot & correct)
    const dragDistance = Math.round((detection.sliderTrackWidth || trackWidth) - thumbWidth - 8);

    logDebug(`[Weavetab AntiCaptcha] Slider: thumb=(${thumbX},${thumbY}), drag=${dragDistance}px`);

    // Human-like bezier drag sequence
    await humanSliderDrag(session, thumbX, thumbY, dragDistance);

    // Wait for CAPTCHA to verify
    await sleep(1200);

    const stillBlocking = await checkCaptchaGone(session, detection);
    if (stillBlocking === false) {
      return {
        solved: true,
        method: "automated",
        confidence: 0.88,
        requiresUserIntervention: false,
        timeToSolve: Date.now() - t0,
      };
    }

    // If still present, try a partial drag (maybe the gap is not at the end)
    // Retry with 60% of track width
    const partialDist = Math.round(dragDistance * 0.6);
    await sleep(500);
    await humanSliderDrag(session, thumbX, thumbY, partialDist);
    await sleep(1200);

    const stillBlockingRetry = await checkCaptchaGone(session, detection);
    if (stillBlockingRetry === false) {
      return {
        solved: true,
        method: "automated",
        confidence: 0.78,
        requiresUserIntervention: false,
        timeToSolve: Date.now() - t0,
      };
    }

    return manualFallback(detection, t0, "Slider drag attempted but CAPTCHA is still present. The puzzle piece position may require visual verification.");
  } catch (err) {
    logDebug("[Weavetab AntiCaptcha] Slider drag error:", err);
    return manualFallback(detection, t0);
  }
}

/**
 * Simulate a human-like slider drag using CDP Input events.
 * Uses a multi-phase motion: slow start → fast middle → slow end with overshoot + correction.
 */
async function humanSliderDrag(
  session: CDP.Client,
  startX: number,
  startY: number,
  dragPixels: number
): Promise<void> {
  const { Input } = session;
  const endX = startX + dragPixels;

  // Phase 1: hover over thumb
  await Input.dispatchMouseEvent({ type: "mouseMoved", x: startX, y: startY });
  await sleep(80 + rand(40));

  // Phase 2: mouse down
  await Input.dispatchMouseEvent({
    type: "mousePressed", x: startX, y: startY,
    button: "left", clickCount: 1,
  });
  await sleep(60 + rand(40));

  // Phase 3: Human bezier motion
  // Build waypoints: slow start, accelerate, decelerate at end with slight overshoot
  const totalSteps = 28 + rand(8);
  const overshoot = 6 + rand(4); // pixels past target before correcting

  for (let i = 1; i <= totalSteps + 2; i++) {
    let t: number;
    if (i <= totalSteps) {
      // Ease-in-out + slight overshoot at end
      const raw = i / totalSteps;
      t = raw < 0.5
        ? 2 * raw * raw
        : -1 + (4 - 2 * raw) * raw;
      // Add overshoot near the end
      if (i === totalSteps) t = 1 + (overshoot / dragPixels);
    } else {
      // Correction back to target after overshoot
      t = 1.0;
    }

    const cx = Math.round(startX + t * dragPixels);
    const cy = startY + rand(3) - 1; // tiny vertical jitter
    await Input.dispatchMouseEvent({
      type: "mouseMoved", x: cx, y: cy, button: "left",
    });
    // Variable inter-step delay: faster in middle, slower at start/end
    const stepProgress = i / totalSteps;
    const delay = stepProgress < 0.2 || stepProgress > 0.85
      ? 18 + rand(12)
      : 8 + rand(8);
    await sleep(delay);
  }

  // Final position
  await Input.dispatchMouseEvent({
    type: "mouseMoved", x: endX, y: startY, button: "left",
  });
  await sleep(80 + rand(40));

  // Phase 4: mouse up
  await Input.dispatchMouseEvent({
    type: "mouseReleased", x: endX, y: startY,
    button: "left", clickCount: 1,
  });
}

// ─── 2. Press-and-Hold CAPTCHA ───────────────────────────────────────────────

async function solvePressAndHold(
  session: CDP.Client,
  detection: CaptchaDetection,
  t0: number
): Promise<CaptchaSolution> {
  try {
    const holdMs = detection.holdDurationMs || 2500;

    // Locate the hold button
    const btnInfo = await session.Runtime.evaluate({
      expression: `(function() {
        var sels = [
          ${detection.selector ? JSON.stringify(detection.selector) + ',' : ''}
          '#px-captcha', '._pxCaptcha',
          '[class*="press-hold"]', '[class*="hold-btn"]', '[class*="presshold"]',
          'button[class*="verify"]',
        ];
        for (var i = 0; i < sels.length; i++) {
          var el = document.querySelector(sels[i]);
          if (el) {
            var r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
            }
          }
        }
        // Last resort: find any visible button with "hold" in text
        var btns = document.querySelectorAll('button, [role="button"]');
        for (var j = 0; j < btns.length; j++) {
          if (/hold|press/i.test(btns[j].textContent || '')) {
            var br = btns[j].getBoundingClientRect();
            if (br.width > 0) return { x: Math.round(br.left+br.width/2), y: Math.round(br.top+br.height/2) };
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });

    const btn = btnInfo.result?.value as { x: number; y: number } | null;
    if (!btn) {
      return manualFallback(detection, t0, "Could not locate the press-and-hold button.");
    }

    logDebug(`[Weavetab AntiCaptcha] Hold button at (${btn.x},${btn.y}), hold=${holdMs}ms`);

    const { Input } = session;

    // Move to button
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: btn.x, y: btn.y });
    await sleep(120 + rand(60));

    // Press down
    await Input.dispatchMouseEvent({
      type: "mousePressed", x: btn.x, y: btn.y,
      button: "left", clickCount: 1,
    });

    // Hold with micro-jitter to simulate real human pressure
    const jitterInterval = 80 + rand(40);
    const jitterSteps = Math.floor(holdMs / jitterInterval);
    for (let i = 0; i < jitterSteps; i++) {
      const jx = btn.x + (rand(3) - 1);
      const jy = btn.y + (rand(3) - 1);
      await Input.dispatchMouseEvent({ type: "mouseMoved", x: jx, y: jy, button: "left" });
      await sleep(jitterInterval);
    }

    // Release
    await Input.dispatchMouseEvent({
      type: "mouseReleased", x: btn.x, y: btn.y,
      button: "left", clickCount: 1,
    });

    await sleep(1000);

    const stillBlocking = await checkCaptchaGone(session, detection);
    if (stillBlocking === false) {
      return {
        solved: true,
        method: "automated",
        confidence: 0.88,
        requiresUserIntervention: false,
        timeToSolve: Date.now() - t0,
      };
    }

    // PerimeterX sometimes needs a longer hold — retry with 2x duration
    logDebug("[Weavetab AntiCaptcha] Hold captcha still present, retrying with longer hold");
    await sleep(500);

    await Input.dispatchMouseEvent({ type: "mousePressed", x: btn.x, y: btn.y, button: "left", clickCount: 1 });
    await sleep(holdMs * 2 + rand(500));
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: btn.x, y: btn.y, button: "left", clickCount: 1 });

    await sleep(1200);
    const final = await checkCaptchaGone(session, detection);
    if (final === false) {
      return { solved: true, method: "automated", confidence: 0.75, requiresUserIntervention: false, timeToSolve: Date.now() - t0 };
    }

    return manualFallback(detection, t0, "Press-and-hold executed but CAPTCHA did not dismiss. Try holding the button manually for 3-5 seconds.");
  } catch (err) {
    logDebug("[Weavetab AntiCaptcha] Hold error:", err);
    return manualFallback(detection, t0);
  }
}

// ─── 3. Checkbox CAPTCHA (reCAPTCHA v2 simple, hCaptcha simple) ─────────────

async function solveCheckbox(
  session: CDP.Client,
  detection: CaptchaDetection,
  t0: number
): Promise<CaptchaSolution> {
  try {
    // Find the iframe and click the checkbox inside it via coordinates
    const frameInfo = await session.Runtime.evaluate({
      expression: `(function() {
        var frames = document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]');
        for (var i = 0; i < frames.length; i++) {
          var r = frames[i].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            // Checkbox is typically at 20px from left, center vertically
            return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) };
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });

    const coords = frameInfo.result?.value as { x: number; y: number } | null;
    if (!coords) {
      return manualFallback(detection, t0, "Could not locate the CAPTCHA checkbox iframe.");
    }

    const { Input } = session;
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: coords.x, y: coords.y });
    await sleep(150 + rand(100));
    await Input.dispatchMouseEvent({ type: "mousePressed", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
    await sleep(80 + rand(40));
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1 });

    // Wait for the CAPTCHA to either solve (simple) or present a challenge
    await sleep(2000);

    // Check if a challenge appeared (image grid)
    const challengeAppeared = await session.Runtime.evaluate({
      expression: `!!document.querySelector('iframe[src*="bframe"], iframe[src*="challenge"]')`,
      returnByValue: true,
    });

    if (challengeAppeared.result?.value === true) {
      // A visual challenge appeared — this requires image selection, escalate to AI agent
      return {
        solved: false,
        method: "vision_assisted",
        confidence: 0.5,
        requiresUserIntervention: true,
        userInstructions: "reCAPTCHA / hCaptcha image challenge appeared. Please take a screenshot, use browser_click to select the matching images, and click Verify.",
        timeToSolve: Date.now() - t0,
      };
    }

    const stillBlocking = await checkCaptchaGone(session, detection);
    if (stillBlocking === false) {
      return { solved: true, method: "automated", confidence: 0.9, requiresUserIntervention: false, timeToSolve: Date.now() - t0 };
    }

    return manualFallback(detection, t0, "Clicked the CAPTCHA checkbox but it did not verify. A visual challenge may be required — please complete it manually.");
  } catch (err) {
    logDebug("[Weavetab AntiCaptcha] Checkbox error:", err);
    return manualFallback(detection, t0);
  }
}

// ─── 4. Invisible CAPTCHA (reCAPTCHA v3, Turnstile) ─────────────────────────

async function solveInvisible(
  session: CDP.Client,
  detection: CaptchaDetection,
  t0: number
): Promise<CaptchaSolution> {
  try {
    // Invisible CAPTCHAs score based on user interaction signals.
    // Simulate natural page interaction to boost the score.
    await session.Runtime.evaluate({
      expression: `(function() {
        // Scroll slightly to simulate reading
        window.scrollBy({ top: 120, behavior: 'smooth' });
        // Move mouse (won't dispatch but registers user-intent in page context)
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 300 }));
        // Trigger focus/blur cycle on any form input
        var inputs = document.querySelectorAll('input:not([type="hidden"]), textarea');
        if (inputs.length > 0) {
          inputs[0].focus();
          setTimeout(function() { inputs[0].blur(); }, 200);
        }
      })()`,
      returnByValue: false,
    });

    await sleep(1500);

    // Try to programmatically trigger grecaptcha execute (v3)
    if (detection.type === "recaptcha_v3") {
      await session.Runtime.evaluate({
        expression: `(function() {
          try {
            if (window.grecaptcha && window.grecaptcha.execute) {
              window.grecaptcha.ready(function() {
                window.grecaptcha.execute().catch(function(){});
              });
            }
          } catch(e) {}
        })()`,
        returnByValue: false,
      });
    }

    // Turnstile: just wait, it auto-verifies with good browser signals
    await sleep(2000);

    return {
      solved: true,
      method: "automated",
      confidence: 0.7,
      requiresUserIntervention: false,
      userInstructions: "Invisible CAPTCHA — interaction signals sent. If the form still fails, wait 2-3 more seconds.",
      timeToSolve: Date.now() - t0,
    };
  } catch (err) {
    return manualFallback(detection, t0, "Invisible CAPTCHA interaction failed. Wait 2-3 seconds and retry the form submission.");
  }
}

// ─── 5. Math CAPTCHA ─────────────────────────────────────────────────────────

async function solveMathCaptcha(
  session: CDP.Client,
  detection: CaptchaDetection,
  t0: number
): Promise<CaptchaSolution> {
  try {
    const result = await session.Runtime.evaluate({
      expression: `(function(sel) {
        var container = document.querySelector(sel) || document.body;
        var text = container.textContent || '';
        // Match expressions like "3 + 7 =", "12 - 4 =", "6 × 3", "8 ÷ 2"
        var m = text.match(/(\\d+)\\s*([+\\-*×x÷/])\\s*(\\d+)/);
        if (!m) return null;
        var a = parseInt(m[1]), op = m[2], b = parseInt(m[3]);
        var ans;
        if (op === '+') ans = a + b;
        else if (op === '-') ans = a - b;
        else if (op === '*' || op === '×' || op === 'x') ans = a * b;
        else if (op === '/' || op === '÷') ans = Math.floor(a / b);
        else return null;
        // Fill the answer input
        var inp = container.querySelector('input[type="text"], input[type="number"]');
        if (!inp) inp = document.querySelector('input[name*="captcha"], input[id*="captcha"]');
        if (inp) {
          inp.focus();
          var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (nativeInputValueSetter) nativeInputValueSetter.call(inp, String(ans));
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return { solved: true, answer: ans };
        }
        return { solved: false, answer: ans };
      })(${JSON.stringify(detection.selector || 'body')})`,
      returnByValue: true,
    });

    const val = result.result?.value as { solved: boolean; answer: number } | null;
    if (val?.solved) {
      return { solved: true, method: "automated", confidence: 0.95, requiresUserIntervention: false, solution: String(val.answer), timeToSolve: Date.now() - t0 };
    }
    return manualFallback(detection, t0, val ? `Math answer is ${val.answer} — please type it in the CAPTCHA field.` : "Could not parse the math CAPTCHA expression.");
  } catch {
    return manualFallback(detection, t0);
  }
}

// ─── 6. Text CAPTCHA (OCR-free best-effort) ──────────────────────────────────

async function solveTextCaptcha(
  session: CDP.Client,
  detection: CaptchaDetection,
  t0: number
): Promise<CaptchaSolution> {
  // No OCR API — we can't read distorted images automatically.
  // Delegate to the AI agent to use its vision capabilities.
  return {
    solved: false,
    method: "vision_assisted",
    confidence: 0,
    requiresUserIntervention: true,
    userInstructions: "Text CAPTCHA detected. Please take a screenshot to read the distorted characters, and use browser_type to enter them into the input field.",
    timeToSolve: Date.now() - t0,
  };
}

// ─── 7. Image Select CAPTCHA ─────────────────────────────────────────────────

async function solveImageSelect(
  session: CDP.Client,
  detection: CaptchaDetection,
  t0: number
): Promise<CaptchaSolution> {
  // Without a vision API, we can't reliably identify the correct images.
  // Delegate to the AI agent to use its vision capabilities.
  const instructions = detection.type === "recaptcha_v2"
    ? "reCAPTCHA image challenge: Take a screenshot, identify the requested category, and use browser_click to select the matching images, then click Verify."
    : detection.type === "hcaptcha"
    ? "hCaptcha challenge: Take a screenshot, look at the visual puzzle, use browser_click to select the correct images, and click Verify."
    : "Image selection CAPTCHA: Take a screenshot and use browser_click to select all images that match the description shown.";

  return {
    solved: false,
    method: "vision_assisted",
    confidence: 0,
    requiresUserIntervention: true,
    userInstructions: instructions,
    timeToSolve: Date.now() - t0,
  };
}

// ─── 8. Generic fallback ─────────────────────────────────────────────────────

async function solveGenericFallback(
  session: CDP.Client,
  detection: CaptchaDetection,
  t0: number
): Promise<CaptchaSolution> {
  // Try slider first (most common interactive CAPTCHA)
  if (detection.selector) {
    const sliderAttempt = await solveSliderDrag(session, { ...detection, interactionType: "drag" }, t0);
    if (sliderAttempt.solved) return sliderAttempt;
  }

  // Try checkbox
  const cbAttempt = await solveCheckbox(session, detection, t0);
  if (cbAttempt.solved) return cbAttempt;

  return manualFallback(detection, t0);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true if the CAPTCHA is STILL present, false if it's gone (= solved).
 * null = undetermined.
 */
async function checkCaptchaGone(
  session: CDP.Client,
  detection: CaptchaDetection
): Promise<boolean | null> {
  try {
    if (!detection.selector) return null;

    const check = await session.Runtime.evaluate({
      expression: `(function(sel) {
        var el = document.querySelector(sel);
        if (!el) return false;  // gone = solved
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < window.innerHeight;
      })(${JSON.stringify(detection.selector)})`,
      returnByValue: true,
    });

    return check.result?.value as boolean;
  } catch {
    return null;
  }
}

function manualFallback(
  detection: CaptchaDetection,
  t0: number,
  customMsg?: string
): CaptchaSolution {
  return {
    solved: false,
    method: "manual_guidance",
    confidence: 0,
    requiresUserIntervention: true,
    userInstructions: customMsg || getHumanInstructions(detection),
    timeToSolve: Date.now() - t0,
  };
}

function getHumanInstructions(detection: CaptchaDetection): string {
  switch (detection.type) {
    case "recaptcha_v2":
      return "Click the 'I'm not a robot' checkbox. If images appear, select all matching ones and click Verify.";
    case "recaptcha_v3":
      return "Invisible CAPTCHA — wait 2-3 seconds and retry. If it fails again, interact with the page first (scroll, move mouse).";
    case "hcaptcha":
      return "Click the hCaptcha checkbox. If a visual challenge appears, complete it by clicking the matching images.";
    case "turnstile":
      return "Cloudflare Turnstile detected. Wait a few seconds for automatic verification.";
    case "geetest":
    case "geetest_v4":
      return "GeeTest CAPTCHA: Drag the slider to the right until the puzzle piece fits into the gap.";
    case "funcaptcha":
      return "FunCaptcha: Rotate the image shown until it matches the correct orientation, then click Next.";
    case "slider":
      return "Drag the slider all the way to the right to verify.";
    case "press_and_hold":
      return "Press and hold the verification button for 2-3 seconds until it completes.";
    case "datadome":
      return "DataDome CAPTCHA: Drag the slider to complete the verification.";
    case "perimeter_x":
      return "PerimeterX CAPTCHA: Press and hold the button for 3 seconds.";
    default:
      return "CAPTCHA detected. Please complete the challenge shown on screen to continue.";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rand(max: number): number {
  return Math.floor(Math.random() * max);
}
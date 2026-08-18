import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — anticaptcha/detector.ts
 * Comprehensive CAPTCHA detection covering all major real-world CAPTCHA types.
 * Detects: reCAPTCHA v2/v3, hCaptcha, Turnstile, GeeTest, FunCaptcha,
 *          slider/drag, press-and-hold, DataDome, PerimeterX, and custom CAPTCHAs.
 * No external API keys. All detection via DOM inspection + CDP.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";

export type CaptchaType =
  | "recaptcha_v2"
  | "recaptcha_v3"
  | "hcaptcha"
  | "turnstile"
  | "geetest"
  | "geetest_v4"
  | "funcaptcha"
  | "slider"
  | "press_and_hold"
  | "datadome"
  | "perimeter_x"
  | "custom"
  | "unknown";

export type InteractionType =
  | "checkbox"     // Click a checkbox (reCAPTCHA, hCaptcha simple)
  | "image_select" // Click images matching a category (reCAPTCHA grid)
  | "drag"         // Drag a slider/puzzle piece to a position
  | "hold"         // Press and hold a button for N seconds
  | "text"         // Type characters shown in image
  | "math"         // Solve a math expression
  | "rotate"       // Rotate an image to correct orientation
  | "none"         // Invisible CAPTCHA, no user action needed
  | "unknown";

export interface CaptchaDetection {
  detected: boolean;
  type: CaptchaType;
  interactionType: InteractionType;
  difficulty: "easy" | "medium" | "hard" | "extreme";
  selector: string;
  iframe?: string;
  widgetId?: string;
  confidence: number; // 0-1
  /** Approximate drag distance in pixels for slider CAPTCHAs (0 if unknown) */
  sliderTrackWidth?: number;
  /** Estimated hold duration in ms for press-and-hold CAPTCHAs */
  holdDurationMs?: number;
  metadata: {
    siteKey?: string;
    version?: string;
    hasAudio?: boolean;
    hasChallenge?: boolean;
    requiresUserInteraction?: boolean;
    geetestVersion?: number;
    frameOrigin?: string;
  };
}

const DETECTION_SCRIPT = `
(function() {
  'use strict';
  const results = [];

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function extractSiteKey(url) {
    const m = url.match(/[?&]k=([^&]+)/) ||
              url.match(/[?&]sitekey=([^&]+)/) ||
              url.match(/[?&]site_key=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = window.getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  }

  function hasCaptchaKeyword(text) {
    return /captcha|challenge|verify|robot|human|puzzle|slider|drag/i.test(text);
  }

  function scoreResult(r) {
    // Higher = more confidence
    const typeScore = {
      recaptcha_v2: 0.95, recaptcha_v3: 0.9, hcaptcha: 0.95,
      turnstile: 0.9, geetest: 0.95, geetest_v4: 0.92,
      funcaptcha: 0.88, slider: 0.75, press_and_hold: 0.8,
      datadome: 0.9, perimeter_x: 0.88, custom: 0.6, unknown: 0.3,
    };
    return (typeScore[r.type] || 0.5) * r.confidence;
  }

  // ─── 1. reCAPTCHA v2 ────────────────────────────────────────────────────────
  document.querySelectorAll('iframe[src*="recaptcha"]').forEach(function(frame) {
    const src = frame.src || '';
    const isV2 = src.includes('/api2/') || src.includes('/enterprise/') || src.includes('recaptcha/api2');
    if (isV2) {
      const hasChallenge = src.includes('bframe') || src.includes('frame=bframe');
      results.push({
        type: 'recaptcha_v2',
        interactionType: hasChallenge ? 'image_select' : 'checkbox',
        difficulty: hasChallenge ? 'hard' : 'medium',
        selector: 'iframe[src*="recaptcha"]',
        iframe: src,
        confidence: 0.95,
        metadata: {
          siteKey: extractSiteKey(src),
          hasAudio: false,
          hasChallenge: hasChallenge,
          requiresUserInteraction: true,
        }
      });
    }
  });

  // ─── 2. reCAPTCHA v3 (invisible) ────────────────────────────────────────────
  var rcScripts = Array.from(document.scripts).filter(function(s) {
    return s.src && s.src.includes('recaptcha/api.js') && !s.src.includes('enterprise');
  });
  if (rcScripts.length > 0 && !results.some(function(r) { return r.type === 'recaptcha_v2'; })) {
    results.push({
      type: 'recaptcha_v3',
      interactionType: 'none',
      difficulty: 'easy',
      selector: 'script[src*="recaptcha/api.js"]',
      confidence: 0.85,
      metadata: {
        siteKey: extractSiteKey(rcScripts[0].src),
        requiresUserInteraction: false,
      }
    });
  }

  // ─── 3. hCaptcha ────────────────────────────────────────────────────────────
  document.querySelectorAll('iframe[src*="hcaptcha"]').forEach(function(frame) {
    const src = frame.src || '';
    const isChallenge = src.includes('/challenge');
    results.push({
      type: 'hcaptcha',
      interactionType: isChallenge ? 'image_select' : 'checkbox',
      difficulty: isChallenge ? 'hard' : 'medium',
      selector: 'iframe[src*="hcaptcha"]',
      iframe: src,
      confidence: 0.95,
      metadata: {
        siteKey: extractSiteKey(src),
        requiresUserInteraction: true,
      }
    });
  });
  // hCaptcha widget div
  if (!results.some(function(r) { return r.type === 'hcaptcha'; })) {
    var hDiv = document.querySelector('[data-hcaptcha-widget-id], h-captcha, [data-sitekey][class*="h-captcha"]');
    if (hDiv && isVisible(hDiv)) {
      results.push({
        type: 'hcaptcha',
        interactionType: 'checkbox',
        difficulty: 'medium',
        selector: '[data-hcaptcha-widget-id]',
        confidence: 0.88,
        metadata: {
          siteKey: hDiv.getAttribute('data-sitekey'),
          requiresUserInteraction: true,
        }
      });
    }
  }

  // ─── 4. Cloudflare Turnstile ────────────────────────────────────────────────
  document.querySelectorAll('iframe[src*="challenges.cloudflare"]').forEach(function(frame) {
    const src = frame.src || '';
    results.push({
      type: 'turnstile',
      interactionType: 'none',
      difficulty: 'easy',
      selector: 'iframe[src*="challenges.cloudflare"]',
      iframe: src,
      confidence: 0.92,
      metadata: {
        siteKey: extractSiteKey(src),
        requiresUserInteraction: false,
      }
    });
  });
  // Turnstile widget
  if (!results.some(function(r) { return r.type === 'turnstile'; })) {
    var cfEl = document.querySelector('[data-turnstile-sitekey], .cf-turnstile, cf-turnstile');
    if (cfEl && isVisible(cfEl)) {
      results.push({
        type: 'turnstile',
        interactionType: 'none',
        difficulty: 'easy',
        selector: '.cf-turnstile',
        confidence: 0.88,
        metadata: {
          siteKey: cfEl.getAttribute('data-sitekey') || cfEl.getAttribute('data-turnstile-sitekey'),
          requiresUserInteraction: false,
        }
      });
    }
  }

  // ─── 5. GeeTest v3 ─────────────────────────────────────────────────────────
  var geetestV3 = (typeof window.initGeetest !== 'undefined') ||
    !!document.querySelector('.geetest_radar_tip, .geetest_holder, .geetest_slider, [class*="geetest_"]');
  if (geetestV3) {
    var sliderEl = document.querySelector('.geetest_slider_button, .geetest_drag_thumb');
    var trackEl  = document.querySelector('.geetest_slider_bar, .geetest_track');
    var trackWidth = trackEl ? trackEl.getBoundingClientRect().width : 280;
    var sliderSel = sliderEl ? '.geetest_slider_button' : '.geetest_holder';
    results.push({
      type: 'geetest',
      interactionType: 'drag',
      difficulty: 'hard',
      selector: sliderSel,
      confidence: 0.93,
      sliderTrackWidth: Math.round(trackWidth),
      metadata: {
        geetestVersion: 3,
        requiresUserInteraction: true,
      }
    });
  }

  // ─── 6. GeeTest v4 ─────────────────────────────────────────────────────────
  var geetestV4 = (typeof window.initGeetest4 !== 'undefined') ||
    !!document.querySelector('[class*="geetest"][class*="v4"], .gt4_root, .geetest4');
  if (geetestV4 && !geetestV3) {
    var gt4Slider = document.querySelector('.geetest-slider-btn, [class*="geetest4"][class*="slide"]');
    var gt4Track  = document.querySelector('[class*="geetest4"][class*="track"], [class*="geetest4"][class*="bar"]');
    var gt4Width  = gt4Track ? gt4Track.getBoundingClientRect().width : 260;
    results.push({
      type: 'geetest_v4',
      interactionType: 'drag',
      difficulty: 'hard',
      selector: gt4Slider ? '.geetest-slider-btn' : '.gt4_root',
      confidence: 0.9,
      sliderTrackWidth: Math.round(gt4Width),
      metadata: {
        geetestVersion: 4,
        requiresUserInteraction: true,
      }
    });
  }

  // ─── 7. FunCaptcha / Arkose Labs ────────────────────────────────────────────
  var funFrame = document.querySelector('iframe[src*="funcaptcha"], iframe[src*="arkoselabs"]');
  if (!funFrame) {
    funFrame = document.querySelector('iframe[title*="arkose"], iframe[title*="FunCaptcha"]');
  }
  if (funFrame && isVisible(funFrame)) {
    var funSrc = funFrame.src || '';
    results.push({
      type: 'funcaptcha',
      interactionType: 'rotate',
      difficulty: 'hard',
      selector: 'iframe[src*="funcaptcha"], iframe[src*="arkoselabs"]',
      iframe: funSrc,
      confidence: 0.88,
      metadata: {
        requiresUserInteraction: true,
        frameOrigin: funSrc.split('/')[2],
      }
    });
  }

  // ─── 8. Generic Slider CAPTCHA ──────────────────────────────────────────────
  if (!results.some(function(r) { return r.interactionType === 'drag'; })) {
    var sliderSelectors = [
      '.slider-captcha-track', '.slide-verify-slider', '.verify-slider',
      '[class*="slider"][class*="captcha"]', '[class*="captcha"][class*="slider"]',
      '[class*="slide-verify"]', '[class*="verify-wrap"]',
      '.nc_wrapper', '.nc-tpl', '[data-nc-scene]',
      'div[class*="drag-verify"]', 'div[class*="dragger"]',
    ];
    for (var i = 0; i < sliderSelectors.length; i++) {
      var sEl = document.querySelector(sliderSelectors[i]);
      if (sEl && isVisible(sEl) && hasCaptchaKeyword(sEl.textContent || '')) {
        var trackEl2 = sEl.querySelector('[class*="track"], [class*="bar"], [class*="bg"]') || sEl;
        var tw = trackEl2.getBoundingClientRect().width || 280;
        results.push({
          type: 'slider',
          interactionType: 'drag',
          difficulty: 'hard',
          selector: sliderSelectors[i],
          confidence: 0.75,
          sliderTrackWidth: Math.round(tw),
          metadata: { requiresUserInteraction: true }
        });
        break;
      }
    }
  }

  // ─── 9. Press-and-Hold CAPTCHA ──────────────────────────────────────────────
  var holdSelectors = [
    '[class*="press-hold"]', '[class*="presshold"]', '[class*="hold-btn"]',
    '[class*="click-hold"]', 'button[data-hold]', '[data-captcha-hold]',
    '[class*="verify-btn"][class*="hold"]',
  ];
  for (var j = 0; j < holdSelectors.length; j++) {
    var hEl = document.querySelector(holdSelectors[j]);
    if (hEl && isVisible(hEl)) {
      // Try to read expected hold duration from attribute or text
      var holdMs = parseInt(hEl.getAttribute('data-hold-time') || hEl.getAttribute('data-duration') || '2000', 10);
      results.push({
        type: 'press_and_hold',
        interactionType: 'hold',
        difficulty: 'medium',
        selector: holdSelectors[j],
        confidence: 0.78,
        holdDurationMs: isNaN(holdMs) ? 2000 : holdMs,
        metadata: { requiresUserInteraction: true }
      });
      break;
    }
  }
  // Also look for countdown-style hold buttons
  var countdownBtns = document.querySelectorAll('button, [role="button"]');
  countdownBtns.forEach(function(btn) {
    if (!results.some(function(r) { return r.interactionType === 'hold'; })) {
      var txt = (btn.textContent || '') + (btn.getAttribute('aria-label') || '');
      if (/hold|press\s+and\s+hold|keep\s+press/i.test(txt) && isVisible(btn)) {
        results.push({
          type: 'press_and_hold',
          interactionType: 'hold',
          difficulty: 'medium',
          selector: null,  // will be resolved to coords
          confidence: 0.7,
          holdDurationMs: 2500,
          metadata: { requiresUserInteraction: true }
        });
      }
    }
  });

  // ─── 10. DataDome ──────────────────────────────────────────────────────────
  var ddFrame = document.querySelector('iframe[src*="geo.captcha-delivery"], iframe[src*="datadome"]');
  var ddDiv   = document.querySelector('#datadome, [id*="datadome"], [class*="datadome"]');
  if ((ddFrame && isVisible(ddFrame)) || (ddDiv && isVisible(ddDiv))) {
    var ddSrc = ddFrame ? (ddFrame.src || '') : '';
    results.push({
      type: 'datadome',
      interactionType: 'drag',  // DataDome typically uses slider
      difficulty: 'hard',
      selector: ddFrame ? 'iframe[src*="captcha-delivery"]' : '#datadome',
      iframe: ddSrc,
      confidence: 0.88,
      metadata: { requiresUserInteraction: true }
    });
  }

  // ─── 11. PerimeterX ────────────────────────────────────────────────────────
  var pxEl = document.querySelector('#px-captcha, ._pxCaptcha, [id^="px-"][id$="captcha"]');
  if (pxEl && isVisible(pxEl)) {
    // PerimeterX is usually press-and-hold
    results.push({
      type: 'perimeter_x',
      interactionType: 'hold',
      difficulty: 'hard',
      selector: '#px-captcha',
      confidence: 0.88,
      holdDurationMs: 3000,
      metadata: { requiresUserInteraction: true }
    });
  }

  // ─── 12. Generic Custom CAPTCHA ────────────────────────────────────────────
  if (results.length === 0) {
    var customSels = [
      '.captcha-container', '[class*="captcha"]', '[id*="captcha"]',
      '[class*="challenge"]', '[id*="challenge"]',
    ];
    for (var k = 0; k < customSels.length; k++) {
      var cEls = document.querySelectorAll(customSels[k]);
      for (var m = 0; m < cEls.length; m++) {
        var cEl = cEls[m];
        if (isVisible(cEl) && hasCaptchaKeyword(cEl.textContent || '')) {
          // Try to classify interaction type from content
          var cText = (cEl.textContent || '').toLowerCase();
          var iType = 'unknown';
          if (/drag|slide|slider/i.test(cText)) iType = 'drag';
          else if (/hold|press/i.test(cText)) iType = 'hold';
          else if (/enter|type|text/i.test(cText)) iType = 'text';
          else if (/select|click.*image|image.*click/i.test(cText)) iType = 'image_select';
          else if (/math|\\d+\\s*[+\\-*/]\\s*\\d+/i.test(cText)) iType = 'math';
          results.push({
            type: 'custom',
            interactionType: iType,
            difficulty: 'hard',
            selector: customSels[k],
            confidence: 0.55,
            metadata: {
              hasChallenge: true,
              requiresUserInteraction: true,
            }
          });
          break;
        }
      }
      if (results.length > 0) break;
    }
  }

  // ─── Pick best result ───────────────────────────────────────────────────────
  if (results.length === 0) {
    return {
      detected: false,
      type: 'unknown',
      interactionType: 'unknown',
      difficulty: 'easy',
      selector: '',
      confidence: 0,
      metadata: {}
    };
  }

  results.sort(function(a, b) { return scoreResult(b) - scoreResult(a); });
  var best = results[0];

  return {
    detected: true,
    type: best.type,
    interactionType: best.interactionType || 'unknown',
    difficulty: best.difficulty,
    selector: best.selector || '',
    iframe: best.iframe,
    confidence: best.confidence,
    sliderTrackWidth: best.sliderTrackWidth,
    holdDurationMs: best.holdDurationMs,
    metadata: best.metadata || {}
  };
})()
`;

/**
 * Comprehensive CAPTCHA detection using multiple heuristics.
 * Returns the highest-confidence detection found on the page.
 */
export async function detectCaptcha(session: CDP.Client): Promise<CaptchaDetection> {
  try {
    const result = await session.Runtime.evaluate({
      expression: DETECTION_SCRIPT,
      returnByValue: true,
      awaitPromise: false,
    });

    const val = result.result?.value as CaptchaDetection | undefined;
    if (!val) {
      return emptyDetection();
    }
    return val;
  } catch (error) {
    logDebug("[Weavetab AntiCaptcha] Detection failed:", error);
    return emptyDetection();
  }
}

function emptyDetection(): CaptchaDetection {
  return {
    detected: false,
    type: "unknown",
    interactionType: "unknown",
    difficulty: "easy",
    selector: "",
    confidence: 0,
    metadata: {},
  };
}

/**
 * Check if a CAPTCHA is currently blocking the workflow.
 * Uses both detection and a visibility/blocking check.
 */
export async function isCaptchaBlocking(session: CDP.Client): Promise<boolean> {
  const detection = await detectCaptcha(session);
  if (!detection.detected) return false;

  // Invisible CAPTCHAs (v3, Turnstile) are never "blocking"
  if (detection.interactionType === "none") return false;

  if (!detection.selector) return true; // Unknown selector — assume blocking

  const blockingCheck = await session.Runtime.evaluate({
    expression: `(function(selector) {
      try {
        var el = document.querySelector(selector);
        if (!el) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < window.innerHeight;
      } catch(e) { return false; }
    })(${JSON.stringify(detection.selector)})`,
    returnByValue: true,
  });

  return blockingCheck.result?.value === true;
}

/**
 * Quickly check if the current page shows a CAPTCHA without the full detection.
 * Cheaper than detectCaptcha — use for polling.
 */
export async function quickCaptchaCheck(session: CDP.Client): Promise<boolean> {
  try {
    const r = await session.Runtime.evaluate({
      expression: `(function() {
        var checks = [
          !!document.querySelector('iframe[src*="recaptcha"]'),
          !!document.querySelector('iframe[src*="hcaptcha"]'),
          !!document.querySelector('iframe[src*="challenges.cloudflare"]'),
          !!document.querySelector('.geetest_holder, .geetest_slider'),
          !!document.querySelector('[id^="px-"][id$="captcha"], #datadome'),
          !!document.querySelector('iframe[src*="funcaptcha"], iframe[src*="arkoselabs"]'),
        ];
        return checks.some(Boolean);
      })()`,
      returnByValue: true,
    });
    return r.result?.value === true;
  } catch {
    return false;
  }
}
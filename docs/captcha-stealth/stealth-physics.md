---
title: "Stealth & Physics"
description: "Ghost Cursor Bézier kinematics, typing jitter, and anti-fingerprinting."
product: mcp
section: captcha-stealth
icon: Sparkles
slug: stealth-physics
---

# Stealth & Kinematic Physics

Weavetab is built from the ground up to make AI automation indistinguishable from human input at the browser and DOM event levels.

## 1. Ghost Cursor Bézier Kinematics

Standard automation tools warp cursor coordinates instantaneously (`x: 0` → `x: 500` in 0ms), which triggers modern anti-bot heuristics.

Weavetab's **Ghost Cursor** engine generates dynamic **cubic Bézier curves** with randomized control points for every movement:

```text
P0 (Current Pos) ──────► P1 (Control Pt 1) ──────► P2 (Control Pt 2) ──────► P3 (Target)
```

- **Acceleration Profiling**: Gaussian velocity distribution with natural ramp-up and ramp-down.
- **Micro-Jitter**: Per-frame sub-pixel deviations mimicking human muscle tremor.
- **Overshoot & Correction**: Intentional minor overshoots past the target element followed by corrective micro-adjustments.
- **Visual Overlay**: Real-time canvas overlay rendering the glowing Ghost Cursor path in the browser window.

---

## 2. Human Keystroke Synthesis

The `browser_type` engine dispatches native CDP `Input.dispatchKeyEvent` calls with realistic human timing profiles:

- **Temporal Jitter**: Per-character delays sampled between 35 ms and 95 ms.
- **Burst Profiling**: Common character digraphs (e.g., `th`, `er`, `ing`) are typed faster in bursts.
- **Word Boundary Pauses**: Natural pauses (120–250 ms) after spaces and punctuation marks.
- **Stuck-Input Breaking**: DOM diffing detects if keystrokes are failing to register and breaks out of deadlocks.

---

## 3. Layer 0 Fingerprint Spoofing

Weavetab's early-script CDP injection guarantees that the following patches execute **before any page JavaScript runs**:

```typescript
// navigator.webdriver is permanently undefined
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

// Native plugin and mime-type arrays spoofed
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });

// WebGL vendor and renderer noise injection
const getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(parameter) {
  if (parameter === 37445) return 'Google Inc. (Intel)';
  if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11)';
  return getParameter.apply(this, arguments);
};
```

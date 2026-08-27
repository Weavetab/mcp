---
title: "CAPTCHA Solver"
description: "Autonomous zero-API solver for Turnstile, GeeTest, and reCAPTCHA."
product: mcp
section: captcha-stealth
badge: new
icon: ShieldAlert
slug: captcha-solver
---

# Autonomous Zero-API CAPTCHA Solver

Weavetab features a built-in **Autonomous Zero-API CAPTCHA Solver** via the `browser_captcha` tool. It solves complex challenges locally using real CDP pointer physics, Bézier kinematics, and DOM heuristics — requiring **$0 external solver API costs** and zero third-party subscription keys (no 2Captcha, Anti-Captcha, or CapSolver needed).

```typescript
// Detect and solve active challenge automatically
browser_captcha({ action: "solve", timeout: 60000 })
```

---

## Supported Challenge Matrix

| Challenge Type | Target Systems | Solving Technique | Zero API Cost |
|---|---|---|:---:|
| **Cloudflare Turnstile** | Cloudflare protected surfaces | Sustained mousedown + micro-jitter physics | Yes |
| **GeeTest Slider** | GeeTest v3 / v4 puzzle sliders | Bézier velocity drag + momentum overshoot correction | Yes |
| **Google reCAPTCHA v2** | Checkbox & iframe challenges | Nested cross-origin iframe pointer penetration | Yes |
| **Google reCAPTCHA v3** | Invisible score-based barriers | High-entropy behavioral simulation bursts | Yes |
| **Arkose Labs / FunCAPTCHA** | Interactive verification | Synthetic CDP pointer kinematics + rotation solver | Yes |
| **hCaptcha** | Checkbox challenges | Cross-domain iframe dispatch + heuristic click | Yes |
| **Math / Text Challenges** | Inline security prompts | DOM arithmetic evaluation + synthetic input | Yes |

---

## How It Works

### 1. Cloudflare Turnstile & Interactive Checkboxes
Cloudflare Turnstile evaluates the physical trajectory and hold duration of the click. Weavetab:
- Calculates a randomized human Bézier path from current cursor coordinates to the checkbox center.
- Dispatches CDP `Input.dispatchMouseEvent` with `mousePressed` event.
- Applies **micro-jitter displacement** (1–3 pixel variations) for 120–280 ms simulating organic finger tremor.
- Releases `mouseReleased` event and monitors CDP DOM mutations for success tokens.

### 2. GeeTest & Slider Puzzles
For slider challenges, Weavetab calculates the drag distance, applies variable velocity profiling (rapid acceleration, mid-flight coasting, deceleration), and introduces subtle overshoot correction:

```text
Start (0px) ──[Fast Accel]──► Mid (70%) ──[Decel]──► Target (100%) ──[Overshoot +2px]──► Final Lock
```

### 3. reCAPTCHA v2 & Cross-Origin Iframes
reCAPTCHA isolates the checkbox inside cross-origin iframes (`anchor` frame). Weavetab penetrates the isolated iframe context via CDP `DOM.describeNode` and dispatches synthetic pointer events directly to the inner target.

---

## Tool API Reference: `browser_captcha`

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `action` | `"detect" | "solve" | "wait_for_user" | "status"` *(required)* | Operation to perform. |
| `timeout` | `number?` | Maximum timeout in milliseconds (default `120000`). |

### Example Usage

```typescript
// Step 1: Detect if a CAPTCHA exists on page
const detection = await browser_captcha({ action: "detect" });
if (detection.detected) {
  // Step 2: Solve autonomously
  const result = await browser_captcha({ action: "solve", timeout: 45000 });
  console.log("Solved:", result.success);
}
```

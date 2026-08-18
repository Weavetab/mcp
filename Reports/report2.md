# Weavetab MCP Interactive Tools — Functional Audit Report

**Report Version:** 2.0.0  
**Generated Date:** August 10, 2026  
**Environment:** Weavetab MCP v2.5.0 on Google Chrome (CDP Layer 0)  
**Test Suite:** Functional audit of all interactive automation tools (click, type, key, scroll, pointer, canvas, select, upload, dialog, clipboard, viewport, tabs, automation, intercept, storage, highlight, plan) across Modern SPA (GitHub), Canvas Designer (Excalidraw), Observability Dashboard (Grafana Play), and AI Chatbot (Perplexity). Utility tools validated against a purpose-built local fixture (native select, file input, JS dialogs, HTML5 drop zone).

---

## Executive Summary

23 interactive tools were exercised in 41 end-to-end operations. **17 tools passed their core happy-path**; **2 are functionally broken** (`browser_dialog` accept-path, `browser_upload`), and **4 exhibit reliability gaps** (stale refs, off-viewport elements, mouse-only drag, AX-tree inconsistency). No crashes or browser instability were observed across the entire session.

### Key Findings
- **`browser_canvas draw`** successfully created a rectangle element in Excalidraw — verified by stroke-pixel sampling (`#1e1e1e` border at expected geometry) and Undo-button state. Native canvas authoring works end-to-end.
- **`browser_dialog` accept-path is broken:** `confirm` accepted returns `false`, and `promptText` is silently discarded (`prompt=null`). Dismiss path behaves correctly. **Priority 1.**
- **`browser_upload` is unusable in practice:** it requires a raw CDP `backendNodeId`, which no other tool exposes (map/inspect surface only `w:NN` refs). **Priority 1.**
- **`browser_pointer drag_and_drop` is mouse-event-only:** it neither fires native HTML5 `dragstart`/`drop` (fixture drop-zone) nor moves canvas elements (Excalidraw, pixel scan delta = 0).
- **Reference IDs (`w:NN`) invalidate after every DOM mutation** on all SPA targets, forcing a re-map before each action — the single largest agent-efficiency drag.

---

## Functional Test Matrix

| Tool | Test Case | Site / Fixture | Result | Latency (`execution_ms`) |
|---|---|---|---|---|
| `browser_map` | Full snapshot (318 elems) | GitHub Explore | ✅ | 3,543 (incl. nav) |
| `browser_map` | `delta: true` after navigation | GitHub Issues | ⚠️ refs returned without labels | 290 |
| `browser_map` | `ax_tree: true` (toolbar discovery) | Excalidraw | ✅ (normal map saw only canvases) | 200 |
| `browser_click` | Fresh-ref click on filter menu | GitHub Issues | ✅ | 1,186 |
| `browser_click` | Label + learned-memory click | Excalidraw / Grafana / Perplexity | ✅ | 749–2,750 |
| `browser_click` | Coordinate click (header) | GitHub Explore | ✅ | 4,706 |
| `browser_click` | Stale ref after DOM change | All sites | ❌ `ELEMENT_NOT_FOUND` | 117–290 |
| `browser_click` | Off-viewport element (y=1417) | Grafana | ❌ `ELEMENT_INVISIBLE` / `NOT_FOUND` | 1,369 |
| `browser_type` | Native input (issues filter) | GitHub | ✅ | 1,234 |
| `browser_type` | `contenteditable` composer | Perplexity | ✅ | 2,134 |
| `browser_type` | Field with empty `data-wt-id` | GitHub | ❌ `COORD_RESOLUTION_FAILED` | 193 |
| `browser_key` | Enter → URL navigation | GitHub | ✅ | 40 |
| `browser_key` | Escape closes state, `/` shortcut | GitHub | ⚠️ key routed to focused input | 40 |
| `browser_scroll` | Window scroll 1,200px | GitHub / Grafana | ✅ | 120 |
| `browser_pointer` | Hover on issue link | GitHub | ✅ | 6,078 |
| `browser_pointer` | Click on canvas element | Excalidraw | ✅ | 348 |
| `browser_pointer` | `drag_and_drop` (HTML5 drop zone) | Fixture | ❌ drop event never fired | 1,122 |
| `browser_pointer` | `drag_and_drop` (canvas element) | Excalidraw | ❌ element did not move (0 px delta) | 840 |
| `browser_canvas` | `get_image` export | Excalidraw | ✅ | 200 |
| `browser_canvas` | `draw` 5-point rectangle | Excalidraw | ✅ rect created (pixel-verified) | 300 |
| `browser_select` | Native `<select>` via CSS selector | Fixture | ✅ | 16 |
| `browser_select` | `w:NN` ref / non-active tab | Fixture | ❌ rejects ref; no `tab_id` param | — |
| `browser_dialog` | `alert` accept | Fixture | ✅ | 15 |
| `browser_dialog` | `confirm` accept | Fixture | ❌ returned `false` (should be `true`) | 10 |
| `browser_dialog` | `confirm` dismiss | Fixture | ✅ | 10 |
| `browser_dialog` | `prompt` with `promptText` | Fixture | ❌ text not injected (`prompt=null`) | 10 |
| `browser_upload` | File input via CDP nodeId | Fixture | ❌ no tool exposes a `backendNodeId` | — |
| `browser_clipboard` | Write → read round-trip | Perplexity / Fixture | ✅ | 120 |
| `browser_viewport` | Resize to 1280×800 | Fixture | ✅ | 150 |
| `browser_tabs` | Open / switch / close | Multiple | ✅ | 812–1,653 |
| `browser_highlight` | Red overlay on `#sel` | Fixture | ✅ | 80 |
| `browser_plan` | Create task panel | Fixture | ✅ | 120 |
| `browser_automation` | Start / poll / stop probe | Fixture | ✅ | 100 |
| `browser_network_intercept` | Enable / disable fetch rule | Fixture | ✅ | 60 |
| `browser_storage` | localStorage set / get | Fixture | ✅ | 40 |
| `browser_inspect` | Computed styles + box model | Fixture | ✅ | 16–35 |

---

## Site-Specific Findings

### 1. GitHub (Complex SPA — 318 interactive elements)
- **Ref stability:** every action invalidates all prior `w:NN` refs; a re-map is mandatory before each click/type. Delta mode returns new refs but with empty labels, forcing a second full pass to attribute them.
- **AX-tree degradation:** after the first successful map on `/explore`, all subsequent maps returned `0 interactive elements` with a coordinate heatmap fallback (page still rendered normally). Repo pages recovered the tree; Explore did not.
- **Popover off-viewport:** the label-filter panel rendered at `top:-108px` (fixed overlay). The tool mis-attributed the resulting failure to the `progress-pjax-loader` (`opacity:0`, 2px tall) via `ELEMENT_OCCLUDED_BY`.
- **Typed-value truncation:** typing `is:issue state:open canvas` yielded only `is:issue state:open` after Enter (suspect GitHub query canonicalization; flagged for verification against input-truncation in the type pipeline).
- **Popup detection noise:** `POPUP DETECTED` advisories frequently pointed at benign elements (e.g. the "Closed 1,435" link), adding context noise.

### 2. Excalidraw (Canvas Designer)
- Canvases are exposed as first-class refs (`w:canvas0`, `w:canvas1`). The 30-node toolbar (Undo, Rectangle, Selection, …) is **invisible to the standard map** and only discoverable via `ax_tree: true`.
- **`browser_canvas draw` is production-viable:** a rectangle was authored and confirmed via stroke-pixel sampling at the exact target geometry plus Undo enabling.
- **`drag_and_drop` failed to move the authored element** (dark-pixel scan: 77 in origin region, 0 in destination). Canvas apps require pointer-capture sequencing (`setPointerCapture`) that a mouse-only dispatch does not satisfy.

### 3. Grafana Play (Observability Dashboard)
- Edit mode entry, sidebar, and panel-menu buttons click cleanly.
- **Off-viewport failure:** the "Add panel" button sat at `y=1417`; both ref-click and label-click returned `ELEMENT_NOT_FOUND`, and post-scroll attempts returned `ELEMENT_INVISIBLE`. No auto-scroll-into-view is performed before resolution.
- Grafana surfaces **zero native `<select>` elements** (all custom dropdowns), so `browser_select` could not be validated on real dashboards.

### 4. Perplexity (AI Chatbot — streaming)
- Full conversational loop passed: type into `contenteditable` composer → Submit → URL transition to `/search/<uuid>` → streamed answer confirmed via `browser_wait(text)` and `browser_find("Canberra")`.
- Initial map returned an empty AX tree (heatmap fallback) until the React shell mounted — recommend a `wait(stable)` before first map on chatbot UIs.
- `browser_key` events dispatch to the **focused element**: a `/` press while the composer holds focus types into the composer rather than invoking a global shortcut.

### 5. Cross-Origin Iframes
- W3Schools TryIt content (native `<select>`) is unreachable — tools cannot traverse cross-origin iframes. Widget-in-iframe patterns require a fixture or same-origin mirror.

---

## Issue Register

| ID | Severity | Tool | Issue | Suggested Fix |
|---|---|---|---|---|
| INT-01 | **P1** | `browser_dialog` | `accept` on confirm returns `false`; `promptText` ignored (prompt resolves `null`) | Pass `accept:true` and `promptText` verbatim to `Page.handleJavaScriptDialog` |
| INT-02 | **P1** | `browser_upload` | Requires CDP `backendNodeId`; no tool exposes one | Surface `backendNodeId` in `map`/`inspect`, or accept `w:NN`/selector |
| INT-03 | **P2** | `browser_pointer` | `drag_and_drop` is mouse-only; no native HTML5 DnD or canvas moves | Use `Input.dispatchDragEvent` with `DragData`; add pointer-capture mode |
| INT-04 | **P2** | All actions | `w:NN` refs invalidate on any DOM change; delta omits labels | Stable refs for unchanged nodes; include labels in delta output |
| INT-05 | **P2** | `browser_click` | Off-viewport elements unreachable; no auto-scroll | Scroll-into-view before coordinate resolve, or coordinate fallback |
| INT-06 | **P3** | `browser_type` | `COORD_RESOLUTION_FAILED` when `data-wt-id` absent | Resolve via bounding-rect / `elementFromPoint` |
| INT-07 | **P3** | `browser_map` | Occlusion error mis-attributes cause (opacity-0 loader vs off-viewport popover) | Distinguish off-viewport vs covered-by-overlay diagnostics |
| INT-08 | **P3** | `browser_select` | Schema/description mismatch (no `ref`/`id`, no `tab_id`) | Accept refs; add `tab_id` parity with other tools |
| INT-09 | **P3** | `browser_map` | AX-tree degradation after first map (GitHub Explore) | Add tree-recovery / `force` rebuild when tree empties |
| INT-10 | **P3** | `browser_find` | Streamed-content confirmation returned in 42ms (suspiciously fast) | Verify cache/staleness semantics for live-updating pages |

---

## Agent Best-Practice Recommendations

1. **Re-map (delta) after every mutation** — treat `w:NN` refs as single-use on SPA pages; prefer label or selector targeting with `intent` to leverage learned memory.
2. **`wait(network|stable)` before first map** on React/Next apps (Perplexity, GitHub Explore) to avoid empty AX-tree fallbacks.
3. **Scroll explicitly** before interacting with anything below the fold — the tool does not auto-scroll.
4. **Prefer `browser_canvas` for canvas apps**, not `drag_and_drop`; simulate element moves via canvas `draw` or keyboard nudges where possible.
5. **Do not rely on `browser_dialog` accept semantics for confirm/prompt** until INT-01 ships; treat confirm-return values as false.
6. **For file uploads**, drive the file input with a same-origin harness until `browser_upload` accepts refs/selectors (INT-02).

---

## Conclusion

The interactive toolset is broadly functional and capable of completing a real end-to-end chatbot conversation, canvas drawing, and complex SPA navigation. Production readiness is gated on two P1 defects — dialog accept semantics and upload reachability — plus ref-stability and off-viewport handling that currently inflate per-step tool calls by roughly 2×. The `browser_canvas` and learned-memory click paths are the standout performers and should be treated as reference implementations for the weaker drag/select/upload paths.

---

*Report prepared by Weavetab Autonomous Audit Engine v2.0 — companion to `report1.md` (reading/vision benchmark).*

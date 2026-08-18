# Weavetab MCP Systems & Automation Tools — Coverage Audit Report

**Report Version:** 3.0.0
**Generated Date:** August 11, 2026
**Environment:** Weavetab MCP v2.5.0 on Google Chrome (CDP Layer 0), Windows 11, 1600×773 viewport
**Test Suite:** Previously-uncovered tooling — `browser_burst`, `browser_thoughts`, `browser_detect`, `browser_performance`, `browser_pdf`, `browser_cookies`, `browser_recording`, `browser_macro_compile`, `browser_reset_loop_counter`, the `github_*` tool family, plus extended query paths (snapshot restore, clipboard image, network-interception mocks, session storage, XPath scraping, multi-tab ops). Exercised on GitHub, Grafana Play (Pokémon canvas dashboard), Perplexity (chatbot), Excalidraw (canvas editor), Wikipedia, httpbin.org, example.com, and `file://` MHTML contexts.

---

## Executive Summary

**26 operations across 16 tool families** were exercised to close the coverage gap left by reports 1 and 2. **10 tools are fully operational, 2 are broken at runtime** (`github_analyze`, XPath mode of `browser_scrape`), **1 macro path is dangerous to use** (`type_and_send` — drops targets or triple-inserts text), and **6 exhibit reliability gaps** (cookie deletion, ref-ID collisions, secure-context clipboard, pass-through macro compiler, silent cookie-name filtering, path overrides). No browser crashes were observed; a 301-frame screen recording completed cleanly.

### Key Findings
- **`type_and_send` (burst macro) is unsafe as shipped:** with no `id` it invokes `browser_type` with zero arguments (`no target specified`); with an `id` it **triplicated the text** on Wikipedia's React search input (`web browser` → `web browserweb browserweb browser`, confirmed in URL query). **Priority 1.**
- **`github_analyze` crashes every call** with `slug.trim is not a function` — the schema exposes no parameter while the implementation requires a repo slug; it fails even while on a repository page. **Priority 2.**
- **XPath scraping silently returns 0 elements** for every query tested (`//h1`, `//a`, `//div[@id='mp-itn']//a`) while the page demonstrably contains matches (696 tagged nodes; CSS `h1` returned 2). Advertised "CSS/XPath" parity is false. **Priority 2.**
- **`browser_cookies delete` is a silent no-op** when called with only a URL — returns success but the cookie persists; the operation only works when `domain` is passed explicitly. **Priority 2.**
- **`browser_map` emits colliding `w:NN` refs:** the counter restarts per element role-group (Grafana showed `[w:1]` twice, `[w:2]` twice, `[w:4]` twice; Perplexity showed `[w:1]`,`[w:2]`,`[w:4]`,`[w:5]`,`[w:7]` duplicated; Wikipedia had 6 duplicate IDs among 696 tagged nodes). Ambiguous action targeting. **Priority 2.**

---

## Functional Test Matrix

| Tool | Test Case | Site / Context | Result | Latency (`execution_ms`) |
|---|---|---|---|---|
| `browser_burst` | `navigate_and_read` macro (auto-splits into `browser_go` + `browser_map`) | GitHub Issues | ✅ | 1,900 (chain) |
| `browser_burst` | `scroll_and_read` macro (scroll + read) | Grafana | ✅ | — |
| `browser_burst` | 5-step chain: wait → map → scroll ×2 → map | Grafana | ✅ | 4,777 (wait) |
| `browser_burst` | `type_and_send` without `id` | Perplexity | ❌ `browser_type` fired with no args | — |
| `browser_burst` | `type_and_send` with `id` | Wikipedia | ⚠️ text triplicated ×3 in field + URL | 1,574 |
| `browser_thoughts` | `feedback` append to mission log / HUD | Any | ✅ | — |
| `browser_thoughts` | `question` (sentence input) + `timeout` auto-cancel | Any | ✅ `{response:"", timeout:true}` | 5s |
| `browser_thoughts` | `question` (paragraph input) + `timeout` | Any | ✅ same contract | 4s |
| `browser_detect` | Engine discovery + per-engine tool-coverage matrix | Local | ✅ (Chrome + Edge; Firefox/WebKit block 10+ tools) | — |
| `browser_performance` | Full CDP metrics + slowest resources | GitHub | ✅ | — |
| `browser_performance` | Heavy charting dashboard | Grafana Pokémon dash | ✅ | — |
| `browser_pdf` | Print page → `%PDF-1.4`, 225.6 KB | GitHub Issues | ✅ | — |
| `browser_cookies` | `get` (URL-scoped) | GitHub | ✅ (6 cookies) | — |
| `browser_cookies` | `get` with `name` filter | GitHub | ⚠️ returns all cookies, ignores name | — |
| `browser_cookies` | `set` → verify present | GitHub | ✅ (6 → 7) | — |
| `browser_cookies` | `delete` URL-only | GitHub | ❌ returns success, cookie persists | — |
| `browser_cookies` | `delete` with explicit `domain` | GitHub | ✅ | — |
| `browser_recording` | `start` / `list` / `stop` | Grafana + GitHub | ✅ 301 frames @3fps, 1.9 MB | — |
| `browser_macro_compile` | Compile trail → normalized burst steps | — | ⚠️ pass-through; no dedup observed | — |
| `browser_macro_compile` | Compiled output replayed via `browser_burst` | Example.com | ✅ | — |
| `browser_reset_loop_counter` | Reset with reason | Any | ✅ | — |
| `github_analyze` | On repo page + bare call | anomalyco/opencode | ❌ `slug.trim is not a function` | — |
| `github_issues` | `search` + `limit` | anomalyco/opencode | ✅ | — |
| `github_get_pr` | List + detail `#41625` (files, comments, mergeable) | anomalyco/opencode | ✅ | — |
| `github_get_pr` | Nonexistent PR | anomalyco/opencode | ✅ clean `404 FETCH_FAILED` | — |
| `github_read` | `README.md` lines 1–30 + `truncated` flag | anomalyco/opencode | ✅ | — |
| `browser_snapshot` | `restore` (MHTML → live page) | httpbin mock | ✅ + ref-cache warning | — |
| `browser_clipboard` | Text write → read round-trip | Example.com (https) | ✅ | — |
| `browser_clipboard` | Image write (dataURL) | https | ✅ | — |
| `browser_clipboard` | Image write | `file://` MHTML | ❌ `MCP error -32001` timeout | — |
| `browser_network_intercept` | Mock `httpbin.org/json` → verify body | httpbin | ✅ mock JSON served | — |
| `browser_viewport` | `set` 1280×720 / `clear` | Any | ✅ | — |
| `browser_storage` | sessionStorage set / get round-trip | Any | ✅ (JSON preserved) | — |
| `browser_tabs` | `list_windows` / `consolidate` / `heal` | Any | ✅ | — |
| `browser_scrape` | XPath `//h1`, `//a`, `//div[@id='mp-itn']//a` | Wikipedia | ❌ 0 elements (CSS `h1` → 2) | 29–116 |
| `browser_screenshot` | `fullPage` 1585×3100 JPEG | Wikipedia | ✅ | 862 |
| `browser_screenshot` | `clip` 400×300 JPEG | Wikipedia | ✅ | 141 |
| `browser_canvas` | `get_image` + numeric pixel verification | Grafana Pokémon dash | ✅ 69,668 colored px | — |
| `browser_canvas` | `draw` 5-point rect → pixel edge-band verification | Excalidraw | ✅ 1,050 px in target region | — |
| `browser_console` | Read buffer (site errors captured) | Cross-site | ✅ | — |

---

## Findings by Surface

### 1. Chatbot Workflow — Perplexity (streaming SPA)
- Full E2E passed: map → click composer → `browser_type` (coordinates strategy) → Submit → URL transition → streamed answer confirmed via `browser_find` + text extraction ("Canberra … 10 sources").
- **`type_and_send` macro is the blocker:** with no target it failed with `no target specified`; the manual equivalent (click + type) succeeded. Report 2's "suspiciously fast" `wait(text)` (INT-10) is explained: content was already rendered before `wait` fired — fast matches are legitimate, not a cache artifact.
- Duplicate `[w:1]`/`[w:2]`/`[w:4]`/`[w:5]`/`[w:7]` refs present in the map output.

### 2. Canvas Authoring — Excalidraw
- **Improvement vs report 2:** the full 68-node toolbar is now visible in the standard map (report 2 required `ax_tree: true`).
- Rectangle tool selected via label click (`w:25`); `w:47` from the map was `ELEMENT_INVISIBLE` (zero-dimension refs persist as a hazard).
- `browser_canvas draw` produced a verified rectangle — pixel sampling showed dense edge bands at y≈250 / y≈450 matching the drawn 5-point path exactly.

### 3. Observability Dashboard — Grafana Play (Pokémon chart dashboard)
- Dashboard navigation, folder expansion, and chart canvas extraction all clean.
- Chart canvases confirmed rendering via numeric sampling (69,668 non-transparent px, 62k green chart px).
- Duplicate ref collisions (`w:1`, `w:2`, `w:4`) observed on the /dashboards page.
- `browser_performance` on the live chart dashboard: 1,564 LayoutCount, 1,663 RecalcStyleCount, 34.0s ProcessTime during hydration — metrics pipeline works; note `transferSize: 0` for most SPA resources (reporting gap for chunked assets).

### 4. Daily-Work Automation — GitHub + httpbin + Wikipedia
- Network-interception mock validated end-to-end: `httpbin.org/json` served the injected `{"mock":true,…}` body; disable restored normal behavior.
- Cookie lifecycle partially broken (see Issue Register R3-04/R3-06).
- Wikipedia search: direct coordinate typing produced a clean `paris` (len 5); the same text through `type_and_send` was triplicated.
- XPath scraping dead on all three query shapes tested.

---

## Issue Register

| ID | Severity | Tool | Issue | Suggested Fix |
|---|---|---|---|---|
| R3-01 | **P1** | `browser_burst` (`type_and_send`) | Without `id`/`label`, fires `browser_type` with no args; with `id`, text is inserted 3× on React-controlled inputs | Validate macro args before dispatch; single-dispatch (no retry) into controlled inputs; pass through `text` verbatim |
| R3-02 | **P2** | `github_analyze` | `slug.trim is not a function` — schema has no param, impl requires slug; fails on repo pages too | Add required `repo` parameter or derive `owner/repo` from the active tab URL |
| R3-03 | **P2** | `browser_scrape` | XPath mode always returns 0 elements | Fix XPath evaluation (`document.evaluate`) or remove the advertised XPath capability until correct |
| R3-04 | **P2** | `browser_cookies` | `delete` with URL only is a silent no-op; requires explicit `domain` | Resolve domain from URL (parity with `get`/`set`); surface a warning when domain is missing |
| R3-05 | **P2** | `browser_map` | Duplicate `w:NN` refs (counter resets per role-group) on Grafana, Perplexity, Wikipedia | Make the ref counter global per snapshot; de-duplicate before emission |
| R3-06 | **P3** | `browser_cookies` | `get` ignores `name` filter; `set` on https produces `secure:false` | Honor `name`; default `secure` from page protocol |
| R3-07 | **P3** | `browser_type` | `NOT_EDITABLE` suggestion says `browser_key { key:"<text>" }` but multi-char keys are rejected | Rewrite fallback guidance (click → type by coordinates) or accept multi-char text in `browser_key` |
| R3-08 | **P3** | `browser_snapshot` | User-supplied `filePath` is overridden to the internal `~/.weavetab/snapshots/` directory | Honor caller path or return the effective path explicitly |
| R3-09 | **P3** | `browser_macro_compile` | Pass-through only — no dedup/optimization; can't verify it consumes the internal recent trail | Document intended optimization; dedupe consecutive identical steps |
| R3-10 | **P3** | `browser_thoughts` | Question timeout returns `{response:"", timeout:true}` — ambiguous empty response | Return distinct `cancelled` status; distinguish unanswered vs answered-empty |
| R3-11 | **P3** | `browser_clipboard` | Image/text ops require a secure context; `file://` pages time out with `-32001` | Detect non-secure context and return a typed error instead of hanging |
| R3-12 | **P3** | `browser_console` | Buffer accumulates site logs across navigations (Grafana plugin preload errors mixed with Wikipedia warnings) | Namespace/clear buffer on navigation; timestamp already present |

---

## Agent Best-Practice Recommendations

1. **Never route text input through `type_and_send` in burst** until R3-01 ships — use `browser_click` + `browser_type` (coordinate strategy) with a fresh map, as proven on Perplexity/Wikipedia.
2. **Always pass `domain` to `browser_cookies delete`**; treat URL-only deletion as unreliable.
3. **Use CSS selectors, not XPath**, in `browser_scrape` until R3-03 is fixed.
4. **Verify refs against the live map before acting** — duplicate `w:NN` IDs can route clicks to the wrong element; prefer label/selector targeting on pages that exhibit collisions.
5. **Keep clipboard operations on https pages**; `file://` and other non-secure contexts will hang.
6. **`browser_recording` is safe for long sessions** (301 frames @3fps, ~1.9 MB) — enable for compliance/audit trails; stop promptly to bound disk usage.
7. **Network interception is production-usable** for stubbing external APIs during automation tests (validated mock served on httpbin).

---

## Conclusion

The systems layer of Weavetab MCP — recording, performance, PDF export, cookie/network/storage primitives, and the `github_*` read tools — is broadly functional and demonstrated strong reliability (no crashes, clean multi-frame recording, verified network mocks, working canvas authoring and chatbot E2E). Production readiness is gated on **one P1** (burst `type_and_send` text corruption), **two P2 runtime breakages** (`github_analyze`, XPath scraping), and ref-ID collisions that degrade targeting precision. The gap between report 1/2 coverage and reality is closed; the most valuable follow-up is hardening the macro-expansion layer (`type_and_send`, `macro_compile`) that currently undermines the token-efficiency promise of `browser_burst`.

---

*Report prepared by Weavetab Autonomous Audit Engine v3.0 — companion to `report1.md` (reading/vision benchmark) and `report2.md` (interactive tools functional audit).*

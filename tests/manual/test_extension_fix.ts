/**
 * Quick test for extension system fixes.
 * Tests: fallback visuals, extension content script detection,
 * and sendToExtension bridge.
 *
 * Run: npx tsx tests/manual/test_extension_fix.ts
 */

import { loadConfigSync } from "../../src/config/loader.js";
import { getOrConnect } from "../../src/cdp/connector.js";
import { sendToExtension } from "../../src/cdp/helpers.js";
import CDP from "chrome-remote-interface";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) { console.error(`  ✅ ${msg}`); passed++; }
  else { console.error(`  ❌ ${msg}`); failed++; }
};

async function main() {
  const config = loadConfigSync();
  console.error(`Config: devMode=${config.devMode}, disableExtensions=${config.disableExtensions}, visuals=${config.visuals}`);

  const client = await getOrConnect(config);
  const session: CDP.Client = client.session;

  // Navigate to a real page
  await session.Page.navigate({ url: "https://httpbin.org/forms/post" });
  await sleep(3000);

  // ─── Test 1: Overlay script installed (functions defined) ───
  console.error("\n── Test 1: Overlay script installed ──");
  const { result: overlayInst } = await session.Runtime.evaluate({
    expression: `(function(){
      var sr = document.getElementById('Weavetab-root');
      if (!sr || !sr.shadowRoot) return 'no shadow root';
      var hasFunctions = typeof window.__wt_fallback_cursor === 'function'
        && typeof window.__wt_fallback_hud === 'function'
        && typeof window.__wt_fallback_thought === 'function'
        && typeof window.__wt_install_minimal === 'function';
      return hasFunctions ? 'functions OK' : 'missing functions';
    })()`,
    returnByValue: true,
  });
  assert(overlayInst?.value === 'functions OK', `overlay install: ${overlayInst?.value}`);

  // ─── Test 2: Extension content script detection (DOM markers) ───
  console.error("\n── Test 2: Extension content script via DOM markers ──");
  const { result: extCs } = await session.Runtime.evaluate({
    expression: `!!(document.getElementById('__Weavetab_cursor_host') || document.getElementById('wt-ui-styles'))`,
    returnByValue: true,
  });
  assert(extCs?.value === true, `extension content script: ${extCs?.value}`);

  // ─── Test 3: Fallback HUD element appears after sendToExtension ───
  console.error("\n── Test 3: Fallback HUD after sendToExtension ──");
  await sendToExtension(session, {
    type: 'Weavetab_STATE',
    hud: { action: 'testing HUD fallback', detail: 'integration test' },
  });
  await sleep(500);

  const { result: fbHud } = await session.Runtime.evaluate({
    expression: `(function(){
      var sr = document.getElementById('Weavetab-root');
      if (!sr || !sr.shadowRoot) return 'no shadow root';
      var h = sr.shadowRoot.getElementById('wt-fallback-hud');
      if (!h) return 'not found';
      return h.children.length > 0 ? 'has entries: ' + h.children.length : 'empty';
    })()`,
    returnByValue: true,
  });
  assert(fbHud?.value && !fbHud.value.includes('not'), `fallback HUD: ${fbHud?.value}`);

  // ─── Test 4: Fallback cursor after sendToExtension with cursor data ───
  console.error("\n── Test 4: Fallback cursor moves on cursor message ──");
  await sendToExtension(session, {
    type: 'Weavetab_STATE',
    cursor: { x: 500, y: 300 },
    state: 'hover',
  });
  await sleep(500);

  const { result: fbCursorPos } = await session.Runtime.evaluate({
    expression: `(function(){
      var sr = document.getElementById('Weavetab-root');
      if (!sr || !sr.shadowRoot) return 'no shadow root';
      var c = sr.shadowRoot.getElementById('wt-fallback-cursor');
      if (!c) return 'not found';
      return c.style.left + '|' + c.style.top + '|opacity=' + c.style.opacity;
    })()`,
    returnByValue: true,
  });
  assert(fbCursorPos?.value && fbCursorPos.value.includes('500'), `fallback cursor pos: ${fbCursorPos?.value}`);

  // ─── Test 5: isExtensionLoaded returns true via DOM markers ───
  console.error("\n── Test 5: isExtensionLoaded via DOM markers ──");
  const { result: loaded } = await session.Runtime.evaluate({
    expression: `!!(document.getElementById('__Weavetab_cursor_host') || document.getElementById('wt-ui-styles'))`,
    returnByValue: true,
  });
  assert(loaded?.value === true, `extension loaded: ${loaded?.value}`);

  // ─── Test 6: Fallback thought bubble ───
  console.error("\n── Test 6: Fallback thought bubble ──");
  await sendToExtension(session, {
    type: 'Weavetab_STATE',
    thought: 'testing thought bubble',
  });
  await sleep(500);

  const { result: fbThought } = await session.Runtime.evaluate({
    expression: `(function(){
      var sr = document.getElementById('Weavetab-root');
      if (!sr || !sr.shadowRoot) return 'no shadow root';
      var t = sr.shadowRoot.getElementById('wt-fallback-thought');
      return t ? (t.textContent || 'empty') : 'not found';
    })()`,
    returnByValue: true,
  });
  assert(fbThought?.value === 'testing thought bubble', `fallback thought: ${fbThought?.value}`);

  console.error(`\n── Results: ${passed} passed, ${failed} failed ──`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`[TEST ERROR] ${err.message}`);
  process.exit(1);
});

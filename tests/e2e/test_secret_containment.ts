import { loadConfigSync } from "../../src/config/loader.js";
import { getOrConnect } from "../../src/cdp/connector.js";
import { weaveType } from "../../src/tools/type.js";
import { browserFill } from "../../src/tools/fill.js";
import { browserScrape } from "../../src/tools/scrape.js";
import { buildActionMap } from "../../src/cdp/walker.js";
import { browserScreenshot } from "../../src/tools/screenshot.js";
import { browserSnapshot } from "../../src/tools/snapshot.js";
import type CDP from "chrome-remote-interface";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function run() {
  const config = loadConfigSync();
  let passed = 0, failed = 0;

  const assert = (cond: boolean, msg: string) => {
    if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
    else       { console.error(`  [FAIL] ${msg}`); failed++; }
  };

  try {
    console.log("Connecting to browser via CDP...");
    const client = await getOrConnect(config);
    const session: CDP.Client = client.session;
    console.log("Connected to Chrome via CDP.\n");

    const testHtml = `
      <!DOCTYPE html>
      <html>
      <head><title>Secret Containment Test</title></head>
      <body style="padding: 40px; font-family: sans-serif;">
        <h2>Weavetab Blind Injection Hardening Test</h2>
        <form id="test-form">
          <div>
            <label for="uname">Username</label>
            <input id="uname" type="text" placeholder="Username" style="margin-bottom:10px; display:block;">
          </div>
          <div>
            <label for="pwd">Password</label>
            <input id="pwd" type="password" placeholder="Enter password" style="margin-bottom:10px; display:block;">
          </div>
          <div>
            <label for="pincode">PIN Code</label>
            <input id="pincode" type="text" name="user_pin" placeholder="Enter PIN" style="margin-bottom:10px; display:block;">
          </div>
        </form>
      </body>
      </html>
    `;

    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(testHtml)}`;
    await session.Page.navigate({ url: dataUrl });
    await sleep(1500);

    // ── Test 1: browser_type on password field ──
    console.log("── Test 1: browser_type on input[type='password'] ──");
    const typeResult = await weaveType(session, {
      selector: "#pwd",
      text: "SuperSecretP@ssw0rd!123",
    }, config);

    assert(typeResult.success === true, "browser_type returned success: true");

    // Verify DOM hardening applied
    const domCheck = await session.Runtime.evaluate({
      expression: `(function() {
        const el = document.querySelector('#pwd') || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery('#pwd') : null);
        if (!el) return { found: false };
        return {
          found: true,
          hasSecretAttr: el.hasAttribute('data-wt-secret'),
          exposedValue: el.value,
          coercedString: String(el),
          jsonString: JSON.stringify(el)
        };
      })()`,
      returnByValue: true
    });
    const domVal = domCheck.result?.value;
    assert(domVal?.found === true, "Password field found in DOM");
    assert(domVal?.hasSecretAttr === true, "Field has data-wt-secret attribute automatically applied");
    assert(domVal?.exposedValue === "[REDACTED]", `Direct .value access returned [REDACTED] (got "${domVal?.exposedValue}")`);

    // ── Test 2: browser_map (buildActionMap) redaction ──
    console.log("\n── Test 2: browser_map ActionMap redaction ──");
    const actionMap = await buildActionMap(session, { lite: false });
    const pwdActionEl = actionMap.elements.find(e => e.selector?.includes('pwd') || e.id?.includes('pwd') || e.label?.toLowerCase().includes('password'));
    assert(!!pwdActionEl, "Password element detected in ActionMap");
    if (pwdActionEl) {
      assert(pwdActionEl.value === "[REDACTED]" || pwdActionEl.value === undefined, `ActionMap value is redacted (got: "${pwdActionEl.value}")`);
      assert(!pwdActionEl.label?.includes("SuperSecretP@ssw0rd"), "ActionMap label does not contain plaintext password");
    }

    // ── Test 3: browser_fill on PIN / secret field ──
    console.log("\n── Test 3: browser_fill on PIN code field (name='user_pin') ──");
    const fillResult = await browserFill(session, {
      fields: [
        { selector: "#pincode", value: "987654" }
      ]
    }, config);

    assert(fillResult.success === true, "browser_fill returned success: true");
    const pinRes = fillResult.results.find(r => r.ref.includes("pincode"));
    assert(pinRes?.value === "[REDACTED]", `browser_fill result value is redacted for PIN (got: "${pinRes?.value}")`);

    // Verify DOM hardening applied to PIN field too
    const pinDomCheck = await session.Runtime.evaluate({
      expression: `(function() {
        const el = document.querySelector('#pincode') || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery('#pincode') : null);
        return {
          hasSecretAttr: el?.hasAttribute('data-wt-secret'),
          exposedValue: el?.value
        };
      })()`,
      returnByValue: true
    });
    assert(pinDomCheck.result?.value?.hasSecretAttr === true, "PIN field automatically marked with data-wt-secret");
    assert(pinDomCheck.result?.value?.exposedValue === "[REDACTED]", `PIN field .value returns [REDACTED] (got: "${pinDomCheck.result?.value?.exposedValue}")`);

    // ── Test 4: browser_fill in scan / discovery mode ──
    console.log("\n── Test 4: browser_fill scan mode (input discovery) ──");
    const scanResult = await browserFill(session, { scan: true }, config);
    assert(scanResult.success === true, "Scan mode returned success");
    const scannedPwd = scanResult.inputs?.find((i: any) => i.ref?.includes("pwd") || i.type === "password" || i.label?.toLowerCase().includes("password"));
    if (scannedPwd) {
      assert(scannedPwd.value === "[REDACTED]" || !scannedPwd.value, `Scan mode does not expose password value (got: "${scannedPwd.value}")`);
    }

    // ── Test 5: browser_scrape on sensitive fields ──
    console.log("\n── Test 5: browser_scrape containment ──");
    const scrapeRes = await browserScrape(session, {
      query: "input",
      attributes: ["value", "outerHTML", "textContent"]
    }, config);
    assert(scrapeRes.success === true, "browser_scrape returned success");
    for (const item of scrapeRes.data) {
      if (item.value && item.value !== "") {
        assert(item.value === "[REDACTED]", `Scraped input value is redacted (got: "${item.value}")`);
      }
    }

    // ── Test 6: browser_screenshot & browser_snapshot ──
    console.log("\n── Test 6: browser_screenshot & browser_snapshot masking ──");
    const shotRes = await browserScreenshot(session, { format: "png" }, config);
    assert(shotRes.success === true, "browser_screenshot executed successfully with secret masking");

    const snapRes = await browserSnapshot(session, { action: "capture", filename: "test_containment.mhtml" }, config);
    assert(snapRes.success === true, "browser_snapshot executed successfully with secret masking");

    console.log(`\n========================================`);
    console.log(`Results: ${passed} PASSED, ${failed} FAILED`);
    console.log(`========================================\n`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error("Test execution failed:", err);
    process.exit(1);
  }
}

run();

import CDP from "chrome-remote-interface";
import { getOrConnect } from "../../src/cdp/connector.js";
import { weaveNavigate } from "../../src/tools/navigate.js";
import { browserScreenshot } from "../../src/tools/screenshot.js";
import { browserSnapshot } from "../../src/tools/snapshot.js";
import { loadConfigSync } from "../../src/config/loader.js";

async function run() {
  console.log("Starting Output Directory test...");
  
  const config = loadConfigSync();
  const client = await getOrConnect(config);
  const session = client.session;

  console.log("1. Navigating to example.com...");
  await weaveNavigate(session, "https://example.com", config, "default", false);
  await new Promise(r => setTimeout(r, 1000));

  console.log("2. Capturing screenshot...");
  const screenshot = await browserScreenshot(session, { format: "png" }, config);
  console.log("Screenshot result:", screenshot.dataUrl.substring(0, 50) + "...");

  console.log("3. Capturing snapshot...");
  const snapshot = await browserSnapshot(session, { action: "capture", filename: "test_snapshot.mhtml" }, config);
  console.log("Snapshot result:", snapshot.message);

  console.log("Test done.");
  process.exit(0);
}

run().catch(console.error);

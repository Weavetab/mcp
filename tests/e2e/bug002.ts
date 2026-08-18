import CDP from "chrome-remote-interface";
import { getOrConnect } from "../../src/cdp/connector.js";
import { weaveNavigate } from "../../src/tools/navigate.js";
import { browserFill } from "../../src/tools/fill.js";
import { sessionRegistry } from "../../src/state/session.js";
import { loadConfigSync } from "../../src/config/loader.js";

async function run() {
  console.log("Starting test for BUG-002...");

  // Connect to Chrome
  const config = loadConfigSync();
  if (!config.policies) config.policies = [];
  const client = await getOrConnect(config);
  const session = client.session;

  sessionRegistry.register(session, config.agentId || "test-agent", "default");

  // 1. Navigate to a test page that has a simple input
  console.log("1. Navigating to mock react page...");
  const url = "file:///" + process.cwd().replace(/\\/g, "/") + "/tests/e2e/mock_react.html";
  await weaveNavigate(session, url, config, "default", false);
  await new Promise(r => setTimeout(r, 1000));

  // 2. Try to fill the "custname" input (we will find it by attribute or just aria-label, but we can also just use CSS)
  console.log("2. Filling field...");
  try {
    const result = await browserFill(session, {
      fields: [
        { ref: "input[name='custname']", value: "TestName" }
      ]
    }, config);
    console.log("Fill result:", JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("Fill error:", e);
  }

  console.log("Test done.");
  process.exit(0);
}

run().catch(console.error);

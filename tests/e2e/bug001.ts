import CDP from "chrome-remote-interface";
import { getOrConnect } from "../../src/cdp/connector.js";
import { weaveNavigate } from "../../src/tools/navigate.js";
import { browserMap } from "../../src/tools/read.js";
import { weaveType } from "../../src/tools/type.js";
import { sessionRegistry } from "../../src/state/session.js";
import { loadConfigSync } from "../../src/config/loader.js";

async function run() {
  console.log("Starting test for BUG-001...");

  // Connect to Chrome
  const config = loadConfigSync();
  if (!config.policies) config.policies = [];
  const client = await getOrConnect(config);
  const session = client.session;

  sessionRegistry.register(session, config.agentId || "test-agent", "default");



  // 1. Navigate to a test page
  console.log("1. Navigating...");
  await weaveNavigate(session, "https://example.com", config, "default", false);
  await new Promise(r => setTimeout(r, 1000));

  // 2. Initial Map
  console.log("2. Initial Map...");
  const map1 = await browserMap(session, {}, "default", config);
  console.log("Map 1 returned length:", map1.length);
  // Extract ref of something
  const match = map1.match(/\[(wt[a-z0-9_]+)\]/);
  const ref = match ? match[1] : "w:test";

  // 3. Type (simulate a non-mutating action or just an action)
  // We can just call browserType on a non-existent field to trigger the trail
  console.log(`3. Typing on ref ${ref}...`);
  try {
    await weaveType(session, { ref, value: "test" }, config);
  } catch (e) {
    console.log("Type result (error expected if not input):", e.message);
  }

  // 4. Second Map
  console.log("4. Second Map (should return valid refs, not 'skipped')...");
  const map2 = await browserMap(session, {}, "default", config);
  console.log("Map 2 Snippet:\n", map2.slice(0, 500));

  console.log("Test done.");
  process.exit(0);
}

run().catch(console.error);

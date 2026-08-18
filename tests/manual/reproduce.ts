import { getOrConnect } from "../../src/cdp/connector.js";
import { loadConfig } from "../../src/config/loader.js";
import { browserMap } from "../../src/tools/read.js";

async function reproduce() {
  console.log("Starting reproduction...");
  try {
    const config = await loadConfig();
    console.log("Config loaded:", config);

    const client = await getOrConnect(config);
    console.log("Connected to browser. Tab:", client.title);

    const mapResult = await browserMap(client.session, {}, client.targetId, config);
    console.log("browser_map result length:", mapResult.length);
    console.log("browser_map preview:", mapResult.slice(0, 500));

    console.log("SUCCESS — exiting.");
    process.exit(0);
  } catch (error) {
    console.error("Reproduction failed:", error);
    process.exit(1);
  }
}

reproduce();

/**
 * electron.test.ts
 * Unit tests for Electron desktop app configuration, profile isolation, and session locking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import {
  validateConfigInternal,
  getElectronAppConfig,
  getElectronAppNames,
  getElectronApps,
  getSystemAppDir,
} from "../../src/config/loader.js";
import {
  sanitizeAppName,
  assertNotRealElectronProfile,
  getElectronProfile,
} from "../../src/cdp/profiles.js";
import {
  getLockFilePath,
  getMutexFilePath,
} from "../../src/cdp/lock.js";
import { sessionRegistry } from "../../src/state/session.js";

test("electron config: parses path shorthand, port shorthand, url, and full objects", () => {
  const dummyExe = path.join(os.tmpdir(), `dummy-app-${Date.now()}.exe`);
  fs.writeFileSync(dummyExe, "dummy binary");

  try {
    const rawConfig = {
      browserPath: "auto",
      electron: {
        "app-by-path": dummyExe,
        "app-by-port-num": 9222,
        "app-by-port-str": "9223",
        "app-by-url": "http://localhost:9224",
        "app-full": {
          path: dummyExe,
          port: 9225,
          args: ["--enable-logging"],
        },
      },
    };

    const validated = validateConfigInternal(rawConfig);
    assert.ok(validated.electron, "electron config parsed");

    const apps = getElectronApps(validated);
    assert.equal(apps["app-by-path"].path, dummyExe);
    assert.equal(apps["app-by-port-num"].port, 9222);
    assert.equal(apps["app-by-port-str"].port, 9223);
    assert.equal(apps["app-by-url"].url, "http://localhost:9224");
    assert.equal(apps["app-by-url"].port, 9224);
    assert.equal(apps["app-full"].port, 9225);
    assert.deepEqual(apps["app-full"].args, ["--enable-logging"]);

    const names = getElectronAppNames(validated);
    assert.deepEqual(names, ["app-by-path", "app-by-port-num", "app-by-port-str", "app-by-url", "app-full"]);

    const single = getElectronAppConfig("app-by-url", validated);
    assert.equal(single?.port, 9224);
  } finally {
    try { fs.unlinkSync(dummyExe); } catch { /* ignore */ }
  }
});

test("electron profiles: sanitizes app names and resolves to ~/.weavetab-system/apps/<appName>", () => {
  assert.equal(sanitizeAppName("../../evil/name"), "evil_name");
  assert.equal(sanitizeAppName("my_dev_app!@#"), "my_dev_app");
  assert.equal(sanitizeAppName(""), "app");

  const testAppName = `test-app-${Date.now()}`;
  try {
    const profileDir = getElectronProfile(testAppName);
    const expectedBase = path.join(os.homedir(), ".weavetab-system", "apps", testAppName);
    assert.equal(path.resolve(profileDir), path.resolve(expectedBase));

    const sysDir = getSystemAppDir(testAppName);
    assert.equal(path.resolve(sysDir), path.resolve(expectedBase));
  } finally {
    try {
      fs.rmSync(path.join(os.homedir(), ".weavetab-system", "apps", testAppName), { recursive: true, force: true });
    } catch { /* ignore */ }
  }
});


test("electron security: assertNotRealElectronProfile prevents targeting real user AppData", () => {
  const home = os.homedir();
  if (process.platform === "win32") {
    const realDir = path.join(home, "AppData", "Roaming", "Slack");
    assert.throws(() => {
      assertNotRealElectronProfile(realDir, "Slack");
    }, /SECURITY BLOCK/);
  } else if (process.platform === "darwin") {
    const realMacDir = path.join(home, "Library", "Application Support", "Slack");
    assert.throws(() => {
      assertNotRealElectronProfile(realMacDir, "Slack");
    }, /SECURITY BLOCK/);
  } else {
    const realLinuxDir = path.join(home, ".config", "Slack");
    assert.throws(() => {
      assertNotRealElectronProfile(realLinuxDir, "Slack");
    }, /SECURITY BLOCK/);
  }

  // Safe isolated directory must not throw
  const safeDir = path.join(home, ".weavetab-system", "apps", "my-app");
  assert.doesNotThrow(() => {
    assertNotRealElectronProfile(safeDir, "my-app");
  });
});

test("electron locks: separate lock and mutex paths for browser vs electron apps", () => {
  const browserLock = getLockFilePath();
  const browserMutex = getMutexFilePath();
  assert.ok(browserLock.endsWith(".weavetab.lock"));
  assert.ok(browserMutex.endsWith(".weavetab.lock.mutex"));

  const appLock = getLockFilePath("my-electron-app");
  const appMutex = getMutexFilePath("my-electron-app");
  assert.ok(appLock.endsWith(".weavetab.electron.my-electron-app.lock"));
  assert.ok(appMutex.endsWith(".weavetab.electron.my-electron-app.lock.mutex"));

  assert.notEqual(browserLock, appLock);
  assert.notEqual(browserMutex, appMutex);
});

test("session registry: keeps distinct active sessions for browser and electron apps", () => {
  const agentId = "agent-test-42";
  const dummyBrowserClient = {
    targetId: "browser-tab-1",
    url: "https://example.com",
    title: "Example",
    session: { close: async () => {} } as any,
    agentId,
    isElectron: false,
  };

  const dummyElectronClient = {
    targetId: "electron-win-1",
    url: "file:///app/index.html",
    title: "Electron App",
    session: { close: async () => {} } as any,
    agentId,
    appName: "my-app",
    isElectron: true,
  };

  sessionRegistry.register("browser-tab-1", dummyBrowserClient);
  sessionRegistry.setActive("browser-tab-1", agentId);

  sessionRegistry.register("electron-win-1", dummyElectronClient);
  sessionRegistry.setActive("electron-win-1", agentId, "my-app");

  const activeBrowser = sessionRegistry.getActive(agentId);
  const activeElectron = sessionRegistry.getActive(agentId, "my-app");

  assert.equal(activeBrowser?.targetId, "browser-tab-1");
  assert.equal(activeBrowser?.isElectron, false);

  assert.equal(activeElectron?.targetId, "electron-win-1");
  assert.equal(activeElectron?.appName, "my-app");
  assert.equal(activeElectron?.isElectron, true);

  // Clean up
  sessionRegistry.unregister("browser-tab-1");
  sessionRegistry.unregister("electron-win-1");
});

test("electron navigation: accepts custom desktop protocols and blocks unsupported protocols", async () => {
  try {
    const { weaveNavigate } = await import("../../src/tools/navigate.js");
    const dummySession = {
      Page: {
        navigate: async () => ({ frameId: "123" }),
        enable: async () => {},
        loadEventFired: async () => {},
        getFrameTree: async () => ({ frameTree: { frame: { url: "app://index.html" } } }),
      },
      Runtime: {
        evaluate: async () => ({ result: { value: "complete" } }),
      },
      DOM: {
        getDocument: async () => ({ root: { nodeId: 1 } }),
      },
    } as any;

    const config = validateConfigInternal({
      agentId: "agent-test-nav",
      electron: {
        "vscode-app": 9222,
      },
    });

    // Allowed custom app protocols should not fail on BLOCKED_PROTOCOL
    const appRes = await weaveNavigate(dummySession, "app://index.html", config, "default", false, true, "vscode-app").catch(e => e);
    if (appRes && typeof appRes === "object" && "error_code" in appRes) {
      assert.notEqual((appRes as any).error_code, "BLOCKED_PROTOCOL");
    }

    const vscodeRes = await weaveNavigate(dummySession, "vscode-webview://main/page", config, "default", false, true, "vscode-app").catch(e => e);
    if (vscodeRes && typeof vscodeRes === "object" && "error_code" in vscodeRes) {
      assert.notEqual((vscodeRes as any).error_code, "BLOCKED_PROTOCOL");
    }

    // Unsupported or blocked protocols MUST be blocked with BLOCKED_PROTOCOL or INVALID_URL
    const ftpRes = await weaveNavigate(dummySession, "ftp://example.com/files", config, "default", false, true, "vscode-app");
    assert.equal((ftpRes as any).error_code, "BLOCKED_PROTOCOL");

    const gopherRes = await weaveNavigate(dummySession, "gopher://example.com", config, "default", false, true, "vscode-app");
    assert.equal((gopherRes as any).error_code, "BLOCKED_PROTOCOL");
  } catch (err) {
    console.error("DEBUG TEST ERROR:", err);
    throw err;
  }
});

test("electron tabs: throws informative error when electron app is not launched", async () => {
  const { WeavetabList, WeavetabConsolidate } = await import("../../src/tools/tabs.js");
  const agentId = "agent-test-tabs";
  const config = validateConfigInternal({ agentId, electron: { "offline-app": 9222 } });

  await assert.rejects(async () => {
    await WeavetabConsolidate(config, "offline-app");
  }, /No active session for Electron app "offline-app"/);
});

test("electron discovery: identifyElectronAppName infers known apps from targets and version info", async () => {
  const { identifyElectronAppName } = await import("../../src/desktop/discovery.js");

  const slackApp = identifyElectronAppName(
    { Browser: "Chrome/120.0.6099.291", "User-Agent": "Mozilla/5.0 Slack/4.36.140" },
    [{ title: "Slack | Engineering Channel", url: "https://app.slack.com/client" }]
  );
  assert.equal(slackApp, "Slack");

  const discordApp = identifyElectronAppName(
    { Browser: "Discord/1.0.9036" },
    [{ title: "Discord", url: "https://discord.com/channels/@me" }]
  );
  assert.equal(discordApp, "Discord");

  const vscodeApp = identifyElectronAppName(
    { Browser: "Visual Studio Code/1.87.0" },
    [{ title: "index.ts - Weavetab - Visual Studio Code", url: "vscode-file://vscode-app" }]
  );
  assert.equal(vscodeApp, "VS Code");

  const fallbackApp = identifyElectronAppName(
    { Browser: "Electron/28.0.0" },
    [{ type: "page", title: "My Custom Desktop Tool", url: "app://main" }]
  );
  assert.equal(fallbackApp, "My Custom Desktop Tool");
});

test("electron discovery: discoverElectronApps probes candidate ports without throwing", async () => {
  const { discoverElectronApps } = await import("../../src/desktop/discovery.js");
  // Test probing empty/closed port safely with fast timeout
  const discovered = await discoverElectronApps([19876]);
  assert.ok(Array.isArray(discovered));
});





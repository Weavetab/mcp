/**
 * config.test.ts
 * Unit tests for config loader:
 * - extension flag (default: true)
 * - migration of legacy sectioned config with visuals/darkMode to simple config with extension
 * - validation of simple config
 * - electron apps helper
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  migrateToSimple,
  validateConfigInternal,
  getConfigExtension,
  getElectronApps,
  DEFAULT_CONFIG,
} from "../../src/config/loader.js";

test("config: DEFAULT_CONFIG has extension: true and no darkMode/visuals", () => {
  assert.equal(DEFAULT_CONFIG.extension, true);
  assert.equal((DEFAULT_CONFIG as any).visuals, undefined);
  assert.equal((DEFAULT_CONFIG as any).darkMode, undefined);
  assert.equal(getConfigExtension(DEFAULT_CONFIG), true);
});

test("config: getConfigExtension returns false when explicitly disabled", () => {
  const cfg = { ...DEFAULT_CONFIG, extension: false };
  assert.equal(getConfigExtension(cfg), false);
});

test("config: migrateToSimple handles legacy visuals and browser.extension", () => {
  const legacyWithVisuals = {
    browser: {
      visuals: false,
      darkMode: true,
      browserType: "chromium",
    },
    security: {
      role: "operator",
    },
  };

  const migrated = migrateToSimple(legacyWithVisuals);
  assert.equal(migrated.extension, false, "Legacy visuals: false maps to extension: false");
  assert.equal((migrated as any).darkMode, undefined, "darkMode should be omitted in simple config");
  assert.equal((migrated as any).visuals, undefined, "visuals should be omitted in simple config");

  const legacyWithExtension = {
    browser: {
      extension: true,
      visuals: false,
    },
  };
  const migrated2 = migrateToSimple(legacyWithExtension);
  assert.equal(migrated2.extension, true, "browser.extension takes priority over visuals");
});

test("config: validateConfigInternal enforces valid types", () => {
  const valid = validateConfigInternal({
    extension: false,
    devMode: true,
    maxTabs: 10,
  });
  assert.equal(valid.extension, false);
  assert.equal(valid.devMode, true);

  const invalidExtension = validateConfigInternal({
    extension: "not-a-bool" as any,
  });
  assert.equal(invalidExtension.extension, true, "Invalid extension should fallback to true");
});

test("config: getElectronApps returns registered electron applications", () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    electron: {
      slack: {
        appPath: "C:\\Users\\User\\AppData\\Local\\slack\\slack.exe",
        debugPort: 9223,
      },
      discord: {
        appPath: "C:\\Users\\User\\AppData\\Local\\Discord\\app.exe",
      },
    },
  };

  const apps = getElectronApps(cfg);
  assert.equal(Object.keys(apps).length, 2);
  assert.equal(apps.slack.debugPort, 9223);
  assert.equal(apps.discord.appPath, "C:\\Users\\User\\AppData\\Local\\Discord\\app.exe");
});

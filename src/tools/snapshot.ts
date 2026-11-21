import CDP from "chrome-remote-interface";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "node:url";
import type { Config } from "../config/loader.js";
import { getOutputDir, getConfigAgentId } from "../config/loader.js";
import { hideWeaveTabOverlay, restoreWeaveTabOverlay, maskSecretFieldsForCapture, restoreSecretFieldsAfterCapture } from "../cdp/helpers.js";
import { clearTabCache } from "../state/cache.js";
import { clearSnapshot } from "../state/delta.js";
import { sessionRegistry } from "../state/session.js";
import { SessionSecretTracker } from "../security/secrets.js";
import { checkDomain, checkReadOnlyAction } from "../security/blacklist.js";

export interface SnapshotOptions {
  action?: "capture" | "restore";
  filename?: string;
  filePath?: string;
  hideOverlay?: boolean;
  app?: string;
}

export async function browserSnapshot(
  session: CDP.Client,
  options: SnapshotOptions,
  config: Config
): Promise<{ success: boolean; message: string; warning?: string }> {
  const action = options.action ?? "capture";
  const active = sessionRegistry.getActive(getConfigAgentId(config), options.app);
  const currentUrl = active?.url || "";
  const isReadOnlyMode =
    config.role === "viewer" || (currentUrl ? checkDomain(currentUrl, config).mode === "read-only" : false);

  if (isReadOnlyMode) {
    const roCheck = checkReadOnlyAction("browser_snapshot", options as unknown as Record<string, unknown>, currentUrl, config);
    if (!roCheck.allowed) {
      throw new Error(`[!] ${roCheck.reason}`);
    }
  }

  let { filename } = options;
  if (!filename) filename = options.filePath;

  if (!filename || !filename.trim()) {
    if (action === "capture") {
      filename = `snapshot-${Date.now()}.mhtml`;
    } else {
      throw new Error("browser_snapshot restore requires a filename or filePath.");
    }
  }

  const snapshotDir = path.resolve(getOutputDir("snapshots", config));
  let filePath = filename.trim();
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(snapshotDir, path.basename(filePath));
  } else {
    filePath = path.resolve(filePath);
    if (isReadOnlyMode && filePath !== snapshotDir && !filePath.startsWith(snapshotDir + path.sep)) {
      throw new Error(`[!] Snapshot filePath must be confined inside snapshotDir (${snapshotDir}) in viewer/read-only mode.`);
    }
  }
  if (!filePath.endsWith(".mhtml")) filePath += ".mhtml";

  if (action === "capture") {
    const shouldHide = options.hideOverlay !== false;
    if (shouldHide) {
      await hideWeaveTabOverlay(session);
    }
    await maskSecretFieldsForCapture(session);

    let snapshotData: string;
    try {
      const res = await session.Page.captureSnapshot({ format: "mhtml" });
      snapshotData = res.data;
    } finally {
      await restoreSecretFieldsAfterCapture(session);
      if (shouldHide) {
        await restoreWeaveTabOverlay(session);
      }
    }

    const targetId = active?.targetId ?? "default";
    const safeSnapshot = SessionSecretTracker.redact(targetId, snapshotData!);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, safeSnapshot, "utf8");
    return { success: true, message: `Snapshot saved to ${filePath}` };
  } else if (action === "restore") {
    try {
      await fs.access(filePath);
    } catch {
      throw new Error(`Snapshot file not found: ${filePath}`);
    }
    const fileUrl = pathToFileURL(filePath).href;
    await session.Page.navigate({ url: fileUrl });

    const targetId = active?.targetId ?? "default";
    clearTabCache(targetId);
    clearSnapshot(targetId);

    return {
      success: true,
      message: `Restored snapshot from ${filePath}`,
      warning: "Ref cache cleared — call browser_map to get fresh w:NN IDs for this restored page before using any ref-based tools.",
    };
  }

  throw new Error("Unknown action");
}

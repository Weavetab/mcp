/**
 * Weavetab — tools/snapshot.ts
 * browser_snapshot: Create and restore MHTML snapshots of the DOM state.
 *
 * Secret containment: before capture, all elements marked data-wt-secret have
 * their value blanked in the live DOM (then restored after capture). This prevents
 * typed credential values from appearing in the MHTML archive.
 *
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import fs from "fs/promises";
import path from "path";
import type { Config } from "../config/loader.js";
import { getOutputDir, getConfigAgentId } from "../config/loader.js";
import { hideWeaveTabOverlay, restoreWeaveTabOverlay, maskSecretFieldsForCapture, restoreSecretFieldsAfterCapture } from "../cdp/helpers.js";
import { clearTabCache } from "../state/cache.js";
import { clearSnapshot } from "../state/delta.js";
import { sessionRegistry } from "../state/session.js";

export interface SnapshotOptions {
  action: "capture" | "restore";
  /** Preferred parameter name. */
  filename?: string;
  /** Accepted alias for filename (sent by the MCP schema). */
  filePath?: string;
  /** If false, keeps the WeaveTab UI overlay visible in the MHTML snapshot.
   * Default: true — overlay (cursor, thought bubble, HUD) is always hidden from snapshots. */
  hideOverlay?: boolean;
}

export async function browserSnapshot(
  session: CDP.Client,
  options: SnapshotOptions,
  config: Config
): Promise<{ success: boolean; message: string; warning?: string }> {
  const { action } = options;
  // Accept both `filename` (original) and `filePath` (MCP schema alias)
  let { filename } = options;
  if (!filename) filename = options.filePath;

  if (!filename || !filename.trim()) {
    throw new Error("browser_snapshot requires a filename.");
  }

  // Strip any absolute path provided by the caller — always save in the managed snapshot dir
  filename = path.basename(filename);
  if (!filename.endsWith(".mhtml")) filename += ".mhtml";

  const snapshotDir = getOutputDir("snapshots", config);
  const filePath = path.join(snapshotDir, filename);

  if (action === "capture") {
    // Always hide overlay before capture (default true); set hideOverlay: false to skip.
    const shouldHide = options.hideOverlay !== false;
    if (shouldHide) {
      await hideWeaveTabOverlay(session);
    }
    // ── Blank secret field values before capture ──────────────────────────
    // Prevents credential values from being embedded in the MHTML archive.
    await maskSecretFieldsForCapture(session);

    let snapshotData: string;
    try {
      const res = await session.Page.captureSnapshot({ format: "mhtml" });
      snapshotData = res.data;
    } finally {
      // ── Restore secret field values after capture (always runs) ──────────
      await restoreSecretFieldsAfterCapture(session);
      if (shouldHide) {
        await restoreWeaveTabOverlay(session);
      }
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, snapshotData!, "utf8");
    return { success: true, message: `Snapshot saved to ${filePath}` };

  } else if (action === "restore") {
    // Navigate to the local MHTML file
    // Note: Chrome must have access to the file path.
    const fileUrl = `file:///${filePath.replace(/\\/g, '/')}`;
    await session.Page.navigate({ url: fileUrl });

    // Invalidate cached ref IDs after restore: the entire DOM is replaced, making
    // all cached w:NN ref IDs stale. Clearing both the action-map cache and the
    // delta snapshot forces the next browser_map / browser_inspect call to rebuild
    // a fresh map with valid refs for the restored page.
    const active = sessionRegistry.getActive(getConfigAgentId(config));
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

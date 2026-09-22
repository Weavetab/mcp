/**
 * Weavetab — tools/upload.ts
 * browser_upload: inject file paths into <input type="file"> elements without OS dialog.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";
import * as fs from "node:fs";
import path from "node:path";

export interface UploadOptions {
  nodeId?: number; // CDP backendNodeId
  ref?: string; // ref ID from browser_map (e.g. "w:42"), auto-resolved
  selector?: string;
  label?: string;
  filePaths: string[]; // absolute paths
}

export async function browserUpload(
  session: CDP.Client,
  options: UploadOptions,
  config: Config
): Promise<{ success: boolean; message: string; file: string }> {
  const { nodeId, ref, selector, label, filePaths } = options;

  if (!filePaths || filePaths.length === 0) {
    throw new Error("browser_upload requires an array of filePaths");
  }

  // Verify files exist locally
  for (const p of filePaths) {
    if (!fs.existsSync(p)) {
      return { success: false, message: `File not found: ${p}`, file: p };
    }
  }

  let targetNodeId = nodeId;
  let finalSelector = selector;

  // Add ref resolution (e.g. "w:42") — works like other tools
  const resolveRef = ref || selector || label;
  let fallbackObjectId: string | undefined;

  if (!targetNodeId && resolveRef) {
    const { buildActionMap } = await import("../cdp/walker.js");
    const { sessionRegistry } = await import("../state/session.js");
    const targetId = sessionRegistry.getActive(getConfigAgentId(config))?.targetId ?? "default";
    const map = await buildActionMap(session, { lite: true }, targetId);

    const element = ref
      ? map.elements.find(el => el.id === ref || el.id.endsWith(ref.startsWith('w:') ? ref.slice(2) : ref))
      : selector
        ? map.elements.find(el => el.id === selector || el.selector === selector)
        : map.elements.find(el => el.label === label);

    if (!element) {
      // ENTERPRISE FIX #7: Fallback to full DOM query for hidden file inputs pruned by lite: true
      try {
        const query = selector 
          ? `(document.querySelector(${JSON.stringify(selector)}) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(${JSON.stringify(selector)}) : null))`
          : `(document.querySelector('input[type="file"]') || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery('input[type="file"]') : document.querySelectorAll('input[type="file"]')[0]))`;
          
        const res = await session.Runtime.evaluate({
          expression: query,
          returnByValue: false
        });
        
        if (res.result && res.result.objectId && res.result.subtype === 'node') {
          fallbackObjectId = res.result.objectId;
          finalSelector = selector || 'input[type="file"]';
        }
      } catch (e) {
        // ignore fallback errors
      }

      if (!fallbackObjectId) {
        throw new Error(`Upload input not found matching "${resolveRef}" — use browser_map to see available elements with their ref IDs, or provide a CSS selector`);
      }
    } else {
      targetNodeId = element.backendNodeId;
      finalSelector = element.selector;
    }
  }

  if (!targetNodeId && !fallbackObjectId) {
    throw new Error("browser_upload requires ref, selector, or label (nodeId is also accepted but prefer ref from browser_map)");
  }

  try {
    if (fallbackObjectId) {
      await session.DOM.setFileInputFiles({
        objectId: fallbackObjectId,
        files: filePaths
      });
    } else if (targetNodeId) {
      const { nodeIds } = await session.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [targetNodeId] });
      if (!nodeIds[0]) throw new Error("Node not found in DOM");

      await session.DOM.setFileInputFiles({
        nodeId: nodeIds[0],
        files: filePaths
      });
    } else {
      throw new Error("No target resolved for upload");
    }

    // Verify upload registered via JS
    let uploaded = false;
    if (finalSelector) {
      const res = await session.Runtime.evaluate({
        expression: `(function(sel) {
          const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
          return el?.files?.length > 0;
        })(${JSON.stringify(finalSelector)})`,
        returnByValue: true
      }).catch(() => null);
      uploaded = res?.result?.value === true;
    } else {
      uploaded = true; // Cannot verify without selector
    }

    return { 
      success: uploaded, 
      message: `attached ${filePaths.length} file(s)`,
      file: path.basename(filePaths[0])
    };
  } catch (error) {
    throw new Error(`Failed to upload: ${error}`);
  }
}

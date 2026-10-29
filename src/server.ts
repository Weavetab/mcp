/**
 * Weavetab — server.ts
 * MCP server: 41 browser automation tools with security, rate limiting, and visual overlay.
 * Weavetab by fy2ne
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WEAVETAB_VERSION } from "./version.js";
import { getOrConnect } from "./cdp/connector.js";
import { checkRateLimit } from "./security/ratelimit.js";
import { checkDomain, isToolAllowedInMode } from "./security/blacklist.js";
import type { Role } from "./config/loader.js";
import { logAction, logActionStructured } from "./audit/logger.js";
import { recordToolUsage, broadcastTelemetry } from "./audit/telemetry.js";
import type { Config } from "./config/loader.js";
import { clearLock, readLock } from "./cdp/lock.js";

import { browserMap } from "./tools/read.js";
import { weaveNavigate } from "./tools/navigate.js";
import { weaveClick } from "./tools/click.js";
import { weaveType } from "./tools/type.js";
import { weaveTypeSecret } from "./tools/type_secret.js";
import { weaveKey } from "./tools/key.js";
import { WeavetabOpen, WeavetabSwitch, WeavetabList, WeavetabClose, WeavetabCloseBatch, WeavetabConsolidate, WeavetabHeal, weaveWindowList, weaveFocusWindow } from "./tools/tabs.js";
import { browserScroll } from "./tools/scroll.js";
import { browserDialog } from "./tools/dialog.js";
import { browserBurst } from "./tools/burst.js";
import { browserWait } from "./tools/wait.js";
import { browserPointer } from "./tools/pointer.js";
import { browserSelect } from "./tools/select.js";
import { browserFill } from "./tools/fill.js";
import { browserHighlight } from "./tools/highlight.js";
import { browserUpload } from "./tools/upload.js";
import { browserFind } from "./tools/find.js";
import { browserStorage } from "./tools/storage.js";
import { browserNetworkIntercept } from "./tools/network_intercept.js";
import { browserConsole } from "./tools/console.js";
import { browserPdf } from "./tools/pdf.js";
import { browserEval } from "./tools/eval.js";
import { browserCookies } from "./tools/cookies.js";
import { browserCanvas } from "./tools/canvas.js";
import { browserScrape } from "./tools/scrape.js";
import { browserSnapshot } from "./tools/snapshot.js";
import { browserScreenshot } from "./tools/screenshot.js";
import { browserViewport } from "./tools/viewport.js";
import { browserClipboard } from "./tools/clipboard.js";
import { browserInspect } from "./tools/inspect.js";
import { browserExtractDesign } from "./tools/design_extract.js";
import { browserAutomation } from "./tools/automation.js";
import { browserRecording } from "./tools/recording.js";
import { browserPerformance } from "./tools/performance.js";
import { detectBrowsers } from "./tools/browser_detect.js";
import { browserThought } from "./tools/thought.js";
import { browserCaptcha } from "./tools/captcha.js";
import { browserEmulate } from "./tools/emulation.js";
import { browserCheckpoint } from "./tools/checkpoint.js";
import { getActiveEngine } from "./cdp/connector.js";
import { resetLoopCounter } from "./intelligence/trail.js";
import { getSiteProfile, learnPattern, recordPatternExecution, recordQuirk, getPatternReliability, formatSiteProfileHint } from "./intelligence/patternCompiler.js";

import { discoverPlugins } from "./plugin/loader.js";
import type { WeavetabPlugin } from "./plugin/interface.js";
import { hookPipeline } from "./plugin/pipeline.js";
import { toPluginInputShape } from "./plugin/schema.js";
import { agentAction } from "./sensors/pacing.js";
import { getCachedConfig, getElectronApps } from "./config/loader.js";
import { agentState } from "./state/agent.js";
import { SessionSecretTracker } from "./security/secrets.js";
import { sessionRegistry } from "./state/session.js";

// Office document tools
import { browserOfficeParse, browserOfficeList } from "./tools/office/index.js";

const activeLoadedPlugins = new Map<string, WeavetabPlugin>();

type ToolHandler<T> = (session: any, config: Config) => Promise<T>;

const ROLE_TOOL_ALLOW: Record<string, Set<string>> = {
  admin: new Set(["*"]),
  operator: new Set(["*"]),
  viewer: new Set(["browser_map", "browser_find", "browser_scrape", "browser_console", "browser_eval", "browser_inspect", "browser_extract_design", "browser_snapshot", "browser_screenshot", "browser_pdf", "browser_cookies", "browser_tabs", "browser_wait", "browser_pattern_learn"]),
  automation: new Set(["*"]), // Allowed all except interactive tools (enforced in isToolAllowedForRole)
  system: new Set(["browser_thoughts", "browser_detect", "browser_performance", "browser_checkpoint", "browser_pattern_learn"]),
};

function isToolAllowedForRole(role: Role, toolName: string): { allowed: boolean; reason?: string } {
  if (role === "automation" && toolName === "browser_thoughts") {
    return { allowed: false, reason: "Role 'automation' does not have permission to use 'browser_thoughts'. Automation agents must be non-interactive." };
  }
  const allowed = ROLE_TOOL_ALLOW[role];
  if (!allowed) return { allowed: true };
  if (allowed.has("*")) return { allowed: true };
  if (allowed.has(toolName)) return { allowed: true };
  return { allowed: false, reason: `Role '${role}' does not have permission to use '${toolName}'. ${role === "viewer" ? "Viewer role only permits read-only tools (map/find/scrape/console/eval/inspect/snapshot/pdf/cookies)." : ""}` };
}

/** Push a rich log card to every active browser session's overlay. Only shown when devMode is on. */
async function pushRichLog(
  agentId: string,
  toolName: string,
  title: string,
  details: string,
  status: "success" | "error" | "info",
  devMode = false
): Promise<void> {
  if (!devMode) return;
  try {
    const { sessionRegistry } = await import("./state/session.js");
    const sessions = sessionRegistry.getAllForAgent(agentId);
    const { sendToExtension } = await import("./cdp/helpers.js");
    await Promise.all(
      sessions.map(({ session }) =>
        sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: `${status === 'error' ? '[ERR]' : '[OK]'} ${title}` } })
      )
    );
  } catch { /* non-fatal */ }
}

function withTimeoutGuard<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[!] ${label} timed out after ${timeoutMs / 1000}s. Target page or browser did not respond.`));
    }, timeoutMs);
  });
  return Promise.race([fn(), timeoutPromise]).finally(() => clearTimeout(timer!));
}

function inferTargetApp(
  requestedApp?: string,
  url?: string,
  tabId?: string
): string | undefined {
  if (requestedApp) {
    const lower = requestedApp.toLowerCase().trim();
    if (lower === "browser" || lower === "chrome" || lower === "chromium") {
      sessionRegistry.setLastActiveApp(null);
      return undefined;
    }
    sessionRegistry.setLastActiveApp(lower);
    return lower;
  }

  // 1. Infer from tabId if provided
  if (tabId) {
    const registered = sessionRegistry.findClientByTargetId(tabId);
    if (registered && registered.isElectron && registered.appName) {
      sessionRegistry.setLastActiveApp(registered.appName);
      return registered.appName;
    }
  }

  // 2. Infer from URL domain if provided
  if (url) {
    const config = getCachedConfig();
    const apps = getElectronApps(config);
    const u = url.toLowerCase();
    for (const appKey of Object.keys(apps)) {
      if (appKey === "discord" && (u.includes("discord.com") || u.startsWith("discord:"))) {
        logAction("target_router", "auto_route", `Auto-routing URL to Electron app "${appKey}"`);
        sessionRegistry.setLastActiveApp(appKey);
        return appKey;
      }
      if (appKey === "slack" && (u.includes("slack.com") || u.startsWith("slack:"))) {
        logAction("target_router", "auto_route", `Auto-routing URL to Electron app "${appKey}"`);
        sessionRegistry.setLastActiveApp(appKey);
        return appKey;
      }
      if (appKey === "linear" && (u.includes("linear.app") || u.startsWith("linear:"))) {
        logAction("target_router", "auto_route", `Auto-routing URL to Electron app "${appKey}"`);
        sessionRegistry.setLastActiveApp(appKey);
        return appKey;
      }
      if (appKey === "notion" && (u.includes("notion.so") || u.startsWith("notion:"))) {
        logAction("target_router", "auto_route", `Auto-routing URL to Electron app "${appKey}"`);
        sessionRegistry.setLastActiveApp(appKey);
        return appKey;
      }
    }
  }

  // 3. Fall back to sticky active session if no web browser is running
  const hasActiveBrowser = sessionRegistry.isBrowserSessionActive();
  if (!hasActiveBrowser) {
    const lastApp = sessionRegistry.getLastActiveApp();
    if (lastApp) {
      return lastApp;
    }
    const allElectrons = sessionRegistry.getActiveElectronClients();
    if (allElectrons.length === 1 && allElectrons[0]?.appName) {
      const soleApp = allElectrons[0].appName;
      sessionRegistry.setLastActiveApp(soleApp);
      return soleApp;
    }
  }

  return undefined;
}

async function withSecurity<T>(
  config: Config,
  toolName: string,
  handler: ToolHandler<T>,
  isOfficial = false,
  targetApp?: string,
  requiresSession = true
): Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> }> {
  const liveConfig = getCachedConfig();

  const rl = checkRateLimit(liveConfig);
  if (!rl.allowed) {
    throw new Error(`[!] Rate limit exceeded. Retry in ${rl.retryAfterMs}ms`);
  }

  if (!isOfficial) {
    // Phase 7d: RBAC role permission check (checked BEFORE browser launch)
    const roleToolCheck = isToolAllowedForRole(liveConfig.role, toolName);
    if (!roleToolCheck.allowed) {
      throw new Error(`[!] ${roleToolCheck.reason}`);
    }
  }

  const resolvedTargetApp = requiresSession ? inferTargetApp(targetApp) : undefined;

  let session: any;
  if (requiresSession) {
    ({ session } = await withTimeoutGuard(() => getOrConnect(liveConfig, resolvedTargetApp), 15000, `CDP Connection (${toolName}${resolvedTargetApp ? `:${resolvedTargetApp}` : ''})`));
    agentState.setSession(session);
  }
  (global as any).__wt_live_config = liveConfig;

  const { sendToExtension } = await import("./cdp/helpers.js");
  const chatMessages: string[] = [];

  if (requiresSession) {
    try {
      const stopCheck = await session.Runtime.evaluate({
        expression: 'window.__wt_stop_requested===true',
        returnByValue: true,
      });
      if (stopCheck?.result?.value === true) {
        await session.Runtime.evaluate({ expression: 'window.__wt_stop_requested=false;' }).catch(()=>{});
        await sendToExtension(session, { type: 'Weavetab_GROUP_STATE', state: 'idle' }).catch(()=>{});
        await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: '' } }).catch(()=>{});
        await sendToExtension(session, { type: 'Weavetab_CLEAR_THOUGHT' }).catch(()=>{});
        agentState.reportTransportClosed();
        throw new Error('[!] mission stopped by user via HUD.');
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('[!]')) throw e;
    }

    if (!isOfficial) {
      // Phase 7c: Domain policy check for read-only / deny / audit-only modes
      const activeClient = sessionRegistry.getActive(liveConfig.agentId, targetApp);
      if (activeClient?.url && !activeClient.isElectron) {
        const domainCheck = checkDomain(activeClient.url, liveConfig);
        if (!domainCheck.allowed) {
          throw new Error(`[!] ${domainCheck.reason}`);
        }
        if (domainCheck.mode === "deny") {
          throw new Error(`[!] Domain denied by policy`);
        }
        if (domainCheck.mode === "read-only") {
          const toolCheck = isToolAllowedInMode(toolName, "read-only");
          if (!toolCheck.allowed) {
            throw new Error(`[!] ${toolCheck.reason}`);
          }
        }
      }
    }

    // Push config to extension once per session (idempotent, ignored if already set)
    sendToExtension(session, {
      type: 'Weavetab_CONFIG',
      groupTabs: (liveConfig as any).groupTabs,
      devMode: liveConfig.devMode,
    }).catch(() => {});
    if (liveConfig.devMode) {
      sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: 'Mission Running', detail: toolName } }).catch(() => {});
    }

    try {
      const { result: hasMsg } = await session.Runtime.evaluate({
        expression: 'window.__wt_chat_queue&&window.__wt_chat_queue.length>0',
        returnByValue: true,
      });
      if (hasMsg?.value === true) {
        const { result: qResult } = await session.Runtime.evaluate({
          expression: `(function(){ const q=window.__wt_chat_queue||[];window.__wt_chat_queue=[];return JSON.stringify(q); })()`,
          returnByValue: true,
        });
        const raw = qResult?.value as string | undefined;
        if (raw && raw !== '[]') {
          chatMessages.push(...JSON.parse(raw));
          for (const msg of chatMessages) {
            logAction('chat_queue', toolName, msg);
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  // Emit a "started" info log so the user sees the tool immediately
  const argsPreview = '(executing…)';
  pushRichLog(liveConfig.agentId, toolName, ` ${toolName} ${argsPreview}`, '', 'info', !!liveConfig.devMode);

  agentState.reportToolCall();

  const t0 = Date.now();
  try {
    const result = await withTimeoutGuard(() => handler(session, liveConfig), 22000, toolName);
    agentState.reportToolSuccess();
    const ms = Date.now() - t0;

    const activeClient = sessionRegistry.getActive(liveConfig.agentId, targetApp);
    logActionStructured({
      timestamp: new Date(t0).toISOString(),
      sessionId: activeClient?.targetId,
      tool: toolName,
      duration: ms,
      result: "success",
      pageUrl: activeClient?.url,
      tabTitle: activeClient?.title,
    });

    // Phase 10g: record tool usage for analytics (opt-in via telemetry:true in config)
    if (liveConfig.telemetry) {
      recordToolUsage({
        tool: toolName,
        domain: activeClient?.url ? new URL(activeClient.url).hostname : "(unknown)",
        duration: ms,
        success: true,
        timestamp: new Date(t0).toISOString(),
      });
      broadcastTelemetry({ type: "tool_end", payload: { tool: toolName, duration: ms, success: true } });
    }

    // Token estimation + devMode gating
    let tokenStr = '';
    if (liveConfig.devMode) {
      try {
        const raw = JSON.stringify(result);
        const out = Math.ceil(raw.length / 4);
        tokenStr = ` · ~${out}tok`;
      } catch { /* skip */ }
    }

    if (liveConfig.devMode) {
      // Build a brief details string from the result
      let details = '';
      try {
        const raw = JSON.stringify(result);
        details = raw.length > 800 ? raw.slice(0, 800) + '…' : raw;
      } catch { details = String(result); }

      await pushRichLog(
        liveConfig.agentId,
        toolName,
        `${toolName}  ·  ${ms}ms${tokenStr}`,
        details,
        'success',
        true
      );

      if (session) {
        await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: `[OK] ${toolName} (${ms}ms${tokenStr})` } });
      }
    }

    // ── Image block output: return proper MCP image block for screenshot results ──
    // If the result contains a dataUrl (e.g. from browser_screenshot), extract the
    // base64 data and mimeType and return them as a native MCP image block.
    // This prevents the model's context from being flooded with raw base64 text,
    // and allows multimodal models to actually see the image.
    let content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
    const resultAny = result as any;

    // Strip execution_ms from output unless devMode is enabled — reduces noise and context tokens for users
    if (!liveConfig.devMode && resultAny && typeof resultAny === 'object' && 'execution_ms' in resultAny) {
      delete resultAny.execution_ms;
    }

    if (resultAny && typeof resultAny === 'object' && typeof resultAny.dataUrl === 'string' && resultAny.dataUrl.startsWith('data:')) {
      const dataUrl = resultAny.dataUrl as string;
      const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
      const base64Data = mimeMatch ? dataUrl.slice(mimeMatch[0].length) : '';
      const isB64 = base64Data.length > 0 && base64Data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64Data);
      const { dataUrl: _omit, ...metaOnly } = resultAny;
      content = [
        { type: "text" as const, text: JSON.stringify(metaOnly) },
      ];
      if (mimeMatch && isB64) {
        content.push({ type: "image" as const, data: base64Data, mimeType: mimeMatch[1] });
      }
    } else if (resultAny && typeof resultAny === 'object' && Array.isArray(resultAny.content)) {
      // Passthrough if already conforming McpToolResult (prevents double JSON wrapping)
      content = resultAny.content;
    } else if (typeof result === 'string') {
      content = [{ type: "text" as const, text: result }];
    } else {
      content = [{ type: "text" as const, text: JSON.stringify(result) }];
    }
    if (chatMessages.length > 0) {
      for (const rawMsg of chatMessages) {
        let msgObj: any = null;
        try {
          msgObj = JSON.parse(rawMsg);
        } catch {
          msgObj = null;
        }

        if (msgObj && (msgObj.snipe || msgObj.type === 'USER_SNIPE_ANNOTATION')) {
          const snipe = msgObj.snipe || msgObj;
          const userComment = msgObj.text || snipe.comment || 'Annotated area selected on page';

          let snipeText = `[URGENT USER TARGETED AREA ANNOTATION - ACTION REQUIRED IMMEDIATELY]:\n`;
          snipeText += `User Instruction / Comment: "${userComment}"\n\n`;

          if (snipe.elements && Array.isArray(snipe.elements) && snipe.elements.length > 0) {
            snipeText += `Targeted DOM Elements in Selection Area:\n`;
            for (const el of snipe.elements) {
              snipeText += `- Tag: <${el.tag || 'elem'}> | Selector: ${el.selector || 'n/a'} | Text: "${el.text || ''}"${el.ref ? ` | Ref: ${el.ref}` : ''}\n`;
            }
          }

          if (snipe.boundingRect) {
            snipeText += `Selection Box Coordinates: [x:${snipe.boundingRect.x}, y:${snipe.boundingRect.y}, w:${snipe.boundingRect.width}, h:${snipe.boundingRect.height}]\n`;
          }

          snipeText += `\n[MANDATORY INSTRUCTION]: Act on this targeted user annotation IMMEDIATELY.`;

          content.unshift({
            type: "text" as const,
            text: snipeText
          });

          // Attach native image block if visual crop mode was used
          if (snipe.mode === 'visual_crop' && snipe.cropImage && typeof snipe.cropImage === 'string' && snipe.cropImage.startsWith('data:')) {
            const mimeMatch = snipe.cropImage.match(/^data:([^;]+);base64,/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'image/webp';
            const base64Data = snipe.cropImage.replace(/^data:[^;]+;base64,/, '');
            content.unshift({
              type: "image" as const,
              data: base64Data,
              mimeType: mimeType
            });
          }
        } else {
          content.unshift({
            type: "text" as const,
            text: `[USER MESSAGE]:\n- ${typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg)}\nProcess this user message naturally. If they asked a question, answer it clearly via a thought bubble. If they gave an instruction or correction, act on it immediately. Keep responses brief and action-oriented.`
          });
        }
      }
    }
    return { content };
  } catch (err) {
    const ms = Date.now() - t0;
    const errMsg = err instanceof Error ? err.message : String(err);
    agentState.reportToolError();

    const activeClient = sessionRegistry.getActive(liveConfig.agentId, targetApp);
    logActionStructured({
      timestamp: new Date(t0).toISOString(),
      sessionId: activeClient?.targetId,
      tool: toolName,
      duration: ms,
      result: `error: ${errMsg}`,
      pageUrl: activeClient?.url,
      tabTitle: activeClient?.title,
    });

    if (liveConfig.devMode) {
      await pushRichLog(
        liveConfig.agentId,
        toolName,
        `${toolName}  ·  FAILED  ·  ${ms}ms`,
        errMsg,
        'error',
        true
      );

      if (session) {
        await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: `[ERR] ${toolName} Error` } });
      }
    }
    throw err;
  }
}

function wrapError(err: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  let message = err instanceof Error ? err.message : String(err);
  message = SessionSecretTracker.redactAll(message);
  logAction("ERROR", "server", message);
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function startServer(config: Config, transportMode: "stdio" | "ws" = "stdio", wsPort = 3000): Promise<void> {
  const server = new McpServer({ name: "Weavetab MCP", version: WEAVETAB_VERSION });

  // Intercept server.tool to inject global plugin middleware hooks (onBeforeAction, onAfterAction)
  const rawTool = server.tool.bind(server);
  (server as any).tool = function (name: string, ...rest: any[]) {
    const rawHandler = rest[rest.length - 1];
    if (typeof rawHandler === "function") {
      rest[rest.length - 1] = async (args: any, extra: any) => {
        try {
          const session = agentState.getSession() ?? sessionRegistry.getActive(config.agentId)?.session;
          const dispatchedArgs = await hookPipeline.dispatchBeforeToolCall(name, args || {}, session);
          const result = await rawHandler(dispatchedArgs, extra);
          const finalResult = await hookPipeline.dispatchAfterToolCall(name, dispatchedArgs, result, session);
          return finalResult;
        } catch (err: any) {
          if (err?.isBlocked || err?.__blocked) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `[!] Action '${name}' blocked by plugin: ${err.message}` }],
            };
          }
          throw err;
        }
      };
    }
    return (rawTool as any)(name, ...rest);
  };

  agentState.setIdleTimeout(config.idleTimeout ?? 60000);
  agentState.setCallbacks({
    onStateChange: async (session, state, word) => {
      if (!session) return;
      const { sendToExtension } = await import("./cdp/helpers.js");
      await sendToExtension(session, { type: "Weavetab_GROUP_STATE", state, word }).catch(() => {});
      if (state === "idle") {
        await sendToExtension(session, { type: "Weavetab_STATE", state: "idle", hud: { action: "" } }).catch(() => {});
        await sendToExtension(session, { type: "Weavetab_CLEAR_THOUGHT" }).catch(() => {});
      }
    },
    onUpdateTabTitle: async (_session, _state) => {
      // handled via extension background & content scripts
    },
  });

  // ── 1. browser_map ─────────────────────────────────────────────────────────
  server.tool(
    "browser_map",
    "Snapshot interactive DOM with volatile ref IDs that invalidate after DOM mutations. For complex SPAs (e.g. GitHub dashboards), use `scope` or `query` to reduce tokens. For forms/pagination/sequential loops, ALWAYS use `delta: true` to save 97% tokens. For canvas/WebGL/Figma pages where the DOM has < 5 interactive elements, use `visual: \"auto\"` to get a numbered screenshot — then use browser_click({ mark: N }) to interact.",
    {
      full: z.boolean().optional().describe("Set to true to return a full markdown table (heavier context) instead of the lite list."),
      lite: z.boolean().optional().describe("Return a compact, token-optimized interactive element list."),
      limit: z.number().optional().describe("Maximum number of elements to return."),
      scope: z.enum(["navigation", "main_content", "main", "sidebar", "form", "modal", "utility"]).optional().describe("Restrict parsing to a semantic page area to save tokens. Useful on dense dashboards. 'main' is an alias for 'main_content'."),
      query: z.string().optional().describe("Filter returned elements by label or role substring. Useful on dense dashboards."),
      delta: z.boolean().optional().describe("Diff mode: return ONLY elements that changed since the last browser_map call (added, removed, or modified). Diffs across time — distinct from prune. Cuts prompt tokens by up to 97% on consecutive calls."),
      ax_tree: z.boolean().optional().describe("Bypass the extension entirely and read raw Chrome Accessibility Tree. Use this if Shadow DOMs hide elements."),
      tab_id: z.string().optional().describe("Read a specific background tab instead of the active one."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
      show_overlays: z.boolean().optional().describe("Default false. Debug only — draws colored element borders via extension (ugly). The blue edge glow is the standard visual indicator, shown automatically during reading states. Only enable this for debugging element boundaries."),
      force: z.boolean().optional().describe("Force a full DOM map rebuild even if loop detection says nothing changed. Bypasses the map skip guard and resets loop strikes."),
      prune: z.boolean().optional().describe("Semantic DOM pruning: compress the current snapshot before returning. Drops hidden elements with no interactive descendants and not referenced by any toggle trigger (aria-controls etc.). Replaces SVG icons with [SVG Icon: label] tokens. Distinct from delta:true — delta diffs across time, prune compresses this snapshot once. Combine both for maximum token efficiency."),
      visual: z.union([z.boolean(), z.literal("auto")]).optional().describe("Set-of-Marks visual grounding. true = always inject numbered badges + return annotated screenshot. \"auto\" = only activate when DOM interactive count < 5 (canvas/WebGL/Figma pages). After receiving marks, use browser_click({ mark: N }) to interact with numbered elements."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_map", async (session, liveConfig) => {
          let targetSession = session;
          let targetId = "default";
          const { sessionRegistry } = await import("./state/session.js");
          const active = sessionRegistry.getActive(liveConfig.agentId, args.app);
          if (active) targetId = active.targetId;

          if (args.tab_id) {
            const { connectToTab } = await import("./cdp/connector.js");
            const client = await connectToTab(args.tab_id, undefined, undefined, undefined, args.app);
            targetSession = client.session;
            targetId = args.tab_id;
          }

          if (args.force) {
            resetLoopCounter("map_force");
          }

          // Structural block — map after no-change click/type is a pure wasted round-trip
          // Skip the skip guard if the user explicitly requests force or delta diff
          if (!args.force && !args.delta) {
            // Get current URL to pass to detectMapAfterNoChange
            const { getCachedActionMap } = await import("./state/cache.js");
            const cachedUrl = getCachedActionMap(targetId)?.url ?? "";
            
            const mapGuard = { shouldSkip: false, allowed: true, lastTool: '', lastRef: '' };
            if (mapGuard.shouldSkip) {
              return {
                content: [{ type: "text" as const, text: JSON.stringify({
                  skipped: true,
                  reason: `DOM did not change after last ${mapGuard.lastTool} on [${mapGuard.lastRef}]. browser_map would return identical refs. Use existing ref IDs or call browser_map only after navigation, a new URL, or a confirmed dom_changed:true interaction.`,
                  last_tool: mapGuard.lastTool,
                  last_ref: mapGuard.lastRef,
                }) }],
              };
            }
          }

          const result = await agentAction(targetSession, 'reading', () => browserMap(targetSession, args, targetId, liveConfig), 'browser_map');

          // Handle visual grounding result (text + annotated image)
          if (result && typeof result === 'object' && 'text' in result) {
            const vr = result as import('./tools/read.js').BrowserMapResult;
            const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
              { type: "text", text: vr.text },
            ];
            if (vr.imageBase64) {
              content.push({ type: "image", data: vr.imageBase64, mimeType: "image/jpeg" });
            }
            return { content };
          }

          return { content: [{ type: "text", text: result as string }] };
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );


  // ── 2. browser_navigate ────────────────────────────────────────────────────
  server.tool(
    "browser_navigate",
    "Navigate to a URL or launch/focus a configured Electron app.",
    {
      url: z.string().optional().describe("Absolute URL to navigate to (must include https:// or app URL). Optional if 'app' is specified."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron' (e.g. 'example' or 'my-dev-app'). When specified, targets or launches the Electron app."),
      force: z.boolean().optional().describe("If true, overwrites current tab even if it's protected (anchor tab). Otherwise opens a new tab automatically."),
      tab_id: z.string().optional().describe("Target a specific tab ID for navigation instead of the active tab.")
    },
    async (args) => {
      try {
        if (!args.url && !args.app) {
          throw new Error("Either 'url' or 'app' must be provided to browser_navigate.");
        }
        const resolvedApp = inferTargetApp(args.app, args.url, args.tab_id);
        return await withSecurity(config, "browser_navigate", async (session, liveConfig) => {
          let targetSession = session;
          let targetId = "default";
          if (args.tab_id) {
            const { connectToTab } = await import("./cdp/connector.js");
            const client = await connectToTab(args.tab_id, undefined, undefined, undefined, resolvedApp);
            targetSession = client.session;
            targetId = args.tab_id;
          }
          if (args.url) {
            const navResult = await agentAction(targetSession, 'navigating', () => weaveNavigate(targetSession, args.url!, liveConfig, targetId, args.force, false, resolvedApp), 'browser_navigate');
            await hookPipeline.dispatchPageNavigate(args.url, targetSession);
            return navResult;
          }
          return { success: true, app: resolvedApp, message: `Connected to Electron app "${resolvedApp}".` };
        }, false, resolvedApp);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 3. browser_click ───────────────────────────────────────────────────────
  server.tool(
    "browser_click",
    "Click a DOM element. Use browser_canvas for charts/canvas. If stuck_warning=true, stop and use browser_map. Pass mark: N to click a numbered element from browser_map({ visual: true/\"auto\" }) without any DOM re-scan.",
    {
      id: z.string().optional().describe("Ref ID from browser_map (e.g. 'w:42'). Primary targeting method. DO NOT SPAM. If stuck_warning is returned, stop retrying and call browser_map first."),
      ref: z.string().optional().describe("Alias for id (e.g. 'w:42')."),
      selector: z.string().optional().describe("CSS selector of the element to click."),
      target: z.string().optional().describe("CSS selector or query string. Alias for selector."),
      label: z.string().optional().describe("Visible text or aria-label to click."),
      intent: z.string().optional().describe("Semantic description of the action (e.g. 'submit login form'). Weavetab checks learned memory first — if a high-confidence selector is found it clicks immediately without DOM resolution. Falls through to normal resolution on a miss; does not error."),
      mark: z.number().int().positive().optional().describe("Mark number from browser_map({ visual: true/\"auto\" }). Clicks the center of the numbered badge seen in the annotated screenshot. Zero DOM walk — instant coordinate dispatch. Use when the page is canvas/WebGL and DOM refs are unavailable."),
      backendNodeId: z.number().optional().describe("Raw CDP backendNodeId for direct hardware targeting."),
      x: z.number().optional().describe("Raw X coordinate. Use for precise positional clicks when element ID is not available."),
      y: z.number().optional().describe("Raw Y coordinate. Use for precise positional clicks when element ID is not available."),
      include_map: z.boolean().optional().describe("Set true to include a full updated page_map in the response. Default false — omit when you already have ref IDs or don't need a DOM refresh."),
      tab_id: z.string().optional().describe("Execute in a specific tab instead of active."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_click", async (session, liveConfig) => {
          let targetSession = session;
          if (args.tab_id) {
            const { connectToTab } = await import("./cdp/connector.js");
            const client = await connectToTab(args.tab_id, undefined, undefined, undefined, args.app);
            targetSession = client.session;
          }
          const normalizedArgs = { ...args };
          if (args.ref && !normalizedArgs.id) normalizedArgs.id = args.ref;
          if (args.selector && !normalizedArgs.id) normalizedArgs.id = args.selector;
          if (args.target && !normalizedArgs.id) normalizedArgs.id = args.target;
          return await agentAction(targetSession, 'clicking', () => weaveClick(targetSession, normalizedArgs, liveConfig), 'browser_click');
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );



// ── 4. browser_type ────────────────────────────────────────────────────────
server.tool(
    "browser_type",
    "Type text into an input field or currently focused element. If id/selector/label is omitted, automatically types directly into document.activeElement without needing a redundant click or browser_map. If target is already focused, skips click to prevent unfocus bugs.",
  {
    id: z.string().optional().describe("Ref ID from browser_map (e.g. 'w:42'). If omitted, types directly into the currently focused element or single page input."),
    ref: z.string().optional().describe("Alias for id (e.g. 'w:42')."),
    selector: z.string().optional().describe("CSS selector of the input field."),
    target: z.string().optional().describe("CSS selector or query string. Alias for selector."),
    label: z.string().optional().describe("Field label or placeholder text. Used for fuzzy matching."),
    intent: z.string().optional().describe("Semantic description of the field (e.g. 'search box', 'username field'). Checked against learned memory first."),
    x: z.number().optional().describe("Raw X coordinate to focus before typing."),
    y: z.number().optional().describe("Raw Y coordinate to focus before typing."),
    text: z.string().describe("Text to type into the field."),
    clearFirst: z.boolean().optional().describe("Wipe existing field content before typing."),
    paste: z.boolean().optional().describe("Instant paste mode via clipboard. Auto-enabled for text longer than 8 chars."),
    include_map: z.boolean().optional().describe("Set true to include a full updated page_map in the response. Default false."),
    tab_id: z.string().optional().describe("Execute in a specific tab instead of active."),
    app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
  },
  async (args) => {
    try {
      return await withSecurity(config, "browser_type", async (session, liveConfig) => {
        let targetSession = session;
        if (args.tab_id) {
          const { connectToTab } = await import("./cdp/connector.js");
          const client = await connectToTab(args.tab_id, undefined, undefined, undefined, args.app);
          targetSession = client.session;
        }
        const normalizedArgs = { ...args };
        if (args.ref && !normalizedArgs.id) normalizedArgs.id = args.ref;
        if (args.selector && !normalizedArgs.id) normalizedArgs.id = args.selector;
        if (args.target && !normalizedArgs.id) normalizedArgs.id = args.target;
        return await agentAction(targetSession, 'typing', () => weaveType(targetSession, normalizedArgs, liveConfig), 'browser_type');
      }, false, args.app);
    } catch (e) { return wrapError(e); }
  }
);

// ── 4b. browser_type_secret ────────────────────────────────────────────────
server.tool(
    "browser_type_secret",
    "Inject a secret from an environment variable.",
  {
    id: z.string().optional().describe("Ref ID from browser_map."),
    ref: z.string().optional().describe("Alias for id (e.g. 'w:42')."),
    target: z.string().optional().describe("Alternative target input element identifier or CSS selector."),
    envKey: z.string().describe("The environment variable key containing the secret."),
    app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
  },
  async (args) => {
    try {
      return await withSecurity(config, "browser_type_secret", async (session, liveConfig) => {
        const normalizedArgs = { ...args };
        if (args.ref && !normalizedArgs.id) normalizedArgs.id = args.ref;
        return await agentAction(session, 'typing', () => weaveTypeSecret(session, normalizedArgs as any, liveConfig), 'browser_type_secret');
      }, false, args.app);
    } catch (e) { return wrapError(e); }
  }
);


  // ── 5. browser_key ─────────────────────────────────────────────────────────
  server.tool(
    "browser_key",
    "Press a keyboard key.",
    {
      key: z.string().describe("Key name: Enter, Escape, Tab, ArrowDown, F5, etc. DO NOT SPAM. If action fails or loops, STOP calling this tool and use browser_map to re-evaluate the page state."),
      modifiers: z.array(z.enum(["Alt", "Ctrl", "Meta", "Shift"])).optional().describe("Array of modifier keys to hold during the press."),
      tab_id: z.string().optional().describe("Execute in a specific tab instead of active."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      const { key, modifiers, tab_id, app } = args;
      try {
        return await withSecurity(config, "browser_key", async (session, liveConfig) => {
          let targetSession = session;
          if (tab_id) {
            const { connectToTab } = await import("./cdp/connector.js");
            const client = await connectToTab(tab_id, undefined, undefined, undefined, app);
            targetSession = client.session;
          }
          return await weaveKey(targetSession, { key, modifiers }, liveConfig);
        }, false, app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 6. browser_scroll ──────────────────────────────────────────────────────
  server.tool(
    "browser_scroll",
    "Scroll the page.",
    {
      id: z.string().optional().describe("Ref ID to scroll into view or scroll inside of. DO NOT SPAM. If action fails or loops, STOP calling this tool and use browser_map to re-evaluate the page state."),
      ref: z.string().optional().describe("Alias for id (e.g. 'w:42')."),
      selector: z.string().optional().describe("CSS Selector of the element to scroll into view."),
      target: z.string().optional().describe("Alternative element identifier or query to scroll into view."),
      label: z.string().optional().describe("Element label to scroll into view."),
      direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction."),
      distance: z.number().optional().describe("Pixels to scroll (default 400)."),
      pixels: z.number().optional().describe("Alias for distance."),
      amount: z.number().optional().describe("Alias for distance."),
      speed: z.enum(["human", "read", "fast"]).optional().describe("Scroll animation speed profile."),
      tab_id: z.string().optional().describe("Execute in a specific tab instead of active. DO NOT SPAM. If action fails or loops, STOP calling this tool and use browser_map to re-evaluate the page state."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_scroll", async (session, liveConfig) => {
          let targetSession = session;
          if (args.tab_id) {
            const { connectToTab } = await import("./cdp/connector.js");
            const client = await connectToTab(args.tab_id, undefined, undefined, undefined, args.app);
            targetSession = client.session;
          }
          const normalizedArgs = { ...args };
          if (args.ref && !normalizedArgs.id) normalizedArgs.id = args.ref;
          if (args.selector && !normalizedArgs.id) normalizedArgs.id = args.selector;
          if (args.target && !normalizedArgs.id) normalizedArgs.id = args.target;
          normalizedArgs.distance = args.distance ?? args.pixels ?? args.amount ?? 400;
          return await browserScroll(targetSession, normalizedArgs, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 7. browser_dialog ──────────────────────────────────────────────────────
  server.tool(
    "browser_dialog",
    "Accept or dismiss JS dialogs (alert, confirm, prompt). Browser sessions only.",
    {
      action: z.enum(["accept", "dismiss"]).describe("Action to perform on the dialog."),
      promptText: z.string().optional().describe("Text to enter if it is a prompt dialog.")
    },
    async (args) => {
      try {
        const liveConfig = getCachedConfig();
        const active = sessionRegistry.getActive(liveConfig.agentId);
        if (active?.isElectron) {
          return { content: [{ type: "text", text: "[Note] JS dialog interception is only available for web browser sessions (Electron apps handle dialogs natively)." }] };
        }
        return await withSecurity(config, "browser_dialog", async (session) => {
          return await browserDialog(session, args as any);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 8. browser_burst ───────────────────────────────────────────────────────
  server.tool(
    "browser_burst",
    "HIGH-SPEED MULTI-ACTION PIPELINE: Executes 2 or more sequential browser actions in a single round-trip without waiting for LLM turns between steps. PREFER THIS over individual single-action calls (e.g. typing + pressing Enter, filling multiple form fields, clicking tabs/buttons then waiting, searching, navigating + reading) to drastically slash latency and token burn. Supports native primitives (browser_click, browser_fill, browser_type, browser_type_secret, browser_navigate, browser_key, browser_scroll, browser_wait, browser_map, etc.) plus ergonomic macro steps (type_and_send, click_and_wait, navigate_and_read, scroll_and_read, fill_form). If compile_from_history: true is passed, automatically compiles recent successful session trail actions into a burst macro.",
    {
      steps: z.array(z.object({
        tool: z.string().describe("Tool name or macro step (e.g. browser_click, browser_fill, browser_type, type_and_send, click_and_wait, navigate_and_read, scroll_and_read, fill_form)."),
        args: z.record(z.unknown()).optional().describe("Tool arguments. Alternatively, arguments may be specified flat on the step object."),
      }).passthrough()).optional().describe("Ordered array of tool calls or macros to execute serially. Either 'steps' or 'actions' may be passed."),
      actions: z.array(z.any()).optional().describe("Alias for 'steps'."),
      compile_from_history: z.boolean().optional().describe("Compile recent successful session trail actions into a macro. If steps are omitted, executes the compiled macro directly."),
      history_limit: z.number().optional().describe("Number of recent session trail entries to consider when compile_from_history is true (default: 20)."),
      dry_run: z.boolean().optional().describe("If true with compile_from_history, returns the compiled steps without executing them."),
      stop_on_error: z.boolean().optional().describe("Halt execution immediately if a step fails to prevent cascading failures (default: true)."),
      batch: z.boolean().optional().describe("If true, defers action map generation until all steps are complete to maximize throughput."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_burst", async (session, liveConfig) => {
          const { browserBurst } = await import("./tools/burst.js");
          return await browserBurst(session, args as any, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 9. browser_tabs ───────────────────────────────────────────────────────
  server.tool(
    "browser_tabs",
    "Manage browser and Electron app tabs/windows (open, switch, close, list). Specify 'app' when targeting desktop apps (e.g. app: 'discord') to avoid opening web browser.",
    {
      action: z.enum(["list", "open", "close", "switch", "list_windows", "focus_window", "consolidate", "heal"]).describe("Action to perform. 'consolidate' deduplicates tabs. 'heal' recovers crashed tabs."),
      url: z.string().optional().describe("URL to open (required for 'open' action)."),
      app: z.string().optional().describe("Optional Electron app name configured in config.json under 'electron'."),
      tabId: z.string().optional().describe("Target Tab ID (required for 'switch' or 'close')."),
      tabIds: z.array(z.string()).optional().describe("Multiple Tab IDs for batch 'close' action."),
      force: z.boolean().optional().describe("Force close protected (anchor) tabs. Use with extreme caution."),
      windowId: z.number().optional().describe("Window ID to focus (required for 'focus_window')."),
      reuse: z.boolean().optional().describe("Default true. When opening a URL already loaded in another tab, focus that tab instead of opening a duplicate."),
    },
    async ({ action, url, app, tabId, tabIds, force, windowId, reuse }) => {
      try {
        const resolvedApp = inferTargetApp(app, url, tabId || (tabIds && tabIds.length > 0 ? tabIds[0] : undefined));
        return await withSecurity(config, "browser_tabs", async (_, liveConfig) => {
          if (action === "list") return await WeavetabList(liveConfig, resolvedApp);
          if (action === "open") {
            if (!url) return { success: false, error_code: "MISSING_PARAM", message: "url is required for action: open" };
            return await WeavetabOpen(url, liveConfig, reuse !== false, resolvedApp);
          }
          if (action === "switch") {
            if (!tabId) return { success: false, error_code: "MISSING_PARAM", message: "tabId is required for action: switch" };
            return await WeavetabSwitch(tabId, liveConfig, resolvedApp);
          }
          if (action === "close") {
            if (tabIds && tabIds.length > 0) return await WeavetabCloseBatch(tabIds, liveConfig, force, resolvedApp);
            if (!tabId) return { success: false, error_code: "MISSING_PARAM", message: "tabId or tabIds is required for action: close" };
            return await WeavetabClose(tabId, liveConfig, force, resolvedApp);
          }
          if (action === "list_windows") {
            return await weaveWindowList(liveConfig, resolvedApp);
          }
          if (action === "focus_window") {
            if (windowId === undefined) return { success: false, error_code: "MISSING_PARAM", message: "windowId is required for action: focus_window" };
            return await weaveFocusWindow(windowId, liveConfig, resolvedApp);
          }
          if (action === "consolidate") {
            return await WeavetabConsolidate(liveConfig, resolvedApp);
          }
          if (action === "heal") {
            return await WeavetabHeal(liveConfig, resolvedApp);
          }
          return { success: false, error_code: "INVALID_ACTION", message: `Invalid action: ${action}` };
        }, false, resolvedApp);
      } catch (e) { return wrapError(e); }
    }
  );


  // ── 11. browser_wait ──────────────────────────────────────────────────────
  server.tool(
    "browser_wait",
    "Pause until a condition is met.",
    {
      for: z.enum(["element", "text", "url", "stable", "network", "auto"]).describe(
        "'stable' = DOM stops mutating, 'network' = 0 pending requests. 'auto' tries to guess."
      ),
      value: z.string().optional().describe("CSS selector, text string, or URL pattern. Not needed for 'stable'/'network'."),
      timeout: z.number().optional().describe("Max wait in ms (default 8000)."),
      tab_id: z.string().optional().describe("Execute in a specific tab instead of active."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_wait", async (session, liveConfig) => {
          let targetSession = session;
          if (args.tab_id) {
            const { connectToTab } = await import("./cdp/connector.js");
            const client = await connectToTab(args.tab_id, undefined, undefined, undefined, args.app);
            targetSession = client.session;
          }
          return await browserWait(targetSession, args, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 11b. browser_captcha ──────────────────────────────────────────────────────
  server.tool(
    "browser_captcha",
    "Autonomous CAPTCHA detection and solving.",
    {
      action: z.enum(["detect", "solve", "wait_for_user", "status"]).describe("Action to perform."),
      timeout: z.number().optional().describe("Timeout in ms (default 120000).")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_captcha", async (session, liveConfig) => {
          return await browserCaptcha(session, args as any, liveConfig);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 12. browser_thoughts ─────────────────────────────────────────────────────────
  server.tool(
    "browser_thoughts",
    "Agent-to-user communication. Renders in the middle down of the page. Use 'question' mode to ask a free-text question. Use 'feedback' mode to provide status updates, analysis, or decisions. Supports element anchoring (e.g. 'w:15') and presentation styles ('observation', 'decision', 'warning', 'question').",
    {
      action: z.enum(["question", "feedback"]).describe("Action to perform."),
      message: z.string().describe("The question to ask, or the feedback/analysis to log."),
      anchor: z.string().optional().describe("Optional element Ref ID (e.g. 'w:15') or CSS selector to visually anchor this thought to on the page."),
      style: z.enum(["observation", "decision", "warning", "question"]).optional().describe("Thought presentation style. Defaults to 'observation' for feedback and 'question' for question."),
      input: z.enum(["sentence", "paragraph"]).optional().describe("Input field type for question mode (default: sentence)."),
      timeout: z.number().optional().describe("Timeout in seconds for question mode before auto-cancel (default: 120)."),
      app: z.string().optional().describe("Optional Electron app name. (Note: thought HUD overlay is browser-only)."),
    },
    async (args) => {
      try {
        const liveConfig = getCachedConfig();
        const active = sessionRegistry.getActive(liveConfig.agentId, args.app);
        if (args.app || active?.isElectron) {
          const { logActionStructured } = await import("./audit/logger.js");
          logActionStructured({
            timestamp: new Date().toISOString(),
            tool: "browser_thoughts",
            result: `[ELECTRON APP FEEDBACK]: ${args.message}`
          });
          return { content: [{ type: "text", text: "[Note] Thought/HUD overlay is disabled for Electron desktop apps (DOM-only execution). Feedback recorded in audit log." }] };
        }
        return await withSecurity(config, "browser_thoughts", async (session) => {
          if (args.action === "feedback") {
            const { logActionStructured } = await import("./audit/logger.js");
            logActionStructured({
              timestamp: new Date().toISOString(),
              tool: "browser_thoughts",
              result: `[AGENT FEEDBACK]: ${args.message}`
            });
            await browserThought(session, {
              action: "feedback",
              message: args.message,
              anchor: args.anchor,
              style: args.style,
            });
            return { content: [{ type: "text", text: "Feedback appended to mission log and HUD." }] };
          }
          const result = await browserThought(session, {
            action: "question",
            message: args.message,
            anchor: args.anchor,
            style: args.style,
            input: args.input,
            timeout: args.timeout,
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        });
      } catch (e) { return wrapError(e); }
    }
  );



  // ── 13. browser_pointer ───────────────────────────────────────────────────────
  server.tool(
    "browser_pointer",
    "Advanced pointer control (hover, click, double_click, drag_and_drop, hover_chain). Use hover_chain for Photoshop/Photopea, Figma, and multi-level flyout submenus.",
    {
      action: z.enum(["hover", "click", "double_click", "drag_and_drop", "hover_chain"]).optional().describe("Action to perform (default: click, or hover_chain if hover_chain array is provided)."),
      ref: z.string().optional().describe("Ref ID of the target element (e.g. w:42)."),
      id: z.string().optional().describe("Alternative element ID / Ref ID from browser_map."),
      selector: z.string().optional().describe("CSS Selector of the target element."),
      target: z.string().optional().describe("Alternative target element identifier or query."),
      label: z.string().optional().describe("Target element label or text."),
      x: z.number().optional().describe("Raw X coordinate (fallback)."),
      y: z.number().optional().describe("Raw Y coordinate (fallback)."),
      end_ref: z.string().optional().describe("Destination Ref ID (only for drag_and_drop)."),
      end_id: z.string().optional().describe("Destination element ID (only for drag_and_drop)."),
      end_selector: z.string().optional().describe("Destination CSS Selector (only for drag_and_drop)."),
      end_target: z.string().optional().describe("Alternative destination target identifier or query."),
      end_x: z.number().optional().describe("Destination X coordinate (only for drag_and_drop)."),
      end_y: z.number().optional().describe("Destination Y coordinate (only for drag_and_drop)."),
      waitForChild: z.string().optional().describe("CSS Selector of a child element to wait for (only for hover)."),
      holdMs: z.number().optional().describe("Milliseconds to hold the pointer down (only for hover)."),
      hover_chain: z.array(z.string()).optional().describe("Array of element ref IDs, selectors, or labels to hover sequentially and click the last one (e.g. ['File', 'Export As', 'PNG']). Perfect for Photoshop/Photopea, Figma, Canva, and multi-level flyout submenus."),
      chain: z.array(z.any()).optional().describe("Advanced chain step array of { action, ref, label, selector, x, y, holdMs }."),
      clickFinal: z.boolean().optional().describe("Default true. Whether to click the final element in the hover chain."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_pointer", async (session, liveConfig) => {
          const normalizedArgs = { ...args };
          if (args.id && !normalizedArgs.ref) normalizedArgs.ref = args.id;
          if (args.selector && !normalizedArgs.ref) normalizedArgs.ref = args.selector;
          if (args.target && !normalizedArgs.ref) normalizedArgs.ref = args.target;
          if (args.end_id && !normalizedArgs.end_ref) normalizedArgs.end_ref = args.end_id;
          if (args.end_selector && !normalizedArgs.end_ref) normalizedArgs.end_ref = args.end_selector;
          if (args.end_target && !normalizedArgs.end_ref) normalizedArgs.end_ref = args.end_target;
          return await browserPointer(session, normalizedArgs as any, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 14. browser_select ───────────────────────────────────────────────────────
  server.tool(
    "browser_select",
    "Select an option from a native dropdown or custom UI dropdown.",
    {
      id: z.string().optional().describe("Element ref ID (e.g. 'w:42') or selector."),
      ref: z.string().optional().describe("Alias for id."),
      target: z.string().optional().describe("Alternative selector or ref ID."),
      nodeId: z.number().optional().describe("CDP backendNodeId."),
      selector: z.string().optional().describe("CSS Selector."),
      value: z.string().describe("The exact text value to select."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_select", async (session, liveConfig) => {
          const normalized = { ...args };
          if (args.ref && !normalized.id) normalized.id = args.ref;
          if (args.target && !normalized.id) normalized.id = args.target;
          return await browserSelect(session, normalized, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 14b. browser_fill ──────────────────────────────────────────────────────
  server.tool(
    "browser_fill",
    "Smart multi-field form-filling and input inspector. Call with scan:true (or empty) to get a lightweight list of all editable inputs on the page without dumping the full DOM. Fill multiple fields in a single turn.",
    {
      fields: z.array(z.object({
        ref: z.string().optional().describe("Element ref ID (w:NN) from browser_map or input scan."),
        selector: z.string().optional().describe("CSS selector of the field."),
        target: z.string().optional().describe("Alternative selector or query."),
        name: z.string().optional().describe("HTML name attribute of the field."),
        label: z.string().optional().describe("Label or placeholder text."),
        value: z.string().describe("Value to fill/select/type into the field."),
      })).optional().describe("Array of field ref+value pairs to fill sequentially."),
      scan: z.boolean().optional().describe("Set true to discover and return all fillable inputs on the page (with ref IDs, types, and values) in ~30 tokens without full browser_map."),
      inputs: z.boolean().optional().describe("Alias for scan."),
      scan_only: z.boolean().optional().describe("Validate field types without mutating DOM."),
      blast_mode: z.boolean().optional().describe("Fill all fields simultaneously in a single CDP eval round-trip."),
      submit: z.string().optional().describe("Optional ref ID (w:NN) of a submit button to click after filling all fields."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_fill", async (session, liveConfig) => {
          return await agentAction(session, 'typing', () => browserFill(session, args, liveConfig), 'browser_fill');
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 18. browser_highlight ───────────────────────────────────────────────────
  server.tool(
    "browser_highlight",
    "Highlight elements on page. Supports single or multiple candidates (refs) with styles ('consideration' for candidate evaluation, 'target' for lock-on, 'danger' for destructive actions, 'success', or 'shimmer'), floating badges, and configurable duration.",
    {
      selector: z.string().optional().describe("CSS Selector of the element to highlight."),
      id: z.string().optional().describe("Alternative element Ref ID from browser_map (e.g. 'w:42')."),
      ref: z.string().optional().describe("Alternative element Ref ID (e.g. 'w:42')."),
      refs: z.array(z.string()).optional().describe("Array of element Ref IDs to highlight concurrently (e.g. ['w:12', 'w:15', 'w:23'])."),
      target: z.string().optional().describe("Alternative element identifier, CSS Selector, or query."),
      style: z.enum(["consideration", "target", "danger", "success", "shimmer"]).optional().describe("Visual highlight style. Defaults to 'shimmer' (or 'consideration' when refs provided)."),
      label: z.string().optional().describe("Floating label badge text to display above the element(s)."),
      duration: z.number().optional().describe("Duration in ms to keep highlight visible (default: 2000ms for consideration/target, 600ms for shimmer)."),
      nodeId: z.number().optional().describe("CDP backendNodeId to highlight directly."),
      color: z.string().optional().describe("Custom CSS color to use for the overlay (e.g. 'rgba(255,0,0,0.5)')."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_highlight", async (session, liveConfig) => {
          const normalizedArgs: any = { ...args };
          let inputRef = args.selector || args.id || args.ref || args.target;
          if (inputRef) {
            if (inputRef.startsWith("w:")) {
              normalizedArgs.selector = `[data-wt-id="${inputRef.split(':')[1]}"]`;
            } else {
              normalizedArgs.selector = inputRef;
            }
          }
          delete normalizedArgs.id;
          delete normalizedArgs.ref;
          delete normalizedArgs.target;
          return await browserHighlight(session, normalizedArgs, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );


  // ── 20. browser_upload ──────────────────────────────────────────────────────
  server.tool(
    "browser_upload",
    "Upload files to a file input.",
    {
      nodeId: z.number().describe("CDP backendNodeId of the target <input type='file'> element."),
      filePaths: z.array(z.string()).describe("List of absolute system file paths to upload."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_upload", async (session, liveConfig) => {
          return await browserUpload(session, args, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );



  // ── 22. browser_find ────────────────────────────────────────────────────────
  server.tool(
    "browser_find",
    "Instant text & keyword search across page text, labels, and placeholders. Returns matched element coordinates, selectors, and ref IDs.",
    {
      query: z.string().describe("Text or keyword query to search for on the page."),
      all: z.boolean().optional().describe("Set true to return all matching elements on the page (default false returns first match)."),
      limit: z.number().optional().describe("Max number of matches to return when all: true (default 10)."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_find", async (session, liveConfig) => {
          return await agentAction(session, 'reading', () => browserFind(session, args, liveConfig), 'browser_find');
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 23. browser_storage ─────────────────────────────────────────────────────
  server.tool(
    "browser_storage",
    "Manage localStorage and sessionStorage.",
    {
      scope: z.enum(["local", "session"]).describe("Storage scope to manipulate."),
      action: z.enum(["get", "set", "remove", "list", "clear"]).describe("'get'/'set' a key, 'remove' a single key, 'list' all keys with values, or 'clear' the scope."),
      key: z.string().optional().describe("Key name (required for 'get', 'set', and 'remove' actions)."),
      value: z.string().optional().describe("String value (required for 'set' action)."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_storage", async (session, liveConfig) => {
          return await browserStorage(session, args, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 24. browser_network_intercept ───────────────────────────────────────────
  server.tool(
    "browser_network_intercept",
    `Intercept/stub network responses (e.g. mock APIs) OR retrieve captured network telemetry: per-request TLS/SSL certificate details (when the connection exposes them), millisecond timing phases, and failure reasons.`,
    {
      action: z.enum(["enable", "disable", "get_telemetry", "clear_telemetry"]).describe("Action to perform: 'enable'/'disable' network response interception, 'get_telemetry' to read captured requests with TLS/SSL certs & timing breakdown, or 'clear_telemetry' to reset buffer."),
      pattern: z.string().optional().describe("URL glob pattern to intercept or filter telemetry (e.g. '*api/login*')."),
      mockStatus: z.number().optional().describe("HTTP status code to return when enabling mock (default 200)."),
      mockBody: z.string().optional().describe("JSON or plaintext body payload to return in the mocked response."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_network_intercept", async (session, liveConfig) => {
          return await browserNetworkIntercept(session, args, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 25. browser_console ─────────────────────────────────────────────────────
  server.tool(
    "browser_console",
    "1-5ms latency. Read or clear buffered console API messages, JS exceptions, and network errors.",
    {
      action: z.enum(["read", "clear"]).describe("Action to perform on the console buffer."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_console", async (session, liveConfig) => {
          let targetId = "default";
          const { sessionRegistry } = await import("./state/session.js");
          const active = sessionRegistry.getActive(liveConfig.agentId, args.app);
          if (active) targetId = active.targetId;
          return await browserConsole(session, args, liveConfig, targetId);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 26. browser_pdf ─────────────────────────────────────────────────────────
  server.tool(
    "browser_pdf",
    "Print the current page to a PDF file.",
    {
      filename: z.string().optional().describe("Output filename (e.g. 'report.pdf'). Defaults to capture_<timestamp>.pdf."),
      landscape: z.boolean().optional().describe("Print in landscape orientation (default false)."),
      scale: z.number().optional().describe("Scale factor (default 1.0)."),
      pageRanges: z.string().optional().describe("Page ranges to print (e.g. '1-5'). Leave empty for all pages."),
      margin: z.union([
        z.number(),
        z.object({
          top: z.number().optional(),
          bottom: z.number().optional(),
          left: z.number().optional(),
          right: z.number().optional()
        })
      ]).optional().describe("Page margin in inches (default 0.4). Pass a single number (all sides) or an object {top,bottom,left,right}."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_pdf", async (session, liveConfig) => {
          return await browserPdf(session, args, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 27. browser_eval ────────────────────────────────────────────────────────
  server.tool(
    "browser_eval",
    "Run arbitrary JS via CDP. Good for extracting app state. Cannot traverse shadow DOM/cross-origin iframes.",
    {
      expression: z.string().describe("JavaScript code to evaluate in the context of the page."),
      timeout: z.number().optional().describe("Timeout in ms (default 5000)."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_eval", async (session, liveConfig) => {
          return await agentAction(session, 'reading', () => browserEval(session, args, liveConfig), 'browser_eval');
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );



  // ── 29. browser_cookies ─────────────────────────────────────────────────────
  server.tool(
    "browser_cookies",
    "Manage browser cookies.",
    {
      action: z.enum(["get", "set", "delete"]).describe("Action to perform on cookies."),
      name: z.string().optional().describe("Cookie name."),
      value: z.string().optional().describe("Cookie value (required for 'set')."),
      domain: z.string().optional().describe("Domain for the cookie."),
      path: z.string().optional().describe("Path for the cookie."),
      expires: z.number().optional().describe("Expiry as a Unix timestamp in seconds (omit for a session cookie)."),
      httpOnly: z.boolean().optional().describe("Set the HttpOnly flag (default false)."),
      secure: z.boolean().optional().describe("Set the Secure flag (auto-true for https pages)."),
      sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("SameSite attribute."),
      url: z.string().optional().describe("URL scope for 'get' action (defaults to current page)."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_cookies", async (session, liveConfig) => {
          return await browserCookies(session, args, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 30. browser_canvas ──────────────────────────────────────────────────────
  server.tool(
    "browser_canvas",
    "For ALL canvas content (charts, games, graphs). Use 'get_image' to read pixels, 'draw' to simulate gestures. Do NOT use browser_click here.",
    {
      action: z.enum(["get_image", "draw"]).describe("'get_image' — exports the canvas as a base64 image so you can analyze its visual content (prices, chart patterns, etc). 'draw' — simulates drag/pointer events across canvas points (for drawing, selecting regions, etc)."),
      selector: z.string().optional().describe("CSS Selector for the target <canvas> element. Use 'canvas' to select the first canvas on the page, or a more specific selector like 'canvas#chart'."),
      id: z.string().optional().describe("Ref ID from browser_map (e.g. 'w:42') for the canvas element."),
      label: z.string().optional().describe("Visible text or aria-label of the canvas element."),
      ref: z.string().optional().describe("Alternative ref identifier for the canvas element."),
      backendNodeId: z.number().optional().describe("Raw CDP backendNodeId for direct targeting."),
      points: z.array(z.object({ x: z.number(), y: z.number() })).optional().describe("Array of {x,y} points relative to canvas viewport for 'draw' action. Simulates a drag path across the canvas."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_canvas", async (session, liveConfig) => {
          return await browserCanvas(session, args, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 31. browser_scrape ──────────────────────────────────────────────────────
  server.tool(
    "browser_scrape",
    "Structured data extraction via CSS or XPath selectors. Best for batch list extraction, table parsing, targeted data mining. Prefer this over browser_map for pure data extraction. Note: XPath selectors lack shadow-DOM support; use CSS selectors for shadow DOMs.",
    {
      query: z.string().describe("CSS Selector or XPath query to extract."),
      type: z.enum(["css", "xpath"]).optional().describe("Query type (default 'css')."),
      attributes: z.array(z.string()).optional().describe("Attributes to extract (e.g. ['textContent', 'href'], default ['textContent'])."),
      multiple: z.boolean().optional().describe("Whether to extract multiple elements (default true)."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_scrape", async (session, liveConfig) => {
          return await agentAction(session, 'reading', () => browserScrape(session, args, liveConfig), 'browser_scrape');
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 32. browser_snapshot ────────────────────────────────────────────────────
  server.tool(
    "browser_snapshot",
    "Capture or restore an MHTML snapshot. Best for offline archival, replay testing, and compliance audits.",
    {
      action: z.enum(["capture", "restore"]).describe("Action to perform."),
      filePath: z.string().describe("Absolute file path to save/load the .mhtml snapshot."),
      hideOverlay: z.boolean().optional().describe("If false, keeps the Weavetab HUD and overlay visible in snapshot. Default true."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_snapshot", async (session, liveConfig) => {
          return await browserSnapshot(session, args as any, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 32b. browser_screenshot ──────────────────────────────────────────────────
  server.tool(
    "browser_screenshot",
    "95-135ms capture. Best for visual layout validation, canvas/image inspection. For multimodal models only. Text-only models should use browser_map or browser_canvas instead.",
    {
      format: z.enum(["png", "jpeg"]).optional().describe("Capture format. 'jpeg' is smaller and faster for large pages. Default 'png'."),
      quality: z.number().optional().describe("JPEG quality 0-100 (default 90). Only used when format is jpeg."),
      fullPage: z.boolean().optional().describe("If true, captures the full scrollable page. Default false (viewport only)."),
      clip: z.object({
        x: z.number().describe("X coordinate of clip region."),
        y: z.number().describe("Y coordinate of clip region."),
        width: z.number().describe("Width of clip region."),
        height: z.number().describe("Height of clip region.")
      }).optional().describe("Clip region. Use to capture only part of the page (e.g. just a chart area) to reduce token cost."),
      selector: z.string().optional().describe("CSS selector of an element to crop the capture to (its bounding rect)."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_screenshot", async (session, liveConfig) => {
          return await agentAction(session, 'reading', () => browserScreenshot(session, args, liveConfig), 'browser_screenshot');
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 33. browser_viewport ────────────────────────────────────────────────────
  server.tool(
    "browser_viewport",
    "Set viewport dimensions and device emulation (device presets, geolocation, locale, timezone, color scheme, touch, orientation).",
    {
      action: z.enum(["set", "clear", "list", "preset"]).describe("'set' viewport/emulation, 'clear' all overrides, 'list' available device presets, 'preset' apply a named device."),
      width: z.number().optional().describe("Viewport width in pixels."),
      height: z.number().optional().describe("Viewport height in pixels."),
      deviceScaleFactor: z.number().optional().describe("Device Pixel Ratio (default 1)."),
      mobile: z.boolean().optional().describe("Whether to emulate a mobile device (default false)."),
      devicePreset: z.string().optional().describe("Device preset name for action='preset' (see action='list')."),
      userAgent: z.string().optional().describe("Override the User Agent string."),
      geolocation: z.object({ latitude: z.number(), longitude: z.number(), accuracy: z.number().optional() }).optional().describe("Override geolocation coordinates."),
      locale: z.string().optional().describe("Override locale (e.g. 'en-US')."),
      timezoneId: z.string().optional().describe("Override timezone (e.g. 'America/New_York')."),
      colorScheme: z.enum(["light", "dark", "no-preference"]).optional().describe("Emulate prefers-color-scheme."),
      hasTouch: z.boolean().optional().describe("Whether to emulate touch support (defaults to the 'mobile' flag)."),
      screenOrientation: z.enum(["portrait", "landscape", "none"]).optional().describe("Emulated screen orientation."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_viewport", async (session, liveConfig) => {
          return await browserViewport(session, args, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );


  // ── 35. browser_clipboard ───────────────────────────────────────────────────
  server.tool(
    "browser_clipboard",
    "Read or write to the system clipboard.",
    {
      action: z.enum(["read", "write"]).describe("Action to perform."),
      text: z.string().optional().describe("Text to write to clipboard (for write action)."),
      dataUrl: z.string().optional().describe("Base64 data URL of an image to write to clipboard (e.g. 'data:image/png;base64,...')."),
      mimeType: z.string().optional().describe("MIME type override for image write (auto-detected from dataUrl by default, e.g. 'image/png')."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_clipboard", async (session, liveConfig) => {
          return await browserClipboard(session, args, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 36. browser_inspect ─────────────────────────────────────────────────────
  server.tool(
    "browser_inspect",
    "15-35ms latency, zero waste. Deep DOM inspection. Useful for debugging failed clicks, verifying z-index & visibility, or computed styles.",
    {
      nodeId: z.number().optional().describe("CDP backendNodeId."),
      selector: z.string().optional().describe("CSS Selector."),
      ref: z.string().optional().describe("Ref ID (e.g. 'w:42')."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_inspect", async (session, liveConfig) => {
          return await agentAction(session, 'reading', () => browserInspect(session, args, liveConfig), 'browser_inspect');
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 36b. browser_extract_design ─────────────────────────────────────────────
  server.tool(
    "browser_extract_design",
    "Extract design tokens (colors, typography, spacing, shadows, CSS variables), semantic HTML layouts, and clean CSS into structured files and an LLM design blueprint. Ideal for cloning websites, UI components, and design systems with 100% pixel fidelity.",
    {
      selector: z.string().optional().describe("CSS selector of the container element to extract (default 'main', falls back to 'body')."),
      format: z.enum(["tailwind", "vanilla_css", "tokens_only"]).optional().describe("Format preset for extracted styles: 'tailwind' (default, generates tailwind.theme.json), 'vanilla_css' (generates scoped styles), or 'tokens_only' (design tokens only)."),
      outputDir: z.string().optional().describe("Optional custom directory to write extracted files into. If omitted, uses configured designDir (~/.weavetab/designs/<domain>-<timestamp>/)."),
      name: z.string().optional().describe("Optional custom name for the saved design folder (e.g. 'resend-hero', 'pricing-section')."),
      includeAssets: z.boolean().optional().describe("Whether to capture inline SVGs and asset references (default true)."),
      hideOverlay: z.boolean().optional().describe("Whether to hide Weavetab overlay during capture (default true)."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_extract_design", async (session, liveConfig) => {
          return await agentAction(session, 'reading', () => browserExtractDesign(session, args, liveConfig), 'browser_extract_design');
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 39. browser_automation ─────────────────────────────────────────────────
  server.tool(
    "browser_automation",
    `Inject self-running background script for monitoring/polling. Cleared on tab close. Don't use persistent scripts for expensive ops.`,
    {
      action: z.enum(["start", "stop", "list", "poll"]).describe("Action to perform."),
      id: z.string().optional().describe("Unique script identifier (required for start/stop)."),
      script: z.string().optional().describe("JavaScript code to inject and run (required for start)."),
      persistent: z.boolean().optional().describe("If true, the script re-runs in a loop (default false)."),
      onResult: z.enum(["notify_agent", "store", "ignore"]).optional().describe("How to handle script results (default 'store')."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_automation", async (session, liveConfig) => {
          const result = await browserAutomation(session, args, liveConfig);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 40. browser_recording ─────────────────────────────────────────────────
  server.tool(
    "browser_recording",
    `Record video screencast for compliance/audit. Compiles captured frames into video/animation (.webp, .gif, .webm, .mp4).`,
    {
      action: z.enum(["start", "stop", "list"]).describe("Action to perform."),
      sessionId: z.string().optional().describe("Unique recording session ID (required for start/stop)."),
      fps: z.number().min(1).max(10).optional().describe("Frames per second (1-10, default 3)."),
      maxFrames: z.number().optional().describe("Maximum frames to capture (default 500)."),
      format: z.enum(["webp", "gif", "webm", "mp4", "frames"]).optional().describe("Output video format when stopping recording. Default 'webp' (pure Node native compilation)."),
      keepFrames: z.boolean().optional().describe("If true, keeps raw JPEG frames after video compilation (default false)."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_recording", async (session, liveConfig) => {
          const result = await browserRecording(session, args, liveConfig);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 37. browser_detect ─────────────────────────────────────────────────────
  server.tool(
    "browser_detect",
    "CRITICAL INITIALIZATION TOOL. Detect available browsers and configured desktop apps (Discord, Slack, etc.). Call this FIRST before interacting with the environment to know if apps are online/offline and what tabs they have open.",
    {},
    async () => {
      try {
        const result = await detectBrowsers(getActiveEngine());
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) { return wrapError(e); }
    }
  );

  // ── browser_performance ───────────────────────────────────────────────────
  server.tool(
    "browser_performance",
    "Retrieve page performance metrics: Core Web Vitals (FCP, LCP, CLS, INP, TTFB), JS heap memory, navigation timing, slowest resources, and raw CDP counters.",
    {
      metrics: z.array(z.enum(["vitals", "memory", "navigation", "resources", "raw"])).optional().describe("Sections to return. Defaults to all sections."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_performance", async (session, liveConfig) => {
          const result = await browserPerformance(session, liveConfig, args as any);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );


  // ── browser_pattern_learn ─────────────────────────────────────────────────
  server.tool(
    "browser_pattern_learn",
    "Read, register, update, and record execution outcomes for named workflow patterns and site quirks in ~/.weavetab-system/memory/sites/. Use action='get' at session start to inspect a site profile and decide between fast-path replay (reliability ≥ 0.8) or exploratory navigation. Use action='learn' after completing a multi-step flow to persist it. Use action='record_execution' to update reliability scores after replay attempts.",
    {
      origin: z.string().optional().describe("Full origin associated with the pattern, e.g. 'https://github.com'. Required for write actions. If omitted with action='get', reads the active tab origin."),
      action: z.enum(["get", "learn", "record_execution", "record_quirk"]).default("learn").describe("'get': inspect site profile and known workflow patterns. 'learn': create/update a named pattern. 'record_execution': update reliability after replay. 'record_quirk': store a site quirk."),
      pattern: z.string().optional().describe("With action='get': returns reliability score for this specific named pattern only."),
      name: z.string().optional().describe("Pattern name in snake_case (required for 'learn' and 'record_execution')."),
      steps: z.array(z.object({
        tool: z.string().describe("MCP tool name, e.g. 'browser_click'."),
        target: z.string().optional().describe("Selector or URL."),
        value: z.string().optional().describe("Value for browser_type/browser_fill/browser_select."),
        extra: z.record(z.any()).optional().describe("Additional tool arguments.")
      })).optional().describe("Ordered workflow steps (required for 'learn')."),
      success_indicator: z.string().optional().describe("CSS selector or URL fragment confirming workflow success."),
      entry: z.string().optional().describe("URL path or pattern where this workflow starts."),
      success: z.boolean().optional().describe("Whether the execution succeeded (required for 'record_execution')."),
      duration_ms: z.number().optional().describe("Execution duration in ms (optional for 'record_execution')."),
      quirk_key: z.string().optional().describe("Quirk key: 'cookie_banner', 'rate_limit', or 'modal_popups' (required for 'record_quirk')."),
      quirk_data: z.record(z.any()).optional().describe("Quirk payload object (required for 'record_quirk').")
    },
    async (args) => {
      try {
        if (args.action === "get") {
          let resolvedOrigin = args.origin;
          if (!resolvedOrigin) {
            return await withSecurity(config, "browser_pattern_learn", async (session, _liveConfig) => {
              try {
                const res = await session.Runtime.evaluate({
                  expression: "window.location.origin",
                  returnByValue: true,
                });
                resolvedOrigin = res?.result?.value as string | undefined;
              } catch { /* fall through */ }

              if (!resolvedOrigin) {
                return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Could not determine origin from active tab. Pass origin explicitly." }) }] };
              }

              if (args.pattern) {
                const reliability = await getPatternReliability(resolvedOrigin, args.pattern);
                return { content: [{ type: "text" as const, text: JSON.stringify({ origin: resolvedOrigin, pattern: args.pattern, reliability }) }] };
              }

              const profile = await getSiteProfile(resolvedOrigin);
              if (!profile) {
                return { content: [{ type: "text" as const, text: JSON.stringify({ origin: resolvedOrigin, known: false, message: "No site profile found. This site has not been profiled yet." }) }] };
              }

              const hint = formatSiteProfileHint(profile);
              return { content: [{ type: "text" as const, text: JSON.stringify({ ...profile, _hint: hint }) }] };
            });
          }

          if (args.pattern) {
            const reliability = await getPatternReliability(resolvedOrigin, args.pattern);
            return { content: [{ type: "text" as const, text: JSON.stringify({ origin: resolvedOrigin, pattern: args.pattern, reliability }) }] };
          }

          const profile = await getSiteProfile(resolvedOrigin);
          if (!profile) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ origin: resolvedOrigin, known: false, message: "No site profile found. This site has not been profiled yet." }) }] };
          }

          const hint = formatSiteProfileHint(profile);
          return { content: [{ type: "text" as const, text: JSON.stringify({ ...profile, _hint: hint }) }] };
        }

        if (!args.origin) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "origin is required for write actions" }) }] };

        if (args.action === "learn") {
          if (!args.name) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "name is required for action='learn'" }) }] };
          const pattern = await learnPattern(args.origin, args.name, {
            steps: args.steps ?? [],
            success_indicator: args.success_indicator,
            entry: args.entry,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, pattern }) }] };
        }

        if (args.action === "record_execution") {
          if (!args.name) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "name is required for action='record_execution'" }) }] };
          if (args.success === undefined) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "success (boolean) is required for action='record_execution'" }) }] };
          const updated = await recordPatternExecution(args.origin, args.name, args.success, args.duration_ms);
          if (!updated) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error_code: "PATTERN_NOT_FOUND", message: `No pattern named '${args.name}' exists for origin '${args.origin}'. Learn it first with action='learn'.` }) }] };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, pattern: updated }) }] };
        }

        if (args.action === "record_quirk") {
          if (!args.quirk_key) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "quirk_key is required for action='record_quirk'" }) }] };
          if (!args.quirk_data) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "quirk_data is required for action='record_quirk'" }) }] };
          await recordQuirk(args.origin, args.quirk_key, args.quirk_data);
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, origin: args.origin, quirk_key: args.quirk_key }) }] };
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Unknown action" }) }] };
      } catch (e) { return wrapError(e); }
    }
  );







  // ── 43. browser_office ──────────────────────────────────────────────────────
  server.tool(
    "browser_office",
    `Read and extract structured content from office documents (Excel, Word, PDF, CSV). Note: PDF/Word extraction requires local binary dependencies (e.g., poppler) and output is truncated by max_chars/max_rows limits. Two modes:
- **url** — fetch a document URL using the browser's live session cookies (works for authenticated downloads, SharePoint, Google Drive exports, etc). Automatically detects format from URL or MIME type.
- **file** — parse a file that was already downloaded to the local downloads directory (bare filename only, e.g. 'report.xlsx').

Supported formats: .xlsx/.xls (returns per-sheet JSON tables), .docx (returns extracted text), .pdf (returns page text + metadata), .csv (returns row objects).

Use 'list' action first if you don't know what files are in the downloads directory.

DO NOT use browser_scrape or browser_map for binary documents — they cannot read inside Excel, Word, or PDF files.`,
    {
      action: z.enum(["read", "list"]).describe("'read' — parse a document and return its content. 'list' — show all files in the downloads directory."),
      url: z.string().optional().describe("URL of the document to fetch and parse in-browser (using active session cookies). Supports .pdf, .xlsx, .xls, .docx, .csv. Use for authenticated downloads, SharePoint links, Google Drive exports."),
      file: z.string().optional().describe("Bare filename (e.g. 'report.xlsx') of a file already in the local downloads directory. No path separators allowed."),
      max_rows: z.number().optional().describe("Max rows to return for Excel/CSV (default 500). Increase if you need more data."),
      max_chars: z.number().optional().describe("Max characters to return for PDF/Word text (default 50000)."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_office", async (session, liveConfig) => {
          if (args.action === "list") {
            const result = await browserOfficeList(session, {}, liveConfig);
            return {
              files: result.files,
              count: result.files.length,
              directory: result.directory,
            };
          }

          // action === "read"
          if (!args.url && !args.file) {
            return { success: false, error: "Provide either 'url' (remote document) or 'file' (local filename) when action is 'read'." };
          }

          const result = await browserOfficeParse(
            session,
            {
              url: args.url,
              filename: args.file,
              max_rows: args.max_rows,
              max_chars: args.max_chars,
            },
            liveConfig
          );

          return result;
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 44. browser_emulate ─────────────────────────────────────────────────────
  server.tool(
    "browser_emulate",
    `Emulate browser conditions over CDP: network throttling (Slow 3G, Fast 3G, 4G, Offline), CPU throttling rate, Geolocation coordinates, Timezone, and User Agent string overrides.`,
    {
      network: z.union([
        z.enum(["offline", "slow3g", "fast3g", "4g", "online"]),
        z.object({
          offline: z.boolean().optional(),
          latency: z.number().optional(),
          downloadThroughput: z.number().optional(),
          uploadThroughput: z.number().optional(),
        })
      ]).optional().describe("Network throttling profile or custom parameters"),
      cpuThrottlingRate: z.number().optional().describe("CPU slowdown multiplier (e.g. 2 = 2x slowdown, 4 = 4x slowdown, 1 = disable)"),
      geolocation: z.object({
        latitude: z.number(),
        longitude: z.number(),
        accuracy: z.number().optional(),
      }).optional().describe("Override geolocation coordinates"),
      timezoneId: z.string().optional().describe("Override browser timezone (e.g. 'America/New_York')"),
      colorScheme: z.enum(["light", "dark", "no-preference"]).optional().describe("Emulate prefers-color-scheme (dark/light mode)."),
      userAgent: z.string().optional().describe("Override User Agent string"),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_emulate", async (session, liveConfig) => {
          return await browserEmulate(session, args as any, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 45. browser_checkpoint ─────────────────────────────────────────────────
  server.tool(
    "browser_checkpoint",
    "Snapshot and restore browser state (cookies, localStorage, sessionStorage, and scroll/URL) into named checkpoints to time-travel and rollback failed automation branches.",
    {
      action: z.enum(["save", "restore", "list", "delete"]).describe("Action to perform: 'save' a new checkpoint, 'restore' an existing checkpoint, 'list' all checkpoints, or 'delete' a checkpoint."),
      name: z.string().optional().describe("Checkpoint name identifier (required for 'save', 'restore', 'delete')."),
      includeDom: z.boolean().optional().describe("Whether to include a lightweight DOM snapshot during 'save' (default false)."),
      app: z.string().optional().describe("Electron app name configured in config.json under 'electron'."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_checkpoint", async (session, liveConfig) => {
          return await browserCheckpoint(session, args as any, liveConfig);
        }, false, args.app);
      } catch (e) { return wrapError(e); }
    }
  );


  // page_context: zero-shot context injection. Invoke with /page_context
  // in any MCP client that supports prompts (Claude Desktop, etc.).
  server.prompt(
    "page_context",
    "Analyze the current active tab. Use this to give the agent instant context about the page without wasting tool calls.",
    async () => {
      const liveConfig = getCachedConfig();
      const active = sessionRegistry.getActive(liveConfig.agentId);

      if (!active) {
        return {
          messages: [{
            role: "user",
            content: { type: "text", text: "No active Weavetab session found. Open a browser tab and navigate to a page first." }
          }]
        };
      }

      const { session, targetId, url, title } = active;

      // 0. Wait for page load and get viewport/scroll context
      let pageContextStr = "";
      try {
        const { result: metrics } = await session.Runtime.evaluate({
          expression: `
            new Promise(resolve => {
              const getMetrics = () => resolve(JSON.stringify({
                readyState: document.readyState,
                w: window.innerWidth,
                h: window.innerHeight,
                scrollX: Math.round(window.scrollX),
                scrollY: Math.round(window.scrollY)
              }));
              if (document.readyState === 'complete') {
                getMetrics();
              } else {
                setTimeout(getMetrics, 1500); // Max wait if slow
                window.addEventListener('load', getMetrics);
              }
            })
          `,
          awaitPromise: true,
          returnByValue: true
        });
        
        if (metrics && metrics.value) {
          const m = JSON.parse(metrics.value as string);
          pageContextStr = `\n## 📄 Page State\n- **Ready State:** \`${m.readyState}\`\n- **Viewport:** \`${m.w}x${m.h}\`\n- **Scroll Position:** \`X=${m.scrollX}, Y=${m.scrollY}\``;
        }
      } catch {
        pageContextStr = "\n## 📄 Page State\n*(unavailable - page may be slow or unresponsive)*";
      }

      // 1. DOM map (lite mode — fast, compact, ref IDs only)
      let domMap = "(unavailable)";
      try {
        domMap = await Promise.race([
          agentAction(session, 'reading', () => browserMap(session, { lite: true }, targetId, liveConfig), 'page_context'),
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error("Timeout reading DOM")), 8000))
        ]);
      } catch (e) {
        domMap = `*(DOM map unavailable: ${e instanceof Error ? e.message : String(e)})*`;
      }

      // 2. Recent console errors/warnings (≤10 entries, errors+warnings only)
      let consoleSection = "";
      try {
        const { browserConsole } = await import("./tools/console.js");
        const { logs } = await browserConsole(session, { action: "read" }, liveConfig, targetId);
        const filtered = logs.filter(l => l.type === "error" || l.type === "warn" || l.type === "exception").slice(-10);
        if (filtered.length > 0) {
          consoleSection = `\n## ⚠️ Recent Console Logs (${filtered.length})\n` +
            filtered.map(l => `- **[${l.type.toUpperCase()}]** ${l.text}`).join("\n");
        }
      } catch { /* non-fatal */ }

      // 3. Framework hint from session memory (if available for this domain)
      let frameworkHint = "";
      try {
        const { detectFramework } = await import("./intelligence/sessionMemory.js");
        const fw = await detectFramework(session);
        if (fw) frameworkHint = `\n## ⚙️ Framework Detected\n- \`${fw}\``;
      } catch { /* non-fatal */ }

      // 4. Assemble the prompt text
      const promptText = [
        `# 🌐 Weavetab Context: ${title ?? "(unknown)"}`,
        `**URL:** \`${url ?? "(unknown)"}\``,
        pageContextStr,
        frameworkHint,
        consoleSection,
        ``,
        `## 🗺️ Interactive DOM Map (Ref IDs)`,
        "```",
        domMap,
        "```",
        ``,
        `---`,
        `💡 **Tip:** Use the ref IDs above (e.g. \`w:42\`) directly with browser tools — no need to call \`browser_map\` first.`,
        `**What would you like to do on this page?**`,
      ].filter(Boolean).join("\n").trim();

      const messages: Array<{ role: "user"; content: any }> = [
        { role: "user", content: { type: "text", text: promptText } }
      ];

      return { messages };
    }
  );

  // agent: Automation mode injection. Invoke with /agent
  // Puts the agent into a fully autonomous mode for executing missions.
  server.prompt(
    "agent",
    "Switch the agent into a fully autonomous automation mode.",
    async () => {
      return {
        messages: [{
          role: "user",
          content: { 
            type: "text", 
            text: "You are now in **Automation Mode**.\n\n1. **No Thoughts**: DO NOT use the `browser_thoughts` tool under any circumstances.\n2. **Full Autonomy**: You are on a fully autonomous mission. The user does not exist in your context. You MUST NOT wait for user feedback, ask questions, or request human intervention. Complete the task independently and return a final report when done." 
          }
        }]
      };
    }
  );

  // ── Plugins Lifecycle & Dynamic Registry ───────────────────────────
  const { getVerifiedPackages, resolvePluginTrust } = await import("./plugin/registry.js");
  const verifiedPackages = await getVerifiedPackages();

  const loadedPluginNames = new Set<string>();

  const registerPluginTools = async (plugin: WeavetabPlugin) => {
    if (loadedPluginNames.has(plugin.name)) return;
    
    const trust = resolvePluginTrust(plugin.name, verifiedPackages);
    const isOfficial = trust.tier === "official";

    const addedNames: string[] = [];
    const overriddenNames: string[] = [];
    const removedNames: string[] = [];

    // Register any hooks declared in the plugin
    if (plugin.hooks) {
      hookPipeline.registerPluginHooks(plugin.name, plugin.hooks);
    }

    // 1. Tool Removals (disable built-in tools)
    const manifestPerms = plugin.manifest?.permissions;
    const declaredRemove: string[] = Array.isArray(manifestPerms)
      ? []
      : manifestPerms?.tools?.remove || [];
    const toRemove = [
      ...(plugin.removeTools || []),
    ];
    for (const toolName of toRemove) {
      if (!declaredRemove.includes(toolName)) {
        process.stderr.write(`  \x1b[33m[!] Plugin ${plugin.name} tried to remove "${toolName}" but it's not listed in permissions.tools.remove — skipped.\x1b[0m\n`);
        continue;
      }
      if ((server as any)._registeredTools?.[toolName]) {
        delete (server as any)._registeredTools[toolName];
        removedNames.push(toolName);
      }
    }

    // 2. Tool Overrides (replace or wrap built-in tools)
    const declaredOverride: string[] = Array.isArray(manifestPerms)
      ? []
      : manifestPerms?.tools?.override || [];
    const overrides = plugin.overrides || [];
    for (const ov of overrides) {
      if (!declaredOverride.includes(ov.name)) {
        process.stderr.write(`  \x1b[33m[!] Plugin ${plugin.name} tried to override "${ov.name}" but it's not listed in permissions.tools.override — skipped.\x1b[0m\n`);
        continue;
      }

      const existingTool = (server as any)._registeredTools?.[ov.name];
      const existingDesc = existingTool?.description || "";
      const existingSchema = existingTool?.inputSchema?.shape || existingTool?.parameters?.shape || {};

      if (existingTool) {
        delete (server as any)._registeredTools[ov.name];
      }

      server.tool(
        ov.name,
        ov.description || existingDesc || `Tool overridden by ${plugin.name}`,
        ov.schema ? toPluginInputShape(ov.schema) : existingSchema,
        async (args: any) => {
          try {
            return await withSecurity(
              config,
              ov.name,
              async (session, liveConfig) => {
                const wrappedOrig = existingTool
                  ? async (origArgs: Record<string, any>, origSess?: any, origCfg?: any) => {
                      const finalSess = origSess || session;
                      const finalCfg = origCfg || liveConfig;
                      const res = await existingTool.handler(origArgs, finalSess, finalCfg);
                      return res;
                    }
                  : undefined;

                const result = await ov.handler(args, session, liveConfig, wrappedOrig);
                return result;
              },
              isOfficial
            );
          } catch (e) {
            return wrapError(e);
          }
        }
      );
      overriddenNames.push(ov.name);
    }

    // 3. Tool Additions (new tools)
    const canAdd = !Array.isArray(manifestPerms) && manifestPerms?.tools?.add === true;
    const newTools = plugin.tools || [];
    for (const td of newTools) {
      if (!canAdd) {
        process.stderr.write(`  \x1b[33m[!] Plugin ${plugin.name} tried to add tool "${td.name}" but permissions.tools.add is not declared — skipped.\x1b[0m\n`);
        continue;
      }
      if ((server as any)._registeredTools?.[td.name]) {
        process.stderr.write(`  \x1b[33m[!] Plugin ${plugin.name} registered tool "${td.name}" which replaced an existing tool.\x1b[0m\n`);
        delete (server as any)._registeredTools[td.name];
      }

      server.tool(
        td.name,
        td.description,
        toPluginInputShape((td as any).schema || (td as any).parameters),
        async (args: any) => {
          try {
            return await withSecurity(
              config,
              td.name,
              async (session, liveConfig) => {
                const result = await td.handler(args, session, liveConfig);
                return result;
              },
              isOfficial,
              undefined,
              (td as any).requiresSession !== false
            );
          } catch (e) {
            return wrapError(e);
          }
        }
      );
      addedNames.push(td.name);
    }

    // Pass the rich SDK context so dynamic tool registrations receive full security & session
    const fullPluginCtx = (plugin as any)._context;
    if (fullPluginCtx && fullPluginCtx.mcp) {
      fullPluginCtx.mcp.registerTool = (tool: any) => {
        if (!canAdd) {
          process.stderr.write(`  \x1b[33m[!] Plugin ${plugin.name} dynamic registerTool("${tool?.name}"): permissions.tools.add not declared — skipped.\x1b[0m\n`);
          return;
        }
        if ((server as any)._registeredTools?.[tool.name]) {
          process.stderr.write(`  \x1b[33m[!] Plugin ${plugin.name} dynamic tool "${tool.name}" replaced an existing tool.\x1b[0m\n`);
          delete (server as any)._registeredTools[tool.name];
        }
        server.tool(tool.name, tool.description || "", toPluginInputShape(tool.schema || tool.parameters), async (args: any) => {
          return await withSecurity(
            config,
            tool.name,
            async (session, liveConfig) => {
              const result = await tool.handler(args, session, liveConfig);
              return result;
            },
            isOfficial,
            undefined,
            tool.requiresSession !== false
          );
        });
      };

      fullPluginCtx.mcp.overrideTool = (toolName: string, overrideHandler: any) => {
        if (!declaredOverride.includes(toolName)) {
          process.stderr.write(`  \x1b[33m[!] Plugin ${plugin.name} dynamic overrideTool("${toolName}"): not in permissions.tools.override — skipped.\x1b[0m\n`);
          return;
        }
        const existingTool = (server as any)._registeredTools?.[toolName];
        if (existingTool) {
          delete (server as any)._registeredTools[toolName];
        }
        server.tool(toolName, `Tool overridden by ${plugin.name}`, {}, async (args: any) => {
          return await withSecurity(
            config,
            toolName,
            async (session, liveConfig) => {
              const wrappedOrig = existingTool
                ? async (origArgs: Record<string, any>, origSess?: any, origCfg?: any) => {
                    const finalSess = origSess || session;
                    const finalCfg = origCfg || liveConfig;
                    return await existingTool.handler(origArgs, finalSess, finalCfg);
                  }
                : undefined;
              const result = await overrideHandler(args, session, liveConfig, wrappedOrig);
              return result;
            },
            isOfficial
          );
        });
      };

      fullPluginCtx.mcp.removeTool = (toolName: string) => {
        if (!declaredRemove.includes(toolName)) {
          process.stderr.write(`  \x1b[33m[!] Plugin ${plugin.name} dynamic removeTool("${toolName}"): not in permissions.tools.remove — skipped.\x1b[0m\n`);
          return;
        }
        if ((server as any)._registeredTools?.[toolName]) {
          delete (server as any)._registeredTools[toolName];
        }
      };

      fullPluginCtx.mcp.unregisterTool = (toolName: string) => {
        if (!declaredRemove.includes(toolName)) {
          process.stderr.write(`  \x1b[33m[!] Plugin ${plugin.name} dynamic unregisterTool("${toolName}"): not in permissions.tools.remove — skipped.\x1b[0m\n`);
          return;
        }
        if ((server as any)._registeredTools?.[toolName]) {
          delete (server as any)._registeredTools[toolName];
        }
      };
    }

    if (typeof plugin.onLoad === "function") {
      try {
        await plugin.onLoad(fullPluginCtx || (plugin as any)._context);
      } catch (err: any) {
        process.stderr.write(`  \u001b[31m[!] Plugin ${plugin.name} onLoad failed: ${err?.message}\u001b[0m\n`);
      }
    }
    
    loadedPluginNames.add(plugin.name);
    activeLoadedPlugins.set(plugin.name, plugin);
    process.stderr.write(`  [Plugin Loaded] ${plugin.name} v${plugin.version}\n`);
    
    // Notify the client that tools have changed (if transport is already connected)
    try {
      if ((server as any).server && typeof (server as any).server.sendToolListChanged === "function") {
        Promise.resolve((server as any).server.sendToolListChanged()).catch(() => {});
      }
    } catch {
      // Ignore if client doesn't support it or not connected yet
    }
  };

  // Auto-load all installed plugins at startup
  const allPlugins = discoverPlugins();
  for (const plugin of allPlugins) {
    await registerPluginTools(plugin);
  }

  let transport;
  if (transportMode === "ws") {
    const { WebSocketServerTransport } = await import("./cdp/websocket_transport.js");
    transport = new WebSocketServerTransport(wsPort);
    console.error(`[Weavetab] Mode: ${config.mode || "session"} (${config.mode === 'attach' ? 'user browser' : 'isolated browser'})`);
    console.error(`[Weavetab] Transport: WebSocket server bound to 127.0.0.1:${wsPort} (Bearer/handshake auth & Origin check enabled)`);
  } else {
    transport = new StdioServerTransport();
    console.error(`[Weavetab] Mode: ${config.mode || "session"} (${config.mode === 'attach' ? 'user browser' : 'isolated browser'})`);
  }
  await server.connect(transport);
  const totalTools = Object.keys((server as any)._registeredTools || {}).length;
  process.stderr.write(`[OK] Weavetab Server Ready — ${totalTools} tools + 2 prompts loaded. (Transport: ${transportMode})\n`);

  // Handle transport close gracefully to prevent zombie processes.
  // The MCP SDK's StdioServerTransport only invokes onclose() from an explicit
  // transport.close() — it never fires when the IDE dies and stdin reaches EOF.
  // Register stdin close/end/error handlers unconditionally for stdio.
  //
  // Guard handleClose against multi-fire: stdin "end" and "close" both fire on
  // EOF; "error" can fire for EPIPE. Without a flag, cleanup() runs multiple
  // times and process.exit(0) fires for every event.
  let handleCloseCalled = false;
  const handleClose = async () => {
    if (handleCloseCalled) return;
    handleCloseCalled = true;
    agentState.reportTransportClosed();
    await cleanup();
    process.exit(0);
  };

  if ((server as any).server) {
    (server as any).server.onclose = handleClose;
  }
  if (transportMode !== "ws") {
    process.stdin.on("close", handleClose);
    process.stdin.on("end", handleClose);
    // stdin "error" (e.g. EPIPE) must NOT trigger a full cleanup/exit — a
    // spurious EPIPE on the MCP pipe should not kill the browser. Log only.
    process.stdin.on("error", (err) => {
      process.stderr.write(`[Weavetab] stdin error (ignored): ${err.message}\n`);
    });
  }
}

let cleanupCalled = false;
async function cleanup() {
  if (cleanupCalled) return;
  cleanupCalled = true;

  // Run plugin onUnload hooks and clear hook pipeline
  try {
    for (const plugin of activeLoadedPlugins.values()) {
      if (typeof plugin.onUnload === "function") {
        try {
          plugin.onUnload((plugin as any)._context);
        } catch (e: any) {
          process.stderr.write(`[Weavetab] Error in plugin "${plugin.name}" onUnload: ${e?.message || e}\n`);
        }
      }
    }
    activeLoadedPlugins.clear();
    hookPipeline.clearAllHooks();
  } catch { /* non-fatal */ }

  // Stop config file watcher handle
  try {
    const { stopConfigWatcher } = await import("./config/loader.js");
    stopConfigWatcher();
  } catch { /* non-fatal */ }

  if ((global as any).__wt_is_server) {
    // In server mode the browser must survive server restarts. Only cancel
    // analytics intervals and close CDP WebSocket connections. Never call
    // Browser.close() — that would kill the browser process (cleanupAll
    // previously ran Browser.close() before the __wt_is_server guard).
    try {
      const { cleanupIntervals } = await import("./cdp/connector.js");
      await cleanupIntervals();
    } catch { /* non-fatal */ }
    console.error("[Weavetab] MCP Server shutting down. Browser session and lockfile preserved for persistence.");
    return;
  }

  // Non-server mode: cancel intervals, close sessions, and shut down the browser.
  try {
    const { cleanupAll } = await import("./cdp/connector.js");
    await cleanupAll();
  } catch { /* non-fatal */ }
  console.error("\n[Weavetab] Cleaning up session and lock files before exiting...");
  try {
    const { sessionRegistry: sr } = await import("./state/session.js");
    const { sendToExtension } = await import("./cdp/helpers.js");
    for (const c of sr.getAll()) {
      await sendToExtension(c.session, { type: 'Weavetab_GROUP_STATE', state: 'idle' }).catch(()=>{});
      await sendToExtension(c.session, { type: 'Weavetab_STATE', hud: { action: '' } }).catch(()=>{});
      await sendToExtension(c.session, { type: 'Weavetab_CLEAR_THOUGHT' }).catch(()=>{});
    }
  } catch { /* non-fatal */ }
  agentState.reportTransportClosed();
  try {
    const { sessionRegistry } = await import("./state/session.js");
    const sessions = sessionRegistry.getAll();
    for (const { session } of sessions) {
      try {
        await session.close();
      } catch { /* ignore */ }
    }
    process.stderr.write(`[Weavetab] ${sessions.length} sessions detached gracefully.\n`);
  } catch (e) {
    console.error(`[Weavetab] Error during cleanup: ${e}`);
  }
}

// ─── Global error handlers: prevent process crash on CDP disconnect ───────
process.on("unhandledRejection", (reason) => {
  // Log the full stack for easier debugging — previously only message was printed
  const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
  process.stderr.write(`[Weavetab] Unhandled rejection: ${detail}\n`);
});

// Uncaught exceptions must never be silently swallowed and marked "non-fatal" —
// that masks critical bugs (OOM, corrupted state) and prevents debugging. Log
// full stack traces, exit immediately on OOM, and exit after 3 consecutive
// exceptions within 10 seconds to prevent runaway failure loops.
let _consecutiveUncaught = 0;
let _consecutiveUncaughtResetTimer: NodeJS.Timeout | null = null;

process.on("uncaughtException", (err) => {
  process.stderr.write(`[Weavetab] Uncaught exception: ${err.stack || err.message}\n`);

  // OOM and similar fatal V8 errors should always terminate
  if (err.message && (err.message.includes('out of memory') || err.message.includes('heap'))) {
    process.stderr.write(`[Weavetab] Fatal OOM error — exiting.\n`);
    process.exit(1);
  }

  // Exit after 3 consecutive uncaught exceptions within 10 seconds
  _consecutiveUncaught++;
  if (_consecutiveUncaughtResetTimer) clearTimeout(_consecutiveUncaughtResetTimer);
  _consecutiveUncaughtResetTimer = setTimeout(() => { _consecutiveUncaught = 0; }, 10_000);
  if (_consecutiveUncaught >= 3) {
    process.stderr.write(`[Weavetab] 3 consecutive uncaught exceptions — exiting to prevent runaway failure.\n`);
    process.exit(1);
  }
});

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(0);
});

process.on("exit", () => {
  // We purposefully do NOT clear the lock file here.
  // Weavetab launches the browser detached, so it survives the server dying.
  // Leaving the lock file allows the next MCP server run to find and reuse
  // the existing browser instead of launching a duplicate.
});

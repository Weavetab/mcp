/**
 * Weavetab — server.ts
 * MCP server: 43 browser automation tools with security, rate limiting, and visual overlay.
 * Weavetab by fy2ne
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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
import { compileTraceToMacro } from "./tools/macro_compiler.js";
import { detectBrowsers } from "./tools/browser_detect.js";
import { browserThought } from "./tools/thought.js";
import { browserCaptcha } from "./tools/captcha.js";
import { browserEmulate } from "./tools/emulation.js";
import { getActiveEngine } from "./cdp/connector.js";
import { resetLoopCounter } from "./intelligence/trail.js";
import { discoverPlugins } from "./plugin/loader.js";
import type { WeavetabPlugin } from "./plugin/interface.js";
import { agentAction } from "./sensors/pacing.js";
import { getCachedConfig } from "./config/loader.js";
import { agentState } from "./state/agent.js";
import { sessionRegistry } from "./state/session.js";

// GitHub tools
import { githubAnalyze } from "./tools/github/analyze.js";
import { githubRead } from "./tools/github/read.js";
import { githubIssues } from "./tools/github/issues.js";
import { githubGetPr } from "./tools/github/pr.js";

// Office document tools
import { browserOfficeParse, browserOfficeList } from "./tools/office/index.js";


type ToolHandler<T> = (session: any, config: Config) => Promise<T>;

const ROLE_TOOL_ALLOW: Record<string, Set<string>> = {
  admin: new Set(["*"]),
  operator: new Set(["*"]),
  viewer: new Set(["browser_map", "browser_find", "browser_scrape", "browser_console", "browser_eval", "browser_inspect", "browser_extract_design", "browser_snapshot", "browser_screenshot", "browser_pdf", "browser_cookies", "browser_tabs", "browser_wait"]),
  automation: new Set(["*"]), // Allowed all except interactive tools (enforced in isToolAllowedForRole)
  system: new Set(["browser_thoughts", "browser_reset_loop_counter", "browser_detect", "browser_performance"]),
};

function isToolAllowedForRole(role: Role, toolName: string): { allowed: boolean; reason?: string } {
  if (role === "automation" && toolName === "browser_thoughts") {
    return { allowed: false, reason: "Role 'automation' does not have permission to use 'browser_thoughts'. Automation agents must be non-interactive." };
  }
  const allowed = ROLE_TOOL_ALLOW[role];
  if (!allowed) return { allowed: true };
  if (allowed.has("*")) return { allowed: true };
  if (allowed.has(toolName)) return { allowed: true };
  return { allowed: false, reason: `Role '${role}' does not have permission to use '${toolName}'. ${role === "viewer" ? "Viewer role only permits read-only tools (map/find/scrape/console/eval/inspect/snapshot/pdf/cookies/github_*)." : ""}` };
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

async function withSecurity<T>(
  config: Config,
  toolName: string,
  handler: ToolHandler<T>,
  isOfficial = false
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

  const { session } = await withTimeoutGuard(() => getOrConnect(liveConfig), 15000, `CDP Connection (${toolName})`);
  agentState.setSession(session);
  (global as any).__wt_live_config = liveConfig;

  try {
    const stopCheck = await session.Runtime.evaluate({
      expression: 'window.__wt_stop_requested===true',
      returnByValue: true,
    });
    if (stopCheck?.result?.value === true) {
      await session.Runtime.evaluate({ expression: 'window.__wt_stop_requested=false;' }).catch(()=>{});
      const { sendToExtension } = await import("./cdp/helpers.js");
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
    const activeClient = sessionRegistry.getActive(liveConfig.agentId);
    if (activeClient?.url) {
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

  const { sendToExtension } = await import("./cdp/helpers.js");
  // Push config to extension once per session (idempotent, ignored if already set)
  sendToExtension(session, {
    type: 'Weavetab_CONFIG',
    groupTabs: (liveConfig as any).groupTabs,
    devMode: liveConfig.devMode,
  }).catch(() => {});
  if (liveConfig.devMode) {
    sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: 'Mission Running', detail: toolName } }).catch(() => {});
  }

  const chatMessages: string[] = [];
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

  // Emit a "started" info log so the user sees the tool immediately
  const argsPreview = '(executing…)';
  pushRichLog(liveConfig.agentId, toolName, ` ${toolName} ${argsPreview}`, '', 'info', !!liveConfig.devMode);

  agentState.reportToolCall();

  const t0 = Date.now();
  try {
    const result = await withTimeoutGuard(() => handler(session, liveConfig), 22000, toolName);
    agentState.reportToolSuccess();
    const ms = Date.now() - t0;

    const activeClient = sessionRegistry.getActive(liveConfig.agentId);
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

      await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: `[OK] ${toolName} (${ms}ms${tokenStr})` } });
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
      const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
      const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '');
      // Return metadata (without the giant dataUrl) + native image block
      const { dataUrl: _omit, ...metaOnly } = resultAny;
      content = [
        { type: "text" as const, text: JSON.stringify(metaOnly) },
        { type: "image" as const, data: base64Data, mimeType },
      ];
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

    const activeClient = sessionRegistry.getActive(liveConfig.agentId);
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

      await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: `[ERR] ${toolName} Error` } });
    }
    throw err;
  }
}

function wrapError(err: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  logAction("ERROR", "server", message);
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function startServer(config: Config, transportMode: "stdio" | "ws" = "stdio", wsPort = 3000): Promise<void> {
  const server = new McpServer({ name: "Weavetab MCP", version: "3.0.0-beta" });

  // Initialize agent state manager
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
      // Handled robustly via Weavetab extension background & content scripts
    },
  });

  // ── 1. browser_map ─────────────────────────────────────────────────────────
  server.tool(
    "browser_map",
    "Snapshot interactive DOM with volatile ref IDs that invalidate after DOM mutations. For complex SPAs (e.g. GitHub dashboards), use `scope` or `query` to reduce tokens. For forms/pagination/sequential loops, ALWAYS use `delta: true` to save 97% tokens.",
    {
      full: z.boolean().optional().describe("Set to true to return a full markdown table (heavier context) instead of the lite list."),
      scope: z.enum(["navigation", "main_content", "sidebar", "form", "modal", "utility"]).optional().describe("Restrict parsing to a semantic page area to save tokens. Crucial for complex dashboards."),
      query: z.string().optional().describe("Filter returned elements by label or role substring. Crucial for complex dashboards."),
      delta: z.boolean().optional().describe("Diff mode: return ONLY elements that changed since the last browser_map call (added, removed, or modified). Diffs across time — distinct from prune. Cuts prompt tokens by up to 97% on consecutive calls."),
      ax_tree: z.boolean().optional().describe("Bypass the extension entirely and read raw Chrome Accessibility Tree. Use this if Shadow DOMs hide elements."),
      tab_id: z.string().optional().describe("Read a specific background tab instead of the active one."),
      show_overlays: z.boolean().optional().describe("Default false. Debug only — draws colored element borders via extension (ugly). The blue edge glow is the standard visual indicator, shown automatically during reading states. Only enable this for debugging element boundaries."),
      force: z.boolean().optional().describe("Force a full DOM map rebuild even if loop detection says nothing changed. Bypasses the map skip guard."),
      prune: z.boolean().optional().describe("Semantic DOM pruning: compress the current snapshot before returning. Drops hidden elements with no interactive descendants and not referenced by any toggle trigger (aria-controls etc.). Replaces SVG icons with [SVG Icon: label] tokens. Distinct from delta:true — delta diffs across time, prune compresses this snapshot once. Combine both for maximum token efficiency."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_map", async (session, liveConfig) => {
          let targetSession = session;
          let targetId = "default";
          const { sessionRegistry } = await import("./state/session.js");
          const active = sessionRegistry.getActive(liveConfig.agentId);
          if (active) targetId = active.targetId;

          if (args.tab_id) {
            const { connectToTab } = await import("./cdp/connector.js");
            const client = await connectToTab(args.tab_id);
            targetSession = client.session;
            targetId = args.tab_id;
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
          return { content: [{ type: "text", text: result }] };
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 2. browser_navigate ────────────────────────────────────────────────────
  server.tool(
    "browser_navigate",
    "Navigate to a URL.",
    {
      url: z.string().describe("Absolute URL to navigate to (must include https://)."),
      force: z.boolean().optional().describe("If true, overwrites current tab even if it's protected (anchor tab). Otherwise opens a new tab automatically."),
      tab_id: z.string().optional().describe("Target a specific tab ID for navigation instead of the active tab.")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_navigate", async (session, liveConfig) => {
          let targetSession = session;
          let targetId = "default";
          if (args.tab_id) {
            const { connectToTab } = await import("./cdp/connector.js");
            const client = await connectToTab(args.tab_id);
            targetSession = client.session;
            targetId = args.tab_id;
          }
          return await agentAction(targetSession, 'navigating', () => weaveNavigate(targetSession, args.url, liveConfig, targetId, args.force), 'browser_navigate');
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 3. browser_click ───────────────────────────────────────────────────────
  server.tool(
    "browser_click",
    "Click a DOM element. Use browser_canvas for charts/canvas. If stuck_warning=true, stop and use browser_map.",
    {
      id: z.string().optional().describe("Ref ID from browser_map (e.g. 'w:42'). Primary targeting method. DO NOT SPAM. If stuck_warning is returned, stop retrying and call browser_map first."),
      selector: z.string().optional().describe("CSS selector of the element to click."),
      target: z.string().optional().describe("CSS selector or query string. Alias for selector."),
      label: z.string().optional().describe("Visible text or aria-label to click."),
      intent: z.string().optional().describe("Semantic description of the action (e.g. 'submit login form'). WeaveTab checks learned memory first — if a high-confidence selector is found it clicks immediately without DOM resolution. Falls through to normal resolution on a miss; does not error."),
      backendNodeId: z.number().optional().describe("Raw CDP backendNodeId for direct hardware targeting."),
      x: z.number().optional().describe("Raw X coordinate. Use for precise positional clicks when element ID is not available."),
      y: z.number().optional().describe("Raw Y coordinate. Use for precise positional clicks when element ID is not available."),
      include_map: z.boolean().optional().describe("Set true to include a full updated page_map in the response. Default false — omit when you already have ref IDs or don't need a DOM refresh."),
      tab_id: z.string().optional().describe("Execute in a specific tab instead of active."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_click", async (session, liveConfig) => {
          let targetSession = session;
          if (args.tab_id) {
            const { connectToTab } = await import("./cdp/connector.js");
            const client = await connectToTab(args.tab_id);
            targetSession = client.session;
          }
          const normalizedArgs = { ...args };
          if (args.selector && !normalizedArgs.id) normalizedArgs.id = args.selector;
          if (args.target && !normalizedArgs.id) normalizedArgs.id = args.target;
          return await agentAction(targetSession, 'clicking', () => weaveClick(targetSession, normalizedArgs, liveConfig), 'browser_click');
        });
      } catch (e) { return wrapError(e); }
    }
  );



// ── 4. browser_type ────────────────────────────────────────────────────────
server.tool(
    "browser_type",
    "Type text into a single input field (use browser_fill for smart multi-field forms). If NOT_EDITABLE, fallback to click + browser_key. Use browser_map if stuck.",
  {
    id: z.string().optional().describe("Ref ID from browser_map. Primary targeting — always prefer this over label when you have a ref ID."),
    selector: z.string().optional().describe("CSS selector of the input field. Use when you know the exact selector."),
    target: z.string().optional().describe("CSS selector or query string. Alias for selector."),
    label: z.string().optional().describe("Field label or placeholder text. Used for fuzzy matching."),
    intent: z.string().optional().describe("Semantic description of the field (e.g. 'search box', 'username field'). Checked against learned memory first."),
    x: z.number().optional().describe("Raw X coordinate to focus before typing. Use as last resort when no id/selector/label is available."),
    y: z.number().optional().describe("Raw Y coordinate to focus before typing. Use as last resort when no id/selector/label is available."),
    text: z.string().describe("Text to type. If a NOT_EDITABLE error is returned: (1) use browser_click on the field, then (2) use browser_key with the text as individual keypresses."),
    clearFirst: z.boolean().optional().describe("Wipe existing field content before typing. May break React/Vue controlled inputs — avoid unless field already has wrong text in it."),
    paste: z.boolean().optional().describe("Instant paste mode via clipboard. Auto-enabled for text longer than 8 chars. Best for long URLs or multi-word strings."),
    include_map: z.boolean().optional().describe("Set true to include a full updated page_map in the response. Default false."),
    tab_id: z.string().optional().describe("Execute in a specific tab instead of active."),
  },
  async (args) => {
    try {
      return await withSecurity(config, "browser_type", async (session, liveConfig) => {
        let targetSession = session;
        if (args.tab_id) {
          const { connectToTab } = await import("./cdp/connector.js");
          const client = await connectToTab(args.tab_id);
          targetSession = client.session;
        }
        const normalizedArgs = { ...args };
        if (args.selector && !normalizedArgs.id) normalizedArgs.id = args.selector;
        if (args.target && !normalizedArgs.id) normalizedArgs.id = args.target;
        return await agentAction(targetSession, 'typing', () => weaveType(targetSession, normalizedArgs, liveConfig), 'browser_type');
      });
    } catch (e) { return wrapError(e); }
  }
);

// ── 4b. browser_type_secret ────────────────────────────────────────────────
server.tool(
    "browser_type_secret",
    "Inject a secret from an environment variable.",
  {
    id: z.string().optional().describe("Ref ID from browser_map."),
    target: z.string().optional().describe("Alternative target input element identifier or CSS selector."),
    envKey: z.string().describe("The environment variable key containing the secret."),
  },
  async (args) => {
    try {
      return await withSecurity(config, "browser_type_secret", async (session, liveConfig) => {
        return await agentAction(session, 'typing', () => weaveTypeSecret(session, args as any, liveConfig), 'browser_type_secret');
      });
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
    },
    async (args) => {
      const { key, modifiers, tab_id } = args;
      try {
        return await withSecurity(config, "browser_key", async (session, liveConfig) => {
          let targetSession = session;
          if (tab_id) {
            const { connectToTab } = await import("./cdp/connector.js");
            const client = await connectToTab(tab_id);
            targetSession = client.session;
          }
          return await weaveKey(targetSession, { key, modifiers }, liveConfig);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 6. browser_scroll ──────────────────────────────────────────────────────
  server.tool(
    "browser_scroll",
    "Scroll the page.",
    {
      id: z.string().optional().describe("Ref ID to scroll into view or scroll inside of. DO NOT SPAM. If action fails or loops, STOP calling this tool and use browser_map to re-evaluate the page state."),
      selector: z.string().optional().describe("CSS Selector of the element to scroll into view."),
      target: z.string().optional().describe("Alternative element identifier or query to scroll into view."),
      label: z.string().optional().describe("Element label to scroll into view."),
      direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction."),
      distance: z.number().optional().describe("Pixels to scroll (default 400)."),
      tab_id: z.string().optional().describe("Execute in a specific tab instead of active. DO NOT SPAM. If action fails or loops, STOP calling this tool and use browser_map to re-evaluate the page state."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_scroll", async (session, liveConfig) => {
          let targetSession = session;
          if (args.tab_id) {
            const { connectToTab } = await import("./cdp/connector.js");
            const client = await connectToTab(args.tab_id);
            targetSession = client.session;
          }
          const normalizedArgs = { ...args };
          if (args.selector && !normalizedArgs.id) normalizedArgs.id = args.selector;
          if (args.target && !normalizedArgs.id) normalizedArgs.id = args.target;
          return await browserScroll(targetSession, normalizedArgs, liveConfig);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 7. browser_dialog ──────────────────────────────────────────────────────
  server.tool(
    "browser_dialog",
    "Accept or dismiss JS dialogs.",
    {
      action: z.enum(["accept", "dismiss"]).describe("Action to perform on the dialog."),
      promptText: z.string().optional().describe("Text to enter if it is a prompt dialog.")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_dialog", async (session) => {
          return await browserDialog(session, args as any);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 8. browser_burst ───────────────────────────────────────────────────────
  server.tool(
    "browser_burst",
    "Chain multiple tool calls in one round-trip. Use the 'click_and_wait' macro step instead of a standard click for buttons like login or buttons that will take time to load a new page.",
    {
      steps: z.array(z.object({
        tool: z.enum(["browser_click", "browser_type", "browser_navigate", "browser_key", "browser_scroll", "browser_wait", "browser_map", "browser_pointer", "browser_eval", "browser_select", "type_and_send", "navigate_and_read", "click_and_wait", "scroll_and_read"]),
        args: z.record(z.unknown()).describe("Arguments for the respective tool. For type_and_send: { text, x?, y?, id?, label?, pressEnter? }. For navigate_and_read: { url }. For click_and_wait: { id?, label?, x?, y?, wait_for?, wait_value? }. For scroll_and_read: { direction, distance? }.")
      })).describe("Ordered array of tool calls to execute serially. Use macro steps to save tokens."),
      batch: z.boolean().optional().describe("If true, defers action map generation until all steps are complete to save time.")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_burst", async (session, liveConfig) => {
          const { browserBurst } = await import("./tools/burst.js");
          return await browserBurst(session, args as any, liveConfig);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 9. browser_tabs ───────────────────────────────────────────────────────
  server.tool(
    "browser_tabs",
    "Manage browser tabs (open, switch, close, list).",
    {
      action: z.enum(["list", "open", "close", "switch", "list_windows", "focus_window", "consolidate", "heal"]).describe("Action to perform. 'consolidate' deduplicates tabs. 'heal' recovers crashed tabs."),
      url: z.string().optional().describe("URL to open (required for 'open' action)."),
      tabId: z.string().optional().describe("Target Tab ID (required for 'switch' or 'close')."),
      tabIds: z.array(z.string()).optional().describe("Multiple Tab IDs for batch 'close' action."),
      force: z.boolean().optional().describe("Force close protected (anchor) tabs. Use with extreme caution."),
      windowId: z.number().optional().describe("Window ID to focus (required for 'focus_window')."),
      reuse: z.boolean().optional().describe("Default true. When opening a URL already loaded in another tab, focus that tab instead of opening a duplicate."),
    },
    async ({ action, url, tabId, tabIds, force, windowId, reuse }) => {
      try {
        return await withSecurity(config, "browser_tabs", async (_, liveConfig) => {
          if (action === "list") return await WeavetabList(liveConfig);
          if (action === "open") {
            if (!url) throw new Error("url is required for action: open");
            return await WeavetabOpen(url, liveConfig, reuse !== false);
          }
          if (action === "switch") {
            if (!tabId) throw new Error("tabId is required for action: switch");
            return await WeavetabSwitch(tabId, liveConfig);
          }
          if (action === "close") {
            if (tabIds && tabIds.length > 0) return await WeavetabCloseBatch(tabIds, liveConfig, force);
            if (!tabId) throw new Error("tabId or tabIds is required for action: close");
            return await WeavetabClose(tabId, liveConfig, force);
          }
          if (action === "list_windows") {
            return await weaveWindowList(liveConfig);
          }
          if (action === "focus_window") {
            if (windowId === undefined) throw new Error("windowId is required for action: focus_window");
            return await weaveFocusWindow(windowId, liveConfig);
          }
          if (action === "consolidate") {
            return await WeavetabConsolidate(liveConfig);
          }
          if (action === "heal") {
            return await WeavetabHeal(liveConfig);
          }
          throw new Error("Invalid action");
        });
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
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_wait", async (session, liveConfig) => {
          let targetSession = session;
          if (args.tab_id) {
            const { connectToTab } = await import("./cdp/connector.js");
            const client = await connectToTab(args.tab_id);
            targetSession = client.session;
          }
          return await browserWait(targetSession, args, liveConfig);
        });
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
    "Agent-to-user communication. Use 'question' mode to ask a free-text question. Use 'feedback' mode to provide status updates or analysis (green sticky feedback).",
    {
      action: z.enum(["question", "feedback"]).describe("Action to perform."),
      message: z.string().describe("The question to ask, or the feedback/analysis to log."),
      input: z.enum(["sentence", "paragraph"]).optional().describe("Input field type for question mode (default: sentence)."),
      timeout: z.number().optional().describe("Timeout in seconds for question mode before auto-cancel (default: 120)."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_thoughts", async (session) => {
          if (args.action === "feedback") {
            const { logActionStructured } = await import("./audit/logger.js");
            logActionStructured({
              timestamp: new Date().toISOString(),
              tool: "browser_thoughts",
              result: `[AGENT FEEDBACK]: ${args.message}`
            });
            await browserThought(session, { action: "feedback", message: args.message });
            return { content: [{ type: "text", text: "Feedback appended to mission log and HUD." }] };
          }
          const result = await browserThought(session, { action: "question", message: args.message, input: args.input, timeout: args.timeout });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        });
      } catch (e) { return wrapError(e); }
    }
  );


  // ── 13. browser_pointer ───────────────────────────────────────────────────────
  server.tool(
    "browser_pointer",
    "Advanced pointer control (hover, drag).",
    {
      action: z.enum(["hover", "click", "double_click", "drag_and_drop"]).describe("Action to perform."),
      ref: z.string().optional().describe("Ref ID of the target element (e.g. w:42)."),
      id: z.string().optional().describe("Alternative element ID / Ref ID from browser_map."),
      selector: z.string().optional().describe("CSS Selector of the target element."),
      target: z.string().optional().describe("Alternative target element identifier or query."),
      x: z.number().optional().describe("Raw X coordinate (fallback)."),
      y: z.number().optional().describe("Raw Y coordinate (fallback)."),
      end_ref: z.string().optional().describe("Destination Ref ID (only for drag_and_drop)."),
      end_id: z.string().optional().describe("Destination element ID (only for drag_and_drop)."),
      end_selector: z.string().optional().describe("Destination CSS Selector (only for drag_and_drop)."),
      end_target: z.string().optional().describe("Alternative destination target identifier or query."),
      end_x: z.number().optional().describe("Destination X coordinate (only for drag_and_drop)."),
      end_y: z.number().optional().describe("Destination Y coordinate (only for drag_and_drop)."),
      waitForChild: z.string().optional().describe("CSS Selector of a child element to wait for (only for hover)."),
      holdMs: z.number().optional().describe("Milliseconds to hold the pointer down (only for hover).")
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
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 14. browser_select ───────────────────────────────────────────────────────
  server.tool(
    "browser_select",
    "Select an option from a native dropdown.",
    {
      nodeId: z.number().optional().describe("CDP backendNodeId."),
      selector: z.string().optional().describe("CSS Selector."),
      value: z.string().describe("The exact text value to select."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_select", async (session, liveConfig) => {
          return await browserSelect(session, args, liveConfig);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 14b. browser_fill ──────────────────────────────────────────────────────
  server.tool(
    "browser_fill",
    "Smart multi-field form-filling. Best for big complex forms to save round-trips.",
    {
      fields: z.array(z.object({
        ref: z.string().describe("Element ref ID (w:NN) from browser_map."),
        value: z.string().describe("Value to fill/select/type into the field."),
      })).describe("Array of field ref+value pairs to fill sequentially."),
      submit: z.string().optional().describe("Optional ref ID (w:NN) of a submit button to click after filling all fields."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_fill", async (session, liveConfig) => {
          return await agentAction(session, 'typing', () => browserFill(session, args, liveConfig), 'browser_fill');
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 18. browser_highlight ───────────────────────────────────────────────────
  server.tool(
    "browser_highlight",
    "Highlight an element with a colored overlay.",
    {
      selector: z.string().optional().describe("CSS Selector of the element to highlight."),
      id: z.string().optional().describe("Alternative element Ref ID from browser_map (e.g. 'w:42')."),
      ref: z.string().optional().describe("Alternative element Ref ID (e.g. 'w:42')."),
      target: z.string().optional().describe("Alternative element identifier, CSS Selector, or query."),
      nodeId: z.number().optional().describe("CDP backendNodeId to highlight directly."),
      color: z.string().optional().describe("CSS color to use for the overlay (e.g. 'rgba(255,0,0,0.5)').")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_highlight", async (session, liveConfig) => {
          const normalizedArgs = { ...args };
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
        });
      } catch (e) { return wrapError(e); }
    }
  );


  // ── 20. browser_upload ──────────────────────────────────────────────────────
  server.tool(
    "browser_upload",
    "Upload files to a file input.",
    {
      nodeId: z.number().describe("CDP backendNodeId of the target <input type='file'> element."),
      filePaths: z.array(z.string()).describe("List of absolute system file paths to upload.")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_upload", async (session, liveConfig) => {
          return await browserUpload(session, args, liveConfig);
        });
      } catch (e) { return wrapError(e); }
    }
  );



  // ── 22. browser_find ────────────────────────────────────────────────────────
  server.tool(
    "browser_find",
    "Sub-5ms CDP text search. Zero token waste. Best for locating specific keywords/text on page without a full DOM walk. No refs returned (use browser_map for refs). No shadow roots/regex.",
    {
      query: z.string().describe("Exact text query to find on the page.")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_find", async (session, liveConfig) => {
          return await agentAction(session, 'reading', () => browserFind(session, args, liveConfig), 'browser_find');
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 23. browser_storage ─────────────────────────────────────────────────────
  server.tool(
    "browser_storage",
    "Manage localStorage and sessionStorage.",
    {
      scope: z.enum(["local", "session"]).describe("Storage scope to manipulate."),
      action: z.enum(["get", "set", "clear"]).describe("Action to perform on the storage."),
      key: z.string().optional().describe("Key name (required for 'get' and 'set' actions)."),
      value: z.string().optional().describe("String value (required for 'set' action)."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_storage", async (session, liveConfig) => {
          return await browserStorage(session, args, liveConfig);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 24. browser_network_intercept ───────────────────────────────────────────
  server.tool(
    "browser_network_intercept",
    `Intercept/stub network responses (e.g. mock APIs, block tracking) OR retrieve detailed raw protocol network telemetry (TLS/SSL certificate info, microsecond timing breakdown, and OS-level failure reasons).`,
    {
      action: z.enum(["enable", "disable", "get_telemetry", "clear_telemetry"]).describe("Action to perform: 'enable'/'disable' network response interception, 'get_telemetry' to read captured requests with TLS/SSL certs & timing breakdown, or 'clear_telemetry' to reset buffer."),
      pattern: z.string().optional().describe("URL glob pattern to intercept or filter telemetry (e.g. '*api/login*')."),
      mockStatus: z.number().optional().describe("HTTP status code to return when enabling mock (default 200)."),
      mockBody: z.string().optional().describe("JSON or plaintext body payload to return in the mocked response."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_network_intercept", async (session, liveConfig) => {
          return await browserNetworkIntercept(session, args, liveConfig);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 25. browser_console ─────────────────────────────────────────────────────
  server.tool(
    "browser_console",
    "1-5ms latency. Read or clear buffered console API messages, JS exceptions, and network errors.",
    {
      action: z.enum(["read", "clear"]).describe("Action to perform on the console buffer.")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_console", async (session, liveConfig) => {
          let targetId = "default";
          const { sessionRegistry } = await import("./state/session.js");
          const active = sessionRegistry.getActive(liveConfig.agentId);
          if (active) targetId = active.targetId;
          return await browserConsole(session, args, liveConfig, targetId);
        });
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
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_pdf", async (session, liveConfig) => {
          return await browserPdf(session, args, liveConfig);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 27. browser_eval ────────────────────────────────────────────────────────
  server.tool(
    "browser_eval",
    "Run arbitrary JS via CDP. Good for extracting app state. Cannot traverse shadow DOM/cross-origin iframes.",
    {
      expression: z.string().describe("JavaScript code to evaluate in the context of the page."),
      timeout: z.number().optional().describe("Timeout in ms (default 5000).")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_eval", async (session, liveConfig) => {
          return await agentAction(session, 'reading', () => browserEval(session, args, liveConfig), 'browser_eval');
        });
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
      url: z.string().optional().describe("URL scope for 'get' action (defaults to current page)."),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_cookies", async (session, liveConfig) => {
          return await browserCookies(session, args, liveConfig);
        });
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
      points: z.array(z.object({ x: z.number(), y: z.number() })).optional().describe("Array of {x,y} points relative to canvas viewport for 'draw' action. Simulates a drag path across the canvas.")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_canvas", async (session, liveConfig) => {
          return await browserCanvas(session, args, liveConfig);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 31. browser_scrape ──────────────────────────────────────────────────────
  server.tool(
    "browser_scrape",
    "Sub-5ms latency, zero waste extraction. Best for batch list extraction, table parsing, targeted data mining. Prefer this over browser_map for pure data extraction. Note: XPath selectors lack shadow-DOM support; use CSS selectors for shadow DOMs.",
    {
      query: z.string().describe("CSS Selector or XPath query to extract."),
      type: z.enum(["css", "xpath"]).optional().describe("Query type (default 'css')."),
      attributes: z.array(z.string()).optional().describe("Attributes to extract (e.g. ['textContent', 'href'], default ['textContent'])."),
      multiple: z.boolean().optional().describe("Whether to extract multiple elements (default true).")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_scrape", async (session, liveConfig) => {
          return await agentAction(session, 'reading', () => browserScrape(session, args, liveConfig), 'browser_scrape');
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 32. browser_snapshot ────────────────────────────────────────────────────
  server.tool(
    "browser_snapshot",
    "Capture or restore an MHTML snapshot. Best for offline archival, replay testing, and compliance audits.",
    {
      action: z.enum(["capture", "restore"]).describe("Action to perform."),
      filePath: z.string().describe("Absolute file path to save/load the .mhtml snapshot.")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_snapshot", async (session, liveConfig) => {
          return await browserSnapshot(session, args as any, liveConfig);
        });
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
      }).optional().describe("Clip region. Use to capture only part of the page (e.g. just a chart area) to reduce token cost.")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_screenshot", async (session, liveConfig) => {
          return await agentAction(session, 'reading', () => browserScreenshot(session, args, liveConfig), 'browser_screenshot');
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 33. browser_viewport ────────────────────────────────────────────────────
  server.tool(
    "browser_viewport",
    "Set viewport dimensions and device emulation.",
    {
      action: z.enum(["set", "clear"]).describe("Action to perform."),
      width: z.number().optional().describe("Viewport width in pixels."),
      height: z.number().optional().describe("Viewport height in pixels."),
      deviceScaleFactor: z.number().optional().describe("Device Pixel Ratio (default 1)."),
      mobile: z.boolean().optional().describe("Whether to emulate a mobile device (default false).")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_viewport", async (session, liveConfig) => {
          return await browserViewport(session, args, liveConfig);
        });
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
      mimeType: z.string().optional().describe("MIME type override for image write (auto-detected from dataUrl by default, e.g. 'image/png').")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_clipboard", async (session, liveConfig) => {
          return await browserClipboard(session, args, liveConfig);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 36. browser_inspect ─────────────────────────────────────────────────────
  server.tool(
    "browser_inspect",
    "15-35ms latency, zero waste. Deep DOM inspection. Crucial for debugging why a click failed, verifying z-index & visibility, or computed styles.",
    {
      nodeId: z.number().optional().describe("CDP backendNodeId."),
      selector: z.string().optional().describe("CSS Selector."),
      ref: z.string().optional().describe("Ref ID (e.g. 'w:42').")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_inspect", async (session, liveConfig) => {
          return await agentAction(session, 'reading', () => browserInspect(session, args, liveConfig), 'browser_inspect');
        });
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
      hideOverlay: z.boolean().optional().describe("Whether to hide Weavetab overlay during capture (default true).")
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_extract_design", async (session, liveConfig) => {
          return await agentAction(session, 'reading', () => browserExtractDesign(session, args, liveConfig), 'browser_extract_design');
        });
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
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_automation", async (session, liveConfig) => {
          const result = await browserAutomation(session, args, liveConfig);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        });
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
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_recording", async (session, liveConfig) => {
          const result = await browserRecording(session, args, liveConfig);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── 38. browser_reset_loop_counter ─────────────────────────────────────────
  server.tool(
    "browser_reset_loop_counter",
    "Reset the loop detection counter.",
    {
      reason: z.string().optional().describe("Optional reason for the reset (e.g. 'new_task', 'manual_recovery')."),
    },
    async (args) => {
      resetLoopCounter(args.reason || "manual_tool_call");
      return { content: [{ type: "text", text: JSON.stringify({ success: true, reason: args.reason || "manual_tool_call" }) }] };
    }
  );



  // ── 37. browser_detect ─────────────────────────────────────────────────────
  server.tool(
    "browser_detect",
    "Detect available browsers on the machine.",
    {},
    async () => {
      try {
        const result = detectBrowsers(getActiveEngine());
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) { return wrapError(e); }
    }
  );

  // ── browser_performance ───────────────────────────────────────────────────
  server.tool(
    "browser_performance",
    "Retrieve page performance metrics.",
    {},
    async () => {
      try {
        return await withSecurity(config, "browser_performance", async (session, liveConfig) => {
          const result = await browserPerformance(session, liveConfig);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── browser_macro_compile ─────────────────────────────────────────────────
  server.tool(
    "browser_macro_compile",
    "Compile a recent trail into a burst macro.",
    {
      trail_steps: z.array(z.any()).describe("An array of TrailStep objects representing successful steps.")
    },
    async (args) => {
      try {
        const result = compileTraceToMacro(args.trail_steps);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) { return wrapError(e); }
    }
  );



  // ── GitHub Tools (v2.5.0 Core Inclusion) ──────────────────────────────────
  server.tool(
    "github_analyze",
    "Analyze a GitHub repository.",
    {
      repo: z.string().optional().describe("Optional 'owner/repo' slug. If omitted, uses the active tab's repository.")
    },
    async (args) => {
      try {
        return await withSecurity(config, "github_analyze", async (session, liveConfig) => {
          // Defence-in-depth: coerce to string | undefined at the server boundary.
          // Zod marks `repo` as optional(string) but (args as any) bypasses that
          // guarantee, so we normalise here before forwarding to githubAnalyze.
          const rawRepo = (args as any).repo;
          const repo: string | undefined =
            typeof rawRepo === "string" && rawRepo.trim() !== ""
              ? rawRepo.trim()
              : undefined;
          return await githubAnalyze(session, liveConfig, repo);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  server.tool(
    "github_read",
    "Read file contents from a GitHub repository.",
    {
      paths: z.array(z.string()).describe("List of file paths to read, relative to the repository root."),
      line_range: z.array(z.number()).length(2).optional().describe("Optional [start, end] line range to read specific lines instead of the default first 200 lines. 1-indexed.")
    },
    async (args) => {
      try {
        return await withSecurity(config, "github_read", async (session, liveConfig) => {
          return await githubRead(session, args as any, liveConfig);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  server.tool(
    "github_issues",
    "Interact with GitHub issues.",
    {
      search: z.string().optional().describe("Search query to find issues."),
      number: z.number().optional().describe("Specific issue number to fetch details and comments for."),
      labels: z.array(z.string()).optional().describe("Filter issues by labels."),
      state: z.enum(["open", "closed", "all"]).optional().describe("Filter issues by state."),
      limit: z.number().optional().describe("Max number of issues to list. Default 5.")
    },
    async (args) => {
      try {
        return await withSecurity(config, "github_issues", async (session) => {
          return await githubIssues(session, args as any);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  server.tool(
    "github_get_pr",
    "Interact with GitHub pull requests.",
    {
      number: z.number().optional().describe("Specific pull request number to fetch details, changed files, and comments for. If omitted, lists recent PRs.")
    },
    async (args) => {
      try {
        return await withSecurity(config, "github_get_pr", async (session) => {
          return await githubGetPr(session, args as any);
        });
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
      userAgent: z.string().optional().describe("Override User Agent string"),
    },
    async (args) => {
      try {
        return await withSecurity(config, "browser_emulate", async (session, liveConfig) => {
          return await browserEmulate(session, args as any, liveConfig);
        });
      } catch (e) { return wrapError(e); }
    }
  );

  // ── Prompts ──────────────────────────────────────────────────────────────────
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
            content: { type: "text", text: "No active WeaveTab session found. Open a browser tab and navigate to a page first." }
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
        `# 🌐 WeaveTab Context: ${title ?? "(unknown)"}`,
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

  // ── Plugins Lifecycle (Add / Override / Remove) ───────────────────────────
  const plugins: WeavetabPlugin[] = discoverPlugins();
  const { getVerifiedPackages, resolvePluginTrust } = await import("./plugin/registry.js");
  const verifiedPackages = await getVerifiedPackages();

  let pluginAddedCount = 0;
  let pluginOverrideCount = 0;
  let pluginRemovedCount = 0;

  for (const plugin of plugins) {
    const trust = resolvePluginTrust(plugin.name, verifiedPackages);
    const isOfficial = trust.tier === "official";

    const addedNames: string[] = [];
    const overriddenNames: string[] = [];
    const removedNames: string[] = [];

    // 1. Tool Removals (disable built-in tools)
    const toRemove = [
      ...(plugin.removeTools || []),
      ...(plugin.manifest?.permissions?.tools?.remove || []),
    ];
    for (const toolName of toRemove) {
      if ((server as any)._registeredTools?.[toolName]) {
        delete (server as any)._registeredTools[toolName];
        removedNames.push(toolName);
        pluginRemovedCount++;
      }
    }

    // 2. Tool Overrides (replace or wrap built-in tools)
    const overrides = plugin.overrides || [];
    for (const ov of overrides) {
      const existingTool = (server as any)._registeredTools?.[ov.name];
      const existingDesc = existingTool?.description || "";
      const existingSchema = existingTool?.parameters?.shape || {};

      if (existingTool) {
        delete (server as any)._registeredTools[ov.name];
      }

      server.tool(
        ov.name,
        ov.description || existingDesc || `Tool overridden by ${plugin.name}`,
        ov.schema || existingSchema,
        async (args: any) => {
          try {
            return await withSecurity(
              config,
              ov.name,
              async (session, liveConfig) => {
                const wrappedOrig = existingTool
                  ? async (origArgs: Record<string, any>, _sess: any, _cfg: any) => {
                      const res = await existingTool.handler(origArgs, {});
                      return res;
                    }
                  : undefined;

                const result = await ov.handler(args, session, liveConfig, wrappedOrig);
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
              },
              isOfficial
            );
          } catch (e) {
            return wrapError(e);
          }
        }
      );
      overriddenNames.push(ov.name);
      pluginOverrideCount++;
    }

    // 3. Tool Additions (new tools)
    const newTools = plugin.tools || [];
    for (const td of newTools) {
      if ((server as any)._registeredTools?.[td.name]) {
        delete (server as any)._registeredTools[td.name];
      }
      server.tool(
        td.name,
        td.description,
        td.schema,
        async (args: any) => {
          try {
            return await withSecurity(
              config,
              td.name,
              async (session, liveConfig) => {
                const result = await td.handler(args, session, liveConfig);
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
              },
              isOfficial
            );
          } catch (e) {
            return wrapError(e);
          }
        }
      );
      addedNames.push(td.name);
      pluginAddedCount++;
    }

    // Execute plugin onLoad hook if present
    if (typeof plugin.onLoad === "function") {
      try {
        await plugin.onLoad();
      } catch (err: any) {
        process.stderr.write(`  \u001b[31m[!] Plugin ${plugin.name} onLoad failed: ${err?.message}\u001b[0m\n`);
      }
    }

    // Build permission and operations warning string
    const ops: string[] = [];
    if (addedNames.length > 0) ops.push(`+${addedNames.length} added`);
    if (overriddenNames.length > 0) ops.push(`⚡overrode [${overriddenNames.join(", ")}]`);
    if (removedNames.length > 0) ops.push(`✖removed [${removedNames.join(", ")}]`);
    const opsStr = ops.length > 0 ? ` (${ops.join(", ")})` : "";

    let permWarning = "";
    if (trust.tier === "unverified" && plugin.manifest?.permissions) {
      const perms = plugin.manifest.permissions;
      const flags: string[] = [];
      if (perms.network) flags.push("network");
      if (perms.cdp) flags.push("cdp");
      if (perms.fs) flags.push("fs");
      if (perms.tools?.override?.length) flags.push(`override:${perms.tools.override.join(",")}`);
      if (perms.tools?.remove?.length) flags.push(`remove:${perms.tools.remove.join(",")}`);
      if (flags.length > 0) {
        permWarning = ` \u001b[33m— requests: ${flags.join(", ")}\u001b[0m`;
      }
    }

    process.stderr.write(
      `  ${trust.badge} ${plugin.name} v${plugin.version}${opsStr}${permWarning}\n`
    );
  }

  let transport;
  if (transportMode === "ws") {
    const { WebSocketServerTransport } = await import("./cdp/websocket_transport.js");
    transport = new WebSocketServerTransport(wsPort);
    console.error(`[Weavetab] Mode: ${config.mode || "session"} (${config.mode === 'attach' ? 'user browser' : 'isolated browser'})`);
    console.error(`[Weavetab] Transport: WebSocket server listening on port ${wsPort}`);
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

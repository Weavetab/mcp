/**
 * Weavetab — tools/network_intercept.ts
 * browser_network_intercept: Intercept/stub network responses AND retrieve
 * deep network telemetry (TLS/SSL Certificate metadata, microsecond timing breakdown,
 * and precise OS-level network failure reasons).
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { TelemetryCapture, TelemetryReport } from "../sensors/network.js";

export interface InterceptRule {
  pattern?: string;
  urlPattern?: string;
  mockStatus?: number;
  mockBody?: string;
}

export interface InterceptOptions {
  action: "enable" | "disable" | "get_telemetry" | "clear_telemetry";
  pattern?: string; // e.g. "*api/users*"
  mockStatus?: number;
  mockBody?: string;
  rules?: InterceptRule[];
}

// Track handler refs so we can remove them on disable — prevents
// handler accumulation that causes double-fulfill CDP crashes.
const activeHandlers = new Map<CDP.Client, (params: any) => Promise<void>>();
const activeInterceptors = new Map<CDP.Client, { pattern: string; mockStatus: number; mockBody: string }>();
const activeTelemetry = new Map<CDP.Client, TelemetryCapture>();

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(escaped);
}

export function cleanupNetworkIntercept(session: CDP.Client): void {
  const handler = activeHandlers.get(session);
  if (handler) {
    try { (session as any).removeListener('Fetch.requestPaused', handler); } catch {}
    activeHandlers.delete(session);
  }
  activeInterceptors.delete(session);
  const tc = activeTelemetry.get(session);
  if (tc) {
    tc.stop().catch(() => {});
    activeTelemetry.delete(session);
  }
}

async function getOrCreateTelemetry(session: CDP.Client): Promise<TelemetryCapture> {
  let tc = activeTelemetry.get(session);
  if (!tc) {
    tc = new TelemetryCapture(session);
    await tc.start();
    activeTelemetry.set(session, tc);
  }
  return tc;
}

export async function browserNetworkIntercept(
  session: CDP.Client,
  options: InterceptOptions,
  _config: Config
): Promise<any> {
  const firstRule = Array.isArray(options.rules) && options.rules.length > 0 ? options.rules[0] : undefined;
  const pattern = options.pattern ?? firstRule?.pattern ?? firstRule?.urlPattern;
  const mockStatus = options.mockStatus ?? firstRule?.mockStatus;
  const mockBody = options.mockBody ?? firstRule?.mockBody;

  // ── Action: get_telemetry ──────────────────────────────────────────────
  if (options.action === "get_telemetry") {
    const tc = activeTelemetry.get(session);
    if (!tc) {
      await getOrCreateTelemetry(session);
      return {
        success: true,
        message: "Network telemetry capture started. No network requests recorded yet. Make network requests and call get_telemetry again.",
        count: 0,
        requests: []
      };
    }

    const report: TelemetryReport = await tc.stop();
    // Restart capture for continuous monitoring
    await tc.start();

    let requests = report.networkRequests;
    if (pattern) {
      const reg = globToRegex(pattern);
      requests = requests.filter(r => reg.test(r.url));
    }

    return {
      success: true,
      message: `Retrieved ${requests.length} captured network request(s) with raw protocol metadata.`,
      count: requests.length,
      requests,
      navigationOccurred: report.navigationOccurred,
      newUrl: report.newUrl,
      errors: report.errors
    };
  }

  // ── Action: clear_telemetry ────────────────────────────────────────────
  if (options.action === "clear_telemetry") {
    const tc = activeTelemetry.get(session);
    if (tc) {
      await tc.start();
    } else {
      await getOrCreateTelemetry(session);
    }
    return { success: true, message: "Network telemetry buffer cleared and capture reset." };
  }

  // Auto-start telemetry background listener when enable/disable is called
  await getOrCreateTelemetry(session).catch(() => {});

  const { sendToExtension } = await import("../cdp/helpers.js");

  const hasExt = await session.Runtime.evaluate({
    expression: `!!window.__Weavetab`,
    returnByValue: true
  }).catch(() => null);

  if (hasExt?.result?.value) {
    // ── Extension path (preferred) ────────────────────────────────────────
    if (options.action === "enable") {
      if (!pattern) throw new Error("enable requires 'pattern' (or rules[0].pattern)");
      await sendToExtension(session, {
        type: 'NETWORK_INTERCEPT_ENABLE',
        pattern,
        mockStatus: mockStatus || 200,
        mockBody: mockBody || '{}'
      });
      activeInterceptors.set(session, { pattern, mockStatus: mockStatus || 200, mockBody: mockBody || '{}' });
      return { success: true, message: `Extension interception enabled for ${pattern}` };
    }
    if (options.action === "disable") {
      await sendToExtension(session, { type: 'NETWORK_INTERCEPT_DISABLE' });
      activeInterceptors.delete(session);
      return { success: true, message: "Extension interception disabled" };
    }
  }

  // ── CDP Fetch domain fallback ───────────────────────────────────────────
  if (options.action === "enable") {
    if (!pattern) throw new Error("enable requires 'pattern' (or rules[0].pattern)");
    const status = mockStatus || 200;
    const body = mockBody || '{}';
    const reg = globToRegex(pattern);

    // Remove stale handler from previous enable() to prevent accumulation
    const oldHandler = activeHandlers.get(session);
    if (oldHandler) {
      try { (session as any).removeListener('Fetch.requestPaused', oldHandler); } catch {}
    }

    try {
      await (session as any).Fetch.enable({ patterns: [{ urlPattern: pattern, requestStage: 'Response' }] });
      const handler = async (params: any) => {
        if (params.request?.url && reg.test(params.request.url)) {
          await (session as any).Fetch.fulfillRequest({
            requestId: params.requestId,
            responseCode: status,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
            body: Buffer.from(body).toString('base64'),
          }).catch(() => {});
        } else {
          // requestStage is 'Response' — continueResponse unblocks without stalling
          const fetchApi = (session as any).Fetch;
          if (typeof fetchApi.continueResponse === 'function') {
            await fetchApi.continueResponse({ requestId: params.requestId }).catch(() =>
              fetchApi.continueRequest({ requestId: params.requestId }).catch(() => {})
            );
          } else {
            await fetchApi.continueRequest({ requestId: params.requestId }).catch(() => {});
          }
        }
      };
      (session as any).on('Fetch.requestPaused', handler);
      activeHandlers.set(session, handler);
      activeInterceptors.set(session, { pattern, mockStatus: status, mockBody: body });
      return { success: true, message: `CDP Fetch interception enabled for ${pattern} (fallback mode)` };
    } catch (e: any) {
      throw new Error(`Failed to enable CDP Fetch interception: ${e.message}`);
    }
  }

  if (options.action === "disable") {
    try {
      const existingHandler = activeHandlers.get(session);
      if (existingHandler) {
        try { (session as any).removeListener('Fetch.requestPaused', existingHandler); } catch {}
        activeHandlers.delete(session);
      }
      await (session as any).Fetch.disable().catch(() => {});
    } catch { /* ignore */ }
    activeInterceptors.delete(session);
    return { success: true, message: "CDP Fetch interception disabled" };
  }

  throw new Error(`Unknown action: ${options.action}`);
}


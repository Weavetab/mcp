import type CDP from "chrome-remote-interface";
import { sendToExtension, hideWeaveTabOverlay, restoreWeaveTabOverlay } from "../cdp/helpers.js";
import { isExtensionLoaded } from "../cdp/extension.js";
import { logDebug } from "../audit/logger.js";
import type { WeavetabPermissions } from "./interface.js";

export interface IPluginExtensionBridge {
  send(session: CDP.Client, message: object): Promise<boolean>;
  setHudState(session: CDP.Client, state: { action?: string; badge?: string; badgeColor?: string; groupState?: string }): Promise<void>;
  showThought(session: CDP.Client, text: string, options?: { durationMs?: number }): Promise<void>;
  clearThought(session: CDP.Client): Promise<void>;
  injectStyles(session: CDP.Client, css: string): Promise<void>;
  injectCss(session: CDP.Client, css: string): Promise<void>;
  injectScript<T = any>(session: CDP.Client, js: string): Promise<T>;
  mountPanel(session: CDP.Client, content: { title?: string; text?: string; html?: string; position?: "bottom-right" | "bottom-left" | "top-right" | "top-left" } | string): Promise<void>;
  clearPanel(session: CDP.Client): Promise<void>;
  hideOverlay(session: CDP.Client): Promise<void>;
  restoreOverlay(session: CDP.Client): Promise<void>;
}

export class PluginExtensionBridge implements IPluginExtensionBridge {
  constructor(
    public readonly pluginName: string,
    private readonly permissions?: WeavetabPermissions
  ) {}

  private checkPermission(category: "hud" | "overlay" | "styles" | "scripts"): boolean {
    return this.permissions?.extension?.[category] === true;
  }

  public async send(session: CDP.Client, message: object): Promise<boolean> {
    if (!this.checkPermission("overlay") && !this.checkPermission("hud") && !this.checkPermission("scripts")) {
      logDebug(`[Weavetab PluginExtension] Plugin "${this.pluginName}" lacks extension permission for send()`);
      return false;
    }
    if (!session) return false;
    return await sendToExtension(session, {
      ...message,
      plugin: this.pluginName,
    });
  }

  public async setHudState(
    session: CDP.Client,
    state: { action?: string; badge?: string; badgeColor?: string; groupState?: string }
  ): Promise<void> {
    if (!this.checkPermission("hud")) {
      logDebug(`[Weavetab PluginExtension] Plugin "${this.pluginName}" lacks permissions.extension.hud`);
      return;
    }
    await this.send(session, {
      type: "WT_HUD_UPDATE",
      state: state.action || state.badge,
      detail: state.groupState,
      action: state.action,
      badge: state.badge,
      badgeColor: state.badgeColor,
      groupState: state.groupState,
      timestamp: Date.now(),
    });
  }

  public async showThought(
    session: CDP.Client,
    text: string,
    options?: { durationMs?: number }
  ): Promise<void> {
    if (!this.checkPermission("hud")) return;
    if (!session || !session.Runtime) return;

    const duration = Math.max(0, Math.min(60000, Number(options?.durationMs) || 4000));
    if (await isExtensionLoaded(session)) {
      await this.send(session, {
        type: "WT_THOUGHT",
        text,
        durationMs: duration,
      });
      return;
    }

    const safeText = JSON.stringify(text);
    const thoughtId = JSON.stringify(`__wt_plugin_thought_${this.pluginName}`);

    try {
      await session.Runtime.evaluate({
        expression: `(function() {
          if (window.__wt_masterVisualsEnabled === false) return;
          var host = document.body || document.documentElement;
          if (!host) return;
          if (!document.getElementById('__wt_plugin_keyframes')) {
            var kf = document.createElement('style');
            kf.id = '__wt_plugin_keyframes';
            kf.setAttribute('data-wt-internal', 'true');
            kf.textContent = '@keyframes wtThoughtFade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }';
            (document.head || document.documentElement).appendChild(kf);
          }
          var existing = document.getElementById(${thoughtId});
          if (existing) existing.remove();

          var bubble = document.createElement('div');
          bubble.id = ${thoughtId};
          bubble.className = 'wt-bubble';
          bubble.setAttribute('data-wt-internal', 'true');
          bubble.style.cssText = [
            'position: fixed',
            'bottom: 24px',
            'left: 50%',
            'transform: translateX(-50%)',
            'background: rgba(15, 23, 42, 0.94)',
            'color: #f8fafc',
            'padding: 10px 16px',
            'border-radius: 12px',
            'font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            'font-size: 13px',
            'font-weight: 500',
            'box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1)',
            'z-index: 2147483647',
            'backdrop-filter: blur(8px)',
            'pointer-events: none',
            'animation: wtThoughtFade 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
            'display: flex',
            'align-items: center',
            'gap: 8px'
          ].join(';');

          var dot = document.createElement('span');
          dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#005EFA;flex-shrink:0;';
          var textSpan = document.createElement('span');
          textSpan.textContent = ${safeText};

          bubble.appendChild(dot);
          bubble.appendChild(textSpan);
          host.appendChild(bubble);

          setTimeout(function() {
            if (bubble && bubble.parentNode) {
              bubble.style.opacity = '0';
              bubble.style.transition = 'opacity 0.3s ease';
              setTimeout(function() { bubble.remove(); }, 300);
            }
          }, ${duration});
        })()`,
        returnByValue: false,
      });
    } catch (e) {
      logDebug(`[Weavetab PluginExtension] Failed to show thought:`, e);
    }
  }

  public async clearThought(session: CDP.Client): Promise<void> {
    if (!session || !session.Runtime) return;
    if (await isExtensionLoaded(session)) {
      await this.send(session, { type: "WT_CLEAR_THOUGHT" });
    }
    const thoughtId = JSON.stringify(`__wt_plugin_thought_${this.pluginName}`);
    try {
      await session.Runtime.evaluate({
        expression: `(function() {
          var existing = document.getElementById(${thoughtId});
          if (existing) existing.remove();
        })()`,
        returnByValue: false,
      });
    } catch { /* ignore */ }
  }

  public async injectCss(session: CDP.Client, css: string): Promise<void> {
    return this.injectStyles(session, css);
  }

  public async injectStyles(session: CDP.Client, css: string): Promise<void> {
    if (!this.checkPermission("styles")) {
      throw new Error(`Permission Denied: Plugin "${this.pluginName}" does not have permissions.extension.styles`);
    }
    if (!session || !session.Runtime) return;
    const safeCss = JSON.stringify(css);
    const styleId = JSON.stringify(`__wt_plugin_styles_${this.pluginName}`);
    await session.Runtime.evaluate({
      expression: `(function() {
        var host = document.head || document.documentElement;
        if (!host) return;
        var style = document.getElementById(${styleId}) || document.createElement('style');
        style.id = ${styleId};
        style.setAttribute('data-wt-internal', 'true');
        style.textContent = ${safeCss};
        if (!style.parentNode) host.appendChild(style);
      })()`,
      returnByValue: false,
    });
  }

  public async injectScript<T = any>(session: CDP.Client, js: string): Promise<T> {
    if (!this.checkPermission("scripts")) {
      throw new Error(`Permission Denied: Plugin "${this.pluginName}" does not have permissions.extension.scripts`);
    }
    if (!session || !session.Runtime) throw new Error("No active CDP session available");
    const res = await session.Runtime.evaluate({
      expression: js,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const msg =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        "Script evaluation failed";
      throw new Error(msg);
    }
    return res.result?.value as T;
  }

  public async mountPanel(
    session: CDP.Client,
    content: { title?: string; text?: string; html?: string; position?: "bottom-right" | "bottom-left" | "top-right" | "top-left" } | string
  ): Promise<void> {
    if (!this.checkPermission("overlay") && !this.checkPermission("hud")) {
      throw new Error(`Permission Denied: Plugin "${this.pluginName}" requires permissions.extension.overlay or permissions.extension.hud`);
    }
    const payload = typeof content === "string" ? { text: content } : content;
    const canScripts = this.checkPermission("scripts");
    if (payload.html && !canScripts) {
      throw new Error(`Permission Denied: Plugin "${this.pluginName}" requires permissions.extension.scripts to mount raw HTML`);
    }
    if (!session || !session.Runtime) return;
    const panelId = JSON.stringify(`__wt_plugin_panel_${this.pluginName}`);
    const pos = payload.position || "bottom-right";
    const posCss = pos === "top-left" ? "top:16px;left:16px;"
      : pos === "top-right" ? "top:16px;right:16px;"
      : pos === "bottom-left" ? "bottom:16px;left:16px;"
      : "bottom:16px;right:16px;";
    const bodyProp = canScripts ? "innerHTML" : "textContent";
    await session.Runtime.evaluate({
      expression: `(function() {
        if (window.__wt_masterVisualsEnabled === false) return;
        var host = document.body || document.documentElement;
        if (!host) return;
        var el = document.getElementById(${panelId}) || document.createElement('div');
        el.id = ${panelId};
        el.setAttribute('data-wt-internal', 'true');
        el.style.cssText = 'position:fixed;${posCss}z-index:2147483646;max-width:320px;background:rgba(15,23,42,0.95);color:#f8fafc;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px 14px;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;box-shadow:0 10px 25px rgba(0,0,0,0.45);pointer-events:auto;';
        el.textContent = '';
        if (${JSON.stringify(payload.title || "")}) {
          var h = document.createElement('div');
          h.style.cssText = 'font-weight:600;margin-bottom:4px;color:#93c5fd;';
          h.textContent = ${JSON.stringify(payload.title || "")};
          el.appendChild(h);
        }
        if (${JSON.stringify(payload.html || "")}) {
          var body = document.createElement('div');
          body.${bodyProp} = ${JSON.stringify(payload.html || "")};
          el.appendChild(body);
        } else if (${JSON.stringify(payload.text || "")}) {
          var p = document.createElement('div');
          p.textContent = ${JSON.stringify(payload.text || "")};
          el.appendChild(p);
        }
        if (!el.parentNode) host.appendChild(el);
      })()`,
      returnByValue: false,
    });
  }

  public async clearPanel(session: CDP.Client): Promise<void> {
    if (!session || !session.Runtime) return;
    const panelId = JSON.stringify(`__wt_plugin_panel_${this.pluginName}`);
    await session.Runtime.evaluate({
      expression: `(function(){ var el = document.getElementById(${panelId}); if (el) el.remove(); })()`,
      returnByValue: false,
    }).catch(() => {});
  }

  public async hideOverlay(session: CDP.Client): Promise<void> {
    if (!this.checkPermission("overlay")) return;
    if (!session) return;
    await hideWeaveTabOverlay(session);
  }

  public async restoreOverlay(session: CDP.Client): Promise<void> {
    if (!this.checkPermission("overlay")) return;
    if (!session) return;
    await restoreWeaveTabOverlay(session);
  }
}

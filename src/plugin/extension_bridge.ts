import type CDP from "chrome-remote-interface";
import { sendToExtension, hideWeaveTabOverlay, restoreWeaveTabOverlay } from "../cdp/helpers.js";
import { logDebug } from "../audit/logger.js";
import type { WeavetabPermissions } from "./interface.js";

export interface IPluginExtensionBridge {
  send(session: CDP.Client, message: object): Promise<boolean>;
  setHudState(session: CDP.Client, state: { action?: string; badge?: string; badgeColor?: string; groupState?: string }): Promise<void>;
  showThought(session: CDP.Client, text: string, options?: { durationMs?: number }): Promise<void>;
  clearThought(session: CDP.Client): Promise<void>;
  injectStyles(session: CDP.Client, css: string): Promise<void>;
  injectScript<T = any>(session: CDP.Client, js: string): Promise<T>;
  hideOverlay(session: CDP.Client): Promise<void>;
  restoreOverlay(session: CDP.Client): Promise<void>;
}

export class PluginExtensionBridge implements IPluginExtensionBridge {
  constructor(
    public readonly pluginName: string,
    private readonly permissions?: WeavetabPermissions
  ) {}

  private checkPermission(category: "hud" | "overlay" | "styles" | "scripts"): boolean {
    if (!this.permissions || !this.permissions.extension) return true; // Default permissive if not restricted
    return this.permissions.extension[category] !== false;
  }

  public async send(session: CDP.Client, message: object): Promise<boolean> {
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
      type: "wt-hud-update",
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

    const duration = options?.durationMs || 4000;
    const safeText = JSON.stringify(text);

    try {
      await session.Runtime.evaluate({
        expression: `(function() {
          var existing = document.getElementById('__wt_plugin_thought_${this.pluginName}');
          if (existing) existing.remove();

          var bubble = document.createElement('div');
          bubble.id = '__wt_plugin_thought_${this.pluginName}';
          bubble.className = 'wt-bubble';
          bubble.setAttribute('data-wt-internal', 'true');
          bubble.style.cssText = [
            'position: fixed',
            'bottom: 24px',
            'right: 24px',
            'background: linear-gradient(135deg, rgba(17, 24, 39, 0.95), rgba(30, 41, 59, 0.95))',
            'color: #f8fafc',
            'padding: 12px 18px',
            'border-radius: 12px',
            'font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            'font-size: 13px',
            'font-weight: 500',
            'box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1)',
            'z-index: 2147483647',
            'backdrop-filter: blur(8px)',
            'pointer-events: none',
            'animation: wtThoughtFade 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
            'display: flex',
            'align-items: center',
            'gap: 8px'
          ].join(';');

          var icon = document.createElement('span');
          icon.textContent = '✨';
          var textSpan = document.createElement('span');
          textSpan.textContent = ${safeText};

          bubble.appendChild(icon);
          bubble.appendChild(textSpan);
          document.body.appendChild(bubble);

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
    try {
      await session.Runtime.evaluate({
        expression: `(function() {
          var existing = document.getElementById('__wt_plugin_thought_${this.pluginName}');
          if (existing) existing.remove();
        })()`,
        returnByValue: false,
      });
    } catch { /* ignore */ }
  }

  public async injectStyles(session: CDP.Client, css: string): Promise<void> {
    if (!this.checkPermission("styles")) {
      throw new Error(`Permission Denied: Plugin "${this.pluginName}" does not have permissions.extension.styles`);
    }
    if (!session || !session.Runtime) return;
    const safeCss = JSON.stringify(css);
    await session.Runtime.evaluate({
      expression: `(function() {
        var styleId = '__wt_plugin_styles_${this.pluginName}';
        var style = document.getElementById(styleId) || document.createElement('style');
        style.id = styleId;
        style.textContent = ${safeCss};
        if (!style.parentNode) document.head.appendChild(style);
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
    return (res.result?.value as T) ?? (res as any);
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

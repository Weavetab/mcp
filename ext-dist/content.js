const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
// Register this tab with background (skip about:blank and chrome:// pages)
if (location.href !== 'about:blank' && !location.protocol.startsWith('chrome')) {
  try { browserAPI.runtime.sendMessage({ type: 'REGISTER_TAB' }).catch(function(){}); } catch(e) {}
}

// ── STABLE EXTENSION MARKER ────────────────────────────────────────
// Unconditionally injected at document root so MCP server can detect the extension reliably.
if (!document.getElementById('wt-extension-marker')) {
  const marker = document.createElement('meta');
  marker.id = 'wt-extension-marker';
  marker.setAttribute('name', 'weavetab-extension');
  if (document.head) {
    document.head.appendChild(marker);
  } else if (document.documentElement) {
    document.documentElement.appendChild(marker);
  }
}

// ── SAFE MESSAGE BRIDGE ────────────────────────────────────────
// Wraps browserAPI.runtime.sendMessage to survive "Extension context invalidated"
// errors that occur when the extension is reloaded/updated mid-session.
var __wt_extAlive = true;
function __wt_safeSendMessage(msg) {
  try {
    if (!browserAPI.runtime || !browserAPI.runtime.id) { __wt_extAlive = false; return; }
    browserAPI.runtime.sendMessage(msg).catch(function(){ __wt_extAlive = false; });
  } catch(e) {
    __wt_extAlive = false;
  }
}

function __wt_safeAppendToBody(el) {
  if (document.body) {
    document.body.appendChild(el);
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      if (document.body) document.body.appendChild(el);
    }, { once: true });
    // Backup for SPAs that might fire DOMContentLoaded early or clear body
    const obs = new MutationObserver((m, observer) => {
      if (document.body) {
        if (!el.parentNode || !document.body.contains(el)) document.body.appendChild(el);
        observer.disconnect();
      }
    });
    obs.observe(document.documentElement, { childList: true });
  }
}

// ── HUD MOUNT LAYER (Phase 1: Closed Shadow DOM + Iframe Architecture) ─────
// Reload-proof, agent-invisible, real-time visual system
(function mountHUD() {
  if (window !== window.top) return;
  if (location.protocol.startsWith('chrome')) return;

  const hudOrigin = new URL(browserAPI.runtime.getURL('')).origin;
  let host = null;
  let shadow = null;
  let iframe = null;
  let hudState = {};

  function createMount() {
    if ((host && document.documentElement.contains(host)) || document.getElementById('__wt_hud_host')) return;

    host = document.createElement('weavetab-host');
    host.id = '__wt_hud_host';
    host.setAttribute('data-wt-internal', 'true');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial !important;position:fixed !important;left:0 !important;top:0 !important;width:0 !important;height:0 !important;z-index:2147483647 !important;pointer-events:none !important;background:transparent !important;opacity:1 !important;transform:none !important;filter:none !important;';
    __wt_safeAppendToBody(host);

    shadow = host.attachShadow({ mode: 'closed' });

    iframe = document.createElement('iframe');
    iframe.src = browserAPI.runtime.getURL('hud/index.html');
    iframe.id = 'wt-hud-iframe';
    iframe.setAttribute('allowtransparency', 'true');
    Object.assign(iframe.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      border: 'none',
      background: 'transparent',
      backgroundColor: 'transparent',
      pointerEvents: 'none',
      zIndex: '2147483647',
      visibility: 'hidden',
      opacity: '0',
      colorScheme: 'normal'
    });
    shadow.appendChild(iframe);

    iframe.onload = function() {
      browserAPI.storage.local.get('wt-hud-state', function(result) {
        hudState = result['wt-hud-state'] || {};
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'REHYDRATE', state: hudState }, hudOrigin);
        }
      });
    };
  }

  const observer = new MutationObserver(function() {
    if (!host || !document.documentElement.contains(host)) {
      createMount();
    }
  });
  observer.observe(document.documentElement, { childList: true });

  let scrollTicking = false;
  document.addEventListener('scroll', function() {
    if (!scrollTicking && iframe && iframe.contentWindow) {
      window.requestAnimationFrame(function() {
        const sh = (document.body || document.documentElement)?.scrollHeight || 1;
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage({
            type: 'RT_SCROLL',
            y: window.scrollY,
            ratio: window.scrollY / sh
          }, hudOrigin);
        }
        scrollTicking = false;
      });
      scrollTicking = true;
    }
  }, { passive: true });

  let __wt_masterVisualsEnabled = true;
  let __wt_userMasterVisuals = true;
  window.__wt_masterVisualsEnabled = true;

  function __wt_applyMasterVisuals(enabled) {
    __wt_masterVisualsEnabled = !!enabled;
    window.__wt_masterVisualsEnabled = __wt_masterVisualsEnabled;

    const cursorHost = document.getElementById('__Weavetab_cursor_host');
    if (cursorHost) {
      cursorHost.style.display = __wt_masterVisualsEnabled ? 'block' : 'none';
    }
    if (typeof __weaveCursor !== 'undefined' && __weaveCursor) {
      __weaveCursor.setVisible(__wt_masterVisualsEnabled);
      if (__weaveCursor._cursor) {
        __weaveCursor._cursor.style.display = __wt_masterVisualsEnabled ? 'block' : 'none';
      } else if (__weaveCursor._canvas) {
        __weaveCursor._canvas.style.display = __wt_masterVisualsEnabled ? 'block' : 'none';
      }
    }

    const hudHost = document.getElementById('__wt_hud_host');
    if (hudHost) {
      hudHost.style.display = __wt_masterVisualsEnabled ? 'block' : 'none';
    }

    const rootHost = document.getElementById('Weavetab-root');
    if (rootHost) {
      rootHost.style.display = __wt_masterVisualsEnabled ? 'block' : 'none';
    }

    const indicatorEl = document.getElementById('wt-controlled-indicator') || document.querySelector('.wt-controlled-indicator') || document.getElementById('__Weavetab_controlled_indicator');
    if (indicatorEl) {
      indicatorEl.style.display = __wt_masterVisualsEnabled ? 'block' : 'none';
    }

    if (!__wt_masterVisualsEnabled) {
      if (typeof clearXRay === 'function') clearXRay();
      document.querySelectorAll('.Weavetab-ripple, .wt-xray-spotlight, .wt-bubble, .__Weavetab_xray').forEach(function(el){
        el.remove();
      });
    }
  }
  window.__wt_setSuppressed = function(suppress) {
    __wt_applyMasterVisuals(suppress ? false : __wt_userMasterVisuals);
  };
  window.__wt_forwardHud = function(msg) {
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage(msg, hudOrigin);
    }
  };

  try {
    browserAPI.storage.local.get(['wt_master_visuals'], function(res) {
      __wt_userMasterVisuals = !(res && res.wt_master_visuals === false);
      __wt_applyMasterVisuals(__wt_userMasterVisuals);
    });

    browserAPI.storage.onChanged.addListener(function(changes, area) {
      if (area === 'local' && changes.wt_master_visuals !== undefined) {
        __wt_userMasterVisuals = changes.wt_master_visuals.newValue !== false;
        __wt_applyMasterVisuals(__wt_userMasterVisuals);
      }
    });
  } catch(e) {}

  browserAPI.runtime.onMessage.addListener(function(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'Weavetab_GROUP_STATE' || msg.type === 'Weavetab_STATE') {
      __wt_handleWeavetabMsg(msg, true);
      return;
    }
    if (msg.type === 'WT_TOGGLE_MASTER_VISUALS') {
      __wt_userMasterVisuals = msg.enabled !== false;
      __wt_applyMasterVisuals(__wt_userMasterVisuals);
    }
    if (msg.type === 'GHOST_CURSOR_MOVE') {
      if (typeof msg.x === 'number' && typeof msg.y === 'number') {
        moveCursor(msg.x, msg.y, msg.phase);
      }
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'RT_CURSOR_MOVE', x: msg.x, y: msg.y, phase: msg.phase }, hudOrigin);
      }
    }
    if (msg.type === 'WT_SCRIPTED_PILL_TOGGLE' && iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'WT_SCRIPTED_PILL_TOGGLE', enabled: msg.enabled }, hudOrigin);
    }
    if (msg.type === 'WT_HUD_UPDATE' && iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({
        type: 'WT_HUD_UPDATE',
        state: msg.state || msg.action || msg.badge,
        detail: msg.detail || msg.groupState,
        action: msg.action,
        badge: msg.badge,
        badgeColor: msg.badgeColor,
        groupState: msg.groupState
      }, hudOrigin);
    }
    if (msg.type === 'WT_THOUGHT' || msg.type === 'Weavetab_THOUGHT') {
      __wt_showThought(msg.text, msg);
    }
    if (msg.type === 'WT_CLEAR_THOUGHT' || msg.type === 'Weavetab_CLEAR_THOUGHT') {
      __wt_removeThought();
    }
    if (msg.type === 'WT_USER_NOTE_INJECT' || msg.type === 'WT_USER_NOTE') {
      let formattedMsg = msg.text || '';
      if (msg.snipe) {
        formattedMsg = `[USER AREA ANNOTATION ATTACHED (${msg.snipe.mode})]: ` + formattedMsg;
      }
      if (window.__wt_masterVisualsEnabled !== false) {
        __wt_showUserNoteVisualBanner(formattedMsg);
      }
    }
    if (msg.type === 'TOGGLE_HUD' && iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'TOGGLE_HUD' }, hudOrigin);
    }
    if (msg.type === 'TOGGLE_DEBUG' && iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'TOGGLE_DEBUG' }, hudOrigin);
    }
  });

  function __wt_showUserNoteVisualBanner(text) {
    let banner = document.getElementById('wt-user-note-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'wt-user-note-banner';
      banner.setAttribute('data-wt-ignore', 'true');
      banner.style.cssText = `
        position: fixed; top: 16px; right: 20px; z-index: 2147483647;
        background: rgba(24, 24, 27, 0.94); backdrop-filter: blur(12px);
        border: 1px solid #38bdf8; color: #f4f4f5; font-weight: 500;
        font-size: 11px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 8px 16px; border-radius: 20px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6), 0 0 14px rgba(56, 189, 248, 0.4);
        display: flex; align-items: center; gap: 8px;
        transition: opacity 0.3s ease, transform 0.3s ease;
        opacity: 0; transform: translateY(-10px); pointer-events: none;
      `;
      document.documentElement.appendChild(banner);
    }
    const cleanText = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0, 90);
    banner.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span style="color:#38bdf8;font-weight:600;">Message Received:</span> <span>${cleanText}</span>`;
    requestAnimationFrame(() => {
      banner.style.opacity = '1';
      banner.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      banner.style.opacity = '0';
      banner.style.transform = 'translateY(-10px)';
      setTimeout(() => banner.remove(), 300);
    }, 4000);
  }

  window.addEventListener('message', function(e) {
    if (e.source === window) {
      if (e.data && (
        e.data.type === 'WT_TOOL_CALL' ||
        e.data.type === 'WT_PLAN_UPDATE' ||
        e.data.type === 'WT_THOUGHT' ||
        e.data.type === 'WT_HUD_UPDATE' ||
        e.data.type === 'Weavetab_CONFIG' ||
        e.data.type === 'WT_CONFIG_UPDATE'
      )) {
        __wt_safeSendMessage(e.data);
      }
      if (e.data && e.data.type === '__WT_ALERT_STATE') {
        __wt_safeSendMessage({ type: e.data.waiting ? 'TAB_ALERT_WAITING' : 'TAB_ALERT_CLEARED' });
      }
      return;
    }

    if (iframe && e.source === iframe.contentWindow && e.origin === hudOrigin) {
      if (e.data && e.data.type === 'HUD_STATE_CHANGED') {
        const st = e.data.state || {};
        if ('debugMenuVisible' in st) {
          iframe.style.pointerEvents = st.debugMenuVisible ? 'auto' : 'none';
        }
        if ('hudVisible' in st) {
          const visible = st.hudVisible !== false;
          iframe.style.display = visible ? 'block' : 'none';
          if (visible) {
            iframe.style.width = '100vw';
            iframe.style.height = '100vh';
            iframe.style.visibility = 'visible';
            iframe.style.opacity = '1';
          } else {
            iframe.style.width = '0';
            iframe.style.height = '0';
            iframe.style.visibility = 'hidden';
            iframe.style.opacity = '0';
          }
        }
        hudState = { ...hudState, ...st };
        browserAPI.storage.local.set({ 'wt-hud-state': hudState });
      }
    }
  });

  createMount();
})();

// ── STALE ELEMENT CLEANUP ─────────────────────────────────────
(function cleanupOldUI() {
  var OLD_IDS = [
    'wt-ghost-cursor','wt-ghost-bubble','wt-ask-panel','wt-cur-canvas',
    'wt-ask-container','wt-msg-panel','wt-ask-title','wt-msg-bar','wt-msg-pill'
  ];
  function removeOld() {
    for (var i = 0; i < OLD_IDS.length; i++) {
      var el = document.getElementById(OLD_IDS[i]);
      if (el) el.remove();
    }
  }
  removeOld();
  var obs = new MutationObserver(function() {
    removeOld();
    obs.disconnect();
  });
  if (document.documentElement) {
    obs.observe(document.documentElement, { childList: true, subtree: true });
    obs.disconnect();
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      removeOld();
    }, { once: true });
  }
})();

// ── UI DESIGN SYSTEM (inject once, styles.css handles visuals) ─
(function injectWeavetabUI() {
  if (document.getElementById('wt-ui-styles')) return;
  const m = document.createElement('meta');
  m.id = 'wt-ui-styles';
  (document.head || document.documentElement || document.body).appendChild(m);
})();

// ── THOUGHT BUBBLE ─────────────────────────────────────────────
let __wt_activeBubble = null;
let __wt_bubbleTimer = null;
let __wt_typewriterTimer = null;
let __wt_feedbackSticky = false;

function __wt_destroyBubble() {
  if (__wt_bubbleTimer) { clearTimeout(__wt_bubbleTimer); __wt_bubbleTimer = null; }
  if (__wt_typewriterTimer) { clearInterval(__wt_typewriterTimer); __wt_typewriterTimer = null; }
  var current = document.querySelector('.wt-bubble[data-wt-thought]');
  if (current) {
    current.style.transition = 'opacity 0.15s ease-out, transform 0.15s ease-out';
    current.style.opacity = '0';
    current.style.transform = 'translateX(-50%) translateY(6px)';
    setTimeout(function() {
      if (current && current.parentNode) current.remove();
      __wt_activeBubble = null;
    }, 150);
  } else {
    __wt_activeBubble = null;
  }
}

// ── MIDDLE-DOWN THOUGHT & PRESENCE HUD ─────────────────────────────
let __wt_thoughtHudEl = null;
let __wt_thoughtHudTimer = null;
let __wt_thoughtHudCountdown = null;

function __wt_highlightAnchor(anchor) {
  if (!anchor) return;
  try {
    let sel = anchor;
    if (anchor.startsWith('w:')) {
      const stripped = anchor.slice(2);
      sel = `[data-wt-id="${stripped}"]`;
    }
    const el = document.querySelector(sel) || shadowQuery(sel);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;

    const ring = document.createElement('div');
    ring.setAttribute('data-wt-ignore', 'true');
    ring.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:1.5px solid #38bdf8;box-shadow:0 0 16px rgba(56,189,248,0.5);border-radius:4px;z-index:2147483646;pointer-events:none;animation:wt-consider-pulse 1.2s ease-in-out infinite;`;
    (document.getElementById('Weavetab-root')?.shadowRoot || document.body || document.documentElement).appendChild(ring);
    setTimeout(() => {
      ring.style.transition = 'opacity 0.25s ease-out';
      ring.style.opacity = '0';
      setTimeout(() => ring.remove(), 260);
    }, 2400);
  } catch(e) {}
}

function __wt_removeThought() {
  if (__wt_thoughtHudTimer) {
    clearTimeout(__wt_thoughtHudTimer);
    __wt_thoughtHudTimer = null;
  }
  if (__wt_thoughtHudCountdown) {
    clearInterval(__wt_thoughtHudCountdown);
    __wt_thoughtHudCountdown = null;
  }
  if (__wt_thoughtHudEl) {
    const el = __wt_thoughtHudEl;
    __wt_thoughtHudEl = null;
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(10px)';
    setTimeout(() => {
      if (el.parentNode) el.remove();
    }, 220);
  }
  __wt_feedbackSticky = false;
  clearTimeout(window.__wt_feedbackStickyTimer);
  __wt_destroyBubble();
}

function __wt_showThought(text, options) {
  if (typeof __wt_masterVisualsEnabled !== 'undefined' && !__wt_masterVisualsEnabled) return;
  if (!text || typeof text !== 'string') return;

  const opts = options || {};
  const isQuestion = opts.action === 'question' || opts.kind === 'question' || !!opts.ask;
  const anchor = opts.anchor || '';

  // Contextual visual anchor highlight
  if (anchor) {
    __wt_highlightAnchor(anchor);
  }

  // Clear pending timers
  if (__wt_thoughtHudTimer) {
    clearTimeout(__wt_thoughtHudTimer);
    __wt_thoughtHudTimer = null;
  }
  if (__wt_thoughtHudCountdown) {
    clearInterval(__wt_thoughtHudCountdown);
    __wt_thoughtHudCountdown = null;
  }

  let hud = __wt_thoughtHudEl;
  if (!hud || !hud.parentNode) {
    hud = document.createElement('div');
    hud.id = '__wt_thought_hud';
    hud.setAttribute('data-wt-ignore', 'true');
    hud.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(8px);
      z-index: 2147483647;
      width: 320px;
      max-width: calc(100vw - 32px);
      background: #0b0d12;
      border: 1px solid #1e222b;
      border-radius: 4px;
      padding: 10px 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.8), 0 0 1px rgba(255,255,255,0.08);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
      color: #f3f4f6;
      pointer-events: auto;
      opacity: 0;
      transition: opacity 0.18s cubic-bezier(0.16, 1, 0.3, 1), transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
      box-sizing: border-box;
    `;
    (document.getElementById('Weavetab-root')?.shadowRoot || document.body || document.documentElement).appendChild(hud);
    __wt_thoughtHudEl = hud;
  }

  const cleanText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cleanAnchor = anchor
    ? anchor.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    : '';
  const anchorBadge = cleanAnchor ? `<span style="color:#2b70ff;font-size:10px;font-family:monospace;font-weight:600;margin-left:4px;">@${cleanAnchor}</span>` : '';

  if (isQuestion) {
    const timeoutSec = (opts.timeout || (opts.ask && opts.ask.timeout) || 20);
    hud.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px;">
        <div style="font-size:12px;line-height:1.4;color:#ffffff;font-weight:500;word-break:break-word;">
          ${cleanText}${anchorBadge}
        </div>
        <button id="wt-hud-close" title="Dismiss" style="background:transparent;border:none;color:#555d6d;font-size:12px;cursor:pointer;padding:0 2px;line-height:1;margin-top:1px;">✕</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <input id="wt-hud-input" type="text" placeholder="Type answer..." style="height:28px;background:#14161f;border:1px solid #252a36;border-radius:3px;padding:0 8px;font-size:12px;color:#fff;outline:none;flex:1;min-width:0;caret-color:#2b70ff;font-family:inherit;box-sizing:border-box;" />
        <button id="wt-hud-submit-btn" title="Send" style="width:28px;height:28px;background:#2b70ff;border:none;border-radius:3px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;padding:0;box-sizing:border-box;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
        <span id="wt-hud-countdown" style="font-size:10px;color:#64748b;font-family:monospace;margin-left:2px;min-width:20px;text-align:right;">${timeoutSec}s</span>
      </div>
    `;
  } else {
    // Feedback / observation mode — ultra compact single row
    hud.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="display:flex;align-items:center;gap:7px;min-width:0;">
          <span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:#2b70ff;box-shadow:0 0 6px #2b70ff;flex-shrink:0;"></span>
          <span style="font-size:12px;line-height:1.4;color:#f3f4f6;word-break:break-word;font-weight:450;">${cleanText}${anchorBadge}</span>
        </div>
        <button id="wt-hud-close" title="Dismiss" style="background:transparent;border:none;color:#555d6d;font-size:12px;cursor:pointer;padding:0 2px;line-height:1;flex-shrink:0;">✕</button>
      </div>
    `;
  }

  // Animate in
  requestAnimationFrame(() => {
    if (hud) {
      hud.style.opacity = '1';
      hud.style.transform = 'translateX(-50%) translateY(0)';
    }
  });

  // Wire close button
  const closeBtn = hud.querySelector('#wt-hud-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      __wt_removeThought();
    });
  }

  if (isQuestion) {
    let askBridge = document.getElementById('__wt_ask_bridge');
    if (!askBridge) {
      askBridge = document.createElement('div');
      askBridge.id = '__wt_ask_bridge';
      askBridge.style.display = 'none';
      document.body.appendChild(askBridge);
    }
    askBridge.dataset.status = 'pending';
    askBridge.dataset.result = '';

    const input = hud.querySelector('#wt-hud-input');
    const submitBtn = hud.querySelector('#wt-hud-submit-btn');
    const countdownSpan = hud.querySelector('#wt-hud-countdown');

    let remaining = opts.timeout || (opts.ask && opts.ask.timeout) || 20;

    __wt_thoughtHudCountdown = setInterval(() => {
      remaining--;
      if (countdownSpan) countdownSpan.textContent = `${remaining}s`;
      if (remaining <= 0) {
        clearInterval(__wt_thoughtHudCountdown);
        __wt_thoughtHudCountdown = null;
        if (askBridge) {
          askBridge.dataset.status = 'timeout';
          askBridge.dataset.result = '';
        }
        __wt_removeThought();
      }
    }, 1000);

    const submit = () => {
      const val = input ? input.value.trim() : '';
      if (askBridge) {
        askBridge.dataset.status = 'submitted';
        askBridge.dataset.result = val;
      }
      if (window.__wt_ask_bridge && window.__wt_ask_bridge.resolve) {
        window.__wt_ask_bridge.resolve({ success: true, response: val, status: 'answered' });
        window.__wt_ask_bridge = {};
      }
      __wt_removeThought();
    };

    if (submitBtn) submitBtn.addEventListener('click', submit);
    if (input) {
      input.addEventListener('focus', () => { input.style.borderColor = '#2b70ff'; });
      input.addEventListener('blur', () => { input.style.borderColor = '#252a36'; });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') __wt_removeThought();
      });
      setTimeout(() => { if (input) input.focus(); }, 80);
    }
  } else {
    const autoDuration = typeof opts.durationMs === 'number' && opts.durationMs > 0
      ? Math.min(60000, opts.durationMs)
      : Math.max(3800, Math.min(8000, text.length * 50));
    __wt_thoughtHudTimer = setTimeout(() => {
      __wt_removeThought();
    }, autoDuration);
  }
}

function __wt_showQuestion(text, inputType, timeoutSeconds) {
  __wt_showThought(text, { action: 'question', timeout: timeoutSeconds || 20 });
}

// ── SHARED OVERLAY CONTAINER ────────────────────────────────────
const __wt_shadowStyles = `
.Weavetab-ripple {
  width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%;
  background: rgba(79,142,247,0.35); border: 2px solid #4F8EF7;
  animation: __wt_ripple 0.55s ease-out forwards;
}
@keyframes __wt_ripple { from { transform: scale(0.3); opacity: 1; } to { transform: scale(2.2); opacity: 0; } }
@keyframes __wt_ripple_expand {
  from { transform: scale(1); opacity: 0.95; }
  to { transform: scale(5.5); opacity: 0; }
}
@keyframes __wt_xray_pulse {
  0% { opacity: 0; transform: scale(0.94); }
  18% { opacity: 1; transform: scale(1.02); }
  70% { opacity: 0.85; transform: scale(1); }
  100% { opacity: 0; transform: scale(0.97); }
}
`;

function getWeavetabRoot() {
  let host = document.getElementById('Weavetab-root');
  if (!host) {
    host = document.createElement('div');
    host.id = 'Weavetab-root';
    host.setAttribute('data-wt-ignore', '');
    Object.assign(host.style, {
      position: 'fixed', left: '0', top: '0',
      width: '0', height: '0',
      zIndex: '2147483640', pointerEvents: 'none',
    });
    var root = document.documentElement || document.body;
    if (root) root.appendChild(host);
  }
  // Reuse existing shadow root (open mode, set by CDP injector or ourselves)
  if (host.shadowRoot) {
    return host.shadowRoot;
  }
  // Guard against NotSupportedError when another context already attached a closed shadow root
  try {
    const sr = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = __wt_shadowStyles;
    sr.appendChild(style);
    return sr;
  } catch (e) {
    // FIX: fallback must be invisible and non-blocking so it can't
    // cover page content or cause opacity bleeding on sites like example.com.
    const fallback = document.createElement('div');
    fallback.setAttribute('data-wt-ignore', '');
    fallback.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;overflow:visible;z-index:2147483640;';
    __wt_safeAppendToBody(fallback);
    return fallback;
  }
}

// ── COORDINATE ORACLE ───────────────────────────────────────────
function shadowQuery(selector) {
  function searchRoot(root) {
    const found = root.querySelector(selector);
    if (found) return found;

    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const result = searchRoot(el.shadowRoot);
        if (result) return result;
      }
    }
    return null;
  }
  return searchRoot(document);
}

// ── BLUE SVG WEAVE CURSOR ───────────────────────────────────────
// Shadow-DOM-isolated, hardware-accelerated SVG cursor with smooth interpolation
class WeaveCursor {
  constructor() {
    // Attach a shadow host that sits above all page content
    this._host = document.createElement('div');
    this._host.id = '__Weavetab_cursor_host';
    this._host.setAttribute('data-wt-ignore', 'true');
    Object.assign(this._host.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      overflow: 'visible',
    });

    const shadow = this._host.attachShadow({ mode: 'closed' });

    // Liquid trail canvas inside shadow root (zero DOM reflows)
    this._trailCanvas = document.createElement('canvas');
    this._trailCanvas.setAttribute('data-wt-ignore', 'true');
    Object.assign(this._trailCanvas.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      zIndex: '2147483645',
      overflow: 'visible',
    });
    this._trailCanvas.width = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1920;
    this._trailCanvas.height = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 1080;
    shadow.appendChild(this._trailCanvas);
    this._trailCtx = this._trailCanvas.getContext('2d');
    this._trailPoints = [];
    this._lastTrailRecord = 0;

    window.addEventListener('resize', () => {
      if (this._trailCanvas) {
        this._trailCanvas.width = window.innerWidth;
        this._trailCanvas.height = window.innerHeight;
      }
    });

    // Hotspot aligned with the top-left pointer tip (3.0, 5.0 in 32x32 viewBox)
    this._hotX = 3.0;
    this._hotY = 5.0;
    this._scale = 0.4;

    const initX = typeof window !== 'undefined' && window.innerWidth ? Math.round(window.innerWidth / 2) : 640;
    const initY = typeof window !== 'undefined' && window.innerHeight ? Math.round(window.innerHeight / 2) : 400;

    // Exact vector SVG cursor matching user design
    this._cursor = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this._cursor.setAttribute('class', 'cursor');
    this._cursor.setAttribute('viewBox', '0 0 32 32');
    this._cursor.setAttribute('width', '32');
    this._cursor.setAttribute('height', '32');
    this._cursor.setAttribute('aria-hidden', 'true');
    Object.assign(this._cursor.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '32px',
      height: '32px',
      display: 'block',
      transformOrigin: `${this._hotX}px ${this._hotY}px`,
      transform: `translate3d(${initX - this._hotX}px, ${initY - this._hotY}px, 0) scale(${this._scale})`,
      overflow: 'visible',
      pointerEvents: 'none',
      willChange: 'transform',
      transition: 'opacity 0.2s ease-out',
      opacity: '1',
      zIndex: '2147483647',
      filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.35))',
    });

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'cursor-shape');
    path.setAttribute('d', 'M 6.1,4.7 C 4.5,4.1 3.0,5.0 3.0,6.7 C 3.0,7.1 3.1,7.5 3.3,8.0 L 10.2,27.0 C 10.8,28.7 12.0,29.6 13.6,29.5 C 15.1,29.4 16.0,28.5 16.5,27.0 L 19.4,18.8 L 25.9,17.0 C 27.7,16.5 28.9,15.2 28.9,13.6 C 28.9,12.1 28.0,10.9 26.4,10.3 Z');
    path.setAttribute('fill', '#1268ff');
    path.setAttribute('stroke', '#ffffff');
    path.setAttribute('stroke-width', '3.1');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');

    this._cursor.appendChild(path);
    shadow.appendChild(this._cursor);

    // Alias _canvas to _cursor for backward compatibility
    this._canvas = this._cursor;

    this._x = initX;
    this._y = initY;
    this._targetX = initX;
    this._targetY = initY;
    this._lerpX = initX;
    this._lerpY = initY;
    this._state = 'idle';
    this._visible = true;
    this._animFrame = null;
    this._lastTime = performance.now();
    this._waypointQueue = [];
    this._playingQueue = false;

    __wt_safeAppendToBody(this._host);
    this._render(performance.now());
  }

  destroy() {
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
    if (this._host && this._host.parentNode) {
      this._host.parentNode.removeChild(this._host);
    }
  }

  setState(state) {
    this._state = state || 'idle';
    if (this._visible && !this._animFrame) {
      this._startLoop();
    }
  }

  setVisible(visible) {
    if (typeof __wt_masterVisualsEnabled !== 'undefined' && !__wt_masterVisualsEnabled) {
      this._visible = false;
      this._cursor.style.opacity = '0';
      if (this._animFrame) {
        cancelAnimationFrame(this._animFrame);
        this._animFrame = null;
      }
      if (this._trailCtx && this._trailCanvas) {
        this._trailCtx.clearRect(0, 0, this._trailCanvas.width, this._trailCanvas.height);
      }
      return;
    }
    this._visible = visible;
    this._cursor.style.opacity = visible ? '1' : '0';
    if (!visible && this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
  }

  moveTo(x, y) {
    if (typeof __wt_masterVisualsEnabled !== 'undefined' && !__wt_masterVisualsEnabled) return;
    if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) return;
    this._targetX = x;
    this._targetY = y;
    if (this._lerpX === -9999) {
      this._lerpX = x;
      this._lerpY = y;
    }
    if (!this._visible) {
      this._visible = true;
      this._cursor.style.opacity = '1';
    }
    if (!this._animFrame) {
      this._startLoop();
    }
  }

  setWaypoints(waypoints, durationMs) {
    if (typeof __wt_masterVisualsEnabled !== 'undefined' && !__wt_masterVisualsEnabled) return;
    if (!waypoints || !waypoints.length) return;
    this._waypointQueue = waypoints;
    this._playingQueue = true;
    this._waypointStartTime = performance.now();
    this._waypointDuration = durationMs || (waypoints.length * 16);
    if (waypoints.length > 0 && this._lerpX === -9999) {
      this._lerpX = waypoints[0].x;
      this._lerpY = waypoints[0].y;
    }
    if (!this._visible) {
      this._visible = true;
      this._cursor.style.opacity = '1';
    }
    if (!this._animFrame) this._startLoop();
  }

  _startLoop() {
    this._lastTime = performance.now();
    const draw = (currentTime) => {
      const dt = Math.min((currentTime - this._lastTime) / 1000, 0.1);
      this._lastTime = currentTime;

      if (this._playingQueue && this._waypointQueue.length > 0) {
        const elapsed = currentTime - this._waypointStartTime;
        const progress = Math.max(0, Math.min(elapsed / (this._waypointDuration || 1), 1));
        const totalSegments = this._waypointQueue.length - 1;

        if (totalSegments <= 0) {
          this._targetX = this._waypointQueue[0].x;
          this._targetY = this._waypointQueue[0].y;
        } else {
          const floatIdx = progress * totalSegments;
          const i0 = Math.floor(floatIdx);
          const i1 = Math.min(i0 + 1, totalSegments);
          const t = floatIdx - i0;

          const p0 = this._waypointQueue[i0];
          const p1 = this._waypointQueue[i1];
          if (p0 && p1) {
            this._targetX = p0.x + (p1.x - p0.x) * t;
            this._targetY = p0.y + (p1.y - p0.y) * t;
          }
        }

        if (progress >= 1) {
          this._playingQueue = false;
          this._waypointQueue = [];
        }
      }

      // Smooth exponential lerp (k = 24 for fluid human-smooth tracking)
      const lerpFactor = 1 - Math.exp(-24 * dt);
      if (this._targetX !== -9999) {
        this._lerpX += (this._targetX - this._lerpX) * lerpFactor;
        this._lerpY += (this._targetY - this._lerpY) * lerpFactor;
        if (Math.abs(this._targetX - this._lerpX) < 0.1) this._lerpX = this._targetX;
        if (Math.abs(this._targetY - this._lerpY) < 0.1) this._lerpY = this._targetY;

        // "always show in browser" - stays visible once loaded and active
        if (typeof __wt_masterVisualsEnabled === 'undefined' || __wt_masterVisualsEnabled) {
          if (!this._visible) {
            this._visible = true;
            this._cursor.style.opacity = '1';
          }
        } else {
          if (this._visible) {
            this._visible = false;
            this._cursor.style.opacity = '0';
          }
        }

        this._render(currentTime);
      }

      const settled = !this._playingQueue &&
        Math.abs(this._targetX - this._lerpX) < 0.1 &&
        Math.abs(this._targetY - this._lerpY) < 0.1 &&
        this._trailPoints.length === 0;

      if (!this._visible || (typeof __wt_masterVisualsEnabled !== 'undefined' && !__wt_masterVisualsEnabled) || settled) {
        this._animFrame = null;
        return;
      }

      this._animFrame = requestAnimationFrame(draw);
    };
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    this._animFrame = requestAnimationFrame(draw);
  }

  _render(currentTime) {
    if (typeof __wt_masterVisualsEnabled !== 'undefined' && !__wt_masterVisualsEnabled) {
      this._cursor.style.opacity = '0';
      if (this._trailCtx && this._trailCanvas) {
        this._trailCtx.clearRect(0, 0, this._trailCanvas.width, this._trailCanvas.height);
      }
      return;
    }
    const x = this._lerpX;
    const y = this._lerpY;
    if (x === -9999 || y === -9999) return;

    const now = currentTime || performance.now();

    // 1. Trail decay tracking
    const dx = this._targetX - this._lerpX;
    const dy = this._targetY - this._lerpY;
    const moveDist = Math.sqrt(dx * dx + dy * dy);

    if (moveDist > 1.8 && now - this._lastTrailRecord > 22) {
      this._trailPoints.push({ x, y, birth: now });
      this._lastTrailRecord = now;
      if (this._trailPoints.length > 14) this._trailPoints.shift();
    }

    // Render decaying trail
    if (this._trailCtx && this._trailCanvas) {
      this._trailCtx.clearRect(0, 0, this._trailCanvas.width, this._trailCanvas.height);
      for (let i = this._trailPoints.length - 1; i >= 0; i--) {
        const pt = this._trailPoints[i];
        const age = (now - pt.birth) / 260;
        if (age >= 1) {
          this._trailPoints.splice(i, 1);
          continue;
        }
        const alpha = (1 - age) * 0.45;
        const radius = Math.max(1, (1 - age) * 2.8);
        this._trailCtx.beginPath();
        this._trailCtx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        this._trailCtx.fillStyle = `rgba(18, 104, 255, ${alpha})`;
        this._trailCtx.shadowColor = '#1268ff';
        this._trailCtx.shadowBlur = 4;
        this._trailCtx.fill();
      }
    }

    // 2. Cursor scale and tactile micro-physics
    let targetScale = this._scale;
    if (this._state === 'clicking') {
      targetScale = this._scale * 0.82; // Tactile compression on click
    } else if (this._state === 'hover') {
      targetScale = this._scale * 1.08; // Interactive focus
    } else if (this._state === 'idle') {
      targetScale = this._scale + Math.sin(now * 0.003) * 0.012; // Alive breathing oscillation
    }

    // 3. Dynamic velocity tilt (natural motion lag)
    const tilt = Math.max(-5, Math.min(5, dx * 0.06));

    this._cursor.style.transform = `translate3d(${x - this._hotX}px, ${y - this._hotY}px, 0) rotate(${tilt}deg) scale(${targetScale})`;
  }
}

// Instantiate the active cursor only in top frame
let __weaveCursor = window === window.top ? new WeaveCursor() : null;
window.__weaveCursor_instance = __weaveCursor;

function moveCursor(x, y, state) {
  if (typeof __wt_masterVisualsEnabled !== 'undefined' && !__wt_masterVisualsEnabled) return;
  if (__weaveCursor && typeof __weaveCursor.moveTo === 'function') {
    if (typeof x === 'number' && typeof y === 'number' && x >= 0 && y >= 0) {
      __weaveCursor.moveTo(x, y);
    }
    if (state) __weaveCursor.setState(state);
  }
}

// Enhanced twin action ripples radiating from click target
function ripple(x, y) {
  if (typeof __wt_masterVisualsEnabled !== 'undefined' && !__wt_masterVisualsEnabled) return;
  const host = document.createElement('div');
  host.className = 'Weavetab-ripple-host';
  host.setAttribute('data-wt-ignore', 'true');
  host.style.cssText = `position:fixed;left:${x}px;top:${y}px;pointer-events:none;z-index:2147483646;transform:translate(-50%, -50%);`;

  const w1 = document.createElement('div');
  w1.style.cssText = 'position:absolute;top:50%;left:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border:2px solid #1268ff;border-radius:50%;box-shadow:0 0 12px rgba(18,104,255,0.7);animation:__wt_ripple_expand 0.42s cubic-bezier(0.1, 0.8, 0.3, 1) forwards;pointer-events:none;';

  const w2 = document.createElement('div');
  w2.style.cssText = 'position:absolute;top:50%;left:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border:1.5px solid #60a5fa;border-radius:50%;animation:__wt_ripple_expand 0.52s 0.08s cubic-bezier(0.1, 0.8, 0.3, 1) forwards;pointer-events:none;';

  host.appendChild(w1);
  host.appendChild(w2);
  (document.getElementById('Weavetab-root')?.shadowRoot || document.body || document.documentElement).appendChild(host);
  setTimeout(() => host.remove(), 620);
}

// ── X-RAY SPOTLIGHT OVERLAY (Phase 5.2) ────────────────────────
const __xrayOverlays = [];

function clearXRay() {
  for (const el of __xrayOverlays) el.remove();
  __xrayOverlays.length = 0;
}

function activateXRay(elements) {
  clearXRay();

  // Colour spectrum for visual richness
  const colours = [
    '#4F8EF7', '#7C3AED', '#10B981', '#F59E0B',
    '#EF4444', '#06B6D4', '#F97316', '#8B5CF6',
  ];

  const top = elements.slice(0, 12);

  top.forEach((item, i) => {
    const el = document.querySelector(item.selector) || shadowQuery(item.selector);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    
    if (rect.width === 0 || rect.height === 0) return;

    const colour = colours[i % colours.length];
    const halo = document.createElement('div');
    halo.className = '__Weavetab_xray';
    halo.setAttribute('data-wt-ignore', '');

    Object.assign(halo.style, {
      position: 'fixed',
      left:   `${rect.left   - 4}px`,
      top:    `${rect.top    - 4}px`,
      width:  `${rect.width  + 8}px`,
      height: `${rect.height + 8}px`,
      border: `2px solid ${colour}`,
      borderRadius: '6px',
      boxShadow: `0 0 12px 4px ${colour}88, inset 0 0 8px ${colour}33`,
      background: `${colour}0d`,
      pointerEvents: 'none',
      zIndex: '2147483645',
      animation: '__wt_xray_pulse 1.4s ease-in-out forwards',
      animationDelay: `${i * 55}ms`,
    });

    // Rank label badge
    const badge = document.createElement('span');
    Object.assign(badge.style, {
      position: 'absolute',
      top: '-10px',
      left: '4px',
      background: colour,
      color: '#fff',
      fontSize: '9px',
      fontFamily: 'system-ui, sans-serif',
      fontWeight: '700',
      padding: '1px 5px',
      borderRadius: '3px',
      lineHeight: '14px',
      whiteSpace: 'nowrap',
      letterSpacing: '0.03em',
      boxShadow: `0 1px 4px ${colour}99`,
    });
    const label = (item.text || item.role || item.tag || '').slice(0, 22) || `#${i + 1}`;
    badge.textContent = `${i + 1} ${label}`;
    halo.appendChild(badge);

    getWeavetabRoot().appendChild(halo);
    __xrayOverlays.push(halo);
  });

  // Auto-clear after 2.8 s
  setTimeout(clearXRay, 2800);
}

// Inject keyframe animation for X-Ray
(function injectXRayStyles() {
  if (document.getElementById('__Weavetab_xray_styles')) return;
  const style = document.createElement('style');
  style.id = '__Weavetab_xray_styles';
  style.textContent = `
    @keyframes __wt_xray_pulse {
      0%   { opacity: 0; transform: scale(0.94); }
      18%  { opacity: 1; transform: scale(1.02); }
      70%  { opacity: 0.85; transform: scale(1); }
      100% { opacity: 0; transform: scale(0.97); }
    }
    .Weavetab-ripple {
      width: 40px; height: 40px;
      margin: -20px 0 0 -20px;
      border-radius: 50%;
      background: rgba(79,142,247,0.35);
      border: 2px solid #4F8EF7;
      animation: __wt_ripple 0.55s ease-out forwards;
    }
    @keyframes __wt_ripple {
      from { transform: scale(0.3); opacity: 1; }
      to   { transform: scale(2.2); opacity: 0; }
    }
    @keyframes wt-reading-pulse {
      0% { opacity: 0; box-shadow: inset 0 0 0 rgba(59,130,246,0); }
      15% { opacity: 1; box-shadow: inset 0 0 60px rgba(59,130,246,0.15); }
      85% { opacity: 1; box-shadow: inset 0 0 60px rgba(59,130,246,0.15); }
      100% { opacity: 0; box-shadow: inset 0 0 0 rgba(59,130,246,0); }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
})();

// ── ACTIVE TAB INDICATOR ─────────────────────────────────────────
class ControlledTabIndicator {
  constructor() {
    this._el = document.createElement('div');
    this._el.id = '__Weavetab_controlled_indicator';
    this._el.setAttribute('data-wt-ignore', '');
    Object.assign(this._el.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      height: '3px',
      zIndex: '2147483646',
      background: '#3B82F6',
      boxShadow: '0 0 12px #3B82F6, 0 0 4px #60a5fa',
      opacity: '0',
      transition: 'opacity 0.25s ease-in-out',
      pointerEvents: 'none',
    });
    // Animated shimmer
    this._shimmer = document.createElement('div');
    Object.assign(this._shimmer.style, {
      position: 'absolute',
      top: '0', left: '-60%', width: '60%', height: '100%',
      background: 'linear-gradient(90deg,transparent,rgba(255,255,255,0.45),transparent)',
      animation: 'wt-shimmer 1.6s infinite',
    });
    // Inject animation keyframes into shadow root
    var style = document.createElement('style');
    style.textContent = '@keyframes wt-shimmer{0%{left:-60%}100%{left:120%}}';
    try { getWeavetabRoot().appendChild(style); } catch(e) {}
    this._el.appendChild(this._shimmer);
    getWeavetabRoot().appendChild(this._el);
    this._hideTimer = null;
    this._persistent = false;
  }

  // Show persistently (while agent is weaving)
  showPersistent(color) {
    this._persistent = true;
    clearTimeout(this._hideTimer);
    if (color) {
      this._el.style.background = color;
      this._el.style.boxShadow = '0 0 12px ' + color + ', 0 0 4px ' + color;
    }
    this._el.style.opacity = '1';
    this._shimmer.style.display = 'block';
  }

  // Show briefly (1.5s flash for single actions)
  show(color) {
    if (this._persistent) return; // Don't override persistent mode
    if (color) this._el.style.background = color;
    this._el.style.opacity = '1';
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.hide(), 1500);
  }

  hide() {
    this._persistent = false;
    this._el.style.opacity = '0';
    this._shimmer.style.display = 'none';
  }

  destroy() {
    clearTimeout(this._hideTimer);
    this._el.remove();
  }
}

const controlledIndicator = window === window.top ? new ControlledTabIndicator() : null;

// ── MESSAGE BRIDGE ──────────────────────────────────────────────
var __wt_lastCursor = { x: -9999, y: -9999 };
var __wt_processedMsgIds = new Set();

function __wt_handleWeavetabMsg(msg, fromBackground) {
  if (!msg) return;
  if (Array.isArray(msg)) { msg.forEach(m => __wt_handleWeavetabMsg(m, fromBackground)); return; }
  if (msg._id) { if (__wt_processedMsgIds.has(msg._id)) return; __wt_processedMsgIds.add(msg._id); if (__wt_processedMsgIds.size > 100) __wt_processedMsgIds.clear(); }

  if (msg.type === 'Weavetab_SUPPRESS_VISUALS') {
    if (typeof window.__wt_setSuppressed === 'function') {
      window.__wt_setSuppressed(!!msg.suppress);
    }
    return;
  }

  if (msg.type === 'Weavetab_STATE') {
    if (msg.cursor) {
      __wt_lastCursor = { x: msg.cursor.x, y: msg.cursor.y };
      if (msg.cursor.waypoints && msg.cursor.duration_ms && __weaveCursor) {
        __weaveCursor.setWaypoints(msg.cursor.waypoints, msg.cursor.duration_ms);
      }
      moveCursor(msg.cursor.x, msg.cursor.y, msg.state);
    }
    else if (msg.state) { moveCursor(__wt_lastCursor.x, __wt_lastCursor.y, msg.state); }
    if (msg.ripple) {
      const rx = msg.ripple.x ?? msg.ripple.cx;
      const ry = msg.ripple.y ?? msg.ripple.cy;
      if (typeof rx === 'number' && typeof ry === 'number') ripple(rx, ry);
    }

    if (msg.userFeedback === true && msg.feedbackText) {
      __wt_feedbackSticky = true;
      clearTimeout(window.__wt_feedbackStickyTimer);
      window.__wt_feedbackStickyTimer = setTimeout(function(){ __wt_feedbackSticky = false; }, 6000);
    } else if (msg.userFeedback === false) {
      setTimeout(function(){ __wt_feedbackSticky = false; }, 2000);
    }

    if (msg.hud) {
      var a = (msg.hud.action || '').trim();
      if (__weaveCursor) {
        if (a === 'reading the page...') {
          __weaveCursor.setState('reading');
        } else if (a === 'Mission Running') {
          __weaveCursor.setState('eval');
        } else if (a.startsWith('[OK]')) {
          __weaveCursor.setState('idle');
        } else if (a.startsWith('[ERR]')) {
          __weaveCursor.setState('stuck');
          setTimeout(function(){ if (__weaveCursor) __weaveCursor.setState('idle'); }, 3000);
        }
      }
      if (typeof window.__wt_forwardHud === 'function') {
        window.__wt_forwardHud({ type: 'WT_HUD_UPDATE', state: msg.hud.action, detail: msg.hud.detail });
      }
    }
    if ((msg.cursor || msg.hud) && controlledIndicator) {
      controlledIndicator.show('#3B82F6');
    }
  }

  if (msg.type === 'WT_THOUGHT' || msg.type === 'Weavetab_THOUGHT') {
    __wt_showThought(msg.text, msg);
  }
  if (msg.type === 'WT_CLEAR_THOUGHT' || msg.type === 'Weavetab_CLEAR_THOUGHT') {
    __wt_removeThought();
  }
  if (msg.type === 'WT_HUD_UPDATE') {
    const hudPayload = {
      type: 'WT_HUD_UPDATE',
      state: msg.state || msg.action || msg.badge,
      detail: msg.detail || msg.groupState,
      action: msg.action,
      badge: msg.badge,
      badgeColor: msg.badgeColor,
      groupState: msg.groupState
    };
    if (typeof window.__wt_forwardHud === 'function') {
      window.__wt_forwardHud(hudPayload);
    }
    if (!fromBackground) {
      __wt_safeSendMessage(hudPayload);
    }
  }

  if (msg.type === 'WT_USER_NOTE_INJECT') {
    window.__wt_user_notes = window.__wt_user_notes || [];
    window.__wt_user_notes.push({ text: msg.text, time: Date.now() });
  }

  if (msg.type === 'GET_SEMANTIC_MAP') {
    const map = [];
    let idCounter = 1;
    function crawl(root, depth = 0) {
      for (const el of root.querySelectorAll('a,button,input,select,textarea,[role],[onclick],[tabindex]')) {
        if (el.hasAttribute('data-wt-ignore')) continue;
        const rect = el.getBoundingClientRect();
        const isEssential = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName);
        if (rect.width === 0 && !isEssential) continue;
        let id = el.getAttribute('data-wt-id');
        if (!id) {
          id = String(idCounter++);
          el.setAttribute('data-wt-id', id);
        }
        map.push({
          id,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
          role: el.getAttribute('role'),
          selector: `[data-wt-id="${id}"]`,
          coords: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
          inShadow: depth > 0
        });
      }
      for (const node of root.querySelectorAll('*')) {
        if (node.shadowRoot) crawl(node.shadowRoot, depth + 1);
      }
    }
    crawl(document);
    if (window.__wt_user_notes && window.__wt_user_notes.length > 0) {
      window.__wt_user_notes = window.__wt_user_notes.filter(n => Date.now() - n.time < 120000);
      const notesMap = window.__wt_user_notes.map((note, i) => ({
        id: `user-msg-${i}`,
        role: 'alert',
        tag: 'div',
        text: `URGENT MESSAGE FROM USER: "${note.text}"`,
        coords: [0, 0, 100, 100],
        interactive: false
      }));
      map.unshift(...notesMap);
    }
    activateXRay(map.filter(m => m.coords && m.text).slice(0, 12));
    window.dispatchEvent(new CustomEvent('Weavetab-msg-out', { detail: { id: msg.id, data: map } }));
  }

  if (msg.type === 'Weavetab_CONFIG') {
    window.__wt_devMode = !!msg.devMode;
    window.dispatchEvent(new CustomEvent('wt-config-sync'));
    if (!fromBackground) __wt_safeSendMessage(msg);
  }

  if (msg.type === 'Weavetab_GROUP_STATE') {
    if (!fromBackground) __wt_safeSendMessage(msg);
    const dotColor = (msg.state === 'idle') ? null : '#3B82F6';
    if (dotColor && controlledIndicator) {
      controlledIndicator.show(dotColor);
    }
    updateFaviconDot(msg.state, msg.isActive);
    if (msg.isActive === false) {
      __wt_removeThought();
    }
    if (msg.state === 'idle') {
      __wt_destroyBubble();
      __wt_feedbackSticky = false;
      restoreOriginalFavicon();
      if (controlledIndicator) controlledIndicator.hide();
      if (__weaveCursor) __weaveCursor.setState('idle');
    } else if (msg.state === 'weaving') {
      if (controlledIndicator) controlledIndicator.showPersistent('#3B82F6');
      if (__weaveCursor) __weaveCursor.setState('eval');
    } else if (msg.state === 'stuck') {
      if (controlledIndicator) controlledIndicator.showPersistent('#3B82F6');
      if (__weaveCursor) __weaveCursor.setState('stuck');
    }
  }

  if (msg.type === 'Weavetab_ASK') {
    __wt_showQuestion(msg.question, 'sentence', msg.timeout || 120);
    window.dispatchEvent(new CustomEvent('Weavetab-msg-out', { detail: { id: msg.id, data: { status: 'shown' } } }));
  }
}

window.addEventListener('Weavetab-msg-in', (e) => {
  __wt_handleWeavetabMsg(e.detail, false);
});

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data && event.data.type === 'Weavetab-msg-in' && event.data.data) {
    __wt_handleWeavetabMsg(event.data.data, false);
  }
});

// ── FAVICON STATUS DOT INDICATOR ───────────────────────────────
let wtFaviconObserver = null;
let __wt_faviconStaleTimer = null;

function updateFaviconDot(state, isActive) {
  if (__wt_faviconStaleTimer) { clearTimeout(__wt_faviconStaleTimer); __wt_faviconStaleTimer = null; }
  if (!document.head) return;

  if (state === 'idle' || !state || isActive === false) {
    if (wtFaviconObserver) {
      wtFaviconObserver.disconnect();
      wtFaviconObserver = null;
    }
    restoreOriginalFavicon();
    return;
  }

  const color = '#3B82F6';

  if (!wtFaviconObserver) {
    wtFaviconObserver = new MutationObserver(() => {
      if (!document.head) return;
      wtFaviconObserver.disconnect();
      applyFaviconDot(color);
    });
  } else {
    wtFaviconObserver.disconnect();
  }

  applyFaviconDot(color);

  __wt_faviconStaleTimer = setTimeout(function() {
    restoreOriginalFavicon();
    __wt_destroyBubble();
  }, 30000);
}

function restoreOriginalFavicon() {
  if (wtFaviconObserver) wtFaviconObserver.disconnect();
  const customLink = document.getElementById('wt-custom-favicon');
  if (customLink) customLink.remove();

  const links = document.querySelectorAll('link[rel*="icon"]');
  links.forEach(link => {
    if (link.dataset.wtOrigHref) {
      link.href = link.dataset.wtOrigHref;
      delete link.dataset.wtOrigHref;
    }
  });
}

function applyFaviconDot(color) {
  const links = Array.from(document.querySelectorAll('link[rel*="icon"]')).filter(l => l.id !== 'wt-custom-favicon');
  let originalHref = '';

  if (links.length > 0) {
    const link = links[0];
    if (!link.dataset.wtOrigHref) {
      link.dataset.wtOrigHref = link.href;
    }
    originalHref = link.dataset.wtOrigHref;
  } else {
    originalHref = '/favicon.ico';
  }

  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      ctx.drawImage(img, 0, 0, 32, 32);
      drawDot(ctx, color);
      setFaviconHref(canvas.toDataURL('image/png'));
    } catch (e) {
      drawFallbackIcon(ctx, color);
      setFaviconHref(canvas.toDataURL('image/png'));
    }
  };
  img.onerror = () => {
    drawFallbackIcon(ctx, color);
    setFaviconHref(canvas.toDataURL('image/png'));
  };
  img.src = originalHref;
}

function drawDot(ctx, color) {
  // Solid dot
  ctx.beginPath();
  ctx.arc(24, 24, 5.5, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawFallbackIcon(ctx, color) {
  ctx.clearRect(0, 0, 32, 32);
  ctx.beginPath();
  ctx.roundRect(1, 1, 30, 30, 7);
  ctx.fillStyle = '#005EFA';
  ctx.fill();

  ctx.save();
  ctx.scale(32 / 1024, 32 / 1024);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill(new Path2D('M 687.274 243.883 C 672.944 247.059, 659.952 258.654, 655.324 272.396 C 654.137 275.922, 653.590 279.927, 653.125 288.513 C 652.785 294.797, 652.579 300.319, 652.668 300.783 C 652.787 301.412, 644.659 301.729, 620.711 302.028 C 591.207 302.395, 587.994 302.558, 581.237 304.018 C 564.823 307.564, 549.671 315.579, 537.486 327.162 C 529.751 334.514, 524.041 342.406, 518.883 352.871 C 511.505 367.840, 509.561 378.819, 509.561 405.531 L 509.561 421.799 489.829 421.799 C 472.552 421.799, 469.403 421.975, 464.531 423.222 C 451.620 426.524, 440.854 435.043, 435.316 446.338 C 430.895 455.355, 430.196 459.791, 430.181 478.919 L 430.169 495.260 398.231 495.621 C 369.003 495.952, 365.742 496.112, 359.798 497.509 C 341.998 501.691, 327.995 508.857, 316.005 519.920 C 306.561 528.633, 298.843 539.685, 294.256 551.063 C 288.324 565.777, 287.262 572.739, 287.262 596.917 C 287.262 607.385, 287.018 615.977, 286.721 616.009 C 286.424 616.042, 276.598 616.308, 264.888 616.599 L 243.596 617.128 237.915 619.439 C 231.794 621.929, 230.107 622.980, 224.368 627.878 C 217.588 633.665, 211.671 643.815, 210.101 652.350 C 209.000 658.334, 209.019 742.238, 210.122 747.453 C 213.427 763.072, 226.231 775.767, 242.295 779.350 C 250.009 781.071, 344.422 781.088, 352.736 779.371 C 367.630 776.294, 379.406 765.945, 384.837 751.159 C 386.211 747.420, 386.431 744.918, 386.805 728.903 L 387.225 710.859 429.447 710.491 C 469.874 710.140, 471.949 710.056, 478.245 708.527 C 511.682 700.410, 536.744 678.244, 548.484 646.401 C 552.676 635.032, 553.788 626.953, 553.777 607.926 L 553.767 590.881 559.632 590.394 C 562.857 590.127, 567.446 589.406, 569.827 588.793 C 583.509 585.274, 595.717 573.520, 600.100 559.646 L 601.945 553.804 601.945 507.325 C 601.945 476.172, 601.682 459.583, 601.148 457.019 C 599.744 450.290, 595.384 442.041, 590.439 436.754 C 581.955 427.684, 572.564 423.193, 559.903 422.149 L 553.588 421.628 553.588 401.941 C 553.588 384.037, 553.724 381.806, 555.095 377.306 C 558.760 365.278, 567.332 355.043, 578.208 349.712 C 587.965 344.929, 589.420 344.750, 622.696 344.238 L 652.468 343.780 652.468 356.743 C 652.468 364.881, 652.845 371.679, 653.482 375.007 C 656.339 389.941, 668.035 402.780, 683.142 407.567 C 688.136 409.149, 688.717 409.168, 733.304 409.168 C 774.155 409.168, 778.848 409.048, 783.015 407.897 C 796.594 404.145, 807.842 393.785, 812.807 380.459 L 814.480 375.967 814.695 328.170 C 814.933 275.382, 815.000 276.331, 810.325 266.622 C 807.355 260.452, 798.181 251.082, 792.126 248.034 C 782.218 243.046, 784.448 243.243, 735.830 243.052 C 700.383 242.912, 690.920 243.075, 687.274 243.883 M 368.992 538.801 C 352.080 541.619, 338.162 553.230, 332.284 569.424 C 329.878 576.053, 329.015 585.231, 329.267 601.514 L 329.485 615.588 340.311 616.006 C 352.109 616.462, 355.362 617.131, 361.945 620.451 C 373.178 626.115, 380.374 634.433, 384.872 646.950 C 385.864 649.711, 386.452 653.756, 386.768 659.976 L 387.225 668.998 421.508 669.204 C 443.289 669.334, 457.997 669.123, 461.838 668.623 C 479.336 666.348, 495.971 654.026, 504.201 637.242 C 509.114 627.223, 509.678 624.277, 510.092 606.458 L 510.455 590.831 488.536 590.526 C 467.134 590.230, 466.479 590.177, 460.787 588.298 C 450.469 584.892, 441.867 578.045, 436.465 568.939 C 432.359 562.017, 430.805 556.306, 430.357 546.481 L 429.970 538.000 401.380 538.085 C 385.656 538.131, 371.080 538.454, 368.992 538.801'), 'evenodd');
  ctx.restore();

  drawDot(ctx, color);
}

function setFaviconHref(dataUrl) {
  if (!document.head) return;
  if (wtFaviconObserver) wtFaviconObserver.disconnect();
  let customLink = document.getElementById('wt-custom-favicon');
  if (!customLink) {
    customLink = document.createElement('link');
    customLink.id = 'wt-custom-favicon';
    customLink.rel = 'icon';
    customLink.type = 'image/png';
    document.head.appendChild(customLink);
  }
  customLink.href = dataUrl;

  const links = document.querySelectorAll('link[rel*="icon"]');
  links.forEach(link => {
    if (link.id !== 'wt-custom-favicon') {
      if (!link.dataset.wtOrigHref) {
        link.dataset.wtOrigHref = link.href;
      }
      link.href = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    }
  });
  if (wtFaviconObserver && document.head) {
    wtFaviconObserver.observe(document.head, { childList: true, subtree: true });
  }
}

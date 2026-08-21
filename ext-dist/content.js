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
  // Guard: exit gracefully on chrome:// pages (content scripts blocked)
  if (location.protocol.startsWith('chrome')) return;

  let host = null;
  let shadow = null;
  let iframe = null;
  let hudState = {};

  // Create mount point with closed shadow DOM
  function createMount() {
    if (host && document.documentElement.contains(host)) return;

    host = document.createElement('weavetab-host');
    host.setAttribute('data-wt-internal', 'true');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial !important;position:fixed !important;left:0 !important;top:0 !important;width:0 !important;height:0 !important;z-index:2147483647 !important;pointer-events:none !important;background:transparent !important;opacity:1 !important;transform:none !important;filter:none !important;';
    __wt_safeAppendToBody(host);

    // Closed shadow root — ref lives ONLY here, never on window
    shadow = host.attachShadow({ mode: 'closed' });

    iframe = document.createElement('iframe');
    iframe.src = browserAPI.runtime.getURL('hud/index.html');
    iframe.id = 'wt-hud-iframe';
    iframe.setAttribute('allowtransparency', 'true');
    // FIX: Start hidden. Expand only after receiving state to prevent white flash.
    Object.assign(iframe.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      border: 'none',
      background: 'transparent',
      pointerEvents: 'none',
      zIndex: '2147483647',
      visibility: 'hidden',
      opacity: '0',
      colorScheme: 'light dark'
    });
    shadow.appendChild(iframe);

    // REHYDRATE: send state to iframe, but DO NOT make visible yet to avoid white flash.
    iframe.onload = function() {
      browserAPI.storage.local.get('wt-hud-state', function(result) {
        hudState = result['wt-hud-state'] || {};
        if (iframe.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'REHYDRATE', state: hudState }, browserAPI.runtime.getURL(''));
        }
      });
    };

    // Listen for HUD state changes from the iframe to toggle visibility
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'HUD_STATE_CHANGED' && e.source === iframe.contentWindow) {
        const visible = e.data.state && e.data.state.hudVisible !== false;
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
    });
  }

  // Navigation guard: re-mount if host is removed (SPA/bfcache safe)
  const observer = new MutationObserver(function() {
    if (!document.documentElement.contains(host)) {
      createMount();
    }
    if (window.__wt_visualComponents && window.__wt_visualComponents.cursor && !document.getElementById('__Weavetab_cursor_host')) {
      if (typeof __wt_recoverVisuals === 'function') __wt_recoverVisuals();
    }
  });
  observer.observe(document.documentElement, { childList: true });

  // Real-time event relays (Agent only)
  // Removed physical mousemove, click, and keydown listeners to prevent lag and interference with agent visuals.

  let scrollTicking = false;
  document.addEventListener('scroll', function() {
    if (!scrollTicking && iframe && iframe.contentWindow) {
      window.requestAnimationFrame(function() {
        iframe.contentWindow.postMessage({
          type: 'RT_SCROLL',
          y: window.scrollY,
          ratio: window.scrollY / document.body.scrollHeight
        }, '*');
        scrollTicking = false;
      });
      scrollTicking = true;
    }
  }, { passive: true });

  // ── MASTER VISUALS TOGGLE SYSTEM ───────────────────────────
  let __wt_masterVisualsEnabled = true;

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

    const hudEl = document.getElementById('Weavetab-hud');
    if (hudEl) {
      hudEl.style.display = 'none';
    }

    const hudHost = document.querySelector('weavetab-host');
    if (hudHost) {
      hudHost.style.display = __wt_masterVisualsEnabled ? 'block' : 'none';
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

  try {
    browserAPI.storage.local.get(['wt_master_visuals'], function(res) {
      if (res && res.wt_master_visuals === false) {
        __wt_applyMasterVisuals(false);
      } else {
        __wt_applyMasterVisuals(true);
      }
    });

    browserAPI.storage.onChanged.addListener(function(changes, area) {
      if (area === 'local' && changes.wt_master_visuals !== undefined) {
        __wt_applyMasterVisuals(changes.wt_master_visuals.newValue !== false);
      }
    });
  } catch(e) {}

  // Ghost CDP cursor relay from background
  browserAPI.runtime.onMessage.addListener(function(msg) {
    if (msg.type === 'WT_TOGGLE_MASTER_VISUALS') {
      __wt_applyMasterVisuals(msg.enabled);
    }
    if (msg.type === 'GHOST_CURSOR_MOVE') {
      if (typeof msg.x === 'number' && typeof msg.y === 'number') {
        moveCursor(msg.x, msg.y, msg.phase);
      }
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'RT_CURSOR_MOVE', x: msg.x, y: msg.y, phase: msg.phase }, '*');
      }
    }
    if (msg.type === 'TOOL_CALL_EVENT' && iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'TOOL_CALL_EVENT', payload: msg.payload }, '*');
    }
    // Relay sidepanel open/close state to HUD iframe so it can gate browser_thought pill
    if (msg.type === 'WT_SIDEPANEL_STATE' && iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'WT_SIDEPANEL_STATE', open: msg.open }, '*');
    }
    // Background tells us to suppress the thought pill for this specific event
    if (msg.type === 'WT_SUPPRESS_THOUGHT_HUD' && iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'WT_SUPPRESS_THOUGHT_HUD' }, '*');
    }
    // Scripted pill toggle from sidepanel settings — relay to HUD iframe
    if (msg.type === 'WT_SCRIPTED_PILL_TOGGLE' && iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'WT_SCRIPTED_PILL_TOGGLE', enabled: msg.enabled }, '*');
    }
    // Handle incoming user notes sent from the sidepanel input
    if (msg.type === 'WT_USER_NOTE_INJECT' || msg.type === 'WT_USER_NOTE') {
      window.__wt_chat_queue = window.__wt_chat_queue || [];
      let formattedMsg = msg.text || '';
      if (msg.snipe) {
        formattedMsg = `[USER AREA ANNOTATION ATTACHED (${msg.snipe.mode})]: ` + formattedMsg;
      }
      window.__wt_chat_queue.push(formattedMsg);

      // Unblock pending ask_bridge polling loops immediately
      window.__wt_ask_bridge = window.__wt_ask_bridge || {};
      if (window.__wt_ask_bridge.resolve) {
        window.__wt_ask_bridge.resolve({
          success: true,
          response: formattedMsg,
          status: 'answered'
        });
        window.__wt_ask_bridge = {};
      }

      // Display on-page glassmorphism notification banner if master visuals are enabled
      if (window.__wt_masterVisualsEnabled !== false) {
        __wt_showUserNoteVisualBanner(formattedMsg);
      }
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

  // State persistence bridge: listen for state changes from iframe
  window.addEventListener('message', function(e) {
    // Forward relevant events to the extension background/sidepanel
    if (e.data && (
      e.data.type === 'WT_TOOL_CALL' ||
      e.data.type === 'WT_PLAN_UPDATE' ||
      e.data.type === 'WT_THOUGHT' ||
      e.data.type === 'TOOL_CALL_EVENT' ||
      e.data.type === 'Weavetab_CONFIG' ||
      e.data.type === 'WT_CONFIG_UPDATE'
    )) {
      __wt_safeSendMessage(e.data);
    }

    
    if (e.origin !== browserAPI.runtime.getURL('').slice(0, -1)) return;
    if (e.data.type === 'HUD_STATE_CHANGED') {
      hudState = { ...hudState, ...e.data.state };
      browserAPI.storage.local.set({ 'wt-hud-state': hudState });
    }
  });

  // Listen for toggle command from background
  browserAPI.runtime.onMessage.addListener(function(msg) {
    console.log('[Weavetab Content] Received message:', msg.type);
    if (msg.type === 'TOGGLE_HUD' && iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'TOGGLE_HUD' }, '*');
    }
    if (msg.type === 'TOGGLE_DEBUG' && iframe && iframe.contentWindow) {
      console.log('[Weavetab Content] Forwarding TOGGLE_DEBUG to iframe');
      iframe.contentWindow.postMessage({ type: 'TOGGLE_DEBUG' }, '*');
    }
  });

  // Initial mount
  createMount();
})();

// ── UNIFIED VISUAL SYSTEM INITIALIZATION ─────────────────────────
// Ensures all visual components initialize in correct order and persist across reloads
window.__wt_visualsReady = false;
window.__wt_visualComponents = {
  cursor: false,
  feedback: false,
  debug: false
};
window.__wt_zIndexCounter = 2147483640; // Start near max z-index

function __wt_initVisuals() {
  if (window.__wt_visualsReady) return;

  // Initialize cursor first
  if (!window.__wt_visualComponents.cursor && window.__weaveCursor_instance) {
    window.__wt_visualComponents.cursor = true;
  }

  // Check for WeaveTab OS panel (todo list + chat)
  if (!window.__wt_visualComponents.feedback && document.getElementById('wt-main-container')) {
    window.__wt_visualComponents.feedback = true;
  }

  // Check for debug overlay
  if (!window.__wt_visualComponents.debug && document.getElementById('wt-debug-overlay')) {
    window.__wt_visualComponents.debug = true;
  }

  // Mark as ready when cursor and panel are initialized
  if (window.__wt_visualComponents.cursor && window.__wt_visualComponents.feedback) {
    window.__wt_visualsReady = true;
  }
}

// Health check every 5 seconds to recover missing components
setInterval(function() {
  __wt_initVisuals();
  __wt_recoverVisuals();
}, 5000);

// Visual recovery - detect and fix missing/broken components
function __wt_recoverVisuals() {
  // Recover cursor if missing
  if (window.__wt_visualComponents && window.__wt_visualComponents.cursor && !document.getElementById('__Weavetab_cursor_host')) {
    console.warn('[Weavetab] Cursor host missing, reinitializing...');
    if (window.__weaveCursor_instance && window.__weaveCursor_instance.destroy) {
      window.__weaveCursor_instance.destroy();
    }
    __weaveCursor = new WeaveCursor();
    window.__weaveCursor_instance = __weaveCursor;
    window.__wt_visualComponents.cursor = true;
  }

  // Recover WeaveTab OS panel if missing
  if (window.__wt_visualComponents.feedback && !document.getElementById('wt-main-container')) {
    console.warn('[Weavetab] WeaveTab OS panel missing, this is handled by page reload');
  }

  // Fix z-index conflicts
  var wtElements = document.querySelectorAll('[data-wt-ignore]');
  wtElements.forEach(function(el) {
    if (el.style.zIndex && parseInt(el.style.zIndex) < 2147483640) {
      el.style.zIndex = ++window.__wt_zIndexCounter;
    }
  });
}

// ── STALE ELEMENT CLEANUP ─────────────────────────────────────
// Removes old UI elements from previous server/extension sessions.
// Observer stays active for the full page lifetime (SPA-safe).
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
  // Persistent observer — never disconnects so SPA re-renders stay clean
  var obs = new MutationObserver(function() { removeOld(); });
  if (document.documentElement) {
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      if (document.documentElement) obs.observe(document.documentElement, { childList: true, subtree: true });
    });
  }
})();

// ── UI DESIGN SYSTEM (inject once, styles.css handles visuals) ─
(function injectWeavetabUI() {
  if (document.getElementById('wt-ui-styles')) return;
  // Guard marker so we only run once
  const m = document.createElement('meta');
  m.id = 'wt-ui-styles';
  (document.head || document.documentElement || document.body).appendChild(m);
})();

// ── THOUGHT BUBBLE ─────────────────────────────────────────────
let __wt_activeBubble = null;
let __wt_bubbleTimer = null;
let __wt_typewriterTimer = null;
let __wt_feedbackSticky = false;
let __wt_thoughtBirth = 0;
let __wt_thoughtQueue = [];
let __wt_lastRemoveTime = 0;
let __wt_toolActive = false;

function __wt_fadeOutBubble(callback) {
  if (!__wt_activeBubble) { if (callback) callback(); return; }
  var bub = __wt_activeBubble;
  bub.style.transition = 'opacity 0.15s ease-out, transform 0.15s ease-out';
  bub.style.opacity = '0';
  bub.style.transform = 'translateX(-50%) translateY(6px)';
  setTimeout(function() {
    bub.remove();
    if (callback) callback();
  }, 150);
}

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
  __wt_lastRemoveTime = Date.now();
}

function __wt_removeThought() {
  if (__wt_feedbackSticky) return;
  if (__wt_thoughtBirth && Date.now() - __wt_thoughtBirth < 300) return;
  __wt_destroyBubble();
}

function __wt_showThought(text, options) {
  // On-page thought bubbles removed — all tool calls/thoughts display inside sidepanel logs
  return;
}

function __wt_renderThought(text, options) {
  // On-page thought bubbles removed — all tool calls/thoughts display inside sidepanel logs
  return;
}

function __wt_processThoughtQueue() {
  if (__wt_thoughtQueue.length > 0) {
    var next = __wt_thoughtQueue.shift();
    setTimeout(function() { __wt_renderThought(next.text, next.options); }, 200);
  }
}

// ── QUESTION INPUT (merged into thought bubble system) ────────
let __wt_askContainer = null;
let __wt_askTimer = null;
let __wt_askBridge = null;

function __wt_showQuestion(text, inputType, timeoutSeconds) {
  __wt_removeAsk();
  __wt_feedbackSticky = true;
  var ts = timeoutSeconds || 120;

  // DOM bridge
  __wt_askBridge = document.getElementById('__wt_ask_bridge');
  if (!__wt_askBridge) {
    __wt_askBridge = document.createElement('div');
    __wt_askBridge.id = '__wt_ask_bridge';
    __wt_askBridge.style.display = 'none';
    document.body.appendChild(__wt_askBridge);
  }
  __wt_askBridge.dataset.status = 'pending';
  __wt_askBridge.dataset.result = '';

  // Update HUD to "waiting..." so the top bar doesn't show question text twice
  updateHUD('waiting for your input...');

  // Render green thought bubble (same as sticky feedback — 0ms delay)
  __wt_renderThought(text, { active: false, sticky: true });

  // Countdown timer
  var remaining = ts;
  __wt_askTimer = setInterval(function() {
    remaining--;
    if (remaining <= 0) {
      clearInterval(__wt_askTimer);
      __wt_askTimer = null;
      if (__wt_askBridge) { __wt_askBridge.dataset.status = 'timeout'; __wt_askBridge.dataset.result = ''; }
      __wt_removeAsk();
    }
  }, 1000);

  // Smooth input row — delays slightly so bubble appears first, then input slides up
  setTimeout(function() {
    if (!__wt_askBridge) return;

    var row = document.createElement('div');
    row.setAttribute('data-wt-ignore', '');
    row.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%) translateY(8px);z-index:2147483640;display:flex;align-items:center;gap:0;pointer-events:auto;opacity:0;transition:opacity 0.25s ease-out, transform 0.25s ease-out;';

    var input;
    if (inputType === 'paragraph') {
      input = document.createElement('textarea');
      input.rows = 3;
      input.style.cssText = 'min-width:280px;max-width:480px;font-size:11px;padding:6px 8px;border-radius:4px 0 0 4px;background:#042f2e;color:#e4e4e7;border:1px solid #059669;border-right:none;outline:none;resize:vertical;font-family:"IBM Plex Mono",monospace;';
      input.placeholder = 'Type your response...';
    } else {
      input = document.createElement('input');
      input.style.cssText = 'min-width:200px;font-size:11px;padding:4px 8px;border-radius:4px 0 0 4px;background:#042f2e;color:#e4e4e7;border:1px solid #059669;border-right:none;outline:none;caret-color:#10b981;font-family:"IBM Plex Mono",monospace;';
      input.placeholder = 'Your answer...';
    }

    var btn = document.createElement('button');
    btn.style.cssText = 'padding:4px 10px;background:#059670;border:1px solid #059670;border-left:none;border-radius:0 4px 4px 0;color:#fff;cursor:pointer;font-size:10px;font-family:"IBM Plex Mono",monospace;';
    btn.textContent = 'Send';

    row.appendChild(input);
    row.appendChild(btn);
    document.body.appendChild(row);
    __wt_askContainer = row;

    // Fade in
    requestAnimationFrame(function() {
      row.style.opacity = '1';
      row.style.transform = 'translateX(-50%) translateY(0)';
    });

    setTimeout(function() { input.focus(); }, 150);

    function submit() {
      if (__wt_askBridge) { __wt_askBridge.dataset.status = 'submitted'; __wt_askBridge.dataset.result = input.value; }
      __wt_removeAsk();
    }
    function cancel() {
      if (__wt_askBridge) { __wt_askBridge.dataset.status = 'cancelled'; __wt_askBridge.dataset.result = ''; }
      __wt_removeAsk();
    }

    btn.onclick = submit;
    input.onkeydown = function(e) {
      if (e.key === 'Enter') {
        if (inputType === 'paragraph' && !e.ctrlKey && !e.metaKey) return;
        submit();
      }
      if (e.key === 'Escape') cancel();
    };
  }, 400);
}

function __wt_removeAsk() {
  if (__wt_askTimer) { clearInterval(__wt_askTimer); __wt_askTimer = null; }
  if (__wt_askContainer) { __wt_askContainer.remove(); __wt_askContainer = null; }
  __wt_askBridge = null;
  __wt_feedbackSticky = false;
  clearTimeout(window.__wt_feedbackStickyTimer);
  __wt_thoughtQueue = [];
  __wt_destroyBubble();
}

// ── SHARED OVERLAY CONTAINER ────────────────────────────────────
const __wt_shadowStyles = `
.Weavetab-ripple {
  width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%;
  background: rgba(79,142,247,0.35); border: 2px solid #4F8EF7;
  animation: __wt_ripple 0.55s ease-out forwards;
}
@keyframes __wt_ripple { from { transform: scale(0.3); opacity: 1; } to { transform: scale(2.2); opacity: 0; } }
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
window.__Weavetab = {
  version: '2.5.0',
  suppressVisuals: false,
  shadowQuery: shadowQuery,

  // ── CDP Co-Processor Helpers ──────────────────────────────────────────────
  // Call these via Runtime.evaluate instead of doing expensive CDP-side work.
  // All return plain JSON-serializable values.

  /** Scroll position, viewport size, and page dimensions in one call. */
  getScrollInfo: function() {
    var vv = window.visualViewport || {};
    var body = document.body || document.documentElement;
    return {
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      viewportW: Math.round(vv.width || window.innerWidth),
      viewportH: Math.round(vv.height || window.innerHeight),
      pageW: Math.round(body.scrollWidth),
      pageH: Math.round(body.scrollHeight),
      maxScrollX: Math.round(Math.max(0, body.scrollWidth - window.innerWidth)),
      maxScrollY: Math.round(Math.max(0, body.scrollHeight - window.innerHeight)),
      scrollRatio: body.scrollHeight > 0 ? +(window.scrollY / body.scrollHeight).toFixed(3) : 0
    };
  },

  /**
   * Wait until no DOM mutations occur for `quietMs` milliseconds.
   * Resolves to true when stable, false on timeout (default 5000ms).
   * CDP calls this and awaits — replaces dumb sleep() calls.
   */
  waitForStable: function(quietMs, timeoutMs) {
    quietMs = quietMs || 300;
    timeoutMs = timeoutMs || 5000;
    return new Promise(function(resolve) {
      var timer = null;
      var deadline = setTimeout(function() {
        obs.disconnect();
        resolve(false);
      }, timeoutMs);
      function reset() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function() {
          clearTimeout(deadline);
          obs.disconnect();
          resolve(true);
        }, quietMs);
      }
      var obs = new MutationObserver(reset);
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      reset(); // start the quiet timer immediately
    });
  },

  /**
   * Resolve a data-wt-id directly from the live index — much faster than
   * doing a full accessibility tree walk.
   * Returns { id, x, y, rect, tag, label, viewport, isVisible } or null.
   */
  getElementByWtId: function(id) {
    var idx = window.__wt_liveIndex;
    if (!idx) return null;
    var entry = null;
    for (var i = 0; i < idx.length; i++) {
      if (idx[i].id === String(id)) { entry = idx[i]; break; }
    }
    if (!entry) return null;
    // Refresh coordinates from DOM if element still exists
    var el = document.querySelector('[data-wt-id="' + entry.id + '"]');
    if (el) {
      var r = el.getBoundingClientRect();
      entry.x = Math.round(r.left + r.width / 2);
      entry.y = Math.round(r.top + r.height / 2);
      entry.rect = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    }
    return entry;
  },

  /**
   * Dump all form field current values — lets agent verify form state cheaply.
   * Returns array of { name, id, type, value, tag }.
   */
  getFormValues: function() {
    var results = [];
    var els = document.querySelectorAll('input, select, textarea');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.hasAttribute('data-wt-ignore')) continue;
      var val = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value;
      results.push({
        name: el.name || el.id || null,
        id: el.id || null,
        wtId: el.getAttribute('data-wt-id') || null,
        type: el.type || el.tagName.toLowerCase(),
        tag: el.tagName.toLowerCase(),
        value: val,
        placeholder: el.placeholder || null
      });
    }
    return results;
  },

  /**
   * Check visibility of a selector — uses the live IntersectionObserver data
   * maintained by the MutationObserver. Much faster than a full DOM query.
   * Returns { found, visible, occluded, x, y, rect } or null.
   */
  checkVisible: function(selector) {
    var el = document.querySelector(selector) || shadowQuery(selector);
    if (!el) return { found: false };
    var r = el.getBoundingClientRect();
    var vv = window.visualViewport || {};
    var vw = vv.width || window.innerWidth;
    var vh = vv.height || window.innerHeight;
    var inViewport = r.width > 0 && r.height > 0 && r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
    var topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    var occluded = topEl !== el && !el.contains(topEl);
    return {
      found: true,
      visible: inViewport,
      occluded: occluded,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
    };
  },

  /**
   * Return the live element index, optionally filtered.
   * filter: 'visible' | 'all' (default 'visible')
   * Much faster than browser_map for simple lookups.
   */
  getLiveIndex: function(filter) {
    var idx = window.__wt_liveIndex || [];
    if (filter === 'all') return idx;
    // Default: visible viewport only
    return idx.filter(function(e) { return e.viewport === 'visible' || e.isVisible; });
  },

  /**
   * Pop and return the next user feedback message from the queue.
   * MCP calls this between tool calls to check for user interrupts.
   * Returns { text, ts, tabId } or null if queue is empty.
   * Non-destructive — call popUserFeedback() to consume, peekUserFeedback() to inspect.
   */
  popUserFeedback: function() {
    // Read from localStorage queue (written by submitFeedback + persisted by background)
    try {
      var raw = localStorage.getItem('__wt_chat_queue_persist');
      if (!raw) return null;
      var arr = JSON.parse(raw);
      if (!arr || !arr.length) return null;
      var item = arr.shift();
      localStorage.setItem('__wt_chat_queue_persist', JSON.stringify(arr));
      return item;
    } catch(e) { return null; }
  },

  /**
   * Check if a blocking dialog (alert/confirm/prompt) is pending on this tab.
   * Agent should check this before clicking if it suspects a dialog might block.
   * Returns { pending: bool, ts: number } — reads from extension storage via background relay.
   */
  getAlertState: function() {
    // Sync check via a DOM marker set by alert wrapper
    return { pending: !!(window.__wt_alertPending), ts: Date.now() };
  },
};
window.__Weavetab_shadowQuery = shadowQuery;

function isOccluded(el) {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const topEl = document.elementFromPoint(cx, cy);
  return topEl !== el && !el.contains(topEl);
}

window.__Weavetab_getCoords = function(selector) {
  const el = document.querySelector(selector) || shadowQuery(selector);

  if (!el) return null;

  const rect = el.getBoundingClientRect();
  const vv = window.visualViewport;

  return {
    x: rect.left + rect.width / 2 + vv.offsetLeft,
    y: rect.top  + rect.height / 2 + vv.offsetTop,
    raw: { left: rect.left, top: rect.top, w: rect.width, h: rect.height },
    occluded: isOccluded(el),
    visible: rect.width > 0 && rect.height > 0
              && rect.top < vv.height && rect.bottom > 0
  };
};

function getStableSelector(el) {
  if (el.id) return `#${el.id}`;
  const path = [];
  while (el.parentNode) {
    let index = 1;
    let sibling = el.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === el.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    path.unshift(`${el.tagName.toLowerCase()}:nth-of-type(${index})`);
    el = el.parentNode;
  }
  return path.join(' > ');
}

window.__Weavetab_fullMap = function() {
  const map = [];
  let idCounter = 1;
  function crawl(root, depth = 0) {
    for (const el of root.querySelectorAll(
      'a,button,input,select,textarea,[role],[onclick],[tabindex]'
    )) {
      if (el.hasAttribute('data-wt-ignore')) continue;
      const rect = el.getBoundingClientRect();
      // Always include form elements (input/textarea/select/button) regardless of rect size
      // — canvas-heavy pages can occlude them and getBoundingClientRect returns 0
      const isEssential = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName);
      if (rect.width === 0 && !isEssential) continue;
      let id = el.getAttribute('data-wt-id');
      if (!id) {
        id = String(idCounter++);
        el.setAttribute('data-wt-id', id);
      }
      map.push({
        id: id,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0,80),
        role: el.getAttribute('role'),
        selector: `[data-wt-id="${id}"]`,
        coords: { x: rect.left + rect.width/2, y: rect.top + rect.height/2 },
        inShadow: depth > 0
      });
      if (el.shadowRoot) crawl(el.shadowRoot, depth + 1);
    }
  }
  crawl(document);
  return map;
};

// ── CONSOLE BUFFERING ───────────────────────────────────────────
const __consoleBuffer = [];
let __consoleCursor = 0;

['log','warn','error','info','debug'].forEach(level => {
  const orig = console[level];
  console[level] = (...args) => {
    __consoleBuffer.push({ level, time: Date.now(), text: args.join(' ') });
    orig.apply(console, args);
  };
});

window.__Weavetab_readConsole = function({ since = 'last', level = null } = {}) {
  const from = since === 'last' ? __consoleCursor : 0;
  const entries = __consoleBuffer.slice(from);
  __consoleCursor = __consoleBuffer.length;
  return level ? entries.filter(e => e.level === level) : entries;
};

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
    this._startLoop();
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
  }

  setVisible(visible) {
    if (typeof __wt_masterVisualsEnabled !== 'undefined' && !__wt_masterVisualsEnabled) {
      this._visible = false;
      this._cursor.style.opacity = '0';
      return;
    }
    this._visible = visible;
    this._cursor.style.opacity = visible ? '1' : '0';
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

        this._render();
      }

      this._animFrame = requestAnimationFrame(draw);
    };
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    this._animFrame = requestAnimationFrame(draw);
  }

  _render() {
    if (typeof __wt_masterVisualsEnabled !== 'undefined' && !__wt_masterVisualsEnabled) {
      this._cursor.style.opacity = '0';
      return;
    }
    const x = this._lerpX;
    const y = this._lerpY;
    if (x === -9999 || y === -9999) return;
    this._cursor.style.transform = `translate3d(${x - this._hotX}px, ${y - this._hotY}px, 0) scale(${this._scale})`;
  }
}

// Instantiate the active cursor
let __weaveCursor = new WeaveCursor();
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


// Click ripple (kept as page-level effect, not inside shadow DOM)
function ripple(x, y) {
  if (typeof __wt_masterVisualsEnabled !== 'undefined' && !__wt_masterVisualsEnabled) return;
  const el = document.createElement('div');
  el.className = 'Weavetab-ripple';
  el.setAttribute('data-wt-ignore', '');
  el.style.cssText = `position:fixed;left:${x}px;top:${y}px;pointer-events:none;z-index:2147483646`;
  getWeavetabRoot().appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// ── X-RAY SPOTLIGHT OVERLAY (Phase 5.2) ────────────────────────
// Flashes glowing halos around top interactive elements when the
// semantic map is scanned (GET_SEMANTIC_MAP message).
let __xrayActive = false;
const __xrayOverlays = [];

function clearXRay() {
  for (const el of __xrayOverlays) el.remove();
  __xrayOverlays.length = 0;
  __xrayActive = false;
}

function activateXRay(elements) {
  clearXRay();
  __xrayActive = true;

  // Colour spectrum for visual richness
  const colours = [
    '#4F8EF7', '#7C3AED', '#10B981', '#F59E0B',
    '#EF4444', '#06B6D4', '#F97316', '#8B5CF6',
  ];

  // Architecture change: Use live index for visual overlay
  // The live index maintains up-to-date coordinates and visibility info
  const liveIndex = window.__wt_liveIndex || [];
  const top = elements.slice(0, 12); // highlight top 12 nodes
  
  top.forEach((item, i) => {
    // Try to get element from live index first for accurate coordinates
    const liveEntry = liveIndex.find(e => e.id === item.id || e.selector === item.selector);
    
    let rect;
    let el;
    
    if (liveEntry && liveEntry.rect) {
      // Use coordinates from live index (more accurate, already computed)
      rect = liveEntry.rect;
      el = document.querySelector(item.selector) || shadowQuery(item.selector);
    } else {
      // Fallback to querying DOM
      el = document.querySelector(item.selector) || shadowQuery(item.selector);
      if (!el) return;
      rect = el.getBoundingClientRect();
    }
    
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

// ── READING GLOW ────────────────────────────────────────────────
let __wt_readingGlow = null;

function __wt_showReadingGlow() {
  if (__wt_readingGlow) return;
  var el = document.createElement('div');
  el.id = 'wt-reading-glow';
  el.setAttribute('data-wt-ignore', '');
  el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;border:4px solid;border-image:linear-gradient(135deg, #3b82f6, #8b5cf6, #10b981) 1;animation:wt-reading-pulse 3.5s ease-in-out forwards;';
  __wt_safeAppendToBody(el);
  __wt_readingGlow = el;
  setTimeout(__wt_hideReadingGlow, 3500);
}

function __wt_hideReadingGlow() {
  if (__wt_readingGlow) { __wt_readingGlow.remove(); __wt_readingGlow = null; }
}

// ── SEMANTIC DOM MAP ────────────────────────────────────────────
// Architecture change: Passive/extension-side ID assignment with live index
// The MutationObserver continuously assigns data-wt-id to interactive elements
// and maintains a live index that CDP can read lazily

// Live index - always up-to-date, accessible via window.__wt_liveIndex
window.__wt_liveIndex = [];
window.__wt_nextId = 1;

// IntersectionObserver for real occlusion detection (not just display:none)
const intersectionObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const el = entry.target;
    const id = el.getAttribute('data-wt-id');
    if (id) {
      const indexEntry = window.__wt_liveIndex.find(e => e.id === id);
      if (indexEntry) {
        indexEntry.isVisible = entry.isIntersecting;
        indexEntry.intersectionRatio = entry.intersectionRatio;
      }
    }
  }
}, { threshold: [0, 0.25, 0.5, 0.75, 1.0] });

// Function to assign data-wt-id to an element and add to live index
function assignIdAndIndex(el) {
  if (el.hasAttribute('data-wt-ignore')) return;
  if (el.hasAttribute('data-wt-id')) return; // Already assigned

  const id = String(window.__wt_nextId++);
  el.setAttribute('data-wt-id', id);
  el.__wt_id = id;

  const rect = el.getBoundingClientRect();
  const inViewport = (
    rect.bottom > 0 && rect.right > 0 &&
    rect.top < window.innerHeight && rect.left < window.innerWidth
  );
  const viewportPos = inViewport ? "visible" : (rect.top >= window.innerHeight ? "below" : "above");

  // Check for event listeners
  const hasClickListener = el.onclick !== null || 
                           el.addEventListener !== undefined && 
                           (el._listeners?.click?.length > 0);

  const indexEntry = {
    id: id,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || el.tagName.toLowerCase(),
    label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 60) || '',
    placeholder: el.getAttribute('placeholder') || '',
    selector: getStableSelector(el),
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    viewport: viewportPos,
    href: el.href || null,
    isVisible: inViewport,
    intersectionRatio: inViewport ? 1.0 : 0.0,
    hasClickListener: hasClickListener,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  };

  window.__wt_liveIndex.push(indexEntry);

  // Observe for intersection changes
  try {
    intersectionObserver.observe(el);
  } catch (e) {
    // Element might not be observable
  }
}

// Function to update an existing entry in the live index
function updateIndexEntry(el) {
  const id = el.getAttribute('data-wt-id');
  if (!id) return;

  const indexEntry = window.__wt_liveIndex.find(e => e.id === id);
  if (!indexEntry) return;

  const rect = el.getBoundingClientRect();
  const inViewport = (
    rect.bottom > 0 && rect.right > 0 &&
    rect.top < window.innerHeight && rect.left < window.innerWidth
  );
  const viewportPos = inViewport ? "visible" : (rect.top >= window.innerHeight ? "below" : "above");

  indexEntry.x = Math.round(rect.left + rect.width / 2);
  indexEntry.y = Math.round(rect.top + rect.height / 2);
  indexEntry.viewport = viewportPos;
  indexEntry.isVisible = inViewport;
  indexEntry.rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  indexEntry.label = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 60) || '';
}

// Function to remove an entry from the live index
function removeIndexEntry(el) {
  const id = el.getAttribute('data-wt-id');
  if (!id) return;

  const index = window.__wt_liveIndex.findIndex(e => e.id === id);
  if (index !== -1) {
    window.__wt_liveIndex.splice(index, 1);
  }

  try {
    intersectionObserver.unobserve(el);
  } catch (e) {
    // Element might not be observable
  }
}

// MutationObserver for continuous ID assignment and index maintenance
const idAssignmentObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    // Handle added nodes
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        // Check if the node itself is interactive
        const interactiveSelector = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="searchbox"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])';
        if (node.matches && node.matches(interactiveSelector)) {
          assignIdAndIndex(node);
        }
        // Check descendants
        const descendants = node.querySelectorAll ? node.querySelectorAll(interactiveSelector) : [];
        for (const desc of descendants) {
          assignIdAndIndex(desc);
        }
      }
    }

    // Handle removed nodes
    for (const node of mutation.removedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.getAttribute && node.getAttribute('data-wt-id')) {
          removeIndexEntry(node);
        }
        const descendants = node.querySelectorAll ? node.querySelectorAll('[data-wt-id]') : [];
        for (const desc of descendants) {
          removeIndexEntry(desc);
        }
      }
    }

    // Handle attribute changes (position, visibility, etc.)
    if (mutation.type === 'attributes' && mutation.target.getAttribute) {
      const target = mutation.target;
      if (target.getAttribute('data-wt-id')) {
        updateIndexEntry(target);
      }
    }
  }
});

// Start observing when DOM is ready
function startIdAssignment() {
  const interactiveSelector = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="searchbox"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])';
  
  // Assign IDs to existing interactive elements
  const existing = document.querySelectorAll(interactiveSelector);
  for (const el of existing) {
    assignIdAndIndex(el);
  }

  // Start observing for changes
  if (document.body) {
    idAssignmentObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-hidden']
    });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      const existing = document.querySelectorAll(interactiveSelector);
      for (const el of existing) {
        assignIdAndIndex(el);
      }
      idAssignmentObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden', 'aria-hidden']
      });
    });
  }
}

// Start the ID assignment system
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startIdAssignment);
} else {
  startIdAssignment();
}

// Legacy buildSemanticMap function for backward compatibility
// Now reads from the live index instead of rebuilding
let cachedMap = null;
const legacyObserver = new MutationObserver(() => {
  cachedMap = null;
});
// FIX: document.body may be null at document_start; defer observe until body exists
if (document.body) {
  legacyObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
} else {
  document.addEventListener('DOMContentLoaded', function() {
    if (document.body) legacyObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  }, { once: true });
}

function buildSemanticMap() {
  if (cachedMap) return cachedMap;

  // Read from the live index maintained by the MutationObserver
  cachedMap = window.__wt_liveIndex.map(entry => ({
    id: entry.id,
    tag: entry.tag,
    role: entry.role,
    label: entry.label,
    placeholder: entry.placeholder,
    selector: entry.selector,
    x: entry.x,
    y: entry.y,
    viewport: entry.viewport,
    href: entry.href,
    coords: { x: entry.x, y: entry.y }
  }));

  return cachedMap;
}

// ── HUD ─────────────────────────────────────────────────────────
const hudHistory = [];
const hud = (() => {
  const el = document.createElement('div');
  el.id = 'Weavetab-hud';
  el.setAttribute('data-wt-ignore', '');
  Object.assign(el.style, {
    position: 'fixed', bottom: '24px', right: '24px',
    transform: 'translateY(8px)',
    color: '#a1a1aa',
    font: '11px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    borderRadius: '8px',
    opacity: '0', pointerEvents: 'none',
    zIndex: '2147483640',
    maxWidth: '400px',
    display: 'flex', flexDirection: 'column-reverse', gap: '4px',
    transition: 'opacity 0.2s, transform 0.2s',
    textAlign: 'right',
  });
  __wt_safeAppendToBody(el);
  return el;
})();

function updateHUD(action, detail) {
  if (window.self !== window.top) return;
  // Tool call entries display strictly inside the Sidepanel TOOL CALLS section.
  // Suppress on-page bottom-right HUD popup overlay.
  if (hud) {
    hud.style.display = 'none';
    hud.style.opacity = '0';
  }
}

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

const controlledIndicator = new ControlledTabIndicator();

// ── MESSAGE BRIDGE ──────────────────────────────────────────────
// Shared handler for both CustomEvent (MAIN world dispatch) and
// postMessage (cross-world: MAIN → ISOLATED) communication channels.
var __wt_lastCursor = { x: -9999, y: -9999 };
var __wt_processedMsgIds = new Set();

function __wt_handleWeavetabMsg(msg) {
  if (!msg) return;
  if (Array.isArray(msg)) { msg.forEach(m => __wt_handleWeavetabMsg(m)); return; }
  if (msg._id) { if (__wt_processedMsgIds.has(msg._id)) return; __wt_processedMsgIds.add(msg._id); if (__wt_processedMsgIds.size > 100) __wt_processedMsgIds.clear(); }

  if (msg.type === 'Weavetab_STATE') {
    if (msg.cursor) {
      __wt_lastCursor = { x: msg.cursor.x, y: msg.cursor.y };
      if (msg.cursor.waypoints && msg.cursor.duration_ms) {
        __weaveCursor.setWaypoints(msg.cursor.waypoints, msg.cursor.duration_ms);
      }
      moveCursor(msg.cursor.x, msg.cursor.y, msg.state);
    }
    else if (msg.state) { moveCursor(__wt_lastCursor.x, __wt_lastCursor.y, msg.state); }
    if (msg.ripple) ripple(msg.ripple.x, msg.ripple.y);

    if (msg.userFeedback === true && msg.feedbackText) {
      __wt_feedbackSticky = true;
      clearTimeout(window.__wt_feedbackStickyTimer);
      window.__wt_feedbackStickyTimer = setTimeout(function(){ __wt_feedbackSticky = false; }, 6000);
    } else if (msg.userFeedback === false) {
      setTimeout(function(){ __wt_feedbackSticky = false; }, 2000);
    }

    // stickyFeedback=true: fired by Weavetab_logs when agent answers a user question.
    // Pin the bubble for 10s so tool chatter (moving to..., typing...) cannot override it.
    if (msg.stickyFeedback === true && msg.hud && msg.hud.action) {
      __wt_thoughtQueue = [];
      clearTimeout(window.__wt_feedbackStickyTimer);

      if (msg.ask) {
        window.__wt_feedbackStickyTimer = setTimeout(function(){
          __wt_feedbackSticky = false;
          __wt_removeAsk();
        }, (msg.ask.timeout || 120) * 1000 + 2000);
        __wt_showQuestion(msg.hud.action, msg.ask.input || 'sentence', msg.ask.timeout || 120);
      } else {
        __wt_feedbackSticky = true;
        window.__wt_feedbackStickyTimer = setTimeout(function(){
          __wt_feedbackSticky = false;
          __wt_destroyBubble();
        }, 10000);
        __wt_renderThought(msg.hud.action, { active: false, sticky: true });
        if (msg.hud) updateHUD(msg.hud.action, msg.hud.detail);
      }
      if (msg.cursor) {
        __wt_lastCursor = { x: msg.cursor.x, y: msg.cursor.y };
        if (msg.cursor.waypoints && msg.cursor.duration_ms) {
          __weaveCursor.setWaypoints(msg.cursor.waypoints, msg.cursor.duration_ms);
        }
        moveCursor(msg.cursor.x, msg.cursor.y, msg.state);
      }
      else if (msg.state) { moveCursor(__wt_lastCursor.x, __wt_lastCursor.y, msg.state); }
      return;
    }

    if (msg.hud) {
      updateHUD(msg.hud.action, msg.hud.detail);
      var a = (msg.hud.action || '').trim();
      if (a === 'reading the page...') {
        __wt_showReadingGlow();
        __wt_showThought('Reading the page...', { active: true });
        __weaveCursor.setState('reading');
      } else if (a === 'Mission Running') {
        // Tool call is starting — switch to eval animation and show tool bubble
        __wt_toolActive = true;
        __weaveCursor.setState('eval');
        __wt_showThought('Executing tool...', { active: true });
      } else if (a.startsWith('[OK]')) {
        // Tool completed successfully — revert to idle and instantly hide bubble
        __weaveCursor.setState('idle');
        __wt_toolActive = false;
        if (!__wt_feedbackSticky) {
          __wt_destroyBubble(); // Instant removal
          __wt_processThoughtQueue();
        }
      } else if (a.startsWith('[ERR]')) {
        // Tool errored — show stuck cursor briefly
        __weaveCursor.setState('stuck');
        __wt_toolActive = false;
        setTimeout(function(){ __weaveCursor.setState('idle'); }, 3000);
        if (!__wt_feedbackSticky) {
          __wt_destroyBubble(); // Instant removal
          __wt_processThoughtQueue();
        }
      } else if (a && a.length > 3) {
        __wt_hideReadingGlow();
        if (!__wt_feedbackSticky) {
          __wt_showThought(a, { active: true });
        }
      } else {
        if (!__wt_feedbackSticky) {
          __wt_hideReadingGlow();
          __wt_destroyBubble(); // Instant removal
          __wt_processThoughtQueue();
        }
      }
    }
    if (msg.darkMode !== undefined) document.body.classList.toggle('Weavetab-dark', msg.darkMode);
    if (msg.cursor || msg.hud) {
      controlledIndicator.show('#3B82F6');
    }
  }

  // Handle plan updates via sendToExtension channel
  if (msg.type === 'Weavetab_STATE' && msg.plan) {
    const p = msg.plan;
    if (p.action === 'hide') {
      if (window.__wt_plan) window.__wt_plan('hide', '', []);
    } else {
      if (window.__wt_plan) window.__wt_plan(p.action || 'create', p.goal || '', p.tasks || []);
    }
  }


  if (msg.type === 'WT_USER_NOTE_INJECT') {
    window.__wt_user_notes = window.__wt_user_notes || [];
    window.__wt_user_notes.push({ text: msg.text, time: Date.now() });
  }

  if (msg.type === 'GET_SEMANTIC_MAP') {
    const map = window.__Weavetab_fullMap();
    if (window.__wt_user_notes && window.__wt_user_notes.length > 0) {
      // Keep notes for 2 minutes
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

  if (msg.type === 'RESOLVE_EXTENSION_URL') {
    var url = '';
    try { url = browserAPI.runtime.getURL((msg.page || 'dashboard') + '.html'); } catch(e) {}
    window.dispatchEvent(new CustomEvent('Weavetab-msg-out', { detail: { id: msg.id, data: url } }));
  }

  if (msg.type === 'Weavetab_CONFIG') {
    window.__wt_devMode = !!msg.devMode;
    window.dispatchEvent(new CustomEvent('wt-config-sync'));
    __wt_safeSendMessage(msg);
  }

  if (msg.type === 'Weavetab_GROUP_STATE') {
    __wt_safeSendMessage(msg);
    // Only ever blue dot — no yellow. Idle state = no dot.
    const dotColor = (msg.state === 'idle') ? null : '#3B82F6';
    if (dotColor) {
      controlledIndicator.show(dotColor);
    }
    updateFaviconDot(msg.state, msg.isActive);
    // Parked tabs: clear thought bubble and reading glow
    if (msg.isActive === false) {
      __wt_removeThought();
      __wt_hideReadingGlow();
    }
    if (msg.state === 'idle') {
      __wt_hideReadingGlow();
      __wt_destroyBubble();
      __wt_feedbackSticky = false;
      __wt_processThoughtQueue();
      restoreOriginalFavicon();
      // Hide the persistent indicator bar when idle
      controlledIndicator.hide();
      __weaveCursor.setState('idle');
    } else if (msg.state === 'weaving') {
      // Show persistent blue bar while agent works
      controlledIndicator.showPersistent('#3B82F6');
      __weaveCursor.setState('eval');
    } else if (msg.state === 'stuck') {
      // Still show blue bar (not red) when stuck
      controlledIndicator.showPersistent('#3B82F6');
      __weaveCursor.setState('stuck');
    }
  }


  if (msg.type === 'Weavetab_THOUGHT') {
    __wt_showThought(msg.text, { active: msg.active });
  }

  if (msg.type === 'Weavetab_ASK') {
    // Legacy support — route to new unified question system
    console.log('[Weavetab] Received ASK request (legacy):', msg.question);
    __wt_showQuestion(msg.question, 'sentence', msg.timeout || 120);
    window.dispatchEvent(new CustomEvent('Weavetab-msg-out', { detail: { id: msg.id, data: { status: 'shown' } } }));
  }

  if (msg.type === 'Weavetab_CLEAR_THOUGHT') {
    __wt_removeThought();
    __wt_hideReadingGlow();
    __wt_processThoughtQueue();
  }

  if (msg.type === 'Weavetab_RELOAD_EXTENSION') {
    __wt_safeSendMessage({ type: 'RELOAD_EXTENSION' });
  }
}

// Channel 1: CustomEvent from MAIN world (used by fallback + sendToExtension)
window.addEventListener('Weavetab-msg-in', (e) => {
  __wt_handleWeavetabMsg(e.detail);
});

// Channel 2: postMessage from MAIN world (cross-world MV3 bridge)
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'Weavetab-msg-in' && event.data.data) {
    __wt_handleWeavetabMsg(event.data.data);
  }
  // ── User feedback relay: WeaveTab OS panel → background storage queue ────
  // When the user types in the chat panel and hits Send, submitFeedback() fires
  // a __WT_FEEDBACK postMessage. We relay it to the background so it lands in
  // chrome.storage.local and window.__Weavetab.popUserFeedback() can return it.
  if (event.data && event.data.type === '__WT_FEEDBACK' && event.data.text) {
    try {
      if (browserAPI.runtime && browserAPI.runtime.id) {
        browserAPI.runtime.sendMessage({ type: 'USER_FEEDBACK', text: event.data.text }).catch(function(){});
      }
    } catch(e) {}
  }
});

// ── FAVICON STATUS DOT INDICATOR ───────────────────────────────
let wtFaviconObserver = null;

let __wt_faviconStaleTimer = null;

function updateFaviconDot(state, isActive) {
  if (__wt_faviconStaleTimer) { clearTimeout(__wt_faviconStaleTimer); __wt_faviconStaleTimer = null; }

  if (state === 'idle' || !state || isActive === false) {
    if (wtFaviconObserver) {
      wtFaviconObserver.disconnect();
      wtFaviconObserver = null;
    }
    restoreOriginalFavicon();
    return;
  }

  // Always use blue — never red or yellow for favicon dot
  const color = '#3B82F6';

  if (!wtFaviconObserver) {
    wtFaviconObserver = new MutationObserver(() => {
      wtFaviconObserver.disconnect();
      applyFaviconDot(color);
      wtFaviconObserver.observe(document.head, { childList: true, subtree: true });
    });
  } else {
    wtFaviconObserver.disconnect();
  }

  applyFaviconDot(color);
  wtFaviconObserver.observe(document.head, { childList: true, subtree: true });

  // Set stale timer: clear dot + hide glow if no message for 30s
  __wt_faviconStaleTimer = setTimeout(function() {
    restoreOriginalFavicon();
    __wt_hideReadingGlow();
    __wt_destroyBubble();
  }, 30000);
}

function restoreOriginalFavicon() {
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
  ctx.arc(16, 16, 11, 0, 2 * Math.PI);
  ctx.fillStyle = '#1E1F22';
  ctx.fill();
  ctx.strokeStyle = '#3C3F45';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(16, 16, 6, 0, 2 * Math.PI);
  ctx.fillStyle = '#7C3AED';
  ctx.fill();

  drawDot(ctx, color);
}

function setFaviconHref(dataUrl) {
  let customLink = document.getElementById('wt-custom-favicon');
  if (!customLink) {
    customLink = document.createElement('link');
    customLink.id = 'wt-custom-favicon';
    customLink.rel = 'icon';
    customLink.type = 'image/png';
    (document.head || document.documentElement).appendChild(customLink);
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
}



// ── PERSISTENT MESSAGING PANEL (WeaveTab OS v2.5.0) ───────────────
// Design inspired by designs/elements.html
(function initWeaveTabUI() {
  if (window.self !== window.top) return;
  if (document.getElementById('wt-main-container')) return;

  const version = "2.5.0";
  const isBeta = true; 

  // ── CSS Injection ─────────────────────────────────────────────
  const style = document.createElement('style');
  style.id = 'wt-ui-styles';
  style.textContent = `
    /* ── Sidepanel Tokens ────────────────────────────────────── */
    :host, .wt-sp-root { all: initial; }
    .wt-sp-root, .wt-sp-root * { box-sizing: border-box; margin: 0; padding: 0; }

    .wt-sp-root {
      --sp-bg: #ffffff;
      --sp-bg-panel: #f9f9fb;
      --sp-bg-item: #f4f4f5;
      --sp-bg-hover: #e8e8ec;
      --sp-border: #e4e4e7;
      --sp-border-hi: #d4d4d8;
      --sp-text: #18181b;
      --sp-text-secondary: #52525b;
      --sp-text-muted: #a1a1aa;
      --sp-blue: #3b82f6;
      --sp-blue-light: #60a5fa;
      --sp-green: #16a34a;
      --sp-green-bg: #f0fdf4;
      --sp-red: #ef4444;
      --sp-red-bg: #fef2f2;
      --sp-yellow: #f59e0b;
      --sp-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.06);
      --sp-font: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
      --sp-font-mono: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
    }

    .wt-sp-root[data-theme='dark'] {
      --sp-bg: #09090b;
      --sp-bg-panel: #111113;
      --sp-bg-item: #1c1c1f;
      --sp-bg-hover: #27272a;
      --sp-border: #27272a;
      --sp-border-hi: #3f3f46;
      --sp-text: #fafafa;
      --sp-text-secondary: #a1a1aa;
      --sp-text-muted: #52525b;
      --sp-green-bg: #052e16;
      --sp-red-bg: #450a0a;
      --sp-shadow: 0 1px 3px rgba(0,0,0,0.4), 0 4px 12px rgba(0,0,0,0.3);
    }

    /* ── Panel Shell ─────────────────────────────────────────── */
    .wt-sp-root {
      position: fixed;
      top: 0; bottom: 0; right: 0;
      width: 360px;
      display: none !important;
      flex-direction: column;
      background: var(--sp-bg);
      border-left: 1px solid var(--sp-border);
      z-index: 2147483646;
      pointer-events: auto;
      font-family: var(--sp-font);
      color: var(--sp-text);

      transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1);
      overflow: hidden;
    }

    .wt-sp-root.minimized {
      transform: translateX(100%);
      pointer-events: none;
    }

    /* ── Header ──────────────────────────────────────────────── */
    .wt-sp-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      border-bottom: 1px solid var(--sp-border);
      flex-shrink: 0;
      -webkit-app-region: drag;
    }

    .wt-sp-brand {
      font-size: 13px;
      font-weight: 600;
      color: var(--sp-text);
      letter-spacing: -0.01em;
    }

    .wt-sp-controls {
      display: flex;
      align-items: center;
      gap: 2px;
      -webkit-app-region: no-drag;
    }

    .wt-sp-ctrl-btn {
      width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      background: transparent;
      border: none;
      border-radius: 6px;
      color: var(--sp-text-muted);
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      font-size: 14px;
    }
    .wt-sp-ctrl-btn:hover { background: var(--sp-bg-hover); color: var(--sp-text); }

    /* ── Badge Row ───────────────────────────────────────────── */
    .wt-sp-badges {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-bottom: 1px solid var(--sp-border);
      flex-shrink: 0;
    }

    .wt-sp-badge {
      font-size: 9px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .wt-sp-badge-dev { background: var(--sp-blue); color: #fff; }
    .wt-sp-badge-beta { background: var(--sp-yellow); color: #fff; }

    /* ── Body (scrollable) ───────────────────────────────────── */
    .wt-sp-body {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }

    .wt-sp-body::-webkit-scrollbar { width: 5px; }
    .wt-sp-body::-webkit-scrollbar-track { background: transparent; }
    .wt-sp-body::-webkit-scrollbar-thumb { background: var(--sp-border-hi); border-radius: 3px; }

    /* ── Section ─────────────────────────────────────────────── */
    .wt-sp-section {
      border-bottom: 1px solid var(--sp-border);
    }

    .wt-sp-section-hdr {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      font-size: 11px;
      font-weight: 600;
      color: var(--sp-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      cursor: pointer;
      user-select: none;
      transition: color 0.15s;
    }
    .wt-sp-section-hdr:hover { color: var(--sp-text); }

    .wt-sp-chevron {
      font-size: 10px;
      transition: transform 0.2s ease;
      display: inline-block;
      color: var(--sp-text-muted);
    }
    .wt-sp-section.closed .wt-sp-chevron { transform: rotate(-90deg); }

    .wt-sp-section-body {
      overflow: hidden;
      transition: max-height 0.25s cubic-bezier(0.32, 0.72, 0, 1);
      max-height: 500px;
    }
    .wt-sp-section.closed .wt-sp-section-body { max-height: 0; }

    .wt-sp-section-grow { flex: 1; display: flex; flex-direction: column; }
    .wt-sp-section-grow .wt-sp-section-body { flex: 1; overflow-y: auto; max-height: none; }

    /* ── Tasks ────────────────────────────────────────────────── */
    .wt-sp-tasks {
      display: flex;
      flex-direction: column;
      padding: 0 14px 10px;
      gap: 2px;
    }

    .wt-sp-task {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.4;
      cursor: pointer;
      transition: background 0.15s;
    }
    .wt-sp-task:hover { background: var(--sp-bg-hover); }

    .wt-sp-task.done { color: var(--sp-green); }
    .wt-sp-task.active { color: var(--sp-text); background: var(--sp-bg-item); border-left: 2px solid var(--sp-blue); padding-left: 6px; }
    .wt-sp-task.pending { color: var(--sp-text-muted); }

    .wt-sp-task-icon { flex-shrink: 0; width: 16px; text-align: center; font-size: 11px; margin-top: 1px; }
    .wt-sp-task.done .wt-sp-task-icon { color: var(--sp-green); }
    .wt-sp-task.active .wt-sp-task-icon { color: var(--sp-blue); }

    .wt-sp-task-desc { flex: 1; word-break: break-word; }
    .wt-sp-task.done .wt-sp-task-desc { text-decoration: line-through; opacity: 0.7; }

    .wt-sp-task-empty {
      font-size: 11px;
      color: var(--sp-text-muted);
      padding: 8px;
      text-align: center;
    }

    /* ── Activity Log ────────────────────────────────────────── */
    .wt-sp-log {
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: 0 14px 10px;
      font-family: var(--sp-font-mono);
    }

    .wt-sp-log-entry {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 5px 8px;
      border-radius: 4px;
      font-size: 11px;
      line-height: 1.4;
      transition: background 0.1s;
    }
    .wt-sp-log-entry:hover { background: var(--sp-bg-hover); }

    .wt-sp-log-icon { flex-shrink: 0; width: 14px; text-align: center; margin-top: 1px; font-size: 10px; }
    .wt-sp-log-icon.running { color: var(--sp-blue); }
    .wt-sp-log-icon.done { color: var(--sp-green); }
    .wt-sp-log-icon.error { color: var(--sp-red); }

    .wt-sp-log-name {
      font-weight: 500;
      color: var(--sp-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 140px;
    }

    .wt-sp-log-badge {
      font-size: 9px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      flex-shrink: 0;
    }
    .wt-sp-log-badge.running { background: rgba(59,130,246,0.12); color: var(--sp-blue); }
    .wt-sp-log-badge.done { background: rgba(22,163,74,0.12); color: var(--sp-green); }
    .wt-sp-log-badge.error { background: rgba(239,68,68,0.12); color: var(--sp-red); }
    .wt-sp-log-badge.info { background: var(--sp-bg-item); color: var(--sp-text-muted); }

    .wt-sp-log-time {
      font-size: 10px;
      color: var(--sp-text-muted);
      margin-left: auto;
      flex-shrink: 0;
    }

    .wt-sp-log-empty {
      font-size: 11px;
      color: var(--sp-text-muted);
      padding: 8px;
      text-align: center;
      font-family: var(--sp-font);
    }

    /* ── Chat ─────────────────────────────────────────────────── */
    .wt-sp-chat {
      padding: 10px 14px;
      border-top: 1px solid var(--sp-border);
      flex-shrink: 0;
    }

    .wt-sp-chat-row {
      display: flex;
      gap: 6px;
      align-items: flex-end;
    }

    .wt-sp-chat-input {
      flex: 1;
      padding: 8px 12px;
      background: var(--sp-bg-item);
      border: 1px solid var(--sp-border);
      border-radius: 8px;
      color: var(--sp-text);
      font-family: var(--sp-font);
      font-size: 12px;
      outline: none;
      resize: none;
      min-height: 36px;
      max-height: 100px;
      transition: border-color 0.15s;
      line-height: 1.4;
    }
    .wt-sp-chat-input::placeholder { color: var(--sp-text-muted); }
    .wt-sp-chat-input:focus { border-color: var(--sp-blue); }

    .wt-sp-send-btn {
      width: 36px; height: 36px;
      display: flex; align-items: center; justify-content: center;
      background: var(--sp-blue);
      border: none;
      border-radius: 8px;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.15s, transform 0.1s;
    }
    .wt-sp-send-btn:hover { background: #2563eb; }
    .wt-sp-send-btn:active { transform: scale(0.95); }
    .wt-sp-send-btn.sent { background: var(--sp-green); }
    .wt-sp-send-btn svg { width: 16px; height: 16px; stroke: #fff; fill: none; }

    /* ── Debug Section ───────────────────────────────────────── */
    .wt-sp-debug-area {
      padding: 0 14px 10px;
      position: relative;
      min-height: 200px;
    }

    .wt-sp-f3-btn {
      margin-left: auto;
      font-size: 9px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--sp-bg-item);
      border: 1px solid var(--sp-border);
      color: var(--sp-text-muted);
      cursor: pointer;
      text-transform: uppercase;
      transition: all 0.15s;
    }
    .wt-sp-f3-btn:hover { color: var(--sp-text); border-color: var(--sp-border-hi); }

    /* ── System Icon (minimized state) ───────────────────────── */
    #wt-system-icon {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 40px;
      height: 40px;
      background: var(--sp-bg);
      border: 1px solid var(--sp-border);
      border-radius: 10px;
      display: none;
      justify-content: center;
      align-items: center;
      cursor: pointer;
      z-index: 2147483640;
      box-shadow: var(--sp-shadow);
      transition: background 0.15s, transform 0.15s;
      pointer-events: auto;
    }
    #wt-system-icon:hover { background: var(--sp-bg-hover); transform: scale(1.05); }
    #wt-system-icon svg { width: 18px; height: 18px; fill: var(--sp-text-muted); }

    /* ── Utilities ────────────────────────────────────────────── */
    .wt-sp-root .hidden, .wt-sp-root.hidden, .wt-hidden { display: none !important; }

    @keyframes wt-sp-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .wt-sp-spinner {
      display: inline-block;
      width: 10px; height: 10px;
      border: 1.5px solid var(--sp-border-hi);
      border-top-color: var(--sp-blue);
      border-radius: 50%;
      animation: wt-sp-spin 0.8s linear infinite;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  // ── HTML Construction ─────────────────────────────────────────
  const container = document.createElement('div');
  container.id = 'wt-main-container';
  container.className = 'wt-sp-root';
  container.setAttribute('data-wt-ignore', 'true');
  container.setAttribute('data-theme', 'dark');
  
  container.innerHTML = `
    <div class="wt-sp-header">
      <span class="wt-sp-brand">Weavetab</span>
      <div class="wt-sp-controls">
        <button class="wt-sp-ctrl-btn" id="wt-theme-toggle" title="Toggle theme">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        </button>
        <button class="wt-sp-ctrl-btn" id="wt-minimize-btn" title="Minimize">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>
        </button>
      </div>
    </div>
    <div class="wt-sp-badges">
      <span class="wt-sp-badge wt-sp-badge-dev hidden" id="wt-badge-dev">DEV</span>
      ${isBeta ? '<span class="wt-sp-badge wt-sp-badge-beta">BETA</span>' : ''}
    </div>
    <div class="wt-sp-body">
      <div class="wt-sp-section" id="wt-sec-tasks">
        <div class="wt-sp-section-hdr" id="wt-header-tasks">
          <span class="wt-sp-chevron">›</span>
          <span>Tasks</span>
        </div>
        <div class="wt-sp-section-body">
          <div class="wt-sp-tasks" id="wt-todo-list">
            <div class="wt-sp-task-empty">No active mission</div>
          </div>
        </div>
      </div>

      <div class="wt-sp-section wt-sp-section-grow" id="wt-sec-logs">
        <div class="wt-sp-section-hdr" id="wt-header-logs">
          <span class="wt-sp-chevron">›</span>
          <span>Activity</span>
        </div>
        <div class="wt-sp-section-body">
          <div class="wt-sp-log" id="wt-log-container">
            <div class="wt-sp-log-empty">Waiting for activity...</div>
          </div>
        </div>
      </div>

      <div class="wt-sp-section closed" id="wt-sec-debug">
        <div class="wt-sp-section-hdr" id="wt-header-debug">
          <span class="wt-sp-chevron">›</span>
          <span>Debug</span>
        </div>
        <div class="wt-sp-section-body">
          <div class="wt-sp-debug-area" id="wt-debug-content-area"></div>
        </div>
      </div>
    </div>

    <div class="wt-sp-chat">
      <div class="wt-sp-chat-row">
        <textarea class="wt-sp-chat-input" id="wt-msg-input" placeholder="Send feedback..." rows="1"></textarea>
        <button class="wt-sp-send-btn" id="wt-send-btn">
          <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
        </button>
      </div>
    </div>
  `;
  __wt_safeAppendToBody(container);

  const systemIcon = document.createElement('div');
  systemIcon.id = 'wt-system-icon';
  systemIcon.title = 'Open Weavetab';
  systemIcon.innerHTML = `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 4h16v16H4V4zm2 2v12h12V6H6zm2 3h3v2H8V9zm4 4h4v2h-4v-2z" />
    </svg>
  `;
  __wt_safeAppendToBody(systemIcon);

  // ── PERSISTENT ACTIVITY LOG ──────────────────────────────────
  // Logs never clear until browser close — append-only like Claude Chrome
  window.__wt_logEntries = [];
  const logContainer = document.getElementById('wt-log-container');

  function __wt_addLogEntry(name, status, detail) {
    const entry = {
      name: name || 'unknown',
      status: status || 'info',
      detail: detail || '',
      time: Date.now()
    };
    window.__wt_logEntries.push(entry);
    __wt_renderLogEntry(entry);
    // Auto-scroll to bottom
    if (logContainer) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }

  function __wt_renderLogEntry(entry) {
    if (!logContainer) return;
    // Remove empty placeholder on first real entry
    const empty = logContainer.querySelector('.wt-sp-log-empty');
    if (empty) empty.remove();

    const el = document.createElement('div');
    el.className = 'wt-sp-log-entry';

    const iconClass = entry.status === 'done' ? 'done' : entry.status === 'error' ? 'error' : entry.status === 'running' ? 'running' : '';
    const icon = entry.status === 'running' ? '<span class="wt-sp-spinner"></span>'
      : entry.status === 'done' ? '&#10003;'
      : entry.status === 'error' ? '&#10007;'
      : '&#9679;';

    const badge = entry.status === 'running' ? 'RUNNING'
      : entry.status === 'done' ? 'OK'
      : entry.status === 'error' ? 'ERR'
      : '';

    const timeStr = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    el.innerHTML = `
      <span class="wt-sp-log-icon ${iconClass}">${icon}</span>
      <span class="wt-sp-log-name">${__wt_escapeHtml(entry.name)}</span>
      ${badge ? `<span class="wt-sp-log-badge ${entry.status}">${badge}</span>` : ''}
      <span class="wt-sp-log-time">${timeStr}</span>
    `;

    if (entry.detail) {
      const detailEl = document.createElement('div');
      detailEl.style.cssText = 'width:100%;font-size:10px;color:var(--sp-text-muted);white-space:pre-wrap;word-break:break-all;margin-top:2px;';
      detailEl.textContent = entry.detail;
      el.appendChild(detailEl);
    }

    logContainer.appendChild(el);
  }

  function __wt_escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── THEME SYSTEM ──────────────────────────────────────────────
  function __wt_applyTheme(theme) {
    container.setAttribute('data-theme', theme);
    document.getElementById('wt-system-icon') && document.getElementById('wt-system-icon').setAttribute('data-theme', theme);
    try { browserAPI.storage.local.set({ wt_theme: theme }); } catch(e) {}
  }

  function __wt_toggleTheme() {
    const current = container.getAttribute('data-theme');
    __wt_applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  // Restore persisted theme
  try {
    browserAPI.storage.local.get(['wt_theme'], function(res) {
      if (res.wt_theme) {
        __wt_applyTheme(res.wt_theme);
      }
    });
  } catch(e) {}



  // ── HUD STATUS INTERCEPTION (for activity log) ────────────────
  // Capture Weavetab_STATE hud updates and add to log
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'Weavetab-msg-in' && e.data.data && e.data.data.type === 'Weavetab_STATE' && e.data.data.hud) {
      const hud = e.data.data.hud;
      if (hud.action && hud.action.length > 2) {
        __wt_addLogEntry(hud.action, 'info', hud.detail || '');
      }
    }
  });



  // ── Panel State Persistence ────────────────────────────────────
  // Sidepanel always opens on browser launch (background clears state on startup).
  // Persists minimized state across page navigations within a session.
  function minimizePanel() {
      container.classList.add('minimized');
      systemIcon.style.display = 'flex';
      try { browserAPI.storage.local.set({ wt_panel_minimized: true }); } catch(e) {}
  }

  function restorePanel() {
      systemIcon.style.display = 'none';
      container.classList.remove('minimized');
      try { browserAPI.storage.local.set({ wt_panel_minimized: false }); } catch(e) {}
  }

  // Restore minimized state from storage (respects user's last action)
  try {
      browserAPI.storage.local.get(['wt_panel_minimized'], function(res) {
          if (res.wt_panel_minimized) {
              container.classList.add('minimized');
              systemIcon.style.display = 'flex';
          }
      });
  } catch(e) {}

  function toggleSection(id) {
      document.getElementById(id).classList.toggle('closed');
  }



  function syncDevMode() {
      const active = !!window.__wt_devMode;
      const devBadge = document.getElementById('wt-badge-dev');
      
      if (devBadge) devBadge.classList.toggle('hidden', !active);
  }

  window.addEventListener('wt-config-sync', syncDevMode);

  container.querySelector('#wt-minimize-btn').onclick = minimizePanel;
  systemIcon.onclick = restorePanel;
  container.querySelector('#wt-theme-toggle').onclick = __wt_toggleTheme;
  container.querySelector('#wt-header-tasks').onclick = () => toggleSection('wt-sec-tasks');
  container.querySelector('#wt-header-logs').onclick = () => toggleSection('wt-sec-logs');
  container.querySelector('#wt-header-debug').onclick = () => toggleSection('wt-sec-debug');

  
  syncDevMode();

  const msgInput = container.querySelector('#wt-msg-input');
  const sendBtn = container.querySelector('#wt-send-btn');

  // Auto-resize textarea
  msgInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  });

  // ── Plan Rendering Integration ───────────────────────────────
  function renderPlan(action, goal, tasks) {
      const list = document.getElementById('wt-todo-list');
      if (!list) return;

      if (action === 'hide' || (!goal && (!tasks || tasks.length === 0))) {
          list.innerHTML = '<div class="wt-sp-task-empty">No active mission</div>';
          return;
      }

      list.innerHTML = '';
      if (goal) {
          const goalEl = document.createElement('div');
          goalEl.className = 'wt-sp-task active';
          goalEl.style.cssText = 'margin-bottom:4px;font-weight:500;';
          goalEl.innerHTML = '<span class="wt-sp-task-icon">&#9654;</span><span class="wt-sp-task-desc">' + __wt_escapeHtml(goal) + '</span>';
          list.appendChild(goalEl);
      }
      if (tasks && tasks.length > 0) {
          tasks.forEach(task => {
              const item = document.createElement('div');
              const statusClass = task.status === 'done' ? 'done' : (task.status === 'in-progress' ? 'active' : 'pending');
              const icon = task.status === 'done' ? '&#10003;' : (task.status === 'in-progress' ? '<span class="wt-sp-spinner"></span>' : '&#9675;');
              
              item.className = 'wt-sp-task ' + statusClass;
              item.setAttribute('data-task-id', task.id);
              item.innerHTML = '<span class="wt-sp-task-icon">' + icon + '</span><span class="wt-sp-task-desc">' + __wt_escapeHtml(task.description) + '</span>';

              list.appendChild(item);
          });
      }

      // Log the plan update
      __wt_addLogEntry('Plan updated', 'info', (tasks ? tasks.length : 0) + ' tasks');
  }

  window.__wt_plan = renderPlan;

  window.addEventListener('message', (e) => {
      if (e.data && e.data.type === '__WT_PLAN') {
          renderPlan(e.data.action, e.data.goal, e.data.tasks);
      }
      syncDevMode();
  });

  setInterval(syncDevMode, 2000);

  try {
      browserAPI.storage.local.get(['wt_plan_collapsed'], function(res) {});
  } catch(e) {}

  // Persist draft
  msgInput.addEventListener('input', function() {
    try { browserAPI.storage.local.set({ wt_chat_draft: msgInput.value }); } catch(e) {}
  });

  // Submit
  function submitFeedback() {
    var text = msgInput.value.trim();
    if (!text) return;

    window.postMessage({
      type: '__WT_FEEDBACK',
      text: text
    }, '*');

    window.dispatchEvent(new CustomEvent('Weavetab-msg-in', {
      detail: {
        type: 'USER_FEEDBACK',
        text: text
      }
    }));

    try {
      var existing = JSON.parse(localStorage.getItem('__wt_chat_queue_persist') || '[]');
      existing.push({ text: text, ts: Date.now() });
      if (existing.length > 20) existing.splice(0, existing.length - 20);
      localStorage.setItem('__wt_chat_queue_persist', JSON.stringify(existing));
    } catch(e) {}

    __wt_addLogEntry('Feedback sent', 'done', text.length > 60 ? text.substring(0, 60) + '...' : text);

    msgInput.value = '';
    msgInput.style.height = 'auto';
    try { browserAPI.storage.local.remove('wt_chat_draft'); } catch(e) {}
    sendBtn.classList.add('sent');
    setTimeout(function(){ sendBtn.classList.remove('sent'); }, 1200);
  }

  sendBtn.onclick = submitFeedback;
  msgInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitFeedback(); }
    if (e.key === 'Escape') { minimizePanel(); }
  });

})();

// ── GEMINI-STYLE AREA SNIPE & DIRECT ANNOTATION ENGINE ─────────────────────
(function initAreaSnipeEngine() {
  let isSnipeActive = false;
  let currentSnipeMode = 'dom_target';
  let overlayEl = null;
  let marqueeBox = null;
  let sizeBadge = null;
  let headerPill = null;
  let startX = 0, startY = 0;
  let isDragging = false;

  function createOverlay(mode) {
    if (overlayEl) overlayEl.remove();
    currentSnipeMode = mode || 'dom_target';

    overlayEl = document.createElement('div');
    overlayEl.id = 'wt-snipe-overlay';
    overlayEl.setAttribute('data-wt-ignore', 'true');
    overlayEl.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0, 0, 0, 0.35); backdrop-filter: blur(2px);
      cursor: crosshair; user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    `;

    headerPill = document.createElement('div');
    headerPill.style.cssText = `
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      background: #18181b; border: 1px solid #3f3f46; color: #f4f4f5;
      font-size: 11px; font-weight: 500; padding: 6px 16px; border-radius: 20px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6); pointer-events: none;
      display: flex; align-items: center; gap: 8px; z-index: 2147483647;
    `;
    const modeLabel = currentSnipeMode === 'visual_crop' ? 'Vision Crop' : 'DOM Target';
    headerPill.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>Drag box to select area</span> <span style="color:#06b6d4;font-weight:600;">[${modeLabel}]</span> <span style="color:#71717a;">(Esc to cancel)</span>`;

    // Marquee selection box matching img1 Gemini/YouTube Chrome UI style
    marqueeBox = document.createElement('div');
    marqueeBox.style.cssText = `
      position: fixed; border: 1px solid rgba(255, 255, 255, 0.45);
      border-radius: 12px;
      box-shadow: 0 0 24px 3px rgba(147, 197, 253, 0.45), inset 0 0 20px rgba(147, 197, 253, 0.2);
      pointer-events: auto; display: none; z-index: 2147483647;
      background: rgba(0, 0, 0, 0.1);
    `;

    // Four thick white rounded corner reticles (matching img1)
    const corners = [
      'top: -2px; left: -2px; border-top: 4px solid #ffffff; border-left: 4px solid #ffffff; border-top-left-radius: 10px;',
      'top: -2px; right: -2px; border-top: 4px solid #ffffff; border-right: 4px solid #ffffff; border-top-right-radius: 10px;',
      'bottom: -2px; left: -2px; border-bottom: 4px solid #ffffff; border-left: 4px solid #ffffff; border-bottom-left-radius: 10px;',
      'bottom: -2px; right: -2px; border-bottom: 4px solid #ffffff; border-right: 4px solid #ffffff; border-bottom-right-radius: 10px;'
    ];
    corners.forEach(styleCss => {
      const c = document.createElement('div');
      c.style.cssText = `position: absolute; width: 18px; height: 18px; pointer-events: none; ${styleCss}`;
      marqueeBox.appendChild(c);
    });

    // Circular close X button on top-right corner
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = `
      position: absolute; top: -11px; right: -11px;
      width: 22px; height: 22px; border-radius: 50%;
      background: rgba(24, 24, 27, 0.95); border: 1px solid rgba(255, 255, 255, 0.25);
      color: #f4f4f5; cursor: pointer; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 12px rgba(0,0,0,0.6); z-index: 2147483647; transition: transform 0.15s, background 0.15s;
    `;
    closeBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    closeBtn.onclick = function(e) {
      e.stopPropagation();
      destroyOverlay();
    };
    marqueeBox.appendChild(closeBtn);

    sizeBadge = document.createElement('div');
    sizeBadge.style.cssText = `
      position: absolute; bottom: -28px; left: 50%; transform: translateX(-50%);
      background: rgba(15, 23, 42, 0.9); backdrop-filter: blur(8px); color: #e2e8f0; font-weight: 600;
      font-size: 10px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 2px 8px; border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.15); box-shadow: 0 4px 12px rgba(0,0,0,0.5); pointer-events: none;
      white-space: nowrap;
    `;
    marqueeBox.appendChild(sizeBadge);

    overlayEl.appendChild(headerPill);
    overlayEl.appendChild(marqueeBox);
    document.documentElement.appendChild(overlayEl);

    isSnipeActive = true;
  }

  function destroyOverlay() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
    isSnipeActive = false;
    isDragging = false;
  }

  function handleMouseDown(e) {
    if (!isSnipeActive || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;

    marqueeBox.style.left = startX + 'px';
    marqueeBox.style.top = startY + 'px';
    marqueeBox.style.width = '0px';
    marqueeBox.style.height = '0px';
    marqueeBox.style.display = 'block';
  }

  function handleMouseMove(e) {
    if (!isSnipeActive || !isDragging) return;
    e.preventDefault();
    e.stopPropagation();

    const currentX = e.clientX;
    const currentY = e.clientY;

    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    marqueeBox.style.left = left + 'px';
    marqueeBox.style.top = top + 'px';
    marqueeBox.style.width = width + 'px';
    marqueeBox.style.height = height + 'px';

    sizeBadge.textContent = `${width} × ${height} px`;
  }

  function handleMouseUp(e) {
    if (!isSnipeActive || !isDragging) return;
    e.preventDefault();
    e.stopPropagation();

    isDragging = false;
    const currentX = e.clientX;
    const currentY = e.clientY;

    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    if (width < 10 || height < 10) {
      destroyOverlay();
      return;
    }

    if (currentSnipeMode === 'visual_crop') {
      captureVisualCrop(left, top, width, height);
    } else {
      captureDOMTargets(left, top, width, height);
    }

    destroyOverlay();
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape' && isSnipeActive) {
      destroyOverlay();
    }
    if (e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      createOverlay('dom_target');
    }
  }

  window.addEventListener('mousedown', handleMouseDown, true);
  window.addEventListener('mousemove', handleMouseMove, true);
  window.addEventListener('mouseup', handleMouseUp, true);
  window.addEventListener('keydown', handleKeyDown, true);

  // ── Mode 1: DOM Element Intersector ──────────────────────────────────────
  function captureDOMTargets(left, top, width, height) {
    const right = left + width;
    const bottom = top + height;
    const elements = [];

    const allEls = document.querySelectorAll('button, input, select, textarea, a, h1, h2, h3, h4, h5, h6, p, table, tr, td, th, div, span, [role]');
    allEls.forEach((el) => {
      if (el.hasAttribute('data-wt-ignore') || el.closest('#wt-snipe-overlay')) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;

      const overlaps = !(r.right < left || r.left > right || r.bottom < top || r.top > bottom);
      if (overlaps) {
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 100);
        if (text || ['INPUT', 'BUTTON', 'A', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
          elements.push({
            tag: el.tagName.toLowerCase(),
            selector: getStableSelector(el),
            ref: el.getAttribute('data-wt-id') || null,
            text: text,
            role: el.getAttribute('role') || null,
            rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
          });
        }
      }
    });

    const uniqueElements = elements.slice(0, 15);

    __wt_safeSendMessage({
      type: 'WT_SNIPE_COMPLETED',
      payload: {
        mode: 'dom_target',
        elements: uniqueElements,
        boundingRect: { x: left, y: top, width, height }
      }
    });
  }

  // ── Mode 2: Visual WebP Crop ─────────────────────────────────────────────
  function captureVisualCrop(left, top, width, height) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      const htmlContent = document.documentElement.outerHTML;
      const dataSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${window.innerWidth}" height="${window.innerHeight}">
          <foreignObject width="100%" height="100%">
            <div xmlns="http://www.w3.org/1999/xhtml">
              ${htmlContent}
            </div>
          </foreignObject>
        </svg>
      `;

      const img = new Image();
      const blob = new Blob([dataSvg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      img.onload = function() {
        ctx.drawImage(img, left, top, width, height, 0, 0, width, height);
        URL.revokeObjectURL(url);
        const webpBase64 = canvas.toDataURL('image/webp', 0.75);

        __wt_safeSendMessage({
          type: 'WT_SNIPE_COMPLETED',
          payload: {
            mode: 'visual_crop',
            cropImage: webpBase64,
            boundingRect: { x: left, y: top, width, height }
          }
        });
      };
      img.onerror = function() {
        captureDOMTargets(left, top, width, height);
      };
      img.src = url;
    } catch(e) {
      captureDOMTargets(left, top, width, height);
    }
  }

  // Listen for start snipe message from sidepanel/background
  browserAPI.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'WT_START_SNIPE') {
      createOverlay(msg.mode || 'dom_target');
    }
    if (msg.type === 'WT_SNIPE_INJECT' && msg.entry) {
      const noteStr = typeof msg.entry === 'string' ? msg.entry : JSON.stringify(msg.entry);
      try {
        if (!window.__wt_chat_queue) window.__wt_chat_queue = [];
        window.__wt_chat_queue.push(noteStr);
      } catch(e) {}

      try {
        const existing = JSON.parse(localStorage.getItem('__wt_chat_queue_persist') || '[]');
        existing.push(msg.entry);
        localStorage.setItem('__wt_chat_queue_persist', JSON.stringify(existing));
      } catch(e) {}

      const bridge = document.getElementById('__wt_ask_bridge');
      if (bridge) {
        bridge.dataset.status = 'submitted';
        bridge.dataset.result = msg.entry.text || 'Annotation submitted';
      }
    }
  });

})();

// ── ALERT / ACTION-REQUIRED TAB INDICATOR ─────────────────────
(function initAlertDetector() {
  if (window.self !== window.top) return;
  // Expose on window so window.__Weavetab.getAlertState() can read it from CDP MAIN world
  window.__wt_alertPending = false;
  var _alert = window.alert;
  window.alert = function(msg) {
    window.__wt_alertPending = true;
    __wt_safeSendMessage({ type: 'TAB_ALERT_WAITING' });
    var r = _alert.apply(this, arguments);
    window.__wt_alertPending = false;
    __wt_safeSendMessage({ type: 'TAB_ALERT_CLEARED' });
    return r;
  };
  var _confirm = window.confirm;
  window.confirm = function(msg) {
    window.__wt_alertPending = true;
    __wt_safeSendMessage({ type: 'TAB_ALERT_WAITING' });
    var r = _confirm.apply(this, arguments);
    window.__wt_alertPending = false;
    __wt_safeSendMessage({ type: 'TAB_ALERT_CLEARED' });
    return r;
  };
  var _prompt = window.prompt;
  window.prompt = function(msg, def) {
    window.__wt_alertPending = true;
    __wt_safeSendMessage({ type: 'TAB_ALERT_WAITING' });
    var r = _prompt.apply(this, arguments);
    window.__wt_alertPending = false;
    __wt_safeSendMessage({ type: 'TAB_ALERT_CLEARED' });
    return r;
  };
})();

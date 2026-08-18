const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Allow users to open the side panel by clicking on the action toolbar icon
if (browserAPI.sidePanel) {
  browserAPI.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));
}

// ── Browser Startup: auto-open sidepanel ────────────────────────
// Clear minimized state on browser launch so sidepanel opens automatically
browserAPI.runtime.onStartup.addListener(function() {
  try { browserAPI.storage.local.remove('wt_panel_minimized'); } catch(e) {}
});
// Also clear on install (first launch)
browserAPI.runtime.onInstalled.addListener(function() {
  try { browserAPI.storage.local.remove('wt_panel_minimized'); } catch(e) {}
});

// HUD toggle command handler
browserAPI.commands.onCommand.addListener(function(command) {
  if (command === 'toggle-hud') {
    browserAPI.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs[0] && tabs[0].id) {
        browserAPI.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_HUD' }).catch(function(){});
      }
    });
  }
  if (command === 'toggle-debug') {
    browserAPI.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs[0] && tabs[0].id) {
        browserAPI.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_DEBUG' }).catch(function(){});
      }
    });
  }
});

// Runtime state
const controlledTabs = new Set();
const anchorTabs = new Set();
let currentGroupState = 'idle';
let activeSessionTabId = null;

// ── Sidepanel Open/Close Tracking ────────────────────────────────────────────
let isSidepanelOpen = false;
browserAPI.runtime.onConnect.addListener(function(port) {
  if (port.name === 'wt-sidepanel') {
    isSidepanelOpen = true;
    // Notify all controlled tabs so HUD can suppress browser_thought pill
    controlledTabs.forEach(tabId => {
      browserAPI.tabs.sendMessage(tabId, { type: 'WT_SIDEPANEL_STATE', open: true }).catch(() => {});
    });
    port.onDisconnect.addListener(function() {
      isSidepanelOpen = false;
      controlledTabs.forEach(tabId => {
        browserAPI.tabs.sendMessage(tabId, { type: 'WT_SIDEPANEL_STATE', open: false }).catch(() => {});
      });
    });
  }
});

// State color mapping — always blue, never yellow
const STATE_COLORS = {
  idle: 'grey',
  weaving: 'blue',
  stuck: 'blue',  // Keep blue, never yellow
};

const STATE_BADGE = {
  idle: { text: '', color: null },
  weaving: { text: '\u25CF', color: '#3B82F6' },
  stuck: { text: '\u25CF', color: '#3B82F6' },  // blue dot, not red
};


browserAPI.tabs.onCreated.addListener(async (tab) => {
  if (!controlledTabs.has(tab.id)) return;
  // Ungroup immediately — prevents Chrome from keeping this tab in any group
  try { browserAPI.tabs.ungroup(tab.id).catch(() => {}); } catch(e) {}
});

browserAPI.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!controlledTabs.has(tabId)) return;
  if (changeInfo.status === 'complete') {
    // Ungroup on update to handle cases where Chrome re-groups after navigation
    try { browserAPI.tabs.ungroup(tabId).catch(() => {}); } catch(e) {}
    browserAPI.tabs.sendMessage(tabId, { type: 'Weavetab_GROUP_STATE', state: currentGroupState, isActive: tabId === activeSessionTabId }).catch(() => {});
  }
});


// Per-tab network interception using declarativeNetRequest
async function enableIntercept(tabId, pattern, mockStatus, mockBody) {
  try {
    await browserAPI.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id: tabId,
        priority: 1,
        condition: { urlFilter: pattern, tabIds: [tabId] },
        action: {
          type: 'redirect',
          redirect: {
            url: `data:application/json,${encodeURIComponent(mockBody)}`
          }
        }
      }]
    });
    return { success: true };
  } catch (e) {
    console.error("Failed to enable intercept:", e);
    return { success: false, error: e.message };
  }
}

async function disableIntercept(tabId) {
  try {
    await browserAPI.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [tabId]
    });
    return { success: true };
  } catch (e) {
    console.error("Failed to disable intercept:", e);
    return { success: false, error: e.message };
  }
}

// Stale state guard: if no Weavetab_GROUP_STATE message for 90s, reset all controlled tabs to idle
let __wt_stateTimeout = null;

function resetToIdle() {
  if (currentGroupState === 'idle') return;
  currentGroupState = 'idle';
  activeSessionTabId = null;
  controlledTabs.forEach(tabId => {
    browserAPI.tabs.sendMessage(tabId, { type: 'Weavetab_GROUP_STATE', state: 'idle', isActive: false }).catch(() => {});
  });
  if (browserAPI.action) {
    browserAPI.action.setBadgeText({ text: '' }).catch(() => {});
  }
}

function refreshStateTimeout() {
  if (__wt_stateTimeout) clearTimeout(__wt_stateTimeout);
  __wt_stateTimeout = setTimeout(resetToIdle, 120000); // 2 min stale guard
}

// Bridge: relay state from CLI (via CDP executeScript) to content scripts
// ── Sidepanel broadcast ─────────────────────────────────────────────────────
// Routes agent-activity messages (tool calls, thoughts, status) to the sidepanel
// so all visual state lives there, not in in-page overlays.
function broadcastToSidepanel(msg) {
  browserAPI.runtime.sendMessage(msg).catch(() => {}); // sidepanel listens on runtime
}

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Forward tool call events to sidepanel ──
  if (message.type === 'TOOL_CALL_EVENT') {
    broadcastToSidepanel({ type: 'TOOL_CALL_EVENT', payload: message.payload });
  }
  // ── Smart thought routing ──
  // browser_thought (kind='thought') → sidepanel when open, HUD when closed
  // Scripted pill suppression is handled in the HUD via WT_SIDEPANEL_STATE
  if (message.type === 'WT_THOUGHT') {
    if (isSidepanelOpen) {
      // Route to sidepanel only — suppress HUD rendering
      broadcastToSidepanel({ type: 'WT_THOUGHT', text: message.text, kind: message.kind });
      // Tell the HUD iframe in the active tab to suppress the browser_thought pill
      if (sender.tab && sender.tab.id) {
        browserAPI.tabs.sendMessage(sender.tab.id, { type: 'WT_SUPPRESS_THOUGHT_HUD' }).catch(() => {});
      }
    } else {
      // Sidepanel closed — let the HUD handle it normally via the iframe relay
      broadcastToSidepanel({ type: 'WT_THOUGHT', text: message.text, kind: message.kind });
    }
  }

  // ── User messaging ──
  if (message.type === 'WT_USER_NOTE') {
    const payload = {
      type: 'WT_USER_NOTE_INJECT',
      text: message.text,
      snipe: message.snipe
    };
    // Query active tab in current window and send message immediately
    browserAPI.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs[0] && tabs[0].id) {
        browserAPI.tabs.sendMessage(tabs[0].id, payload).catch(function(){});
      }
    });
    // Send to activeSessionTabId if set
    if (activeSessionTabId) {
      browserAPI.tabs.sendMessage(activeSessionTabId, payload).catch(function(){});
    }
    // Fallback to all controlled tabs
    controlledTabs.forEach(tabId => {
      browserAPI.tabs.sendMessage(tabId, payload).catch(function(){});
    });
  }

  if (message.type === 'WT_TOGGLE_MASTER_VISUALS') {
    browserAPI.storage.local.set({ wt_master_visuals: message.enabled }).catch(() => {});
    controlledTabs.forEach(tabId => {
      browserAPI.tabs.sendMessage(tabId, { type: 'WT_TOGGLE_MASTER_VISUALS', enabled: message.enabled }).catch(() => {});
    });
    sendResponse({ ok: true });
  }

  if (message.type === 'Weavetab_STATE') {
    broadcastToSidepanel(message);
    controlledTabs.forEach(tabId => {
      browserAPI.tabs.sendMessage(tabId, message).catch(() => {});
    });
    sendResponse({ ok: true });
  }
  if (message.type === 'Weavetab_CONFIG') {
    const { groupTabs } = message;
    browserAPI.storage.local.set({
      weaveGroupEnabled: groupTabs !== false,
    }).catch(() => {});
    sendResponse({ ok: true });
  }
  if (message.type === 'Weavetab_GROUP_STATE') {
    const { state, word } = message;
    currentGroupState = state;
    refreshStateTimeout();
    const color = STATE_COLORS[state] || 'blue';
    const badge = STATE_BADGE[state] || STATE_BADGE.idle;

    // Track which tab relayed this state update (the active session tab)
    if (sender.tab) activeSessionTabId = sender.tab.id;
    // Per-tab badge
    if (browserAPI.action) {
      const ids = Array.from(controlledTabs);
      ids.forEach(tid => {
        if (badge.text) {
          browserAPI.action.setBadgeText({ tabId: tid, text: badge.text }).catch(() => {});
          if (badge.color) {
            browserAPI.action.setBadgeBackgroundColor({ tabId: tid, color: badge.color }).catch(() => {});
          }
        } else {
          browserAPI.action.setBadgeText({ tabId: tid, text: '' }).catch(() => {});
        }
      });
    }

    // Broadcast state to all controlled tabs so they update their favicons
    controlledTabs.forEach(tabId => {
      browserAPI.tabs.sendMessage(tabId, { type: 'Weavetab_GROUP_STATE', state, isActive: tabId === activeSessionTabId }).catch(() => {});
    });

    // ── Mirror to sidepanel status dot ──
    broadcastToSidepanel({ type: 'WT_AGENT_STATUS', status: state });

    sendResponse({ ok: true });
  }
  if (message.type === 'REGISTER_TAB') {
    // Skip about:blank and chrome:// pages
    if (sender.tab.url === 'about:blank' || sender.tab.url.startsWith('chrome://')) {
      sendResponse({ ok: true, skipped: true });
      return;
    }
    controlledTabs.add(sender.tab.id);
    refreshStateTimeout();

    // Immediately inform the tab of the current group state so it can set its favicon
    browserAPI.tabs.sendMessage(sender.tab.id, { type: 'Weavetab_GROUP_STATE', state: currentGroupState, isActive: sender.tab.id === activeSessionTabId }).catch(() => {});

    updateBadge();
    sendResponse({ ok: true });
  }

  if (message.type === 'NETWORK_INTERCEPT_ENABLE') {
    enableIntercept(sender.tab.id, message.pattern, message.mockStatus, message.mockBody)
      .then(res => sendResponse(res));
    return true;
  }
  if (message.type === 'NETWORK_INTERCEPT_DISABLE') {
    disableIntercept(sender.tab.id)
      .then(res => sendResponse(res));
    return true;
  }
  if (message.type === 'GET_ANCHOR_STATUS') {
    sendResponse({ isAnchor: anchorTabs.has(sender.tab.id) });
    return true;
  }
  if (message.type === 'SET_ANCHOR_TAB') {
    if (message.anchor) anchorTabs.add(sender.tab.id);
    else anchorTabs.delete(sender.tab.id);
    sendResponse({ ok: true });
  }

  // ── User feedback relay: sidepanel / content script → storage queue ────────
  // CDP polls window.__Weavetab.popUserFeedback() or window.__wt_chat_queue which reads from this queue.
  if (message.type === 'USER_FEEDBACK' || message.type === 'WT_USER_NOTE') {
    if (message.text || message.snipe) {
      const noteEntry = {
        text: message.text || '',
        snipe: message.snipe || null,
        ts: message.ts || Date.now(),
        tabId: sender.tab && sender.tab.id
      };

      browserAPI.storage.local.get('__wt_feedback_queue', function(res) {
        const queue = res['__wt_feedback_queue'] || [];
        queue.push(noteEntry);
        // Cap queue at 20 entries
        if (queue.length > 20) queue.splice(0, queue.length - 20);
        browserAPI.storage.local.set({ '__wt_feedback_queue': queue });
      });

      // Forward directly to active session tab content script for immediate DOM queue push & interrupt
      browserAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          browserAPI.tabs.sendMessage(tabs[0].id, {
            type: 'WT_SNIPE_INJECT',
            entry: noteEntry
          }).catch(() => {});
        }
      });
    }
    sendResponse({ ok: true });
  }


  // Alert tab: mark tabs with alert dialogs waiting + write to storage so CDP can see it
  if (message.type === 'TAB_ALERT_WAITING') {
    const alertTabId = sender.tab && sender.tab.id;
    if (alertTabId) {
      browserAPI.tabs.sendMessage(alertTabId, { type: 'Weavetab_GROUP_STATE', state: 'weaving', isActive: false }).catch(() => {});
      // Write alert state to storage — CDP polls __Weavetab.getAlertState()
      browserAPI.storage.local.set({ '__wt_alert_state': { pending: true, tabId: alertTabId, ts: Date.now() } });
    }
    sendResponse({ ok: true });
  }
  if (message.type === 'TAB_ALERT_CLEARED') {
    const alertTabId = sender.tab && sender.tab.id;
    if (alertTabId) {
      browserAPI.tabs.sendMessage(alertTabId, { type: 'Weavetab_GROUP_STATE', state: 'idle', isActive: false }).catch(() => {});
      browserAPI.storage.local.set({ '__wt_alert_state': { pending: false, tabId: alertTabId, ts: Date.now() } });
    }
    sendResponse({ ok: true });
  }
  if (message.type === 'RELOAD_EXTENSION') {
    sendResponse({ ok: true });
    browserAPI.runtime.reload();
  }


});

browserAPI.tabs.onRemoved.addListener((tabId) => {
  if (controlledTabs.has(tabId)) {
    controlledTabs.delete(tabId);
    updateBadge();
  }
  anchorTabs.delete(tabId);
});


// Startup cleanup: Ungroup all Weavetab tabs and clear badges
browserAPI.runtime.onInstalled.addListener(() => {
  browserAPI.tabs.query({}, (tabs) => {
    const ids = tabs.map(t => t.id).filter(id => id !== undefined);
    if (ids.length > 0) {
      browserAPI.tabs.ungroup(ids).catch(() => {});
    }
  });
});

function updateBadge() {
  if (!browserAPI.action) return;
  const ids = Array.from(controlledTabs);
  if (ids.length === 0) {
    browserAPI.action.setBadgeText({ text: '' }).catch(() => {});
  } else {
    ids.forEach(tid => {
      // Just set the dot, but don't group
      browserAPI.action.setBadgeText({ tabId: tid, text: '\u25CF' }).catch(() => {});
      browserAPI.action.setBadgeBackgroundColor({ tabId: tid, color: '#3B82F6' }).catch(() => {});
    });
  }
}

// On startup: close stale blank tabs — but NEVER the last remaining tab.
// Weavetab launches Chrome on about:blank, so removing the only tab closes
// the browser window (graceful shutdown ~1s after launch → ECONNREFUSED loop).
browserAPI.runtime.onStartup.addListener(async () => {
  try {
    const blanks = await browserAPI.tabs.query({ url: 'about:blank' });
    if (blanks.length === 0) return;
    const all = await browserAPI.tabs.query({});
    // Keep one tab alive if every tab would otherwise be closed.
    const mustKeep = blanks.length === all.length ? 1 : 0;
    blanks.slice(0, blanks.length - mustKeep).forEach(t =>
      browserAPI.tabs.remove(t.id).catch(() => {})
    );
  } catch (e) {
    // Non-fatal: never let tab cleanup crash the service worker or close the browser.
  }
});

// Network blocking for speed (delayed to avoid 'No SW' on cold start)
// Guard: only run if the service worker is still alive (not being terminated)
setTimeout(function() {
  // Check the runtime is still valid before calling declarativeNetRequest
  try {
    if (!browserAPI.runtime || !browserAPI.runtime.id) return;
    browserAPI.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1, 2, 3, 4],
      addRules: [
        { id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '*google-analytics.com*', resourceTypes: ['script', 'xmlhttprequest', 'ping'] } },
        { id: 2, priority: 1, action: { type: 'block' }, condition: { urlFilter: '*doubleclick.net*', resourceTypes: ['script', 'xmlhttprequest', 'ping', 'image', 'sub_frame'] } },
        { id: 3, priority: 1, action: { type: 'block' }, condition: { urlFilter: '*facebook.net/en_US/fbevents.js*', resourceTypes: ['script'] } }
        // NOTE: GTM blocking removed — some sites bundle critical resources through GTM
      ]
    }).catch(function(e) {
      // Non-fatal — log for debugging only
      console.warn('[Weavetab] Dynamic rules update failed (non-fatal):', e && e.message);
    });
  } catch(e) {
    // Service worker terminated or runtime invalidated — safe to ignore
  }
}, 1000);

// ─── Omnibox: Weavetab:// protocol via browserAPI.omnibox ─────────────────────

const DASHBOARD_URL = browserAPI.runtime.getURL('dashboard.html');

browserAPI.omnibox.onInputStarted.addListener(() => {
  browserAPI.omnibox.setDefaultSuggestion({
    description: 'Open Weavetab Dashboard <url>chrome-extension://...</url>'
  });
});

browserAPI.omnibox.onInputChanged.addListener((text, suggest) => {
  const suggestions = [];
  const lower = text.toLowerCase();
  if (!lower || lower === 'dashboard' || 'dashboard'.startsWith(lower)) {
    suggestions.push({
      content: 'dashboard',
      description: 'Open Weavetab Dashboard'
    });
  }
  if ('help'.startsWith(lower)) {
    suggestions.push({
      content: 'help',
      description: 'Weavetab Help & Documentation'
    });
  }
  suggest(suggestions);
});

browserAPI.omnibox.onInputEntered.addListener((text, disposition) => {
  const branch = text && text !== 'dashboard' ? encodeURIComponent(text) : 'default';
  const url = DASHBOARD_URL + `?branch=${branch}`;
  switch (disposition) {
    case 'currentTab':
      browserAPI.tabs.update({ url });
      break;
    case 'newForegroundTab':
      browserAPI.tabs.create({ url });
      break;
    case 'newBackgroundTab':
      browserAPI.tabs.create({ url, active: false });
      break;
  }
});

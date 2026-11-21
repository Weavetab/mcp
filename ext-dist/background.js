const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

browserAPI.commands.onCommand.addListener(function(command) {
  const msgType = command === 'toggle-hud' ? 'TOGGLE_HUD' : command === 'toggle-debug' ? 'TOGGLE_DEBUG' : null;
  if (!msgType) return;
  browserAPI.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (tabs[0] && tabs[0].id) {
      browserAPI.tabs.sendMessage(tabs[0].id, { type: msgType }).catch(() => {});
    }
  });
});

const controlledTabs = new Set();
let currentGroupState = 'idle';
let activeSessionTabId = null;

function saveSessionState() {
  if (!browserAPI.storage?.session) return;
  browserAPI.storage.session.set({
    wt_controlled_tabs: Array.from(controlledTabs),
    wt_group_state: currentGroupState,
    wt_active_tab_id: activeSessionTabId,
  }).catch(() => {});
}

if (browserAPI.storage?.session) {
  browserAPI.storage.session.get(['wt_controlled_tabs', 'wt_group_state', 'wt_active_tab_id'], (res) => {
    if (res && Array.isArray(res.wt_controlled_tabs)) {
      res.wt_controlled_tabs.forEach((id) => controlledTabs.add(id));
    }
    if (res && typeof res.wt_group_state === 'string') {
      currentGroupState = res.wt_group_state;
    }
    if (res && res.wt_active_tab_id !== undefined) {
      activeSessionTabId = res.wt_active_tab_id;
    }
  });
}

const STATE_BADGE = {
  idle: { text: '', color: null },
  weaving: { text: '\u25CF', color: '#3B82F6' },
  stuck: { text: '\u25CF', color: '#F59E0B' },
};

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
      removeRuleIds: [tabId],
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
    console.warn('intercept enable err:', e && e.message);
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

const STALE_ALARM = 'wt-stale-state-guard';

function resetToIdle() {
  if (currentGroupState === 'idle') return;
  currentGroupState = 'idle';
  activeSessionTabId = null;
  saveSessionState();
  controlledTabs.forEach(tabId => {
    browserAPI.tabs.sendMessage(tabId, { type: 'Weavetab_GROUP_STATE', state: 'idle', isActive: false }).catch(() => {});
  });
  if (browserAPI.action) {
    browserAPI.action.setBadgeText({ text: '' }).catch(() => {});
  }
}

function refreshStateTimeout() {
  if (browserAPI.alarms) {
    browserAPI.alarms.create(STALE_ALARM, { delayInMinutes: 2 });
  }
}

if (browserAPI.alarms) {
  browserAPI.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === STALE_ALARM) {
      resetToIdle();
    }
  });
}

// relay state from content scripts across controlled tabs
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'WT_THOUGHT' || message.type === 'WT_HUD_UPDATE') {
    controlledTabs.forEach(tabId => {
      browserAPI.tabs.sendMessage(tabId, message).catch(() => {});
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
    const { state } = message;
    currentGroupState = state;
    refreshStateTimeout();
    const badge = STATE_BADGE[state] || STATE_BADGE.idle;

    if (sender.tab?.id) activeSessionTabId = sender.tab.id;
    saveSessionState();
    if (browserAPI.action) {
      Array.from(controlledTabs).forEach(tid => {
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

    controlledTabs.forEach(tabId => {
      browserAPI.tabs.sendMessage(tabId, { type: 'Weavetab_GROUP_STATE', state, isActive: tabId === activeSessionTabId }).catch(() => {});
    });

    sendResponse({ ok: true });
  }
  if (message.type === 'REGISTER_TAB') {
    if (!sender.tab?.id) return;
    const tabUrl = sender.tab.url || '';
    if (tabUrl === 'about:blank' || tabUrl.startsWith('chrome://')) {
      sendResponse({ ok: true, skipped: true });
      return;
    }
    controlledTabs.add(sender.tab.id);
    saveSessionState();
    refreshStateTimeout();

    browserAPI.tabs.sendMessage(sender.tab.id, { type: 'Weavetab_GROUP_STATE', state: currentGroupState, isActive: sender.tab.id === activeSessionTabId }).catch(() => {});

    updateBadge();
    sendResponse({ ok: true });
  }

  if (message.type === 'NETWORK_INTERCEPT_ENABLE') {
    if (!sender.tab?.id) return;
    enableIntercept(sender.tab.id, message.pattern, message.mockStatus, message.mockBody)
      .then(res => sendResponse(res));
    return true;
  }
  if (message.type === 'NETWORK_INTERCEPT_DISABLE') {
    if (!sender.tab?.id) return;
    disableIntercept(sender.tab.id)
      .then(res => sendResponse(res));
    return true;
  }

  // plugin css injection bypasses strict site csp via scripting api
  if (message.type === 'PLUGIN_INJECT_CSS' && message.css) {
    if (!sender.tab?.id) return;
    browserAPI.scripting.insertCSS({ target: { tabId: sender.tab.id }, css: message.css })
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e && e.message }));
    return true;
  }
  if (message.type === 'PLUGIN_REMOVE_CSS' && message.css) {
    if (!sender.tab?.id) return;
    browserAPI.scripting.removeCSS({ target: { tabId: sender.tab.id }, css: message.css })
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e && e.message }));
    return true;
  }

  if (message.type === 'USER_FEEDBACK' || message.type === 'WT_USER_NOTE') {
    if (message.text || message.snipe) {
      const noteEntry = {
        text: message.text || '',
        snipe: message.snipe || null,
        ts: message.ts || Date.now(),
        tabId: sender.tab && sender.tab.id
      };

      const notePayload = {
        type: 'WT_USER_NOTE_INJECT',
        text: message.text,
        snipe: message.snipe
      };
      browserAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          browserAPI.tabs.sendMessage(tabs[0].id, notePayload).catch(() => {});
          browserAPI.tabs.sendMessage(tabs[0].id, { type: 'WT_SNIPE_INJECT', entry: noteEntry }).catch(() => {});
        }
      });
      if (activeSessionTabId) {
        browserAPI.tabs.sendMessage(activeSessionTabId, notePayload).catch(() => {});
      }
      controlledTabs.forEach(tabId => {
        browserAPI.tabs.sendMessage(tabId, notePayload).catch(() => {});
      });

      browserAPI.storage.local.get('__wt_feedback_queue', function(res) {
        const queue = res['__wt_feedback_queue'] || [];
        queue.push(noteEntry);
        if (queue.length > 20) queue.splice(0, queue.length - 20);
        browserAPI.storage.local.set({ '__wt_feedback_queue': queue });
      });
    }
    sendResponse({ ok: true });
  }


  // Alert tab: mark tabs with alert dialogs waiting + write to storage so CDP can see it
  if (message.type === 'TAB_ALERT_WAITING') {
    if (!sender.tab?.id) return;
    const alertTabId = sender.tab.id;
    browserAPI.tabs.sendMessage(alertTabId, { type: 'Weavetab_GROUP_STATE', state: 'weaving', isActive: false }).catch(() => {});
    browserAPI.storage.local.set({ '__wt_alert_state': { pending: true, tabId: alertTabId, ts: Date.now() } });
    sendResponse({ ok: true });
  }
  if (message.type === 'TAB_ALERT_CLEARED') {
    if (!sender.tab?.id) return;
    const alertTabId = sender.tab.id;
    browserAPI.tabs.sendMessage(alertTabId, { type: 'Weavetab_GROUP_STATE', state: 'idle', isActive: false }).catch(() => {});
    browserAPI.storage.local.set({ '__wt_alert_state': { pending: false, tabId: alertTabId, ts: Date.now() } });
    sendResponse({ ok: true });
  }
  if (message.type === 'RELOAD_EXTENSION') {
    sendResponse({ ok: true });
    browserAPI.runtime.reload();
  }


});

browserAPI.tabs.onRemoved.addListener((tabId) => {
  disableIntercept(tabId);
  if (controlledTabs.has(tabId)) {
    controlledTabs.delete(tabId);
    if (activeSessionTabId === tabId) activeSessionTabId = null;
    saveSessionState();
    updateBadge();
  }
});


// Startup cleanup: Ungroup all Weavetab tabs and clear badges
browserAPI.runtime.onInstalled.addListener(() => {
  browserAPI.tabs.query({}, (tabs) => {
    const ids = tabs.map(t => t.id).filter(id => id !== undefined);
    if (ids.length > 0) {
      browserAPI.tabs.ungroup(ids).catch(() => {});
    }
  });
  try {
    if (browserAPI.declarativeNetRequest) {
      browserAPI.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1, 2, 3],
        addRules: [
          { id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '*google-analytics.com*', resourceTypes: ['script', 'xmlhttprequest', 'ping'] } },
          { id: 2, priority: 1, action: { type: 'block' }, condition: { urlFilter: '*doubleclick.net*', resourceTypes: ['script', 'xmlhttprequest', 'ping', 'image', 'sub_frame'] } },
          { id: 3, priority: 1, action: { type: 'block' }, condition: { urlFilter: '*facebook.net/en_US/fbevents.js*', resourceTypes: ['script'] } }
        ]
      }).catch(() => {});
    }
  } catch (e) {}
});

function updateBadge() {
  if (!browserAPI.action) return;
  const badge = STATE_BADGE[currentGroupState] || STATE_BADGE.idle;
  const ids = Array.from(controlledTabs);
  if (ids.length === 0) {
    browserAPI.action.setBadgeText({ text: '' }).catch(() => {});
    return;
  }
  ids.forEach(tid => {
    browserAPI.action.setBadgeText({ tabId: tid, text: badge.text }).catch(() => {});
    if (badge.color) {
      browserAPI.action.setBadgeBackgroundColor({ tabId: tid, color: badge.color }).catch(() => {});
    }
  });
}

browserAPI.runtime.onStartup.addListener(async () => {
  try {
    const all = await browserAPI.tabs.query({});
    const byWin = new Map();
    for (const t of all) {
      const list = byWin.get(t.windowId) || [];
      list.push(t);
      byWin.set(t.windowId, list);
    }
    for (const [, winTabs] of byWin) {
      const blanks = winTabs.filter(t => t.url === 'about:blank');
      if (blanks.length === 0) continue;
      const mustKeep = blanks.length === winTabs.length ? 1 : 0;
      blanks.slice(0, blanks.length - mustKeep).forEach(t => {
        if (t.id !== undefined) browserAPI.tabs.remove(t.id).catch(() => {});
      });
    }
  } catch (e) {}
});

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

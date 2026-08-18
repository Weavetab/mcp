// sidepanel/src/index.ts — Weavetab live activity panel
// Displays: agent status, thoughts stream, tool call feed, task list, message input.
// All visuals (except the in-page cursor/canvas overlay) live here.

const browserAPI = (typeof browser !== 'undefined' ? browser : chrome) as typeof chrome;

// ── Sidepanel Port: keep-alive connection so background tracks open/closed state ──
// Background uses this to decide whether to route browser_thought to sidepanel or HUD
const _sidepanelPort = browserAPI.runtime.connect({ name: 'wt-sidepanel' });
// No-op disconnect handler; reconnect is not needed — page reload will reconnect
_sidepanelPort.onDisconnect.addListener(() => {});


// ── DOM refs ────────────────────────────────────────────────────────────────
const toolFeed      = document.getElementById('tool-feed-container')!;
const thoughtsFeed  = document.getElementById('thoughts-feed')!;
const notesList     = document.getElementById('notes-list')!;
const statusDot     = document.getElementById('status-dot')!;
const statusLabel   = document.getElementById('status-label')!;
const badgeDevmode  = document.getElementById('badge-devmode')!;
const notesInput    = document.getElementById('notes-input') as HTMLInputElement;
const btnSend       = document.getElementById('btn-send')!;


// ── State ───────────────────────────────────────────────────────────────────
let devModeEnabled = false;
let showScriptedCursorPill = true; // user preference for scripted HUD pills
const MAX_TOOL_ENTRIES   = 500;
const MAX_THOUGHT_ENTRIES = 200;

// ── Status helpers ───────────────────────────────────────────────────────────
type AgentStatus = 'idle' | 'weaving' | 'stuck' | 'done';

function setStatus(s: AgentStatus) {
  const map: Record<AgentStatus, { dot: string; label: string; color: string }> = {
    idle:    { dot: '#6b7280', label: 'IDLE',    color: '#6b7280' },
    weaving: { dot: '#3b82f6', label: 'WEAVING', color: '#3b82f6' },
    stuck:   { dot: '#f59e0b', label: 'STUCK',   color: '#f59e0b' },
    done:    { dot: '#10b981', label: 'DONE',     color: '#10b981' },
  };
  const { dot, label, color } = map[s] ?? map.idle;
  statusDot.style.background = dot;
  statusDot.style.boxShadow  = `0 0 6px ${dot}`;
  statusLabel.textContent    = label;
  statusLabel.style.color    = color;
}

// ── Tool call renderer ───────────────────────────────────────────────────────
const toolCallMap = new Map<string, HTMLElement>();

function upsertToolCall(payload: any) {
  const { name, status, args, result, id } = payload;
  const key = id ?? name;

  let el = toolCallMap.get(key);
  const isNew = !el;
  if (isNew) {
    el = document.createElement('div');
    el.className = 'tool-call';
    toolCallMap.set(key, el);
  }

  const statusMeta: Record<string, { icon: string; cls: string }> = {
    pending: { icon: '⏳', cls: 'status-pending' },
    done:    { icon: '✓',  cls: 'status-done'    },
    error:   { icon: '✗',  cls: 'status-error'   },
  };
  const { icon, cls } = statusMeta[status] ?? statusMeta.pending;

  const argStr = args ? JSON.stringify(args).slice(0, 150) : '';
  const resStr = result ? String(result).slice(0, 120) : '';
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  el!.innerHTML = `
    <div class="tool-header">
      <span style="font-weight:600;color:var(--text);">${escHtml(name ?? '?')}</span>
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="font-size:9px;color:var(--text-muted);">${ts}</span>
        <span class="${cls}">${icon}</span>
      </div>
    </div>
    ${argStr ? `<div class="tool-args">${escHtml(argStr)}</div>` : ''}
    ${resStr ? `<div class="tool-result ${cls}">${escHtml(resStr)}</div>` : ''}
  `;

  if (isNew) {
    const emptyEl = toolFeed.querySelector('.empty');
    if (emptyEl) emptyEl.remove();

    toolFeed.prepend(el!);
    // Trim excess entries
    while (toolFeed.children.length > MAX_TOOL_ENTRIES) {
      const last = toolFeed.lastElementChild;
      if (last) {
        const lastKey = [...toolCallMap.entries()].find(([, v]) => v === last)?.[0];
        if (lastKey) toolCallMap.delete(lastKey);
        last.remove();
      }
    }
  }
}

// ── Thought renderer ─────────────────────────────────────────────────────────
function appendThought(text: string, kind: 'thought' | 'action' = 'thought') {
  const emptyEl = thoughtsFeed.querySelector('.empty');
  if (emptyEl) emptyEl.remove();

  const el  = document.createElement('div');
  el.className = `thought-item thought-${kind}`;
  const ts  = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.innerHTML = `<span class="thought-ts">${ts}</span><span class="thought-text">${escHtml(text)}</span>`;
  thoughtsFeed.prepend(el);
  while (thoughtsFeed.children.length > MAX_THOUGHT_ENTRIES) {
    thoughtsFeed.lastElementChild?.remove();
  }
}

// ── Plan/task renderer ───────────────────────────────────────────────────────
function renderTasks(tasks: string[]) {
  notesList.innerHTML = '';
  if (!tasks?.length) {
    notesList.innerHTML = `<div class="task-item"><span class="task-icon" style="color:var(--text-muted)">○</span><span style="color:var(--text-muted)">No active mission</span></div>`;
    return;
  }
  tasks.forEach(task => {
    const el = document.createElement('div');
    el.className = 'task-item';
    el.innerHTML = `<span class="task-icon">◈</span><span>${escHtml(task)}</span>`;
    notesList.appendChild(el);
  });
}

// ── Message listener ─────────────────────────────────────────────────────────
browserAPI.runtime.onMessage.addListener((message: any) => {
  switch (message.type) {

    // Agent group state from background
    case 'Weavetab_GROUP_STATE':
    case 'WT_AGENT_STATUS': {
      const s = message.state ?? message.status;
      if (s === 'weaving' || s === 'idle' || s === 'stuck' || s === 'done') setStatus(s);
      break;
    }

    // State & tool action events
    case 'Weavetab_STATE': {
      if (message.hud?.action) {
        const actionText = String(message.hud.action).trim();
        if (actionText) {
          const status = actionText.startsWith('[ERR]') ? 'error' : (actionText.startsWith('[OK]') ? 'done' : 'pending');
          upsertToolCall({
            id: `wt-state-${Date.now()}-${Math.random()}`,
            name: actionText,
            status,
            timestamp: Date.now()
          });
        }
      }
      break;
    }

    // Tool call events forwarded from content/MCP
    case 'TOOL_CALL_EVENT':
    case 'WT_TOOL_CALL': {
      const payload = message.payload ?? message.data ?? message;
      if (payload?.name) upsertToolCall(payload);
      if (payload?.status === 'pending' || payload?.status === 'done') {
        setStatus(payload.status === 'pending' ? 'weaving' : 'weaving');
      }
      break;
    }

    // Thought / internal note from agent
    case 'WT_THOUGHT': {
      if (message.text) appendThought(message.text, message.kind ?? 'thought');
      break;
    }

    // Plan/task list update
    case 'WT_PLAN_UPDATE': {
      renderTasks(message.data?.tasks ?? []);
      break;
    }

    // Dev-mode toggle
    case 'WT_CONFIG_UPDATE':
    case 'Weavetab_CONFIG': {
      devModeEnabled = !!message.devMode;
      badgeDevmode.style.display = devModeEnabled ? 'inline-block' : 'none';
      break;
    }
  }
});

// ── Boot: restore persisted state ────────────────────────────────────────────
let masterVisualsEnabled = true;
const btnMasterVisuals = document.getElementById('btn-master-visuals') as HTMLButtonElement;
const btnScriptedPill = document.getElementById('btn-scripted-pill') as HTMLButtonElement;

browserAPI.storage.local.get(['wt_devMode', 'wt_plan', 'wt_agent_status', 'wt_scripted_pill', 'wt_master_visuals'], result => {
  devModeEnabled = !!result.wt_devMode;
  badgeDevmode.style.display = devModeEnabled ? 'inline-block' : 'none';
  if (result.wt_plan?.tasks) renderTasks(result.wt_plan.tasks);
  if (result.wt_agent_status) setStatus(result.wt_agent_status as AgentStatus);
  // Restore scripted pill preference (default: on)
  showScriptedCursorPill = result.wt_scripted_pill !== false;
  _syncScriptedPillBtn();

  // Restore master visuals preference (default: on)
  masterVisualsEnabled = result.wt_master_visuals !== false;
  _syncMasterVisualsBtn();
});

function _syncMasterVisualsBtn() {
  if (!btnMasterVisuals) return;
  if (masterVisualsEnabled) {
    btnMasterVisuals.textContent = 'Visuals: ON';
    btnMasterVisuals.classList.remove('off');
  } else {
    btnMasterVisuals.textContent = 'Visuals: OFF';
    btnMasterVisuals.classList.add('off');
  }
}

function _broadcastMasterVisualsToTabs(enabled: boolean) {
  browserAPI.runtime.sendMessage({ type: 'WT_TOGGLE_MASTER_VISUALS', enabled }).catch(() => {});
  browserAPI.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.id) {
        browserAPI.tabs.sendMessage(tab.id, { type: 'WT_TOGGLE_MASTER_VISUALS', enabled }).catch(() => {});
      }
    });
  });
}

if (btnMasterVisuals) {
  btnMasterVisuals.addEventListener('click', () => {
    masterVisualsEnabled = !masterVisualsEnabled;
    browserAPI.storage.local.set({ wt_master_visuals: masterVisualsEnabled });
    _syncMasterVisualsBtn();
    _broadcastMasterVisualsToTabs(masterVisualsEnabled);
  });
}

function _syncScriptedPillBtn() {
  if (!btnScriptedPill) return;
  btnScriptedPill.textContent = showScriptedCursorPill ? 'Cursor Pills: ON' : 'Cursor Pills: OFF';
  btnScriptedPill.style.opacity = showScriptedCursorPill ? '1' : '0.5';
}

function _broadcastScriptedPillToTabs(enabled: boolean) {
  // Relay setting to all active tab HUD iframes via content script
  browserAPI.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.id) {
        browserAPI.tabs.sendMessage(tab.id, { type: 'WT_SCRIPTED_PILL_TOGGLE', enabled }).catch(() => {});
      }
    });
  });
}

if (btnScriptedPill) {
  btnScriptedPill.addEventListener('click', () => {
    showScriptedCursorPill = !showScriptedCursorPill;
    browserAPI.storage.local.set({ wt_scripted_pill: showScriptedCursorPill });
    _syncScriptedPillBtn();
    _broadcastScriptedPillToTabs(showScriptedCursorPill);
  });
}


// ── Snipe Tool State & Event Handlers ─────────────────────────────────────
let currentSnipeMode: 'dom_target' | 'visual_crop' = 'dom_target';
let activeSnipePayload: any = null;

const btnSnipeTrigger = document.getElementById('btn-snipe-trigger') as HTMLButtonElement;
const snipePopover = document.getElementById('snipe-popover') as HTMLDivElement;
const popoverOptDom = document.getElementById('popover-opt-dom') as HTMLButtonElement;
const popoverOptVision = document.getElementById('popover-opt-vision') as HTMLButtonElement;
const snipeBadgeContainer = document.getElementById('snipe-badge-container') as HTMLDivElement;
const snipeBadgeContent = document.getElementById('snipe-badge-content') as HTMLDivElement;
const btnRemoveSnipe = document.getElementById('btn-remove-snipe') as HTMLButtonElement;

function toggleSnipePopover(e: MouseEvent) {
  e.stopPropagation();
  if (!snipePopover) return;
  const isHidden = snipePopover.style.display === 'none';
  snipePopover.style.display = isHidden ? 'flex' : 'none';
  if (btnSnipeTrigger) btnSnipeTrigger.classList.toggle('active', isHidden);
}

document.addEventListener('click', (e) => {
  if (snipePopover && snipePopover.style.display !== 'none') {
    if (!snipePopover.contains(e.target as Node) && e.target !== btnSnipeTrigger) {
      snipePopover.style.display = 'none';
      if (btnSnipeTrigger) btnSnipeTrigger.classList.remove('active');
    }
  }
});

if (btnSnipeTrigger) {
  btnSnipeTrigger.addEventListener('click', toggleSnipePopover);
}

function startSnipeWithMode(mode: 'dom_target' | 'visual_crop') {
  currentSnipeMode = mode;
  if (snipePopover) snipePopover.style.display = 'none';
  if (btnSnipeTrigger) btnSnipeTrigger.classList.add('active');

  // Update popover active item styles
  if (popoverOptDom) popoverOptDom.classList.toggle('active', mode === 'dom_target');
  if (popoverOptVision) popoverOptVision.classList.toggle('active', mode === 'visual_crop');

  browserAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      browserAPI.tabs.sendMessage(tabs[0].id, {
        type: 'WT_START_SNIPE',
        mode: currentSnipeMode
      }).catch(() => {});
    }
  });
}

if (popoverOptDom) {
  popoverOptDom.addEventListener('click', () => startSnipeWithMode('dom_target'));
}

if (popoverOptVision) {
  popoverOptVision.addEventListener('click', () => startSnipeWithMode('visual_crop'));
}

function clearSnipeAttachment() {
  activeSnipePayload = null;
  if (snipeBadgeContainer) snipeBadgeContainer.style.display = 'none';
  if (snipeBadgeContent) snipeBadgeContent.innerHTML = '';
  if (btnSnipeTrigger) btnSnipeTrigger.classList.remove('active');
}

if (btnRemoveSnipe) {
  btnRemoveSnipe.addEventListener('click', clearSnipeAttachment);
}

function renderSnipeBadge(payload: any) {
  activeSnipePayload = payload;
  if (btnSnipeTrigger) btnSnipeTrigger.classList.remove('active');
  if (!snipeBadgeContainer || !snipeBadgeContent) return;

  snipeBadgeContainer.style.display = 'flex';
  if (payload.mode === 'visual_crop' && payload.cropImage) {
    const dim = payload.boundingRect ? `${payload.boundingRect.width}×${payload.boundingRect.height}px` : 'WebP Image';
    const estTokens = payload.cropImage ? Math.round(payload.cropImage.length / 120) : 100;
    snipeBadgeContent.innerHTML = `
      <img class="snipe-badge-thumb" src="${payload.cropImage}" alt="crop preview" />
      <div class="snipe-badge-meta">
        <span class="snipe-badge-title">Vision Crop Attachment</span>
        <span class="snipe-badge-subtitle">${dim} • WebP Image (~${estTokens} tokens)</span>
      </div>
    `;
  } else {
    const elemCount = payload.elements?.length || 0;
    const firstTag = payload.elements?.[0]?.selector || payload.elements?.[0]?.tag || 'DOM Target';
    snipeBadgeContent.innerHTML = `
      <div class="snipe-badge-icon-box">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
      </div>
      <div class="snipe-badge-meta">
        <span class="snipe-badge-title">DOM Target Attachment</span>
        <span class="snipe-badge-subtitle">${elemCount} elements • 0 image tokens</span>
      </div>
    `;
  }
}

// Listen for completed snipe events from content script
browserAPI.runtime.onMessage.addListener((message: any) => {
  if (message.type === 'WT_SNIPE_COMPLETED' && message.payload) {
    renderSnipeBadge(message.payload);
  }
});

// ── Message agent ─────────────────────────────────────────────────────────────
function sendNote() {
  const txt = notesInput.value.trim();
  if (!txt && !activeSnipePayload) return;

  const payload: any = {
    type: 'WT_USER_NOTE',
    text: txt || '(Targeted area annotation sent)',
    ts: Date.now()
  };

  if (activeSnipePayload) {
    payload.snipe = activeSnipePayload;
  }

  browserAPI.runtime.sendMessage(payload).catch(() => {});
  appendThought(`[you] ${activeSnipePayload ? '[Snipe Attached] ' : ''}${txt || 'Annotation attached'}`, 'action');
  
  notesInput.value = '';
  clearSnipeAttachment();
}

btnSend.addEventListener('click', sendNote);
notesInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') sendNote();
});

// ── Util ────────────────────────────────────────────────────────────────────
function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Initial status
setStatus('idle');


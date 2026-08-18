// hud/src/realtime.ts — rAF-throttled RT channel
// Single pending slot per event type — always renders latest, never queues

const pending: Record<string, any> = {}
;(window as any).wtState = pending;

window.addEventListener('message', (e) => {
  const { type, ...data } = e.data
  if (type?.startsWith('RT_')) {
    pending[type] = data  // overwrite, don't queue
    return
  }
  handleLogicalMessage(type, data)
})

function handleLogicalMessage(type: string, data: any) {
  // Handle non-RT messages (state updates, widget commands, etc.)
  if (type === 'HUD_STATE_CHANGED') {
    // Widget state changes handled by widgets themselves
  }
  if (type === 'REHYDRATE') {
    // Restore HUD state from chrome.storage
    window.dispatchEvent(new CustomEvent('wt-rehydrate', { detail: data }))
  }
}

// Removed tick() loop - rendering is now handled centrally in canvas.ts

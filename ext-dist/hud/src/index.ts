// hud/src/index.ts — HUD entry point
// Tool Feed (top-right) and Notes Panel removed — they were broken and noisy.

import './realtime.js'
import './canvas.js'
import { initToggle, restoreVisibility } from './widgets/toggle.js'
import { initDebugMenu, restoreDebugVisibility } from './widgets/debugMenu.js'

// DevMode state
let devModeEnabled = false

// Check devMode from parent window
function checkDevMode() {
  try {
    const parentWindow = window.parent as any
    devModeEnabled = parentWindow.__wt_devMode === true
  } catch (e) {
    console.log('[Weavetab HUD] Could not check devMode:', e)
  }
}

// Initialize widgets
initToggle()
initDebugMenu()

// Initial devMode check
checkDevMode()

// Listen for config changes
window.addEventListener('message', (e) => {
  if (e.data.type === 'WT_CONFIG_UPDATE') {
    checkDevMode()
  }
})

// Handle REHYDRATE message from content script
window.addEventListener('message', (e) => {
  if (e.data.type === 'REHYDRATE') {
    const state = e.data.state || {}

    // Restore HUD visibility
    if (state.hudVisible !== undefined) {
      restoreVisibility(state.hudVisible)
    }

    // Restore debug menu visibility
    if (state.debugMenuVisible !== undefined) {
      restoreDebugVisibility(state.debugMenuVisible)
    }

    // Check devMode state
    checkDevMode()

    window.dispatchEvent(new CustomEvent('wt-rehydrate', { detail: state }))
  }
})

// Minimal API — tool feed removed, tracked via thought bubbles now
;(window as any).WeaveTabHUD = {}

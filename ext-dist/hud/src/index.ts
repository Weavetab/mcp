import './realtime.js'
import './canvas.js'
import { initToggle, restoreVisibility } from './widgets/toggle.js'
import { initDebugMenu, restoreDebugVisibility } from './widgets/debugMenu.js'

initToggle()
initDebugMenu()

window.addEventListener('message', (e) => {
  if (!e.data || typeof e.data !== 'object') return
  if (e.data.type === 'REHYDRATE') {
    const state = e.data.state || {}
    const hudVis = state.hudVisible !== false
    restoreVisibility(hudVis)
    window.parent.postMessage({ type: 'HUD_STATE_CHANGED', state: { hudVisible: hudVis } }, '*')

    if (state.debugMenuVisible !== undefined) {
      restoreDebugVisibility(state.debugMenuVisible)
    }
  }
})

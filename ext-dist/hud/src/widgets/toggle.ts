// hud/src/widgets/toggle.ts — HUD toggle command

let hudVisible = true

export function initToggle() {
  // Listen for toggle command from content script (parent window)
  window.addEventListener('message', (e) => {
    if (e.data.type === 'TOGGLE_HUD') {
      toggleHUD()
    }
  })

  // Also listen directly from window (in case of direct calls)
  ;(window as any).toggleHUD = toggleHUD
}

export function toggleHUD() {
  hudVisible = !hudVisible

  const canvas = document.getElementById('rt-canvas')
  const widgets = document.getElementById('widgets')

  if (canvas) {
    canvas.style.display = hudVisible ? 'block' : 'none'
  }
  if (widgets) {
    widgets.style.display = hudVisible ? 'block' : 'none'
  }

  // Persist state via content script
  window.parent.postMessage({
    type: 'HUD_STATE_CHANGED',
    state: { hudVisible }
  }, '*')
}

export function restoreVisibility(visible: boolean) {
  hudVisible = visible

  const canvas = document.getElementById('rt-canvas')
  const widgets = document.getElementById('widgets')

  if (canvas) {
    canvas.style.display = hudVisible ? 'block' : 'none'
  }
  if (widgets) {
    widgets.style.display = hudVisible ? 'block' : 'none'
  }
}

const pending: Record<string, any> = {}
;(window as any).wtState = pending

window.addEventListener('message', (e) => {
  if (!e.data || typeof e.data !== 'object') return
  const { type, ...data } = e.data
  if (typeof type === 'string' && type.startsWith('RT_')) {
    pending[type] = data
    return
  }
  handleLogicalMessage(type, data)
})

function handleLogicalMessage(type: string, data: any) {
  if (type === 'WT_HUD_UPDATE') {
    updateHudBadge(data.state || data.action || data.badge, data.detail || data.groupState)
  }
}

function updateHudBadge(state?: string, detail?: string) {
  const host = document.getElementById('widgets')
  if (!host) return
  let badge = document.getElementById('wt-plugin-hud-badge')
  if (!state || state === 'idle') {
    if (badge) badge.remove()
    return
  }
  if (!badge) {
    badge = document.createElement('div')
    badge.id = 'wt-plugin-hud-badge'
    badge.style.cssText = 'position:fixed;bottom:14px;right:14px;padding:5px 10px;border-radius:999px;background:rgba(15,23,42,0.88);border:1px solid rgba(59,130,246,0.45);color:#e2e8f0;font-size:11px;display:flex;align-items:center;gap:6px;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,0.35);'
    host.appendChild(badge)
  }
  badge.textContent = detail ? `${state}: ${detail}` : state
}

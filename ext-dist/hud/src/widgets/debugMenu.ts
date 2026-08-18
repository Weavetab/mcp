// hud/src/widgets/debugMenu.ts — Debug menu overlay with Ctrl+F3

let debugMenuVisible = false
let container: HTMLElement | null = null
let consoleOutput: HTMLElement | null = null
let activeTab = 'console'

export function initDebugMenu() {
  console.log('[Weavetab HUD] Debug menu initialized')
  
  // Listen for toggle command from content script
  window.addEventListener('message', (e) => {
    console.log('[Weavetab HUD] Received message:', e.data.type)
    if (e.data.type === 'TOGGLE_DEBUG') {
      console.log('[Weavetab HUD] Toggling debug menu')
      toggleDebugMenu()
    }
  })

  // Also listen from parent (content script) via postMessage
  ;(window as any).toggleDebugMenu = toggleDebugMenu
  
  console.log('[Weavetab HUD] Debug menu ready - use Ctrl+F3 or WeaveTabHUD.toggleDebugMenu()')
}

export function toggleDebugMenu() {
  console.log('[Weavetab HUD] toggleDebugMenu called, current state:', debugMenuVisible)
  debugMenuVisible = !debugMenuVisible

  if (!container) {
    console.log('[Weavetab HUD] Creating debug menu container')
    createDebugMenu()
  }

  if (container) {
    container.style.display = debugMenuVisible ? 'flex' : 'none'
    console.log('[Weavetab HUD] Debug menu visibility set to:', debugMenuVisible)
  }

  // Persist state
  window.parent.postMessage({
    type: 'HUD_STATE_CHANGED',
    state: { debugMenuVisible }
  }, '*')
}

function createDebugMenu() {
  container = document.createElement('div')
  container.id = 'wt-debug-menu'
  container.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 700px;
    max-height: 80vh;
    background: rgba(17, 17, 19, 0.98);
    border: 1px solid #3b82f6;
    border-radius: 8px;
    pointer-events: auto;
    z-index: 1000;
    display: none;
    flex-direction: column;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    color: #e8e8f0;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
  `

  // Header
  const header = document.createElement('div')
  header.style.cssText = `
    padding: 12px 16px;
    border-bottom: 1px solid #2a2a30;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: rgba(59, 130, 246, 0.1);
  `
  header.innerHTML = `
    <span style="color: #60a5fa; font-weight: 600;">🔧 WeaveTab Debug Menu</span>
    <span style="color: #6b7280; font-size: 10px;">Ctrl+F3 to toggle</span>
  `
  container.appendChild(header)

  // Tabs
  const tabs = document.createElement('div')
  tabs.style.cssText = `
    display: flex;
    border-bottom: 1px solid #2a2a30;
    padding: 8px 16px;
    gap: 4px;
  `

  const tabNames = ['Console', 'State', 'Actions', 'Network']
  tabNames.forEach((tabName, index) => {
    const tab = document.createElement('button')
    tab.textContent = tabName
    tab.dataset.tab = tabName.toLowerCase()
    tab.style.cssText = `
      padding: 6px 12px;
      background: ${index === 0 ? '#3b82f6' : 'transparent'};
      border: none;
      color: ${index === 0 ? '#fff' : '#9ca3af'};
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-family: inherit;
    `
    tab.onclick = () => switchTab(tabName.toLowerCase())
    tabs.appendChild(tab)
  })
  container.appendChild(tabs)

  // Content area
  const content = document.createElement('div')
  content.id = 'wt-debug-content'
  content.style.cssText = `
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    min-height: 300px;
  `

  consoleOutput = document.createElement('div')
  consoleOutput.id = 'wt-debug-console'
  consoleOutput.style.cssText = `
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    line-height: 1.4;
  `
  consoleOutput.innerHTML = `
    <div style="color: #6b7280;">[Debug Console Ready]</div>
    <div style="color: #6b7280;">Press Ctrl+F3 to close this menu</div>
    <div style="color: #6b7280; margin-top: 8px;">Use browserAsk to test messaging system</div>
  `
  content.appendChild(consoleOutput)
  container.appendChild(content)

  // Footer with actions
  const footer = document.createElement('div')
  footer.style.cssText = `
    padding: 8px 16px;
    border-top: 1px solid #2a2a30;
    display: flex;
    gap: 8px;
  `

  const actionButtons = [
    { label: 'Clear', color: '#6b7280', action: () => clearConsole() },
    { label: 'Test Ask', color: '#3b82f6', action: () => testAskSystem() },
    { label: 'Export', color: '#22c55e', action: () => exportLogs() }
  ]

  actionButtons.forEach(btn => {
    const button = document.createElement('button')
    button.textContent = btn.label
    button.style.cssText = `
      padding: 4px 12px;
      background: transparent;
      border: 1px solid ${btn.color};
      color: ${btn.color};
      border-radius: 4px;
      cursor: pointer;
      font-size: 10px;
      font-family: inherit;
    `
    button.onclick = btn.action
    footer.appendChild(button)
  })

  container.appendChild(footer)

  document.getElementById('widgets')!.appendChild(container)
}

function switchTab(tabName: string) {
  activeTab = tabName
  const tabs = container?.querySelectorAll('button[dataset-tab]')
  tabs?.forEach(tab => {
    const isActive = (tab as HTMLElement).dataset.tab === tabName
    ;(tab as HTMLElement).style.background = isActive ? '#3b82f6' : 'transparent'
    ;(tab as HTMLElement).style.color = isActive ? '#fff' : '#9ca3af'
  })

  if (consoleOutput) {
    if (tabName === 'console') {
      consoleOutput.style.display = 'block'
    } else {
      consoleOutput.style.display = 'none'
      consoleOutput.innerHTML = `<div style="color: #6b7280;">[${tabName.charAt(0).toUpperCase() + tabName.slice(1)} Tab - Coming Soon]</div>`
    }
  }
}

function clearConsole() {
  if (consoleOutput) {
    consoleOutput.innerHTML = '<div style="color: #6b7280;">[Console Cleared]</div>'
  }
}

function testAskSystem() {
  logToConsole('Testing ask system...', 'info')
  window.parent.postMessage({
    type: 'TEST_ASK_SYSTEM'
  }, '*')
}

function exportLogs() {
  logToConsole('Exporting logs...', 'info')
  if (consoleOutput) {
    const logs = consoleOutput.innerText
    const blob = new Blob([logs], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'weavetab-debug-logs.txt'
    a.click()
    URL.revokeObjectURL(url)
    logToConsole('Logs exported successfully', 'info')
  }
}

export function logToConsole(message: string, type: 'info' | 'warn' | 'error' = 'info') {
  if (!consoleOutput) return

  const colors = {
    info: '#60a5fa',
    warn: '#f59e0b',
    error: '#ef4444'
  }

  const timestamp = new Date().toLocaleTimeString()
  const logEntry = document.createElement('div')
  logEntry.style.cssText = `
    margin-bottom: 4px;
    color: ${colors[type]};
  `
  logEntry.innerHTML = `<span style="color: #6b7280;">[${timestamp}]</span> ${message}`
  consoleOutput.appendChild(logEntry)
  consoleOutput.scrollTop = consoleOutput.scrollHeight
}

export function restoreDebugVisibility(visible: boolean) {
  debugMenuVisible = visible
  if (container) {
    container.style.display = debugMenuVisible ? 'flex' : 'none'
  }
}

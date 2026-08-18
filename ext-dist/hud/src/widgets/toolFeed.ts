// hud/src/widgets/toolFeed.ts — Tool call feed widget

interface ToolCall {
  id: string
  name: string
  status: 'pending' | 'done' | 'error'
  timestamp: number
}

const MAX_CALLS = 10
const AUTO_COLLAPSE_MS = 30000

let toolCalls: ToolCall[] = []
let container: HTMLElement | null = null

export function initToolFeed() {
  container = document.createElement('div')
  container.id = 'wt-tool-feed'
  container.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    width: 280px;
    max-height: 300px;
    overflow-y: auto;
    background: rgba(17, 17, 19, 0.75);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
    pointer-events: auto;
    z-index: 100;
    font-family: 'Inter', sans-serif;
    font-size: 12px;
    color: #e2e8f0;
    transition: all 0.3s ease;
  `

  const header = document.createElement('div')
  header.style.cssText = `
    padding: 8px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    font-weight: 600;
    color: #3b82f6;
    letter-spacing: 0.5px;
  `
  header.textContent = 'Tool Calls'
  container.appendChild(header)

  const list = document.createElement('div')
  list.id = 'wt-tool-list'
  list.style.cssText = `
    padding: 4px;
  `
  container.appendChild(list)

  document.getElementById('widgets')!.appendChild(container)

  // Load persisted state
  loadState()

  // Start auto-collapse timer
  setInterval(autoCollapse, 5000)
}

export function addToolCall(name: string, id: string) {
  const call: ToolCall = {
    id,
    name,
    status: 'pending',
    timestamp: Date.now()
  }

  toolCalls.unshift(call)
  if (toolCalls.length > MAX_CALLS) {
    toolCalls.pop()
  }

  render()
  saveState()
}

export function updateToolCallStatus(id: string, status: 'done' | 'error') {
  const call = toolCalls.find(c => c.id === id)
  if (call) {
    call.status = status
    render()
    saveState()
  }
}

function render() {
  const list = document.getElementById('wt-tool-list')
  if (!list) return

  list.innerHTML = ''

  toolCalls.forEach(call => {
    const item = document.createElement('div')
    item.style.cssText = `
      padding: 6px 8px;
      margin-bottom: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.03);
      transition: background 0.2s ease;
    `

    const statusColor = call.status === 'done' ? '#22c55e' : call.status === 'error' ? '#ef4444' : '#f59e0b'
    const statusDot = document.createElement('div')
    statusDot.style.cssText = `
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: ${statusColor};
      box-shadow: 0 0 8px ${statusColor}88;
      transition: all 0.3s ease;
    `
    item.appendChild(statusDot)

    const name = document.createElement('span')
    name.textContent = call.name
    name.style.cssText = `
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
    `
    item.appendChild(name)

    const time = document.createElement('span')
    const age = Math.floor((Date.now() - call.timestamp) / 1000)
    time.textContent = age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`
    time.style.cssText = `
      color: #6b7280;
      font-size: 10px;
    `
    item.appendChild(time)

    list.appendChild(item)
  })
}

function autoCollapse() {
  const now = Date.now()
  const originalLength = toolCalls.length
  toolCalls = toolCalls.filter(call => now - call.timestamp < AUTO_COLLAPSE_MS)
  
  if (toolCalls.length !== originalLength) {
    render()
    saveState()
  }
}

function saveState() {
  window.parent.postMessage({
    type: 'HUD_STATE_CHANGED',
    state: { toolCalls }
  }, '*')
}

function loadState() {
  // State is loaded via wt-rehydrate custom event
  window.addEventListener('wt-rehydrate', (e: Event) => {
    const customEvent = e as CustomEvent
    if (customEvent.detail?.toolCalls) {
      toolCalls = customEvent.detail.toolCalls
      render()
    }
  })
}

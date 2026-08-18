// hud/src/widgets/notesPanel.ts — Agent notes panel (user-only, persisted)

let textarea: HTMLTextAreaElement | null = null
let container: HTMLElement | null = null
let saveTimeout: number | null = null

export function initNotesPanel() {
  container = document.createElement('div')
  container.id = 'wt-notes-panel'
  container.style.cssText = `
    position: fixed;
    bottom: 10px;
    right: 10px;
    width: 300px;
    height: 200px;
    background: rgba(17, 17, 19, 0.75);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
    pointer-events: auto;
    z-index: 100;
    display: flex;
    flex-direction: column;
    font-family: 'Inter', sans-serif;
    transition: all 0.3s ease;
  `

  const header = document.createElement('div')
  header.style.cssText = `
    padding: 8px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    font-weight: 600;
    color: #3b82f6;
    letter-spacing: 0.5px;
    font-size: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  `
  header.innerHTML = '<span>Agent Notes</span><span style="color:#6b7280;font-size:10px">(private)</span>'
  container.appendChild(header)

  textarea = document.createElement('textarea')
  textarea.placeholder = 'Type notes here... (visible only to you)'
  textarea.style.cssText = `
    flex: 1;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid transparent;
    border-radius: 4px;
    margin: 8px;
    color: #e2e8f0;
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    line-height: 1.5;
    padding: 8px 10px;
    resize: none;
    outline: none;
  `
  textarea.addEventListener('input', () => {
    // Debounced save
    if (saveTimeout) clearTimeout(saveTimeout)
    saveTimeout = window.setTimeout(() => {
      saveState()
    }, 300)
  })
  container.appendChild(textarea)

  document.getElementById('widgets')!.appendChild(container)

  // Load persisted state
  loadState()
}

function saveState() {
  if (!textarea) return
  window.parent.postMessage({
    type: 'HUD_STATE_CHANGED',
    state: { notes: textarea.value }
  }, '*')
}

function loadState() {
  window.addEventListener('wt-rehydrate', (e: Event) => {
    const customEvent = e as CustomEvent
    if (customEvent.detail?.notes !== undefined && textarea) {
      textarea.value = customEvent.detail.notes
    }
  })
}

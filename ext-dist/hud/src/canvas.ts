const canvas = document.getElementById('rt-canvas') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!

let targetX = window.innerWidth / 2
let targetY = window.innerHeight / 2
let currX = targetX
let currY = targetY
let velX = 0
let velY = 0
let phase = 'idle'
let showScriptedCursorPill = true

window.addEventListener('message', function(e: MessageEvent) {
  if (!e.data || typeof e.data !== 'object') return
  if (e.data.type === 'WT_SCRIPTED_PILL_TOGGLE') {
    showScriptedCursorPill = !!e.data.enabled
  }
})

const clickWaves: { x: number; y: number; radius: number; alpha: number }[] = []

let scrollY = 0
let scrollRatio = 0
let scrollDirty = false

function resizeCanvas() {
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  scrollDirty = true
}
window.addEventListener('resize', resizeCanvas)
resizeCanvas()

const STIFFNESS = 0.15
const DAMPING = 0.6
let clickJitterTime = 0
let lastCursorX = targetX
let lastCursorY = targetY

function renderLoop() {
  const wtState = (window as any).wtState || {}
  if (wtState.RT_CURSOR_MOVE) {
    targetX = wtState.RT_CURSOR_MOVE.x
    targetY = wtState.RT_CURSOR_MOVE.y
    phase = wtState.RT_CURSOR_MOVE.phase || 'idle'
    delete wtState.RT_CURSOR_MOVE
  }

  if (wtState.RT_CLICK) {
    spawnClickWaves(wtState.RT_CLICK.x, wtState.RT_CLICK.y)
    phase = 'clicking'
    clickJitterTime = Date.now()
    setTimeout(() => { if (phase === 'clicking') phase = 'idle' }, 300)
    delete wtState.RT_CLICK
  }

  if (wtState.RT_SCROLL) {
    scrollY = wtState.RT_SCROLL.y
    if (scrollRatio !== wtState.RT_SCROLL.ratio) {
      scrollRatio = wtState.RT_SCROLL.ratio
      scrollDirty = true
    }
    delete wtState.RT_SCROLL
  }

  const hasActivity = clickWaves.length > 0 ||
    phase !== 'idle' ||
    Math.abs(targetX - lastCursorX) > 0.5 ||
    Math.abs(targetY - lastCursorY) > 0.5
  lastCursorX = targetX
  lastCursorY = targetY

  if (!hasActivity) {
    if (scrollDirty) {
      scrollDirty = false
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (showScriptedCursorPill && scrollRatio > 0 && scrollRatio < 1) {
        drawScroll()
      }
    }
    requestAnimationFrame(renderLoop)
    return
  }

  scrollDirty = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  velX += (targetX - currX) * STIFFNESS
  velY += (targetY - currY) * STIFFNESS
  velX *= DAMPING
  velY *= DAMPING

  const now = Date.now()
  if (phase === 'clicking' && now - clickJitterTime < 300) {
    const jitterAmount = 2.5
    targetX += (Math.random() - 0.5) * jitterAmount
    targetY += (Math.random() - 0.5) * jitterAmount
    const clickPhase = (now - clickJitterTime) / 50
    targetX += Math.sin(clickPhase)
    targetY += Math.cos(clickPhase)
  }

  currX += velX
  currY += velY

  if (showScriptedCursorPill) {
    drawClickWaves()
    drawScroll()
  }

  requestAnimationFrame(renderLoop)
}

function spawnClickWaves(x: number, y: number) {
  for (let i = 0; i < 3; i++) {
    setTimeout(() => {
      clickWaves.push({ x, y, radius: 0, alpha: 1.0 })
    }, i * 100)
  }
}

function drawClickWaves() {
  for (let i = clickWaves.length - 1; i >= 0; i--) {
    const wave = clickWaves[i]
    wave.radius += 3
    wave.alpha -= 0.015

    if (wave.alpha <= 0) {
      clickWaves.splice(i, 1)
      continue
    }

    ctx.beginPath()
    ctx.arc(wave.x, wave.y, wave.radius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(59, 130, 246, ${wave.alpha})`
    ctx.lineWidth = 3
    ctx.shadowColor = '#3b82f6'
    ctx.shadowBlur = 10
    ctx.stroke()
  }
}

function drawScroll() {
  if (scrollRatio <= 0 || scrollRatio >= 1) return
  const barWidth = 4
  const barHeight = 60
  const x = canvas.width - barWidth - 10
  const y = 10 + (canvas.height - barHeight - 20) * scrollRatio
  ctx.fillStyle = 'rgba(59, 130, 246, 0.5)'
  ctx.beginPath()
  ctx.roundRect(x, y, barWidth, barHeight, 2)
  ctx.fill()
}

requestAnimationFrame(renderLoop)

// hud/src/canvas.ts — Advanced Visual rendering functions for HUD

const canvas = document.getElementById('rt-canvas') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!

// State
let targetX = window.innerWidth / 2;
let targetY = window.innerHeight / 2;
let currX = targetX;
let currY = targetY;
let velX = 0;
let velY = 0;
let phase = 'idle';
let currentToolName = '';

// ── Routing state (set by content.js via postMessage) ──
// True when sidepanel is open — browser_thought pill routes there instead
let isSidepanelOpen = false;
// True when user wants scripted cursor pills to show (Typing..., Clicking..., etc.)
let showScriptedCursorPill = true;
// One-shot flag: background sent WT_SUPPRESS_THOUGHT_HUD for current event
let suppressNextThoughtPill = false;

// Listen for sidepanel state + suppression from content.js relay
window.addEventListener('message', function(e: MessageEvent) {
  if (!e.data) return;
  if (e.data.type === 'WT_SIDEPANEL_STATE') {
    isSidepanelOpen = !!e.data.open;
    // When sidepanel opens, clear any in-progress thought pill immediately
    if (isSidepanelOpen) currentToolName = '';
  }
  if (e.data.type === 'WT_SUPPRESS_THOUGHT_HUD') {
    suppressNextThoughtPill = true;
    currentToolName = '';
  }
  // User toggled scripted pill setting from sidepanel settings
  if (e.data.type === 'WT_SCRIPTED_PILL_TOGGLE') {
    showScriptedCursorPill = !!e.data.enabled;
  }
});

// Dictionary of dynamic tool thoughts
const toolThoughts: Record<string, string[]> = {
  // Navigation & Core
  'browser_navigate': ['Navigating to URL...', 'Loading page...', 'Waiting for network...', 'Fetching content...'],
  'browser_wait': ['Waiting for DOM...', 'Idling...', 'Pausing execution...', 'Awaiting network idle...'],
  'browser_tabs': ['Managing tabs...', 'Switching context...', 'Checking open tabs...'],
  'browser_viewport': ['Adjusting viewport...', 'Resizing window...', 'Setting resolution...'],
  
  // Mapping & Analysis
  'browser_map': ['Mapping page elements...', 'Analyzing layout...', 'Looking around...', 'Building DOM tree...'],
  'browser_inspect': ['Inspecting element...', 'Reading CSS properties...', 'Checking attributes...'],
  'browser_detect': ['Running visual detection...', 'Scanning for objects...', 'Analyzing pixels...'],
  'browser_find': ['Finding text...', 'Searching DOM...', 'Locating element...'],
  'browser_highlight': ['Highlighting element...', 'Focusing...', 'Selecting node...'],
  
  // Interaction
  'browser_click': ['Clicking element...', 'Interacting...', 'Triggering action...'],
  'browser_click_and_wait': ['Clicking and waiting...', 'Triggering action...', 'Awaiting navigation...'],
  'browser_type': ['Typing text...', 'Entering data...', 'Filling input...'],
  'browser_type_secret': ['Entering secure data...', 'Typing credentials...', 'Masking input...'],
  'browser_key': ['Pressing key...', 'Sending keystroke...', 'Triggering shortcut...'],
  'browser_scroll': ['Scrolling down...', 'Moving view...', 'Reading more...'],
  'browser_pointer': ['Moving pointer...', 'Hovering...', 'Adjusting cursor...'],
  'browser_select': ['Selecting option...', 'Choosing from dropdown...', 'Updating select...'],
  'browser_fill': ['Filling form...', 'Populating fields...', 'Entering structured data...'],
  'browser_dialog': ['Handling dialog...', 'Dismissing alert...', 'Accepting prompt...'],
  
  // Data Extraction & Media
  'browser_scrape': ['Scraping content...', 'Extracting data...', 'Parsing HTML...'],
  'browser_snapshot': ['Taking snapshot...', 'Capturing DOM state...', 'Saving page tree...'],
  'browser_screenshot': ['Taking screenshot...', 'Capturing pixels...', 'Generating data URL...'],
  'browser_pdf': ['Generating PDF...', 'Printing to PDF...', 'Saving document...'],
  'browser_canvas': ['Reading canvas...', 'Extracting image data...', 'Analyzing canvas pixels...'],
  
  // Advanced / DevTools
  'browser_eval': ['Executing script...', 'Running JavaScript...', 'Evaluating in page...'],
  'browser_console': ['Reading console...', 'Checking logs...', 'Monitoring errors...'],
  'browser_network_intercept': ['Intercepting network...', 'Modifying requests...', 'Mocking responses...'],
  'browser_storage': ['Accessing local storage...', 'Reading session data...', 'Modifying IndexedDB...'],
  'browser_cookies': ['Managing cookies...', 'Reading session cookies...', 'Clearing cookies...'],
  'browser_clipboard': ['Accessing clipboard...', 'Copying text...', 'Pasting content...'],
  
  // High-Level Logic
  'browser_thought': ['Thinking...', 'Processing query...', 'Asking question...'],
  'browser_burst': ['Executing burst actions...', 'Running macro...', 'Batching commands...'],
  'browser_macro_compile': ['Compiling macro...', 'Optimizing action sequence...', 'Building script...'],
  'browser_automation': ['Running automation...', 'Executing workflow...', 'Processing sequence...'],
  'browser_performance': ['Profiling performance...', 'Measuring layout shifts...', 'Analyzing render time...'],
  'browser_reset_loop_counter': ['Resetting loops...', 'Clearing state...', 'Restarting sequence...'],
  
  // GitHub Integration
  'github_analyze': ['Analyzing repository...', 'Reading source code...', 'Checking structure...'],
  'github_read': ['Reading file...', 'Fetching blob...', 'Parsing code...'],
  'github_issues': ['Checking issues...', 'Reading tickets...', 'Fetching discussions...'],
  'github_get_pr': ['Fetching Pull Request...', 'Reading diff...', 'Analyzing changes...'],
  
  // System
  'browser_upload': ['Uploading file...', 'Transferring data...', 'Sending payload...'],
  // browser_feedback merged into browser_thought
  
  'default': ['Processing...', 'Working...', 'Executing tool...', 'Computing...']
};

function getThoughtText(toolName: string): string {
  const thoughts = toolThoughts[toolName] || toolThoughts['default'];
  const cycleIndex = Math.floor(Date.now() / 1500) % thoughts.length;
  return thoughts[cycleIndex];
}

// Trail & Particles
const trail: { x: number; y: number; age: number }[] = []
const particles: { x: number; y: number; vx: number; vy: number; life: number; color: string }[] = []

// Click waves/ripples
const clickWaves: { x: number; y: number; radius: number; alpha: number }[] = []

// Scroll state
let scrollY = 0
let scrollRatio = 0

// Resize canvas
function resizeCanvas() {
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
}
window.addEventListener('resize', resizeCanvas)
resizeCanvas()

// Helper: spring physics
const STIFFNESS = 0.15;
const DAMPING = 0.6;

// Realistic movement patterns
let searchTime = 0;
let searchPhase = 0;
let clickJitterTime = 0;

// Typing animation state
let typingDots = 0;
let typingAnimTime = 0;

// Idle detection - skip rendering when nothing is happening
let lastCursorX = 0, lastCursorY = 0;
let isIdle = true;

// Main render loop
function renderLoop() {
  // 1. Process pending RT messages from realtime.ts
  const wtState = (window as any).wtState || {};
  if (wtState.RT_CURSOR_MOVE) {
    targetX = wtState.RT_CURSOR_MOVE.x;
    targetY = wtState.RT_CURSOR_MOVE.y;
    phase = wtState.RT_CURSOR_MOVE.phase || 'idle';
    delete wtState.RT_CURSOR_MOVE; // consumed
  }
  
  if (wtState.RT_CLICK) {
    spawnParticles(wtState.RT_CLICK.x, wtState.RT_CLICK.y, '#3b82f6');
    phase = 'clicking';
    clickJitterTime = Date.now();
    setTimeout(() => { if (phase === 'clicking') phase = 'idle'; }, 300);
    delete wtState.RT_CLICK; // consumed
  }
  
  if (wtState.RT_SCROLL) {
    scrollY = wtState.RT_SCROLL.y;
    scrollRatio = wtState.RT_SCROLL.ratio;
    delete wtState.RT_SCROLL;
  }



  // Idle detection: skip full render when nothing has changed
  const hasActivity = particles.length > 0 || clickWaves.length > 0 ||
    currentToolName || phase !== 'idle' ||
    Math.abs(targetX - lastCursorX) > 0.5 || Math.abs(targetY - lastCursorY) > 0.5;
  lastCursorX = targetX; lastCursorY = targetY;

  if (!hasActivity) {
    // Still update scroll indicator minimally
    if (scrollRatio > 0 && scrollRatio < 1) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawScroll();
    }
    requestAnimationFrame(renderLoop);
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 2. Update Physics with realistic movement patterns
  velX += (targetX - currX) * STIFFNESS;
  velY += (targetY - currY) * STIFFNESS;
  velX *= DAMPING;
  velY *= DAMPING;
  
  // Add realistic movement based on phase
  const now = Date.now();
  
  // Searching/reading behavior - more pronounced scanning movement
  if (currentToolName && phase !== 'typing' && phase !== 'clicking') {
    searchTime += 0.016;
    searchPhase += 0.03;
    // Enhanced Lissajous curve movement for "searching" effect
    const searchAmp = 3;
    targetX += Math.sin(searchPhase) * searchAmp;
    targetY += Math.cos(searchPhase * 0.7) * searchAmp;
    
    // Add occasional "reading" pauses
    if (Math.random() < 0.02) {
      searchPhase += 0.5; // Skip ahead to simulate pausing
    }
  }
  
  // Clicking jitter - enhanced human-like micro-movements during click
  if (phase === 'clicking' && now - clickJitterTime < 300) {
    const jitterAmount = 2.5;
    const jitterX = (Math.random() - 0.5) * jitterAmount;
    const jitterY = (Math.random() - 0.5) * jitterAmount;
    targetX += jitterX;
    targetY += jitterY;
    
    // Add circular motion during click for more natural feel
    const clickPhase = (now - clickJitterTime) / 50;
    targetX += Math.sin(clickPhase) * 1;
    targetY += Math.cos(clickPhase) * 1;
  }
  
  currX += velX;
  currY += velY;

  if (showScriptedCursorPill) {
    // Click waves when agent clicks
    drawClickWaves();
  }

  // 6. Draw Emote/Status (handles its own gating)
  drawEmote();

  // 7. Draw Scroll Indicator
  if (showScriptedCursorPill) {
    drawScroll();
  }

  requestAnimationFrame(renderLoop)
}

function spawnParticles(x: number, y: number, color: string) {
  for (let i = 0; i < 15; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 4 + 1;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      color
    });
  }
  
  // Spawn click waves/ripples
  for (let i = 0; i < 3; i++) {
    setTimeout(() => {
      clickWaves.push({
        x, y,
        radius: 0,
        alpha: 1.0
      });
    }, i * 100);
  }
}

function drawRibbon() {
  if (trail.length < 2) return;
  
  ctx.beginPath();
  ctx.moveTo(trail[0].x, trail[0].y);
  
  for (let i = 1; i < trail.length - 1; i++) {
    const xc = (trail[i].x + trail[i + 1].x) / 2;
    const yc = (trail[i].y + trail[i + 1].y) / 2;
    ctx.quadraticCurveTo(trail[i].x, trail[i].y, xc, yc);
  }
  ctx.lineTo(trail[trail.length - 1].x, trail[trail.length - 1].y);
  
  // Enhanced gradient with better visibility
  const gradient = ctx.createLinearGradient(
    trail[0].x, trail[0].y,
    trail[trail.length - 1].x, trail[trail.length - 1].y
  );
  
  // Blue gradient that fades based on phase
  if (phase === 'idle') {
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0.6)');
  } else {
    gradient.addColorStop(0, 'rgba(59, 130, 246, 0)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0.9)');
  }
  
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 4; // Thicker trail for better visibility
  ctx.lineCap = 'round';
  ctx.stroke();

  // Age trail points
  for (let i = trail.length - 1; i >= 0; i--) {
    trail[i].age += 0.04; // Slower aging for longer trail
    if (trail[i].age > 1) {
      trail.splice(i, 1);
    }
  }
}

function drawParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.1; // gravity
    p.life -= 0.03;

    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }

    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0.5, p.life * 3), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(59, 130, 246, ${p.life})`;
    ctx.fill();
  }
}

function drawClickWaves() {
  for (let i = clickWaves.length - 1; i >= 0; i--) {
    const wave = clickWaves[i];
    wave.radius += 3; // Faster expansion
    wave.alpha -= 0.015; // Slower fade for longer visibility

    if (wave.alpha <= 0) {
      clickWaves.splice(i, 1);
      continue;
    }

    ctx.beginPath();
    ctx.arc(wave.x, wave.y, wave.radius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(59, 130, 246, ${wave.alpha})`;
    ctx.lineWidth = 3; // Thicker waves
    ctx.shadowColor = '#3b82f6';
    ctx.shadowBlur = 10;
    ctx.stroke();
  }
}

function drawCursor() {
  // Cursor removed from browser visuals
  return;
}

function drawEmote() {
  // Floating on-page text pills removed — all tool calls/thoughts display inside sidepanel logs
  return;
}

function drawScroll() {
  if (scrollRatio <= 0 || scrollRatio >= 1) return;
  const barWidth = 4;
  const barHeight = 60;
  const x = canvas.width - barWidth - 10;
  const y = 10 + (canvas.height - barHeight - 20) * scrollRatio;
  ctx.fillStyle = 'rgba(59, 130, 246, 0.5)';
  ctx.beginPath();
  ctx.roundRect(x, y, barWidth, barHeight, 2);
  ctx.fill();
}

// Start loop
requestAnimationFrame(renderLoop);

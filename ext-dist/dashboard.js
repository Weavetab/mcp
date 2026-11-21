const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
const urlParams = new URLSearchParams(window.location.search);
const branch = urlParams.get('branch') || 'default';
const branchEl = document.getElementById('branch-display');
if (branchEl) branchEl.textContent = `branch: ${branch}`;

class WeavetabVoiceSystem {
  constructor() {
    this.orb = document.getElementById('voice-orb');
    this.status = document.getElementById('status-text');
    this.transcript = document.getElementById('transcript-text');
    this.btnListen = document.getElementById('btn-listen');
    this.trigger = document.getElementById('voice-trigger');
    this.isListening = false;
    this.isSpeaking = false;
    this.hasError = false;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      this.status.textContent = 'Speech API not supported';
      this.status.style.color = '#ef4444';
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.btnListen.addEventListener('click', () => this.toggleListening());
    this.trigger.addEventListener('click', () => this.toggleListening());
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'BUTTON') {
        e.preventDefault();
        this.toggleListening();
      }
    });

    this.recognition.onstart = () => {
      this.hasError = false;
      this.isListening = true;
      this.updateUI('listening');
    };
    this.recognition.onresult = (event) => {
      const result = event.results[0][0].transcript;
      this.transcript.textContent = `"${result}"`;
      if (event.results[0].isFinal) this.handleVoiceCommand(result);
    };
    this.recognition.onerror = () => {
      this.hasError = true;
      this.isListening = false;
      this.btnListen.classList.remove('active');
      this.orb.className = 'orb';
      this.status.textContent = 'Error capturing voice';
    };
    this.recognition.onend = () => {
      if (this.isListening) {
        try {
          this.recognition.start();
        } catch (_) {
          this.stopListening();
        }
      } else if (!this.hasError) {
        this.stopListening();
      }
    };
  }

  toggleListening() {
    if (this.isListening) this.stopListening();
    else this.startListening();
  }

  startListening() {
    try {
      this.recognition.start();
      this.btnListen.classList.add('active');
    } catch (_) {}
  }

  stopListening() {
    this.isListening = false;
    if (this.recognition) this.recognition.stop();
    this.btnListen.classList.remove('active');
    this.updateUI('idle');
  }

  updateUI(state) {
    this.orb.className = 'orb';
    if (state === 'listening') {
      this.orb.classList.add('listening');
      this.status.textContent = "I'm listening...";
    } else if (state === 'speaking') {
      this.orb.classList.add('speaking');
      this.status.textContent = 'Weavetab is speaking';
    } else {
      this.status.textContent = 'Ready to listen';
    }
  }

  handleVoiceCommand(text) {
    this.stopListening();
    this.status.textContent = 'Processing...';
    setTimeout(() => this.speak(this.generateAIResponse(text)), 600);
  }

  generateAIResponse(text) {
    const t = text.toLowerCase();
    if (t.includes('hello') || t.includes('hi')) return 'Hello. I am the Weavetab Voice System.';
    if (t.includes('time')) return `Current time is ${new Date().toLocaleTimeString()}.`;
    if (t.includes('status')) return 'All systems are operational.';
    return `You said: ${text}.`;
  }

  speak(text) {
    this.isSpeaking = true;
    this.updateUI('speaking');
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const pref = voices.find((v) => v.name.includes('Google US English') || v.name.includes('Samantha') || v.name.includes('Microsoft Aria'));
    if (pref) utterance.voice = pref;
    utterance.pitch = 0.9;
    utterance.rate = 1.0;
    utterance.onend = () => {
      this.isSpeaking = false;
      this.updateUI('idle');
    };
    window.speechSynthesis.speak(utterance);
  }
}

new WeavetabVoiceSystem();

function goHome() {
  const url = new URL(window.location.href);
  url.searchParams.set('branch', 'default');
  window.location.href = url.toString();
}

const bindBtn = (id, fn) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', fn);
};

bindBtn('btn-perm-mic', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    alert('Microphone permission granted!');
  } catch (e) {
    alert('Microphone permission failed: ' + e.message);
  }
});

bindBtn('btn-perm-camera', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
    alert('Camera granted!');
  } catch (e) {
    alert('Camera failed: ' + e.message);
  }
});

bindBtn('btn-perm-geo', () => {
  navigator.geolocation.getCurrentPosition(() => alert('Location granted!'), (e) => alert(e.message));
});

bindBtn('btn-perm-notif', async () => {
  const p = await Notification.requestPermission();
  alert('Notification: ' + p);
});

const canvas = document.getElementById('wt-canvas');
const ctx = canvas.getContext('2d');
const contentArea = document.getElementById('content-area');
const container = document.getElementById('canvas-container');

function drawPlaceholder() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 800, 600);
  ctx.fillStyle = '#3b82f6';
  ctx.font = 'bold 36px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Agent Canvas', 400, 260);
  ctx.fillStyle = '#a1a1aa';
  ctx.font = '18px system-ui, sans-serif';
  ctx.fillText('Ready', 400, 310);
}

function showErrorState(heading, message) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#050506;color:#fff;font-family:sans-serif;';
  const h2 = document.createElement('h2');
  h2.style.cssText = 'color:#ef4444;margin-bottom:20px;';
  h2.textContent = heading;
  const p = document.createElement('p');
  p.style.cssText = 'margin-bottom:20px;';
  p.textContent = message;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;';
  const retry = document.createElement('button');
  retry.textContent = 'Retry';
  retry.style.cssText = 'padding:12px 24px;background:#3b82f6;color:#fff;border:none;border-radius:8px;cursor:pointer;';
  retry.addEventListener('click', () => location.reload());
  const home = document.createElement('button');
  home.textContent = 'Go Home';
  home.style.cssText = 'padding:12px 24px;background:#1f2937;color:#fff;border:none;border-radius:8px;cursor:pointer;';
  home.addEventListener('click', goHome);
  row.append(retry, home);
  wrap.append(h2, p, row);
  document.body.replaceChildren(wrap);
}

function saveWorkspace() {
  if (!browserAPI?.storage?.local) return;
  try {
    if (contentArea.style.display === 'block') {
      browserAPI.storage.local.set({ [`branch_${branch}_html`]: contentArea.textContent }).catch(() => {});
    } else {
      browserAPI.storage.local.set({ [`branch_${branch}_canvas`]: canvas.toDataURL() }).catch(() => {});
    }
  } catch (_) {}
}

if (!browserAPI?.storage?.local) {
  showErrorState('Extension Not Loaded', 'The WeaveTab extension storage API is unavailable.');
} else {
  browserAPI.storage.local.get([`branch_${branch}_html`, `branch_${branch}_canvas`], (result) => {
    if (browserAPI.runtime?.lastError) {
      showErrorState('Storage Error', browserAPI.runtime.lastError.message || 'Unknown error');
      return;
    }
    if (result[`branch_${branch}_html`]) {
      contentArea.textContent = result[`branch_${branch}_html`];
      container.style.display = 'none';
      contentArea.style.display = 'block';
    } else if (result[`branch_${branch}_canvas`]) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.onerror = () => drawPlaceholder();
      img.src = result[`branch_${branch}_canvas`];
    } else {
      drawPlaceholder();
    }
  });
}

window.addEventListener('wt-dashboard-command', (e) => {
  const { command, params } = e.detail || {};
  if (command === 'show-canvas') {
    container.style.display = 'flex';
    contentArea.style.display = 'none';
    saveWorkspace();
  }
  if (command === 'show-html') {
    container.style.display = 'none';
    contentArea.style.display = 'block';
    if (params?.text) contentArea.textContent = params.text;
    else if (params?.html) contentArea.textContent = params.html;
    saveWorkspace();
  }
});

window.addEventListener('beforeunload', saveWorkspace);

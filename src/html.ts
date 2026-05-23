export function renderHTML(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>火神</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  height: 100%; overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
  color: #f5e6d6;
}

#agent-video {
  position: fixed;
  inset: 0;
  width: 100%; height: 100%;
  object-fit: cover;
  object-position: top center;
  z-index: 0;
}

#ui {
  position: fixed;
  inset: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
}

#top-bar {
  flex: none;
  padding: 14px 16px 12px;
  background: linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 100%);
}

h1 {
  font-size: 16px; margin: 0 0 10px;
  font-weight: 600; letter-spacing: 0.06em;
  color: #ffb88c;
  text-shadow: 0 1px 10px rgba(0,0,0,0.9);
}

.stats { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.stat { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.stat .label { font-size: 14px; }
.bar {
  flex: 1; height: 4px;
  background: rgba(255,255,255,0.15);
  border-radius: 2px; overflow: hidden;
}
.bar > div {
  height: 100%;
  background: linear-gradient(90deg, #ff5a3c, #ffd070, #6dd96d);
  transition: width 0.4s ease;
}
.value {
  width: 26px; text-align: right;
  font-size: 11px; opacity: 0.75;
  font-variant-numeric: tabular-nums;
}
.value.warn { color: #ff8c5a; font-weight: 600; opacity: 1; }

.video-ctrl { display: flex; gap: 5px; }
.video-ctrl button {
  flex: 1; font-size: 11px; padding: 5px 4px;
  opacity: 0.45; letter-spacing: 0.01em;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(0,0,0,0.3);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: #f5e6d6; cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.video-ctrl button.on {
  opacity: 1;
  background: rgba(255,107,31,0.28);
  border-color: rgba(255,180,80,0.4);
}

/* transparent spacer — video shows through */
#spacer { flex: 1; }

#log {
  max-height: 140px; overflow-y: auto;
  padding: 0 16px 8px;
  font-size: 14px; line-height: 1.7;
  scrollbar-width: none;
}
#log::-webkit-scrollbar { display: none; }
.msg {
  margin-bottom: 4px; word-wrap: break-word;
  text-shadow: 0 1px 6px rgba(0,0,0,0.95), 0 0 16px rgba(0,0,0,0.7);
}
.msg.user { color: #9fd4d4; }
.msg.agent { color: #ffc69a; }
.msg.push { color: #ff8c5a; font-style: italic; }

#bottom-bar {
  flex: none;
  padding: 24px 12px 20px;
  background: linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.45) 60%, transparent 100%);
}
.input-row { display: flex; gap: 8px; margin-bottom: 8px; }
#input {
  flex: 1; padding: 12px 15px;
  border-radius: 16px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(0,0,0,0.38);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: #f5e6d6; font-size: 14px; outline: none;
  font-family: inherit;
}
#input::placeholder { color: rgba(245,230,214,0.32); }
#input:focus { border-color: rgba(255,180,80,0.45); }

button {
  padding: 10px 16px; border-radius: 16px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,107,31,0.18);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: #f5e6d6; font-size: 14px; cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}
button:hover { background: rgba(255,107,31,0.32); }
button:disabled { opacity: 0.5; cursor: wait; }
.actions { display: flex; gap: 8px; }
.actions button { flex: 1; }
</style>
</head>
<body>

<video id="agent-video" src="/default1.mp4" loop muted autoplay playsinline></video>

<div id="ui">
  <div id="top-bar">
    <h1>火神</h1>
    <div class="stats">
      <div class="stat">
        <span class="label">🍖</span>
        <div class="bar"><div id="bar-hunger"></div></div>
        <span class="value" id="val-hunger">50</span>
      </div>
      <div class="stat">
        <span class="label">💤</span>
        <div class="bar"><div id="bar-sleepiness"></div></div>
        <span class="value" id="val-sleepiness">50</span>
      </div>
      <div class="stat">
        <span class="label">💕</span>
        <div class="bar"><div id="bar-loneliness"></div></div>
        <span class="value" id="val-loneliness">50</span>
      </div>
    </div>
    <div class="video-ctrl">
      <button id="vc-loop" class="on">🔁 ループ</button>
      <button id="vc-sound">🔊 音</button>
      <button id="vc-play" class="on">▶️ 再生</button>
      <button id="vc-switch">🎬 切替</button>
    </div>
  </div>

  <div id="spacer"></div>

  <div id="bottom-bar">
    <div id="log"></div>
    <div class="input-row">
      <input id="input" placeholder="話しかける..." autocomplete="off">
      <button id="send">送信</button>
    </div>
    <div class="actions">
      <button id="feed">🍖 ごはん</button>
      <button id="nap">💤 寝かせる</button>
    </div>
  </div>
</div>

<script>
const log = document.getElementById('log');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const prefix = role === 'user' ? 'あなた' : role === 'push' ? '火神（自発）' : '火神';
  div.textContent = prefix + ': ' + text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function updateVisualState(_state) { /* no-op */ }

function updateStats(s) {
  if (!s) return;
  for (const k of ['hunger', 'sleepiness', 'loneliness']) {
    const raw = typeof s[k] === 'number' ? s[k] : 0;
    const v = 100 - raw;
    document.getElementById('bar-' + k).style.width = v + '%';
    const val = document.getElementById('val-' + k);
    val.textContent = v;
    val.classList.toggle('warn', v <= 30);
  }
  updateVisualState(s);
}

async function poll() {
  try {
    const res = await fetch('/state');
    if (!res.ok) return;
    const s = await res.json();
    updateStats(s);
    if (s.pendingPush) addMsg('push', s.pendingPush);
  } catch (_) { /* ignore */ }
}

async function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addMsg('user', text);
  sendBtn.disabled = true;
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    const data = await res.json();
    addMsg('agent', data.reply ?? '...');
    if (data.state) updateStats(data.state);
  } catch (_) {
    addMsg('agent', '(つながらないみたい...)');
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

async function action(path) {
  try {
    const r = await fetch(path, { method: 'POST' });
    const d = await r.json();
    if (d.reply) addMsg('agent', d.reply);
    if (d.state) updateStats(d.state);
    if (path === '/feed') playOneShot('/after-meal.mp4');
  } catch (_) { /* ignore */ }
}

sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) send(); });
document.getElementById('feed').addEventListener('click', () => action('/feed'));
document.getElementById('nap').addEventListener('click', () => action('/nap'));

const video = document.getElementById('agent-video');
const VIDEO_SOURCES = ['/default1.mp4', '/default2.mp4'];
let videoIdx = 0;

function setOn(btn, on) { btn.classList.toggle('on', on); }

const btnLoop = document.getElementById('vc-loop');
const btnSound = document.getElementById('vc-sound');
const btnPlay = document.getElementById('vc-play');
const btnSwitch = document.getElementById('vc-switch');

btnLoop.addEventListener('click', () => {
  video.loop = !video.loop;
  setOn(btnLoop, video.loop);
});
btnSound.addEventListener('click', () => {
  video.muted = !video.muted;
  setOn(btnSound, !video.muted);
  if (!video.muted && video.paused) video.play().catch(() => {});
});
btnPlay.addEventListener('click', () => {
  if (video.paused) {
    video.play().catch(() => {});
    setOn(btnPlay, true);
  } else {
    video.pause();
    setOn(btnPlay, false);
  }
});
btnSwitch.addEventListener('click', () => {
  videoIdx = (videoIdx + 1) % VIDEO_SOURCES.length;
  const wasPlaying = !video.paused;
  video.src = VIDEO_SOURCES[videoIdx];
  video.load();
  if (wasPlaying) video.play().catch(() => {});
});
video.addEventListener('play', () => setOn(btnPlay, true));
video.addEventListener('pause', () => setOn(btnPlay, false));

function playOneShot(src) {
  const prevLoop = video.loop;
  const prevPaused = video.paused;
  video.loop = false;
  setOn(btnLoop, false);
  video.src = src;
  video.load();
  video.play().catch(() => {});
  function onEnded() {
    video.removeEventListener('ended', onEnded);
    video.src = VIDEO_SOURCES[videoIdx];
    video.loop = prevLoop;
    setOn(btnLoop, prevLoop);
    video.load();
    if (!prevPaused) video.play().catch(() => {});
  }
  video.addEventListener('ended', onEnded);
}

poll();
setInterval(poll, 3000);
</script>
</body>
</html>`;
}

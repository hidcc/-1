export function renderHTML(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>火神</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; padding: 16px;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
  background: radial-gradient(circle at 50% 0%, #2a140a 0%, #0e0805 80%);
  color: #f5e6d6;
  min-height: 100vh;
}
.container { max-width: 480px; margin: 0 auto; }
h1 {
  font-size: 18px; margin: 0 0 12px;
  font-weight: 500; letter-spacing: 0.04em;
  color: #ffb88c;
}
#agent-visual {
  position: relative;
  width: 100%; aspect-ratio: 1;
  background: #000;
  border-radius: 28px;
  box-shadow: 0 0 80px rgba(255, 107, 31, 0.45);
  margin-bottom: 12px;
  overflow: hidden;
  user-select: none;
}
#agent-video {
  width: 100%; height: 100%;
  object-fit: cover;
  object-position: top center;
  display: block;
}
.video-ctrl {
  display: flex; gap: 6px;
  margin-bottom: 16px;
}
.video-ctrl button {
  flex: 1;
  font-size: 12px;
  padding: 8px 6px;
  opacity: 0.55;
  letter-spacing: 0.02em;
}
.video-ctrl button.on {
  opacity: 1;
  background: rgba(255,107,31,0.32);
  border-color: rgba(255,180,80,0.5);
}
.stats { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
.stat { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.stat .label { width: 24px; text-align: center; }
.stat .name { width: 92px; opacity: 0.85; }
.bar {
  flex: 1; height: 12px;
  background: rgba(255,255,255,0.07);
  border-radius: 6px; overflow: hidden;
}
.bar > div {
  height: 100%; width: 50%;
  background: linear-gradient(90deg, #ff5a3c, #ffd070, #6dd96d);
  transition: width 0.4s ease;
}
.value { width: 36px; text-align: right; font-variant-numeric: tabular-nums; }
.value.warn { color: #ff8c5a; font-weight: 600; }
#log {
  background: rgba(255,255,255,0.04);
  border-radius: 14px; padding: 12px 14px;
  height: 240px; overflow-y: auto;
  margin-bottom: 12px;
  font-size: 14px; line-height: 1.65;
}
#log:empty::before {
  content: "話しかけて起こしてみよう...";
  opacity: 0.4;
}
.msg { margin-bottom: 6px; word-wrap: break-word; }
.msg.user { color: #9fd4d4; }
.msg.agent { color: #ffc69a; }
.msg.push { color: #ff8c5a; font-style: italic; }
.input-row { display: flex; gap: 8px; margin-bottom: 8px; }
#input {
  flex: 1; padding: 11px 13px;
  border-radius: 12px; border: 1px solid rgba(255,255,255,0.15);
  background: rgba(0,0,0,0.3); color: #f5e6d6;
  font-size: 14px; outline: none;
}
#input:focus { border-color: rgba(255,180,80,0.5); }
button {
  padding: 10px 14px; border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(255,107,31,0.18); color: #f5e6d6;
  font-size: 14px; cursor: pointer;
  transition: background 0.15s;
}
button:hover { background: rgba(255,107,31,0.32); }
button:disabled { opacity: 0.5; cursor: wait; }
.actions { display: flex; gap: 8px; }
.actions button { flex: 1; }
</style>
</head>
<body>
<div class="container">
  <h1>火神</h1>
  <div id="agent-visual">
    <video id="agent-video" src="/default1.mp4" loop muted autoplay playsinline></video>
  </div>
  <div class="video-ctrl">
    <button id="vc-loop" class="on">🔁 ループ</button>
    <button id="vc-sound">🔊 音</button>
    <button id="vc-play" class="on">▶️ 再生</button>
    <button id="vc-switch">🎬 切替</button>
  </div>
  <div class="stats">
    <div class="stat"><span class="label">🍖</span><span class="name">満腹</span><div class="bar"><div id="bar-hunger"></div></div><span class="value" id="val-hunger">50</span></div>
    <div class="stat"><span class="label">💤</span><span class="name">眠気</span><div class="bar"><div id="bar-sleepiness"></div></div><span class="value" id="val-sleepiness">50</span></div>
    <div class="stat"><span class="label">💕</span><span class="name">親密</span><div class="bar"><div id="bar-loneliness"></div></div><span class="value" id="val-loneliness">50</span></div>
  </div>
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

// Slot for future state-driven visual updates.
// Today this is a no-op; later you can swap classes on #agent-visual
// based on state.hunger/sleepiness/loneliness to drive animations.
function updateVisualState(_state) { /* no-op */ }

function updateStats(s) {
  if (!s) return;
  for (const k of ['hunger', 'sleepiness', 'loneliness']) {
    const raw = typeof s[k] === 'number' ? s[k] : 0;
    const v = 100 - raw; // display as satisfaction: full=good, empty=needy
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

// Video controls
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

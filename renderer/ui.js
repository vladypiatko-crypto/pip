import { Pet3D } from './pet3d.js';

const $ = (id) => document.getElementById(id);

// Outside Electron (e.g. opening the page in a browser to preview), use a stand-in bridge.
const pip = window.pip || (await import('./preview-bridge.js')).default;

let settings = await pip.getSettings();
const pet = new Pet3D($('pet'), settings.skins);
await pet.load('../assets/pip.glb');
let currentSkin = settings.skin;
pet.setSkin(currentSkin);
capturePreview();

// New skins Pip designed get their picture taken once Pip is wearing them.
function capturePreview() {
  const skin = settings.skins.skins[currentSkin];
  if (!skin?.custom || skin.preview) return;
  const id = currentSkin;
  setTimeout(() => { if (currentSkin === id) pip.skinPreview(id, pet.snapshot()); }, 1400);
}

// ---------- click-through: only Pip and the panel catch the mouse ----------
let ignoring = true;
function overInteractive(e) {
  if (e.target.closest?.('.panel, .bubble')) return true;
  const r = $('pet').getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height * 0.55);
  return Math.hypot(dx, dy) < 82;
}
window.addEventListener('mousemove', (e) => {
  const over = overInteractive(e) || dragging;
  if (over === ignoring) { ignoring = !over; pip.ignoreMouse(ignoring); }
  // Pip follows the cursor with its eyes
  const r = $('pet').getBoundingClientRect();
  pet.lookAt((e.clientX - (r.left + r.width / 2)) / 200, -(e.clientY - (r.top + r.height / 2)) / 200);
});
window.addEventListener('mouseleave', () => pet.lookAt(0, 0));

// ---------- drag Pip around, tap to open the chat ----------
let dragging = false;
let moved = 0;
let last = null;
$('pet').addEventListener('mousedown', (e) => {
  if (!overInteractive(e)) return;
  dragging = true;
  moved = 0;
  last = { x: e.screenX, y: e.screenY };
  $('pet').classList.add('dragging');
  pip.drag('start');
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.screenX - last.x;
  const dy = e.screenY - last.y;
  moved += Math.abs(dx) + Math.abs(dy);
  last = { x: e.screenX, y: e.screenY };
  if (moved > 4 && (dx || dy)) pip.drag('move', dx, dy);
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  $('pet').classList.remove('dragging');
  pip.drag('end');
  if (moved <= 4) { pet.poke(); togglePanel(); }
});

// ---------- panel ----------
function togglePanel(force) {
  const open = force ?? $('panel').hidden;
  $('panel').hidden = !open;
  pip.chatOpen(open);
  if (open) { showChat(); $('bubble').hidden = true; setTimeout(() => $('input').focus(), 30); }
}
$('btn-close').onclick = () => togglePanel(false);
$('btn-gear').onclick = () => ($('settings').hidden ? showSettings() : showChat());
$('btn-new').onclick = () => { pip.newChat(); $('log').innerHTML = ''; greet(); showChat(); };
pip.onOpenChat(() => togglePanel(true));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') togglePanel(false); });

function showChat() {
  $('settings').hidden = true;
  $('chat').hidden = false;
  $('panel-title').textContent = 'Pip';
}
function showSettings() {
  $('chat').hidden = true;
  $('settings').hidden = false;
  $('panel-title').textContent = 'Pip settings';
  renderSettings();
}

// ---------- chat ----------
let replyEl = null;
let replyText = '';
let working = false;

function addMsg(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.innerHTML = kind === 'pip' ? markdown(text) : escapeHtml(text);
  $('log').append(el);
  $('log').scrollTop = $('log').scrollHeight;
  return el;
}
function greet() {
  addMsg('pip', settings.computerAccess === 'granted'
    ? "Hi! I'm Pip. Tell me what to do and I'll do it on your computer. Try \"help me build a game\"!"
    : "Hi! I'm Pip. Ask me anything, or tell me to do something on your computer and I'll ask permission first.");
}
greet();

function setWorking(on) {
  working = on;
  $('btn-send').hidden = on;
  $('btn-stop').hidden = !on;
  $('input').disabled = on;
  if (!on) { $('activity').hidden = true; $('bubble').hidden = true; }
}

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text || working) return;
  $('input').value = '';
  addMsg('me', text);
  replyEl = null;
  replyText = '';
  setWorking(true);
  showActivity('💭 Thinking…');
  const res = await pip.ask(text);
  if (res?.error) { addMsg('err', res.error); setWorking(false); }
});
$('btn-stop').onclick = () => pip.stop();

function showActivity(label) {
  $('activity').textContent = label;
  $('activity').hidden = false;
  if ($('panel').hidden) { $('bubble').textContent = label; $('bubble').hidden = false; }
}

pip.onState((s) => pet.setState(s));
pip.onMoving(({ dx }) => pet.setMoving(dx));
pip.onTool((label) => showActivity(label + '…'));
pip.onText((t) => {
  if (!replyEl) { replyEl = addMsg('pip', ''); replyEl.classList.add('typing'); }
  replyText += t;
  replyEl.innerHTML = markdown(replyText);
  $('log').scrollTop = $('log').scrollHeight;
  if ($('panel').hidden) { $('bubble').textContent = replyText.split('\n').filter(Boolean).pop() || ''; $('bubble').hidden = false; }
});
pip.onDone(({ error }) => {
  replyEl?.classList.remove('typing');
  if (error) {
    const el = addMsg('err', error);
    if (/not signed in/i.test(error)) {
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.style.marginTop = '6px';
      btn.textContent = 'Sign in to Claude';
      btn.onclick = () => pip.openLogin();
      el.append(document.createElement('br'), btn);
    }
  }
  setWorking(false);
  replyEl = null;
});

// ---------- settings ----------
let lastSkinDef = settings.skins.skins[settings.skin] ? stripPreview(settings.skins.skins[settings.skin]) : null;
function stripPreview(sk) { const { preview, ...rest } = sk; return rest; }
pip.onSettings((s) => {
  settings = s;
  pet.skins = s.skins; // includes skins Pip just designed
  const now = s.skins.skins[s.skin];
  const before = JSON.stringify(lastSkinDef);
  if (s.skin !== currentSkin || (now && JSON.stringify(stripPreview(now)) !== before)) {
    currentSkin = s.skin;
    pet.setSkin(s.skin);
  }
  lastSkinDef = now ? stripPreview(now) : null;
  capturePreview();
  if (!$('settings').hidden) renderSettings();
});

function renderSettings() {
  const box = $('skins');
  box.innerHTML = '';
  for (const [id, skin] of Object.entries(settings.skins.skins)) {
    const b = document.createElement('button');
    b.className = 'skin' + (id === settings.skin ? ' selected' : '');
    const img = skin.custom ? (skin.preview || '') : `../assets/previews/${id}.png`;
    b.innerHTML = `${img ? `<img src="${img}" alt="">` : '<div class="noimg">🎨</div>'}<span>${escapeHtml(skin.label)}</span>`;
    b.onclick = () => pip.updateSettings({ skin: id });
    if (skin.custom) {
      const del = document.createElement('span');
      del.className = 'del';
      del.title = 'Delete this skin';
      del.textContent = '✕';
      del.onclick = (e) => { e.stopPropagation(); if (confirm(`Delete "${skin.label}"?`)) pip.deleteSkin(id); };
      b.append(del);
    }
    box.append(b);
  }
  {
    const make = document.createElement('button');
    make.className = 'skin make';
    make.innerHTML = '<div class="noimg">✨</div><span>Design one</span>';
    make.onclick = () => {
      showChat();
      $('input').value = 'Design yourself a brand new skin: surprise me!';
      $('input').focus();
    };
    box.append(make);
  }
  $('opt-wander').checked = !!settings.wander;
  $('opt-access').checked = settings.computerAccess === 'granted';
  if (settings.room) { $('room-link').value = settings.room.link; $('room-code').value = settings.room.code; }
  $('btn-room-off').hidden = !settings.room;
}
$('opt-wander').onchange = (e) => pip.updateSettings({ wander: e.target.checked });
$('opt-access').onchange = (e) => pip.updateSettings({ computerAccess: e.target.checked ? 'granted' : 'denied' });
$('btn-folder').onclick = () => pip.openFolder();
$('btn-quit').onclick = () => pip.quit();
$('btn-room').onclick = async () => {
  const link = $('room-link').value.trim();
  const code = $('room-code').value.trim();
  if (!link || !code) { $('room-status').textContent = 'Paste the room link and pairing code.'; return; }
  await pip.roomConnect(link, code);
};
$('btn-room-off').onclick = () => pip.roomDisconnect();
pip.onRoomStatus((s) => {
  const text = { connecting: 'Connecting…', connected: `Connected as ${s.owner || 'you'} ✓`, off: 'Not connected', error: s.text }[s.state] || '';
  $('room-status').textContent = text;
  $('btn-room-off').hidden = s.state === 'off';
});

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function markdown(src) {
  return src.split(/```/).map((part, i) => {
    if (i % 2) return `<pre><code>${escapeHtml(part.replace(/^[^\n]*\n/, '').replace(/\n$/, ''))}</code></pre>`;
    return part.split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p>${escapeHtml(p)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>')}</p>`).join('');
  }).join('');
}

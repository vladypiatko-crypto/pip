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
  const dy = e.clientY - (r.bottom - 99); // Pip sits at the bottom of its (taller) canvas
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
$('btn-gear').onclick = () => toggleView('settings');
$('btn-history').onclick = () => toggleView('history');
$('btn-usage').onclick = () => toggleView('usage');
$('btn-rooms').onclick = () => toggleView('rooms');
$('btn-new').onclick = () => { pip.newChat(); $('log').innerHTML = ''; greet(); showChat(); };
pip.onOpenChat(() => togglePanel(true));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') togglePanel(false); });

const VIEWS = {
  chat: { title: 'Pip' },
  settings: { title: 'Pip settings', render: () => { renderSettings(); renderVersion(); } },
  history: { title: 'Continue a chat', render: () => renderHistory() },
  usage: { title: 'Usage', render: () => renderUsage() },
  rooms: { title: 'Chat together', render: () => renderRooms() },
};
let view = 'chat';
function showView(name) {
  view = name;
  for (const v of Object.keys(VIEWS)) $(v).hidden = v !== name;
  $('panel-title').textContent = VIEWS[name].title;
  for (const [btn, v] of [['btn-gear', 'settings'], ['btn-history', 'history'], ['btn-usage', 'usage'], ['btn-rooms', 'rooms']]) {
    $(btn).style.color = v === name ? 'var(--accent)' : '';
  }
  VIEWS[name].render?.();
}
const toggleView = (name) => showView(view === name ? 'chat' : name);
const showChat = () => showView('chat');
const showSettings = () => showView('settings');

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
  $('btn-send').textContent = on ? 'Next' : 'Go';
  $('btn-send').title = on ? 'Queue this message for when Pip finishes' : 'Send';
  $('btn-stop').hidden = !on;
  $('input').placeholder = on ? 'Type your next message… (Enter = do it next)' : 'Ask Pip… e.g. help me build a game';
  if (!on) { $('activity').hidden = true; $('bubble').hidden = true; }
}

// While Pip works you can keep typing. Messages wait in a queue ("Next up") and are
// sent together when Pip finishes, or right away with "Send now", which interrupts Pip.
const queue = []; // { text, el }
let interrupting = false;

function send(text) {
  addMsg('me', text);
  replyEl = null;
  replyText = '';
  setWorking(true);
  startCard();
  return pip.ask(text).then((res) => { if (res?.error) { finishCard('error'); addMsg('err', res.error); setWorking(false); } });
}

// ---------- live "Pip is working" card in the chat ----------
// A sparkle + shimmering label while Pip thinks, a list of steps that tick off as it
// works, and a timer. When Pip finishes it folds into a small summary you can tap open.
let card = null;
const THINKING_WORDS = ['Thinking', 'Pondering', 'Figuring it out', 'Making a plan', 'Connecting the dots'];
function startCard() {
  finishCard('ok');
  const el = document.createElement('div');
  el.className = 'msg turn live';
  el.dataset.mode = 'thinking';
  el.innerHTML = '<div class="turn-head"><span class="spark" aria-hidden="true"></span><span class="label shimmer">Thinking</span><span class="dots"><i></i><i></i><i></i></span><span class="timer"></span></div><ol class="steps"></ol>';
  el.querySelector('.turn-head').onclick = () => { if (el.classList.contains('finished')) el.classList.toggle('open'); };
  $('log').append(el);
  $('log').scrollTop = $('log').scrollHeight;
  const c = { el, steps: [], start: Date.now(), word: 0 };
  c.timer = setInterval(() => {
    const sec = Math.round((Date.now() - c.start) / 1000);
    el.querySelector('.timer').textContent = sec >= 2 ? `${sec}s` : '';
    if (el.dataset.mode === 'thinking' && sec > 0 && sec % 3 === 0) setCardLabel(THINKING_WORDS[++c.word % THINKING_WORDS.length], 'thinking');
  }, 1000);
  card = c;
}
function setCardLabel(text, mode) {
  if (!card) return;
  card.el.querySelector('.label').textContent = text;
  card.el.dataset.mode = mode;
}
function addStep(label) {
  if (!card) startCard();
  const clean = label.replace(/…$/, '');
  const prev = card.steps[card.steps.length - 1];
  if (prev && prev.label === clean && !prev.el.classList.contains('done')) {
    prev.count++;
    prev.el.querySelector('.n').textContent = `×${prev.count}`;
  } else {
    if (prev) prev.el.classList.add('done');
    const li = document.createElement('li');
    li.innerHTML = '<span class="st"></span><span class="sl"></span><span class="n"></span>';
    li.querySelector('.sl').textContent = clean;
    card.el.querySelector('.steps').append(li);
    card.steps.push({ label: clean, el: li, count: 1 });
  }
  setCardLabel(clean, 'working');
  $('log').scrollTop = $('log').scrollHeight;
}
function finishCard(outcome) { // 'ok' | 'error' | 'stopped'
  const c = card;
  if (!c) return;
  card = null;
  clearInterval(c.timer);
  c.steps.forEach((s) => s.el.classList.add('done'));
  const sec = Math.max(1, Math.round((Date.now() - c.start) / 1000));
  const t = sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
  const n = c.steps.length;
  const text = outcome === 'stopped' ? `Interrupted after ${t}`
    : outcome === 'error' ? `Stopped after ${t}`
    : n ? `Worked for ${t} · ${n} step${n > 1 ? 's' : ''}` : `Thought for ${t}`;
  c.el.classList.remove('live');
  c.el.classList.add('finished', outcome);
  c.el.dataset.mode = 'done';
  c.el.querySelector('.label').textContent = text;
  c.el.querySelector('.timer').textContent = n ? '▸' : '';
}

function queueMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg me queued';
  el.innerHTML = `<div class="q-label">Next up</div><div class="q-text"></div><div class="q-actions"><button class="q-now" title="Stop what Pip is doing and send this now">Send now</button><button class="q-del" title="Remove">✕</button></div>`;
  el.querySelector('.q-text').textContent = text;
  const item = { text, el };
  el.querySelector('.q-now').onclick = () => sendNow();
  el.querySelector('.q-del').onclick = () => { queue.splice(queue.indexOf(item), 1); el.remove(); };
  queue.push(item);
  $('log').append(el);
  $('log').scrollTop = $('log').scrollHeight;
}

function flushQueue() {
  if (!queue.length) return false;
  const text = queue.map((q) => q.text).join('\n\n');
  for (const q of queue) q.el.remove();
  queue.length = 0;
  send(text);
  return true;
}

function sendNow() {
  if (!working) { flushQueue(); return; }
  interrupting = true;
  setCardLabel('Switching to your new message', 'working');
  pip.stop(); // the queued messages go out as soon as Pip has stopped
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  if (working) queueMessage(text);
  else send(text);
});
$('input').addEventListener('keydown', (e) => {
  // Ctrl/Cmd+Enter while Pip works = send now (interrupt)
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && working) {
    e.preventDefault();
    const text = $('input').value.trim();
    if (text) { $('input').value = ''; queueMessage(text); }
    if (queue.length) sendNow();
  }
});
$('btn-stop').onclick = () => pip.stop();

function showActivity(label) {
  if ($('panel').hidden) { $('bubble').textContent = label; $('bubble').hidden = false; }
}

pip.onState((s) => pet.setState(s));
pip.onMoving(({ dx }) => pet.setMoving(dx));
pip.onTool((label) => { addStep(label); showActivity(label + '…'); });
pip.onText((t) => {
  if (!replyEl) { replyEl = addMsg('pip', ''); replyEl.classList.add('typing'); setCardLabel('Answering', 'talking'); }
  replyText += t;
  replyEl.innerHTML = markdown(replyText);
  $('log').scrollTop = $('log').scrollHeight;
  if ($('panel').hidden) { $('bubble').textContent = replyText.split('\n').filter(Boolean).pop() || ''; $('bubble').hidden = false; }
});
pip.onDone(({ error }) => {
  replyEl?.classList.remove('typing');
  if (interrupting && error === 'Stopped.') {
    interrupting = false;
    finishCard('stopped');
    setWorking(false);
    replyEl = null;
    flushQueue();
    return;
  }
  interrupting = false;
  finishCard(error ? (error === 'Stopped.' ? 'stopped' : 'error') : 'ok');
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
  // Anything typed while Pip was busy goes next.
  if (queue.length) setTimeout(flushQueue, 400);
});

// ---------- settings ----------
let lastSkinDef = settings.skins.skins[settings.skin] ? stripPreview(settings.skins.skins[settings.skin]) : null;
function stripPreview(sk) { const { preview, ...rest } = sk; return rest; }
pip.onSettings((s) => {
  settings = s;
  renderPickers();
  if (view === 'rooms') renderRooms();
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
}
$('opt-wander').onchange = (e) => pip.updateSettings({ wander: e.target.checked });
$('opt-access').onchange = (e) => pip.updateSettings({ computerAccess: e.target.checked ? 'granted' : 'denied' });
$('btn-folder').onclick = () => pip.openFolder();
$('btn-quit').onclick = () => pip.quit();
// ---------- updates ----------
const shortDate = (d) => (d ? new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');
async function renderVersion() {
  const v = await pip.version();
  $('version-text').textContent = v
    ? `Version ${String(v.sha || 'unknown').slice(0, 7)}${v.date ? ` (${shortDate(v.date)})` : ''}`
    : 'Version: running from source';
}
async function checkUpdate() {
  $('update-status').textContent = 'Checking…';
  $('btn-update').hidden = true;
  const r = await pip.checkUpdate();
  if (r.error) { $('update-status').textContent = r.error; return; }
  if (r.upToDate) { $('update-status').textContent = 'You have the newest version ✓'; return; }
  $('update-status').textContent = r.latest.date ? `New version from ${shortDate(r.latest.date)}: ${r.latest.message}` : r.latest.message;
  $('btn-update').hidden = false;
}
$('btn-check-update').onclick = checkUpdate;
$('btn-update').onclick = async () => {
  $('btn-update').disabled = true;
  $('update-status').textContent = 'Updating… Pip will close and come back in about a minute.';
  const r = await pip.update();
  if (r.error) { $('update-status').textContent = r.error; $('btn-update').disabled = false; }
};
pip.onOpenView((v) => { togglePanel(true); showView(v); });
pip.onCheckUpdate(() => checkUpdate());
pip.onUpdateAvailable((r) => {
  $('bubble').textContent = '✨ A new Pip update is ready! Tap me, then ⚙ to update.';
  $('bubble').hidden = false;
  setTimeout(() => ($('bubble').hidden = true), 15000);
});

// ---------- model & effort ----------
const MODELS = [
  { id: '', name: 'Auto', desc: "Claude Code's default for your plan", ico: '✳' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', desc: 'Smartest for most tasks', ico: '◆' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', desc: 'Fast and capable', ico: '◇' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', desc: 'Quickest, uses the least', ico: '○' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', desc: 'Most capable (if your plan has it)', ico: '★' },
];
const EFFORTS = [
  { id: '', name: 'Auto', desc: 'Let Claude decide', level: 0 },
  { id: 'low', name: 'Low', desc: 'Quick answers, uses the least', level: 1 },
  { id: 'medium', name: 'Medium', desc: 'Balanced', level: 2 },
  { id: 'high', name: 'High', desc: 'Thinks things through', level: 3 },
  { id: 'xhigh', name: 'Extra high', desc: 'For tricky problems', level: 4 },
  { id: 'max', name: 'Max', desc: 'Thinks hardest, uses the most', level: 5 },
];
const barsHtml = (level) => Array.from({ length: 5 }, (_, i) => `<i class="${i < level ? 'on' : ''}"></i>`).join('');

function renderPickers() {
  const m = MODELS.find((x) => x.id === (settings.model || '')) || { name: settings.model, ico: '✳' };
  $('pick-model-text').textContent = m.name;
  $('pick-model').querySelector('.pill-ico').textContent = m.ico;
  const e = EFFORTS.find((x) => x.id === (settings.effort || '')) || EFFORTS[0];
  $('pick-effort-text').textContent = e.level ? e.name : 'Effort';
  $('pick-effort-bars').innerHTML = barsHtml(e.level || 0);
  $('pick-effort').classList.toggle('auto', !e.level);
}

function buildMenu(menu, items, current, render, onPick) {
  menu.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'menu-item' + (it.id === current ? ' on' : '');
    b.setAttribute('role', 'menuitemradio');
    b.innerHTML = `<span class="mi-ico">${render(it)}</span><span class="mi-body"><b></b><small></small></span><span class="mi-check">✓</span>`;
    b.querySelector('b').textContent = it.name;
    b.querySelector('small').textContent = it.desc;
    b.onclick = () => { onPick(it.id); closeMenus(); };
    menu.append(b);
  }
}
function closeMenus() {
  for (const id of ['menu-model', 'menu-effort']) $(id).hidden = true;
  for (const id of ['pick-model', 'pick-effort']) $(id).classList.remove('open');
}
function toggleMenu(which) {
  const menu = $('menu-' + which);
  const wasOpen = !menu.hidden;
  closeMenus();
  if (wasOpen) return;
  if (which === 'model') {
    buildMenu(menu, MODELS, settings.model || '', (it) => it.ico, (id) => { settings.model = id; renderPickers(); pip.updateSettings({ model: id }); });
  } else {
    buildMenu(menu, EFFORTS, settings.effort || '', (it) => `<span class="bars">${barsHtml(it.level)}</span>`, (id) => { settings.effort = id; renderPickers(); pip.updateSettings({ effort: id }); });
  }
  menu.hidden = false;
  $('pick-' + which).classList.add('open');
}
$('pick-model').onclick = (e) => { e.stopPropagation(); toggleMenu('model'); };
$('pick-effort').onclick = (e) => { e.stopPropagation(); toggleMenu('effort'); };
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); }, true);
renderPickers();

// ---------- continue a chat ----------
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(ts).toLocaleDateString();
};
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

async function renderHistory() {
  const list = await pip.listChats();
  const ul = $('chat-list');
  ul.innerHTML = '';
  if (!list.length) { ul.innerHTML = '<li class="empty">No chats yet. Ask Pip something!</li>'; return; }
  for (const c of list) {
    const li = document.createElement('li');
    if (c.current) li.className = 'current';
    li.innerHTML = `<span class="t">${escapeHtml(c.title)}</span><span class="m">${ago(c.updated)}</span><button class="x" title="Delete">✕</button>`;
    li.onclick = () => continueChat(c.id);
    li.querySelector('.x').onclick = (e) => { e.stopPropagation(); if (confirm('Delete this chat?')) pip.deleteChat(c.id); };
    ul.append(li);
  }
}
async function continueChat(id) {
  const r = await pip.openChat(id);
  if (r.error) { alert(r.error); return; }
  $('log').innerHTML = '';
  for (const m of r.messages) addMsg(m.role, m.text);
  addMsg('pip', 'Picking up where we left off. What next?');
  showChat();
  $('input').focus();
}
pip.onChatsChanged(() => { if (view === 'history') renderHistory(); });

// ---------- usage viewer ----------
let usageRange = 'today';
document.querySelectorAll('#usage-range button').forEach((b) => {
  b.onclick = () => { usageRange = b.dataset.r; renderUsage(); };
});
const STATUS_TEXT = { allowed_warning: 'Getting close to a limit', rejected: 'Limit reached: Claude will be back after the reset' };
const WINDOW_NAMES = { five_hour: '5-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly Opus limit', seven_day_sonnet: 'Weekly Sonnet limit' };
const resetsIn = (sec) => {
  const ms = sec * 1000 - Date.now();
  if (ms <= 0) return 'resets now';
  const h = Math.floor(ms / 3600e3);
  const m = Math.round((ms % 3600e3) / 60e3);
  return h >= 24 ? `resets ${new Date(sec * 1000).toLocaleDateString([], { weekday: 'short' })} ${new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : `resets in ${h ? h + ' h ' : ''}${m} min`;
};
async function renderUsage() {
  document.querySelectorAll('#usage-range button').forEach((b) => b.classList.toggle('on', b.dataset.r === usageRange));
  const u = await pip.getUsage();
  const lim = $('limits');
  const windows = Object.entries(u.limits?.unifiedWindows || {});
  if (!windows.length) {
    lim.innerHTML = '<p class="hint">Ask Pip anything and your plan\'s limits will show up here.</p>';
  } else {
    lim.innerHTML = windows.map(([k, w]) => {
      const pct = Math.round((w.utilization <= 1 ? w.utilization * 100 : w.utilization) || 0);
      const cls = pct >= 90 ? 'high' : pct >= 70 ? 'warn' : '';
      return `<div class="limit"><div class="lbl"><span>${escapeHtml(WINDOW_NAMES[k] || k.replace(/_/g, ' '))}: <b>${pct}%</b> used</span><span>${w.resetsAt ? resetsIn(w.resetsAt) : ''}</span></div><div class="bar"><i class="${cls}" style="width:${Math.min(100, pct)}%"></i></div></div>`;
    }).join('') + `<p class="hint">Updated ${ago(u.limitsAt)}${STATUS_TEXT[u.limits.status] ? ` · <b>${STATUS_TEXT[u.limits.status]}</b>` : ''}</p>`;
  }
  const r = u[usageRange];
  $('usage-totals').innerHTML = `<div><b>${r.requests}</b><span>answers</span></div><div><b>${fmtTok(r.input)}</b><span>tokens in</span></div><div><b>${fmtTok(r.output)}</b><span>tokens out</span></div>`;
  const max = Math.max(1, ...u.days.map((d) => d.tokens));
  $('usage-chart').innerHTML = u.days.map((d) => `<i style="height:${Math.max(3, (d.tokens / max) * 100)}%" title="${d.day}: ${fmtTok(d.tokens)} tokens, ${d.requests} answers"></i>`).join('');
  const names = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-fable-5-1': 'Fable 5.1' };
  const rows = Object.entries(r.byModel).sort((a, b) => b[1].output - a[1].output);
  const src = r.bySource;
  $('usage-models').innerHTML =
    (rows.length ? rows.map(([m, x]) => `<div class="mrow"><span>${escapeHtml(names[m] || m)}</span><span>${x.requests} · ${fmtTok(x.input + x.output)} tokens</span></div>`).join('') : '<p class="hint">Nothing yet in this period.</p>') +
    (src.room ? `<div class="mrow"><span>In shared rooms</span><span>${src.room.requests} · ${fmtTok(src.room.input + src.room.output)} tokens</span></div>` : '') +
    (r.apiValueUsd > 0.005 ? `<p class="hint">At API prices this would have cost about $${r.apiValueUsd.toFixed(2)}. On your plan it's included.</p>` : '');
}
pip.onUsageChanged(() => { if (view === 'usage') renderUsage(); });

// ---------- rooms: chat together, everyone on their own subscription ----------
function renderRooms() {
  $('my-name').value = settings.name || '';
  const h = settings.hosting;
  $('btn-stop-host').hidden = !h;
  const ul = $('room-list');
  ul.innerHTML = '';
  const rooms = settings.recentRooms || [];
  if (!rooms.length) ul.innerHTML = '<li class="empty">Rooms you host or join show up here.</li>';
  for (const r of rooms) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="t">${r.hosted ? '🏠 ' : ''}${escapeHtml(r.name)}</span><span class="m">${ago(r.ts)}</span><button class="x" title="Remove from list">✕</button>`;
    li.title = r.hosted ? 'Host this room again' : 'Open this room again';
    li.onclick = () => (r.hosted ? hostRoom(r.name, r.id) : joinRoom(r.link));
    li.querySelector('.x').onclick = (e) => { e.stopPropagation(); pip.forgetRoom(r.id); };
    ul.append(li);
  }
}
function needName() {
  const name = $('my-name').value.trim();
  if (!name) { $('room-status').textContent = 'First type your name, so friends know who you are.'; $('my-name').focus(); return true; }
  if (name !== settings.name) pip.updateSettings({ name });
  return false;
}
$('my-name').onchange = () => { const n = $('my-name').value.trim(); if (n) pip.updateSettings({ name: n }); };
async function hostRoom(name, id) {
  if (needName()) return;
  $('btn-host').disabled = true;
  $('room-status').textContent = 'Starting your room…';
  const r = await pip.hostRoom(name || $('host-name').value.trim() || 'Our room', id);
  $('btn-host').disabled = false;
  if (r.error) { $('room-status').textContent = r.error; return; }
  $('room-status').textContent = '';
  $('host-result').hidden = false;
  $('invite-link').textContent = r.invite;
  $('host-note').textContent = r.note || 'Send this invite link to your friends. They join from their own Pip (👥 → Join) or any web browser:';
  pip.copy(r.invite);
  $('btn-copy').textContent = 'Copied ✓';
  setTimeout(() => ($('btn-copy').textContent = 'Copy'), 2000);
}
async function joinRoom(link) {
  if (needName()) return;
  const r = await pip.joinRoom(link || $('join-link').value.trim());
  $('room-status').textContent = r.error || 'Opening the room…';
}
$('btn-host').onclick = () => hostRoom();
$('btn-join').onclick = () => joinRoom();
$('btn-copy').onclick = () => { pip.copy($('invite-link').textContent); $('btn-copy').textContent = 'Copied ✓'; setTimeout(() => ($('btn-copy').textContent = 'Copy'), 2000); };
$('btn-stop-host').onclick = async () => { await pip.stopHosting(); $('host-result').hidden = true; $('room-status').textContent = 'Stopped hosting.'; };

// Advanced: pair with a room that's open in a normal web browser
$('btn-room').onclick = async () => {
  const link = $('room-link').value.trim();
  const code = $('room-code').value.trim();
  if (!link || !code) { $('room-status').textContent = 'Paste the room link and pairing code.'; return; }
  await pip.roomConnect(link, code);
};
$('btn-room-off').onclick = () => pip.roomDisconnect();
pip.onRoomStatus((s) => {
  const text = { connecting: s.text || 'Connecting…', connected: `Pip is connected to "${s.room || 'the room'}" ✓ Ask Claude there and your subscription answers.`, off: '', error: s.text }[s.state] || '';
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

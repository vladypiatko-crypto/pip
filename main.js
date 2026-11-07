// Pip: a 3D desktop pet that floats around your screen and does things for you
// with your own Claude Code subscription.

const { app, BrowserWindow, ipcMain, screen, dialog, Tray, Menu, nativeImage, shell, clipboard } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runClaude, findClaude } = require('./lib/claude');
const { spawn } = require('node:child_process');
const { startControlServer } = require('./lib/control');
const { RoomLink } = require('./lib/room');
const { startHosting, stopHosting, currentHost } = require('./lib/host');

const SKINS = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'skins.json'), 'utf8'));
const SLOTS = ['body', 'belly', 'eye', 'highlight', 'cheek', 'bulb', 'accent'];
const PARTS = ['stem', 'bulb', 'leaf', 'crown', 'headphones', 'beanie'];
const SHAPES = ['sphere', 'box', 'cylinder', 'cone', 'torus', 'capsule'];
const WIN_W = 380;
const WIN_H = 600;

// ---------- settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { skin: SKINS.default, wander: true, computerAccess: null, room: null, model: '', effort: '', name: '', pairCode: '', recentRooms: [] };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch {}
  if (!/^[A-Z0-9]{6,8}$/.test(settings.pairCode)) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    settings.pairCode = Array.from(crypto.randomBytes(6), (b) => abc[b % abc.length]).join('');
  }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  send('pet:settings', publicSettings());
}
const publicSettings = () => ({ ...settings, skins: allSkins(), workspace: workspace(), hosting: hostInfo() });

// ---------- saved chats (so you can continue them later) ----------
const chatsPath = () => path.join(app.getPath('userData'), 'chats.json');
let chats = [];        // newest first: { id, sessionId, title, created, updated, messages:[{role,text}], usage:{input,output}, model }
let currentChat = null;
function loadChats() { try { chats = JSON.parse(fs.readFileSync(chatsPath(), 'utf8')).chats || []; } catch {} }
function saveChats() {
  chats = chats.slice(0, 200);
  fs.writeFileSync(chatsPath(), JSON.stringify({ chats }));
  send('chats:changed');
}
const chatList = () => chats.map(({ id, title, updated, messages, usage }) => ({ id, title, updated, count: messages.length, tokens: (usage?.input || 0) + (usage?.output || 0), current: id === currentChat?.id }));

// ---------- usage log (for the usage viewer) ----------
const usagePath = () => path.join(app.getPath('userData'), 'usage.json');
let usage = { limits: null, limitsAt: 0, events: [] };
let usageTimer = null;
function loadUsage() { try { usage = { ...usage, ...JSON.parse(fs.readFileSync(usagePath(), 'utf8')) }; } catch {} }
function saveUsageSoon() {
  clearTimeout(usageTimer);
  usageTimer = setTimeout(() => fs.writeFile(usagePath(), JSON.stringify(usage), () => {}), 400);
  send('usage:changed');
}
function recordUsage(source, u) {
  if (!u) return;
  for (const [model, m] of Object.entries(u.byModel || {})) {
    usage.events.push({ ts: Date.now(), source, model, input: m.input, output: m.output, costUsd: m.costUsd || 0 });
  }
  if (!Object.keys(u.byModel || {}).length) usage.events.push({ ts: Date.now(), source, model: u.model || 'unknown', input: u.input || 0, output: u.output || 0, costUsd: u.costUsd || 0 });
  usage.events = usage.events.slice(-5000);
  saveUsageSoon();
}
function recordLimits(info) {
  usage.limits = info;
  usage.limitsAt = Date.now();
  saveUsageSoon();
}
function usageSummary() {
  const now = Date.now();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const ranges = { today: startOfDay.getTime(), week: now - 7 * 864e5, month: now - 30 * 864e5 };
  const out = {};
  for (const [k, since] of Object.entries(ranges)) {
    const ev = usage.events.filter((e) => e.ts >= since);
    const byModel = {};
    const bySource = {};
    for (const e of ev) {
      const m = (byModel[e.model] ||= { requests: 0, input: 0, output: 0 });
      m.requests++; m.input += e.input; m.output += e.output;
      const s = (bySource[e.source] ||= { requests: 0, input: 0, output: 0 });
      s.requests++; s.input += e.input; s.output += e.output;
    }
    out[k] = {
      requests: ev.length,
      input: ev.reduce((n, e) => n + e.input, 0),
      output: ev.reduce((n, e) => n + e.output, 0),
      apiValueUsd: ev.reduce((n, e) => n + (e.costUsd || 0), 0),
      byModel, bySource,
    };
  }
  // Per-day totals for the last 14 days (for the little chart)
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(startOfDay.getTime() - i * 864e5);
    const end = d.getTime() + 864e5;
    const ev = usage.events.filter((e) => e.ts >= d.getTime() && e.ts < end);
    days.push({ day: d.toISOString().slice(0, 10), tokens: ev.reduce((n, e) => n + e.input + e.output, 0), requests: ev.length });
  }
  return { limits: usage.limits, limitsAt: usage.limitsAt, ...out, days };
}

// ---------- custom skins Pip designs itself ----------
const customPath = () => path.join(app.getPath('userData'), 'custom-skins.json');
let custom = { skins: {}, previews: {} };
function loadCustom() {
  try { custom = { skins: {}, previews: {}, ...JSON.parse(fs.readFileSync(customPath(), 'utf8')) }; } catch {}
}
function saveCustom() {
  fs.mkdirSync(path.dirname(customPath()), { recursive: true });
  fs.writeFileSync(customPath(), JSON.stringify(custom));
}
function allSkins() {
  const skins = { ...SKINS.skins };
  for (const [id, s] of Object.entries(custom.skins)) skins[id] = { ...s, custom: true, preview: custom.previews[id] || null };
  return { default: SKINS.default, skins };
}

const isHex = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const vec = (v, lo, hi, d) => (Array.isArray(v) && v.length === 3 ? v.map((x, i) => num(x, lo, hi, d[i])) : d);
function finishOf(src, fallback) {
  const f = src && isHex(src.color) ? src : fallback;
  const out = { color: f.color };
  if (f.metalness !== undefined) out.metalness = num(f.metalness, 0, 1, 0);
  if (f.roughness !== undefined) out.roughness = num(f.roughness, 0, 1, 0.5);
  if (isHex(f.emissive)) { out.emissive = f.emissive; out.emissiveIntensity = num(f.emissiveIntensity, 0, 5, 1); }
  return out;
}

// Check and tidy a skin from Claude so a bad value can never break the pet.
function cleanSkin(def) {
  const id = String(def.id || '').toLowerCase();
  if (!/^[a-z0-9-]{2,30}$/.test(id)) throw new Error('id must be 2-30 lowercase letters, numbers or dashes');
  if (SKINS.skins[id]) throw new Error(`"${id}" is a built-in skin; pick another id`);
  const base = SKINS.skins[SKINS.default];
  const skin = { label: String(def.label || id).slice(0, 30), parts: (def.parts || []).filter((p) => PARTS.includes(p)), extras: [] };
  for (const slot of SLOTS) skin[slot] = finishOf(def.colors?.[slot], base[slot]);
  for (const e of (def.extras || []).slice(0, 40)) {
    if (!SHAPES.includes(e.shape) || !isHex(e.color)) continue;
    skin.extras.push({
      shape: e.shape,
      attach: ['hand_L', 'hand_R'].includes(e.attach) ? e.attach : 'body',
      position: vec(e.position, -3, 3, [0, 0, 0]),
      rotation: vec(e.rotation, -7, 7, [0, 0, 0]),
      scale: vec(e.scale, 0.01, 4, [0.3, 0.3, 0.3]),
      tube: num(e.tube, 0.02, 0.45, 0.12),
      ...finishOf(e, e),
    });
  }
  return { id, skin };
}

async function skinTool(name, args) {
  if (name === 'list_skins') {
    const list = Object.entries(allSkins().skins).map(([id, s]) => `${id} (${s.label}${s.custom ? ', custom' : ''})`);
    return `Wearing: ${settings.skin}. Skins: ${list.join(', ')}.`;
  }
  if (name === 'wear_skin') {
    if (!allSkins().skins[args.id]) throw new Error(`No skin called "${args.id}"`);
    settings.skin = args.id;
    saveSettings();
    buildTray();
    return `Now wearing ${args.id}.`;
  }
  if (name === 'delete_skin') {
    if (!custom.skins[args.id]) throw new Error(`"${args.id}" is not a custom skin`);
    delete custom.skins[args.id];
    delete custom.previews[args.id];
    saveCustom();
    if (settings.skin === args.id) settings.skin = SKINS.default;
    saveSettings();
    buildTray();
    return `Deleted ${args.id}.`;
  }
  if (name === 'save_skin') {
    const { id, skin } = cleanSkin(args);
    custom.skins[id] = skin;
    delete custom.previews[id]; // the pet takes a new picture once it's wearing it
    saveCustom();
    if (args.wear !== false) settings.skin = id;
    saveSettings();
    buildTray();
    send('pet:state', 'happy');
    return `Saved skin "${skin.label}" (${skin.extras.length} extra pieces)${args.wear !== false ? ' and Pip is wearing it now' : ''}. The user can find it in Settings > Skins.`;
  }
  throw new Error(`Unknown skin tool ${name}`);
}

ipcMain.on('pet:skin-preview', (_e, { id, dataUrl }) => {
  if (!custom.skins[id] || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 800000) return;
  custom.previews[id] = dataUrl;
  saveCustom();
  send('pet:settings', publicSettings());
});
ipcMain.on('pet:delete-skin', (_e, id) => { skinTool('delete_skin', { id }).catch(() => {}); });
const workspace = () => {
  const dir = process.env.PIP_WORKSPACE || path.join(app.getPath('documents'), 'Pip Projects');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// ---------- window ----------
let win = null;
let tray = null;
let control = null;
let mcpConfigPath = null;      // all tools: computer control + skins
let mcpSkinsConfigPath = null; // chat-only mode: just the skin designer
let room = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    x: area.x + area.width - WIN_W - 40, y: area.y + area.height - WIN_H - 20,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true }); // clicks pass through empty space
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------- wandering ----------
let busy = false;          // Claude is working on something
let chatOpen = false;
let dragging = false;
let glide = null;
function wanderTick() {
  if (!win || win.isDestroyed() || !settings.wander || busy || chatOpen || dragging || glide) return;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const b = win.getBounds();
  const tx = Math.round(area.x + Math.random() * (area.width - b.width));
  const ty = Math.round(area.y + area.height * 0.25 + Math.random() * (area.height * 0.75 - b.height));
  const dist = Math.hypot(tx - b.x, ty - b.y);
  if (dist < 80) return;
  const steps = Math.min(600, Math.max(90, dist / 2));
  let i = 0;
  send('pet:moving', { dx: tx - b.x });
  glide = setInterval(() => {
    if (!win || win.isDestroyed() || chatOpen || dragging || busy) { clearInterval(glide); glide = null; send('pet:moving', { dx: 0 }); return; }
    i++;
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in-out
    win.setPosition(Math.round(b.x + (tx - b.x) * e), Math.round(b.y + (ty - b.y) * e));
    if (i >= steps) { clearInterval(glide); glide = null; send('pet:moving', { dx: 0 }); }
  }, 16);
}

// ---------- asking Claude ----------
let current = null;     // running Claude turn
let cancelled = false;
let sessionId = null;

const COMPUTER_TOOLS = ['screenshot', 'click', 'move_mouse', 'drag', 'type_text', 'press_keys', 'scroll', 'wait', 'open'];
const SKIN_TOOLS = ['save_skin', 'list_skins', 'wear_skin', 'delete_skin'];

function systemPrompt() {
  const access = settings.computerAccess === 'granted';
  return [
    'You are Pip, a small, cheerful 3D desktop pet that floats on the user\'s screen and helps them get things done.',
    'Talk like a friendly companion: short, warm replies (1-3 sentences) when chatting; clear step-by-step updates when working.',
    access
      ? [
          'The user has allowed you to use their computer. You have tools from the "pip" server to see the screen and control the mouse and keyboard (screenshot, click, type_text, press_keys, scroll, drag, open, wait), plus file and shell tools.',
          `Your project folder is the current working directory (${workspace()}). When asked to build something, like a game, create it there with your file tools, then open it for the user (for a web game, open its index.html in the browser with the open tool).`,
          'When working on screen: take a screenshot first, act one step at a time, and take another screenshot to check the result after important steps.',
          `The computer runs ${process.platform === 'darwin' ? 'macOS (use cmd for shortcuts)' : process.platform === 'win32' ? 'Windows' : 'Linux'}.`,
          'Never type passwords, payment or personal details, make purchases, send messages as the user, or delete the user\'s files: stop and ask the user to do those parts themselves.',
        ].join(' ')
      : 'The user has NOT allowed you to use their computer, so you cannot see the screen, click, or create files. Chat normally; if they want you to do something on the computer, tell them to tap the gear and allow computer access.',
    `You can also redesign yourself! When the user asks for a new look or skin (or you're asked to surprise them), design one with the save_skin tool: choose a fun palette, switch built-in accessories on or off, and build new accessories from shapes (hats, horns, wings, glasses, capes, a sword in your hand...). Be creative and detailed, using several shapes per accessory. You are currently wearing "${settings.skin}". Use list_skins, wear_skin and delete_skin to manage skins.`,
  ].join('\n');
}

async function askPermissionOnce() {
  if (settings.computerAccess) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Let Pip use your computer?',
    message: 'Can Pip use your computer to help you?',
    detail: 'Pip will be able to see your screen, move the mouse, type, open apps and websites, and create files and run commands in its "Pip Projects" folder. It uses your own Claude Code subscription.\n\nYou can press Stop at any time, and change this later in Pip\'s settings.',
    buttons: ['Allow', 'Chat only'],
    defaultId: 0, cancelId: 1, noLink: true,
  });
  settings.computerAccess = response === 0 ? 'granted' : 'denied';
  saveSettings();
}

const ACTION_LABELS = {
  screenshot: '👀 Looking at your screen', click: '🖱️ Clicking', move_mouse: '🖱️ Moving the mouse', drag: '🖱️ Dragging',
  type_text: '⌨️ Typing', press_keys: '⌨️ Pressing keys', scroll: '🖱️ Scrolling', wait: '⏳ Waiting', open: '🚀 Opening',
  save_skin: '🎨 Designing a new look', wear_skin: '👕 Changing outfits', list_skins: '👗 Checking my wardrobe', delete_skin: '🗑️ Removing a skin',
  Write: '📝 Writing a file', Edit: '✏️ Editing a file', Read: '📖 Reading', Bash: '💻 Running a command', Glob: '🔎 Looking for files', Grep: '🔎 Searching',
};

ipcMain.handle('pet:ask', async (_e, text) => {
  if (current) return { error: 'I\'m still working on the last thing! Press Stop if you want me to switch.' };
  await askPermissionOnce();
  if (!currentChat) {
    currentChat = { id: crypto.randomUUID(), sessionId: null, title: text.replace(/\s+/g, ' ').slice(0, 60), created: Date.now(), updated: Date.now(), messages: [], usage: { input: 0, output: 0 } };
    chats.unshift(currentChat);
  }
  const chat = currentChat;
  chat.messages.push({ role: 'me', text });
  chat.updated = Date.now();
  chats = [chat, ...chats.filter((c) => c !== chat)];
  saveChats();
  const access = settings.computerAccess === 'granted';
  cancelled = false;
  busy = true;
  send('pet:state', 'thinking');
  const turn = runClaude({
    prompt: text,
    systemPrompt: systemPrompt(),
    cwd: workspace(),
    sessionId,
    model: settings.model || undefined,
    effort: settings.effort || undefined,
    tools: access ? 'Read,Write,Edit,Glob,Grep,Bash' : '',
    mcpConfigPath: access ? mcpConfigPath : mcpSkinsConfigPath,
    allowedTools: [
      ...(access ? ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', ...COMPUTER_TOOLS.map((t) => `mcp__pip__${t}`)] : []),
      ...SKIN_TOOLS.map((t) => `mcp__pip__${t}`),
    ],
  });
  current = turn;
  turn.on('session', (id) => { sessionId = id; chat.sessionId = id; });
  turn.on('limits', recordLimits);
  turn.on('text', (t) => { send('pet:state', 'talking'); send('pet:text', t); });
  turn.on('tool', ({ name }) => {
    send('pet:state', 'working');
    if (!name.startsWith('mcp__pip__')) send('pet:tool', ACTION_LABELS[name] || `🔧 ${name}`); // pip tools report themselves when they run
  });
  turn.on('done', (r) => {
    current = null;
    busy = false;
    if (r.sessionId) { sessionId = r.sessionId; chat.sessionId = r.sessionId; }
    if (r.text) chat.messages.push({ role: 'pip', text: r.text });
    if (r.error) chat.messages.push({ role: 'err', text: r.error });
    if (r.usage) {
      chat.usage.input += r.usage.input;
      chat.usage.output += r.usage.output;
      chat.model = r.usage.model || chat.model;
      recordUsage('chat', r.usage);
    }
    chat.updated = Date.now();
    saveChats();
    send('pet:done', { error: r.error || null });
    send('pet:state', r.error ? 'sad' : 'happy');
  });
  return { ok: true };
});

ipcMain.on('pet:stop', () => { cancelled = true; current?.stop(); });
ipcMain.on('pet:new-chat', () => { sessionId = null; currentChat = null; send('chats:changed'); });

// ---------- chat history ----------
ipcMain.handle('chats:list', () => chatList());
ipcMain.handle('chats:open', (_e, id) => {
  if (current) return { error: 'Wait until I finish, or press Stop.' };
  const chat = chats.find((c) => c.id === id);
  if (!chat) return { error: 'That chat is gone.' };
  currentChat = chat;
  sessionId = chat.sessionId;
  send('chats:changed');
  return { messages: chat.messages, title: chat.title };
});
ipcMain.on('chats:delete', (_e, id) => {
  chats = chats.filter((c) => c.id !== id);
  if (currentChat?.id === id) { currentChat = null; sessionId = null; }
  saveChats();
});

// ---------- usage ----------
ipcMain.handle('usage:get', () => usageSummary());

// ---------- other renderer requests ----------
ipcMain.on('pet:ignore-mouse', (_e, ignore) => win?.setIgnoreMouseEvents(ignore, { forward: true }));
ipcMain.on('pet:drag', (_e, { phase, dx, dy }) => {
  if (phase === 'start') { dragging = true; if (glide) { clearInterval(glide); glide = null; } }
  if (phase === 'move' && win) { const [x, y] = win.getPosition(); win.setPosition(x + dx, y + dy); }
  if (phase === 'end') dragging = false;
});
ipcMain.on('pet:chat-open', (_e, open) => { chatOpen = open; });
ipcMain.handle('pet:get-settings', () => publicSettings());
ipcMain.on('pet:update-settings', (_e, patch) => {
  const allowed = ['skin', 'wander', 'computerAccess', 'model', 'effort', 'name'];
  for (const k of allowed) if (k in patch) settings[k] = typeof patch[k] === 'string' ? patch[k].slice(0, 60) : patch[k];
  if (!allSkins().skins[settings.skin]) settings.skin = SKINS.default;
  saveSettings();
  buildTray();
});
ipcMain.on('pet:open-folder', () => shell.openPath(workspace()));

// Opens a terminal running `claude` so the user can sign in with their subscription.
ipcMain.on('pet:open-login', () => {
  const bin = findClaude().cmd;
  const detach = (cmd, args) => { try { const c = spawn(cmd, args, { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); return true; } catch { return false; } };
  if (process.platform === 'darwin') {
    detach('osascript', ['-e', `tell application "Terminal" to do script "${bin.replace(/"/g, '\\"')}"`, '-e', 'tell application "Terminal" to activate']);
  } else if (process.platform === 'win32') {
    detach('cmd.exe', ['/c', 'start', 'Claude sign-in', 'cmd', '/k', bin]);
  } else {
    const terms = [['x-terminal-emulator', ['-e', bin]], ['gnome-terminal', ['--', bin]], ['konsole', ['-e', bin]], ['xfce4-terminal', ['-e', bin]], ['xterm', ['-e', bin]]];
    const { execFileSync } = require('node:child_process');
    for (const [t, a] of terms) { try { execFileSync('which', [t], { stdio: 'ignore' }); detach(t, a); break; } catch {} }
  }
});
ipcMain.on('pet:quit', () => app.quit());

ipcMain.handle('room:connect', (_e, { link, code }) => {
  settings.room = { link, code };
  saveSettings();
  connectRoom();
  return { ok: true };
});
ipcMain.on('room:disconnect', () => {
  room?.close();
  room = null;
  settings.room = null;
  saveSettings();
  send('room:status', { state: 'off' });
});

function connectRoom() {
  room?.close();
  if (!settings.room) return;
  room = new RoomLink(settings.room.link, settings.room.code, {
    status: (s) => send('room:status', s),
    activity: (state) => { if (!current) send('pet:state', state); },
    limits: recordLimits,
    usage: (u) => recordUsage('room', u),
  });
}

// ---------- one-click rooms: host one, or join with an invite link ----------
let roomWin = null;
const hostInfo = () => {
  const h = currentHost();
  return h ? { publicUrl: h.publicUrl, lanUrl: h.lanUrl, localUrl: h.localUrl } : null;
};

function parseRoomLink(link) {
  try {
    const u = new URL(String(link).trim());
    const m = u.pathname.match(/\/r\/([a-z0-9-]{4,40})/);
    if (!/^https?:$/.test(u.protocol) || !m) return null;
    return { base: u.origin, id: m[1] };
  } catch { return null; }
}

function rememberRoom(entry) {
  settings.recentRooms = [entry, ...(settings.recentRooms || []).filter((r) => r.id !== entry.id)].slice(0, 10);
  saveSettings();
}

// Opens the room in its own window, already joined as you and paired with this Pip,
// so "Ask Claude" uses your own Claude Code and subscription.
function openRoom(base, id, roomName) {
  const link = `${base}/r/${id}`;
  settings.room = { link, code: settings.pairCode };
  saveSettings();
  connectRoom();
  const hash = new URLSearchParams({ name: settings.name || 'Me', pair: settings.pairCode, billing: 'pip' });
  if (settings.model) hash.set('model', settings.model);
  if (settings.effort && settings.effort !== 'default') hash.set('effort', settings.effort);
  if (roomName) hash.set('roomName', roomName);
  if (!roomWin || roomWin.isDestroyed()) {
    roomWin = new BrowserWindow({
      width: 1040, height: 760, title: 'Claude Room', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'persist:rooms' },
    });
    roomWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    roomWin.on('closed', () => {
      roomWin = null;
      room?.close();
      room = null;
      settings.room = null;
      saveSettings();
      send('room:status', { state: 'off' });
    });
  }
  roomWin.loadURL(`${link}#${hash}`);
  roomWin.show();
  roomWin.focus();
}

ipcMain.handle('room:host', async (_e, { name, id }) => {
  if (!settings.name) return { error: 'Set your name first.' };
  try {
    const h = await startHosting({
      dataDir: path.join(app.getPath('userData'), 'rooms'),
      onStatus: (text) => send('room:status', { state: 'connecting', text }),
    });
    const roomName = String(name || 'Our room').slice(0, 80);
    const slug = roomName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20);
    const roomId = /^[a-z0-9-]{4,40}$/.test(id || '') ? id : `${slug ? slug + '-' : ''}${crypto.randomBytes(5).toString('hex')}`;
    const invite = `${h.publicUrl || h.lanUrl || h.localUrl}/r/${roomId}`;
    openRoom(h.localUrl, roomId, roomName);
    rememberRoom({ id: roomId, name: roomName, link: invite, hosted: true, ts: Date.now() });
    return {
      invite, roomId, public: !!h.publicUrl,
      note: h.publicUrl ? null : 'Could not make a public link, so only people on the same Wi-Fi can join with this link.',
    };
  } catch (err) {
    return { error: `Could not host: ${err.message}` };
  }
});

ipcMain.handle('room:join', (_e, link) => {
  if (!settings.name) return { error: 'Set your name first.' };
  const r = parseRoomLink(link);
  if (!r) return { error: 'That doesn\'t look like a room invite link (it should contain /r/).' };
  const h = currentHost();
  // Our own hosted room: talk to it directly on this computer.
  const mine = h && [h.publicUrl, h.lanUrl, h.localUrl].includes(r.base);
  openRoom(mine ? h.localUrl : r.base, r.id);
  const prev = (settings.recentRooms || []).find((x) => x.id === r.id);
  rememberRoom({ id: r.id, name: prev?.name || r.id, link: `${r.base}/r/${r.id}`, hosted: !!prev?.hosted, ts: Date.now() });
  return { ok: true };
});

ipcMain.handle('room:stop-hosting', async () => {
  await stopHosting();
  if (roomWin && !roomWin.isDestroyed()) roomWin.close();
  send('pet:settings', publicSettings());
  return { ok: true };
});
ipcMain.on('room:forget', (_e, id) => {
  settings.recentRooms = (settings.recentRooms || []).filter((r) => r.id !== id);
  saveSettings();
});
ipcMain.on('pet:copy', (_e, text) => clipboard.writeText(String(text)));

// ---------- updates ----------
// The installer writes INSTALL.json (which version is installed) next to the app.
const PIP_HOME = path.dirname(__dirname); // ~/.pip-pet or %LOCALAPPDATA%\PipPet when installed
function installedVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'INSTALL.json'), 'utf8')); } catch { return null; }
}
async function checkForUpdate() {
  const v = installedVersion();
  if (!v || !/^[\w.-]+\/[\w.-]+$/.test(v.repo || '')) return { error: 'This copy of Pip wasn\'t installed with the installer, so it can\'t update itself. (Running from source? Use git pull.)' };
  const branch = v.branch || 'main';
  try {
    // Newest version id, read the way `git` does (no API rate limit).
    const res = await fetch(`https://github.com/${v.repo}.git/info/refs?service=git-upload-pack`, { headers: { 'User-Agent': 'git/2 pip-desktop-pet' } });
    if (!res.ok) throw new Error(`GitHub said ${res.status}`);
    const esc = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sha = ((await res.text()).match(new RegExp(`([0-9a-f]{40}) refs/heads/${esc}\\n`)) || [])[1];
    if (!sha) throw new Error('could not find the newest version');
    const latest = { sha, date: null, message: 'A new version of Pip is ready.' };
    // Nice-to-have details (this API is rate limited, so it's optional).
    try {
      const c = await (await fetch(`https://api.github.com/repos/${v.repo}/commits/${sha}`, { headers: { 'User-Agent': 'pip-desktop-pet' } })).json();
      if (c.commit) { latest.date = c.commit.committer?.date; latest.message = String(c.commit.message || '').split('\n')[0]; }
    } catch {}
    settings.lastUpdateCheck = Date.now();
    saveSettings();
    return { installed: v, latest, upToDate: !!v.sha && v.sha === latest.sha };
  } catch (err) {
    return { error: `Couldn't check for updates: ${err.message}` };
  }
}
function runUpdate() {
  const v = installedVersion();
  if (!v) return { error: 'This copy of Pip can\'t update itself.' };
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    if (process.platform === 'win32') {
      const cmd = path.join(PIP_HOME, 'bin', 'pip-pet.cmd');
      if (!fs.existsSync(cmd)) return { error: 'Update helper is missing. Run the install command again.' };
      spawn('cmd.exe', ['/c', 'start', 'Updating Pip', 'cmd', '/c', cmd, 'update'], { detached: true, stdio: 'ignore', env }).unref();
    } else {
      const launcher = path.join(os.homedir(), '.local', 'bin', 'pip-pet');
      if (!fs.existsSync(launcher)) return { error: 'Update helper is missing. Run the install command again.' };
      const log = path.join(PIP_HOME, 'update.log');
      spawn('/bin/bash', ['-c', `sleep 1; "${launcher}" update > "${log}" 2>&1`], { detached: true, stdio: 'ignore', env }).unref();
    }
  } catch (err) {
    return { error: `Couldn't start the update: ${err.message}` };
  }
  setTimeout(() => app.quit(), 300); // the installer starts the new Pip when it's done
  return { ok: true };
}
ipcMain.handle('pip:version', () => installedVersion());
ipcMain.handle('pip:check-update', () => checkForUpdate());
ipcMain.handle('pip:update', () => runUpdate());

// ---------- tray ----------
function buildTray() {
  if (!tray) {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'previews', `${SKINS.default}.png`)).resize({ width: 20, height: 20 });
    tray = new Tray(icon);
    tray.setToolTip('Pip');
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Pip', click: () => { win.show(); send('pet:open-chat'); } },
    { label: 'Skin', submenu: Object.entries(allSkins().skins).map(([id, s]) => ({ label: s.label, type: 'radio', checked: settings.skin === id, click: () => { settings.skin = id; saveSettings(); } })) },
    { label: 'Float around', type: 'checkbox', checked: settings.wander, click: (i) => { settings.wander = i.checked; saveSettings(); } },
    { label: 'Computer access', type: 'checkbox', checked: settings.computerAccess === 'granted', click: (i) => { settings.computerAccess = i.checked ? 'granted' : 'denied'; saveSettings(); } },
    { label: 'Open Pip Projects folder', click: () => shell.openPath(workspace()) },
    { label: 'Check for updates…', click: () => { win.show(); send('pet:open-view', 'settings'); send('pet:check-update'); } },
    { type: 'separator' },
    { label: 'Quit Pip', click: () => app.quit() },
  ]));
}

// ---------- start ----------
if (process.env.PIP_USER_DATA) app.setPath('userData', process.env.PIP_USER_DATA); // separate profile, e.g. for tests
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  loadSettings();
  loadCustom();
  loadChats();
  loadUsage();
  if (process.platform === 'darwin') app.dock?.hide();
  control = await startControlServer({
    allowed: () => settings.computerAccess === 'granted',
    cancelled: () => cancelled,
    petWindow: () => win,
    onAction: (name) => { send('pet:state', 'working'); send('pet:tool', ACTION_LABELS[name] || name); },
    skinTool: (name, args) => { send('pet:tool', ACTION_LABELS[name] || name); return skinTool(name, args); },
  });
  const writeMcp = (file, toolset) => {
    const p = path.join(app.getPath('userData'), file);
    fs.writeFileSync(p, JSON.stringify({
      mcpServers: {
        pip: {
          type: 'stdio',
          command: process.execPath, // Electron's own binary, run as plain Node
          args: [path.join(__dirname, 'mcp', 'computer-server.mjs')],
          env: { ELECTRON_RUN_AS_NODE: '1', PIP_CONTROL_URL: control.url, PIP_CONTROL_TOKEN: control.token, PIP_TOOLSET: toolset },
        },
      },
    }, null, 2), { mode: 0o600 });
    return p;
  };
  mcpConfigPath = writeMcp('mcp-config.json', 'all');
  mcpSkinsConfigPath = writeMcp('mcp-skins.json', 'skins');
  createWindow();
  buildTray();
  settings.room = null; // rooms reopen from the Rooms list
  setInterval(wanderTick, 9000);
  // Once a day, quietly check for a new version.
  setTimeout(async () => {
    if (!installedVersion() || Date.now() - (settings.lastUpdateCheck || 0) < 864e5) return;
    const r = await checkForUpdate();
    if (r.latest && !r.upToDate) send('pet:update-available', r);
  }, 15000);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { stopHosting().catch(() => {}); });

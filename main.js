// Pip: a 3D desktop pet that floats around your screen and does things for you
// with your own Claude Code subscription.

const { app, BrowserWindow, ipcMain, screen, dialog, Tray, Menu, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runClaude, findClaude } = require('./lib/claude');
const { spawn } = require('node:child_process');
const { startControlServer } = require('./lib/control');
const { RoomLink } = require('./lib/room');

const SKINS = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'skins.json'), 'utf8'));
const SLOTS = ['body', 'belly', 'eye', 'highlight', 'cheek', 'bulb', 'accent'];
const PARTS = ['stem', 'bulb', 'leaf', 'crown', 'headphones', 'beanie'];
const SHAPES = ['sphere', 'box', 'cylinder', 'cone', 'torus', 'capsule'];
const WIN_W = 380;
const WIN_H = 560;

// ---------- settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { skin: SKINS.default, wander: true, computerAccess: null, room: null, model: '' };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch {}
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  send('pet:settings', publicSettings());
}
const publicSettings = () => ({ ...settings, skins: allSkins(), workspace: workspace() });

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
    tools: access ? 'Read,Write,Edit,Glob,Grep,Bash' : '',
    mcpConfigPath: access ? mcpConfigPath : mcpSkinsConfigPath,
    allowedTools: [
      ...(access ? ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', ...COMPUTER_TOOLS.map((t) => `mcp__pip__${t}`)] : []),
      ...SKIN_TOOLS.map((t) => `mcp__pip__${t}`),
    ],
  });
  current = turn;
  turn.on('session', (id) => { sessionId = id; });
  turn.on('text', (t) => { send('pet:state', 'talking'); send('pet:text', t); });
  turn.on('tool', ({ name }) => {
    send('pet:state', 'working');
    if (!name.startsWith('mcp__pip__')) send('pet:tool', ACTION_LABELS[name] || `🔧 ${name}`); // pip tools report themselves when they run
  });
  turn.on('done', (r) => {
    current = null;
    busy = false;
    if (r.sessionId) sessionId = r.sessionId;
    send('pet:done', { error: r.error || null });
    send('pet:state', r.error ? 'sad' : 'happy');
  });
  return { ok: true };
});

ipcMain.on('pet:stop', () => { cancelled = true; current?.stop(); });
ipcMain.on('pet:new-chat', () => { sessionId = null; });

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
  const allowed = ['skin', 'wander', 'computerAccess', 'model'];
  for (const k of allowed) if (k in patch) settings[k] = patch[k];
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
  });
}

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
  connectRoom();
  setInterval(wanderTick, 9000);
});

app.on('window-all-closed', () => app.quit());

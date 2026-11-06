// Pip's hands and eyes: a localhost-only server that the MCP helper calls.
// It takes screenshots and drives the mouse and keyboard, but only while the
// user has granted computer access, and only for requests carrying the secret token.

const http = require('node:http');
const crypto = require('node:crypto');
const { desktopCapturer, screen, shell } = require('electron');

let nut = null;
function input() {
  if (!nut) nut = require('@nut-tree-fork/nut-js');
  nut.mouse.config.autoDelayMs = 30;
  nut.keyboard.config.autoDelayMs = 8;
  return nut;
}

const SKIN_TOOLS = new Set(['save_skin', 'list_skins', 'wear_skin', 'delete_skin']); // allowed even in chat-only mode
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_SHOT_WIDTH = 1280;

const KEYMAP = {
  ctrl: 'LeftControl', control: 'LeftControl', shift: 'LeftShift', alt: 'LeftAlt', option: 'LeftAlt', opt: 'LeftAlt',
  cmd: 'LeftCmd', command: 'LeftCmd', meta: 'LeftSuper', super: 'LeftSuper', win: 'LeftSuper', windows: 'LeftSuper',
  enter: 'Enter', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', home: 'Home', end: 'End',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', pageup: 'PageUp', pagedown: 'PageDown', capslock: 'CapsLock',
  '-': 'Minus', '=': 'Equal', '.': 'Period', ',': 'Comma', '/': 'Slash', ';': 'Semicolon', "'": 'Quote',
  '[': 'LeftBracket', ']': 'RightBracket', '\\': 'Backslash', '`': 'Grave',
};

function parseKeys(combo) {
  const { Key } = input();
  return combo.toLowerCase().split('+').map((raw) => {
    const k = raw.trim();
    let name = KEYMAP[k];
    if (!name && /^[a-z]$/.test(k)) name = k.toUpperCase();
    if (!name && /^[0-9]$/.test(k)) name = 'Num' + k;
    if (!name && /^f([1-9]|1[0-9]|2[0-4])$/.test(k)) name = k.toUpperCase();
    if (!name || !(name in Key)) throw new Error(`Unknown key "${raw}"`);
    return Key[name];
  });
}

/**
 * hooks: {
 *   allowed(): boolean            - has the user granted computer access?
 *   cancelled(): boolean          - did the user press Stop?
 *   petWindow(): BrowserWindow    - so Pip can hide from screenshots and dodge clicks
 *   onAction(name, args)          - lets the pet show what it's doing
 *   skinTool(name, args)          - skin designer tools (handled by main.js)
 * }
 */
function startControlServer(hooks) {
  const token = crypto.randomBytes(24).toString('hex');
  let lastShot = null;

  const display = () => screen.getPrimaryDisplay();

  // Screenshot pixels -> screen points for the input library.
  function toScreen(x, y) {
    const d = display();
    const b = d.bounds;
    const sx = lastShot ? b.width / lastShot.w : 1;
    const sy = lastShot ? b.height / lastShot.h : 1;
    let px = b.x + x * sx;
    let py = b.y + y * sy;
    // Windows reports DPI-scaled points to Electron, but the input library works in physical pixels.
    if (process.platform === 'win32') { px *= d.scaleFactor; py *= d.scaleFactor; }
    return { x: Math.round(px), y: Math.round(py), logical: { x: b.x + x * sx, y: b.y + y * sy } };
  }

  // If Claude wants to click where Pip is floating, Pip hops out of the way first.
  function dodge(point) {
    const win = hooks.petWindow();
    if (!win || win.isDestroyed()) return;
    const w = win.getBounds();
    const pad = 30;
    if (point.x < w.x - pad || point.x > w.x + w.width + pad || point.y < w.y - pad || point.y > w.y + w.height + pad) return;
    const area = display().workArea;
    const goLeft = point.x > area.x + area.width / 2;
    win.setPosition(goLeft ? area.x + 20 : area.x + area.width - w.width - 20, area.y + area.height - w.height - 20);
  }

  async function screenshot() {
    const d = display();
    const scale = Math.min(1, MAX_SHOT_WIDTH / d.size.width);
    const size = { width: Math.round(d.size.width * scale), height: Math.round(d.size.height * scale) };
    const win = hooks.petWindow();
    const hide = win && !win.isDestroyed();
    if (hide) { win.setOpacity(0); await sleep(80); }
    let sources;
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    } finally {
      if (hide) win.setOpacity(1);
    }
    const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) {
      throw new Error('Screenshot came back empty. On macOS, allow Screen Recording for Pip (or Electron) in System Settings > Privacy & Security, then restart Pip.');
    }
    const sz = src.thumbnail.getSize();
    lastShot = { w: sz.width, h: sz.height };
    return [
      { type: 'image', data: src.thumbnail.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' },
      { type: 'text', text: `Screenshot of the main screen, ${sz.width}x${sz.height} pixels. Use these pixel coordinates for clicks.` },
    ];
  }

  const text = (t) => [{ type: 'text', text: t }];

  async function run(name, a) {
    if (name === 'screenshot') return screenshot();
    if (name === 'wait') { await sleep(Math.min(30, Math.max(0, a.seconds || 1)) * 1000); return text('Waited.'); }
    if (name === 'open') {
      const t = String(a.target || '');
      if (/^https?:\/\//i.test(t)) await shell.openExternal(t);
      else { const err = await shell.openPath(t); if (err) throw new Error(err); }
      return text(`Opened ${t}`);
    }

    const { mouse, keyboard, Button, Point } = input();
    const buttons = { left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE };
    if (name === 'click' || name === 'move_mouse') {
      const p = toScreen(a.x, a.y);
      dodge(p.logical);
      await mouse.setPosition(new Point(p.x, p.y));
      if (name === 'move_mouse') return text(`Mouse at ${a.x},${a.y}.`);
      const btn = buttons[a.button || 'left'];
      if (a.double) await mouse.doubleClick(btn); else await mouse.click(btn);
      return text(`${a.double ? 'Double-clicked' : 'Clicked'} ${a.button || 'left'} at ${a.x},${a.y}.`);
    }
    if (name === 'drag') {
      const p1 = toScreen(a.from_x, a.from_y);
      const p2 = toScreen(a.to_x, a.to_y);
      dodge(p1.logical); dodge(p2.logical);
      await mouse.setPosition(new Point(p1.x, p1.y));
      await mouse.pressButton(Button.LEFT);
      for (let i = 1; i <= 12; i++) {
        await mouse.setPosition(new Point(Math.round(p1.x + ((p2.x - p1.x) * i) / 12), Math.round(p1.y + ((p2.y - p1.y) * i) / 12)));
      }
      await mouse.releaseButton(Button.LEFT);
      return text('Dragged.');
    }
    if (name === 'type_text') { await keyboard.type(String(a.text || '')); return text('Typed.'); }
    if (name === 'press_keys') {
      const keys = parseKeys(String(a.keys || ''));
      await keyboard.pressKey(...keys);
      await keyboard.releaseKey(...keys.reverse());
      return text(`Pressed ${a.keys}.`);
    }
    if (name === 'scroll') {
      const p = toScreen(a.x, a.y);
      await mouse.setPosition(new Point(p.x, p.y));
      const n = Math.max(1, Math.min(30, a.amount || 5));
      const fn = { up: 'scrollUp', down: 'scrollDown', left: 'scrollLeft', right: 'scrollRight' }[a.direction] || 'scrollDown';
      await mouse[fn](n * 100);
      return text(`Scrolled ${a.direction}.`);
    }
    throw new Error(`Unknown tool ${name}`);
  }

  const server = http.createServer((req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.url !== '/tool') return reply(404, { error: 'not found' });
    const auth = req.headers.authorization || '';
    const expected = `Bearer ${token}`;
    if (auth.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) return reply(401, { error: 'bad token' });
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch { return reply(400, { error: 'bad json' }); }
      if (hooks.skinTool && SKIN_TOOLS.has(msg.name)) {
        try { return reply(200, { content: text(await hooks.skinTool(msg.name, msg.args || {})) }); }
        catch (err) { return reply(200, { isError: true, content: text(`Failed: ${err.message}`) }); }
      }
      if (!hooks.allowed()) return reply(403, { error: 'The user has not given Pip access to this computer. Ask them to allow it in Pip\'s settings.' });
      if (hooks.cancelled()) return reply(409, { error: 'The user pressed Stop. Do not continue.' });
      hooks.onAction(msg.name, msg.args || {});
      try {
        reply(200, { content: await run(msg.name, msg.args || {}) });
      } catch (err) {
        reply(200, { isError: true, content: text(`Failed: ${err.message}`) });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, token, close: () => server.close() }));
  });
}

module.exports = { startControlServer, parseKeys };

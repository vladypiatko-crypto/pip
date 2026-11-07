// Links Pip to a Claude Room so that when *you* press "Ask Claude" in the room,
// the answer is made by your own Claude Code on this computer (your subscription).
// Room requests are chat-only: Claude gets no tools, so other people's messages
// can never make it touch this computer.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { runClaude } = require('./claude');

class RoomLink {
  constructor(link, code, hooks) {
    this.hooks = hooks;
    this.code = String(code || '').trim().toUpperCase();
    this.runs = new Map();
    this.closed = false;
    this.retry = 0;
    this.waits = 0;
    try {
      const u = new URL(link.trim());
      const m = u.pathname.match(/\/r\/([a-z0-9-]{4,40})/);
      if (!m) throw new Error('bad link');
      this.roomId = m[1];
      this.wsUrl = `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/ws`;
    } catch {
      hooks.status({ state: 'error', text: 'That doesn\'t look like a Claude Room link.' });
      this.closed = true;
      return;
    }
    // An empty folder so chat-only runs have nothing to look at.
    this.cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pip-room-'));
    this.connect();
  }

  connect() {
    if (this.closed) return;
    this.hooks.status({ state: 'connecting' });
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'companion', room: this.roomId, code: this.code })));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'companion-ok') { this.retry = 0; this.hooks.status({ state: 'connected', room: m.room, owner: m.owner }); }
      if (m.t === 'companion-error') {
        if (m.retry && this.waits++ < 100) { this.hooks.status({ state: 'connecting', text: m.text }); this.waitRetry = true; return; }
        this.hooks.status({ state: 'error', text: m.text });
        this.closed = true;
        ws.close();
      }
      if (m.t === 'run') this.run(m);
      if (m.t === 'stop') this.runs.get(m.id)?.stop();
    });
    ws.on('close', () => {
      for (const r of this.runs.values()) r.stop();
      if (this.closed) return;
      if (this.waitRetry) { this.waitRetry = false; setTimeout(() => this.connect(), 2000); return; }
      this.hooks.status({ state: 'connecting' });
      setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.retry++, 20000));
    });
    ws.on('error', () => {});
  }

  run({ id, system, prompt, model, effort }) {
    const send = (msg) => this.ws?.readyState === 1 && this.ws.send(JSON.stringify(msg));
    this.hooks.activity('thinking');
    const okModel = typeof model === 'string' && /^claude-[a-z0-9-]{3,40}$/.test(model) ? model : undefined;
    const okEffort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : undefined;
    const turn = runClaude({ prompt, systemPrompt: system, cwd: this.cwd, tools: '', noPersist: true, model: okModel, effort: okEffort });
    turn.on('limits', (l) => this.hooks.limits?.(l));
    this.runs.set(id, turn);
    turn.on('text', (text) => { this.hooks.activity('talking'); send({ t: 'c-delta', id, text }); });
    turn.on('done', (r) => {
      this.runs.delete(id);
      const u = r.usage || {};
      send({ t: 'c-done', id, error: r.error || null, usage: { input: u.input || 0, output: u.output || 0, model: u.model || okModel || null } });
      this.hooks.activity(r.error ? 'sad' : 'happy');
      if (r.usage) this.hooks.usage?.(r.usage);
    });
  }

  close() {
    this.closed = true;
    for (const r of this.runs.values()) r.stop();
    try { this.ws?.close(); } catch {}
  }
}

module.exports = { RoomLink };

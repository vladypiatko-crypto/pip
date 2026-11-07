// Claude Room: a shared chat where a group works with Claude together.
// Every person brings their own Anthropic API key. When someone asks Claude,
// the request is made with *their* key, so each person pays for their own use.
// Keys are held in memory for the lifetime of that person's connection only:
// they are never written to disk, logged, or sent to other people.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
let DATA_DIR = path.join(__dirname, 'data'); // startRoomServer() can point this elsewhere

const MODELS = {
  'claude-opus-5-5': { label: 'Opus 5.5', fallbacks: true },
  'claude-sonnet-5-5': { label: 'Sonnet 5.5', fallbacks: true },
  'claude-haiku-5-5': { label: 'Haiku 5.5', fallbacks: false },
  'claude-fable-5-1': { label: 'Fable 5.1', fallbacks: true },
};
const DEFAULT_MODEL = 'claude-opus-5-5';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_CONTEXT_CHARS = 600_000; // roughly 150k tokens of chat history sent to Claude
const MAX_MESSAGE_CHARS = 20_000;

// ---------- rooms ----------

const rooms = new Map(); // id -> { id, name, messages, clients:Set, busy, saveTimer }

const validRoomId = (id) => typeof id === 'string' && /^[a-z0-9-]{4,40}$/.test(id);

function loadRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  let saved = { name: 'Untitled room', messages: [] };
  try { saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${id}.json`), 'utf8')); } catch {}
  const room = { id, name: saved.name, messages: saved.messages || [], clients: new Set(), companions: new Map(), busy: null, saveTimer: null };
  rooms.set(id, room);
  return room;
}

function saveRoom(room) {
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => {
    const data = JSON.stringify({ name: room.name, messages: room.messages.filter((m) => !m.streaming) });
    fs.writeFile(path.join(DATA_DIR, `${room.id}.json`), data, () => {});
  }, 500);
}

const members = (room) => [...room.clients].map((c) => ({
  id: c.id, name: c.name, hasKey: !!c.apiKey, model: c.model,
  hasPip: !!(c.pairCode && room.companions.get(c.pairCode)), billing: c.billing,
}));

function broadcast(room, payload) {
  const data = JSON.stringify(payload);
  for (const c of room.clients) if (c.ws.readyState === 1) c.ws.send(data);
}

function addMessage(room, msg) {
  room.messages.push(msg);
  broadcast(room, { t: 'msg', msg });
  saveRoom(room);
  return msg;
}

// ---------- talking to Claude ----------

// Turn the shared transcript into alternating user/assistant turns.
// Each person's message is tagged with their name so Claude knows who said what.
function toApiMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.type === 'system' || m.streaming || !m.text) continue;
    const role = m.type === 'claude' ? 'assistant' : 'user';
    const text = role === 'user' ? `[${m.author}]: ${m.text}` : m.text;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  }
  // Trim the oldest turns if the history gets very long.
  let total = out.reduce((n, m) => n + m.content.length, 0);
  while (out.length > 1 && total > MAX_CONTEXT_CHARS) total -= out.shift().content.length;
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function systemPrompt(room, asker) {
  const people = [...new Set([...room.clients].map((c) => c.name))].join(', ');
  return [
    `You are Claude, taking part in a shared group chat called "${room.name}".`,
    `Several people talk in this room. Each of their messages starts with their name in square brackets, like "[Sam]: ...". People in the room right now: ${people}.`,
    `Not every message is addressed to you; people also talk to each other. You are only called on when someone asks for you, and the latest request came from ${asker}.`,
    'Read the recent conversation, answer what was asked, and address people by name when it helps. Do not start your reply with a name tag in square brackets.',
    'Be a helpful collaborator for the whole group: keep track of what different people want, point out disagreements or open questions, and keep replies focused.',
  ].join('\n');
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Your API key was rejected. Check it in Settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Your API key does not have access to this model.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited on your API key. Wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) {
    const m = err.error?.error?.message || err.message;
    if (/credit balance/i.test(m)) return 'Your API account is out of credits. Add credits at console.anthropic.com.';
    return `Request rejected: ${m}`;
  }
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status}): ${err.message}`;
  return `Something went wrong: ${err.message}`;
}

async function askClaude(room, client) {
  const model = MODELS[client.model] ? client.model : DEFAULT_MODEL;
  const messages = toApiMessages(room.messages);
  if (!messages.length) return;

  const reply = addMessage(room, {
    id: crypto.randomUUID(), type: 'claude', author: 'Claude', text: '', ts: Date.now(),
    via: client.name, model, streaming: true,
  });
  const abort = new AbortController();
  room.busy = { replyId: reply.id, abort, by: client.name };

  try {
    const anthropic = new Anthropic({ apiKey: client.apiKey });
    const params = {
      model,
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: client.effort },
      cache_control: { type: 'ephemeral' },
      system: systemPrompt(room, client.name),
      messages,
    };
    if (MODELS[model].fallbacks) {
      // If a safety classifier declines, let the API retry on a suitable model.
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    const stream = anthropic.beta.messages.stream(params, { signal: abort.signal });
    stream.on('text', (delta) => {
      reply.text += delta;
      broadcast(room, { t: 'delta', id: reply.id, text: delta });
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      reply.error = 'Claude declined to answer this one.';
    } else if (final.stop_reason === 'max_tokens') {
      reply.error = 'Reply was cut off (hit the length limit).';
    }
    reply.usage = { input: final.usage?.input_tokens || 0, output: final.usage?.output_tokens || 0 };
    if (final.model && final.model !== model) reply.model = final.model;
  } catch (err) {
    if (abort.signal.aborted) reply.error = 'Stopped.';
    else {
      reply.error = describeError(err);
      console.error(`[${room.id}] Claude request by ${client.name} failed:`, err.status || '', err.message);
    }
  } finally {
    reply.streaming = false;
    room.busy = null;
    broadcast(room, { t: 'done', msg: reply });
    saveRoom(room);
  }
}

// Ask through the person's own Pip desktop pet, which runs *their* Claude Code
// on *their* computer, so the answer is paid by their Claude subscription.
// The server never sees any Claude login; it only relays the chat text.
function transcriptPrompt(room, asker) {
  const lines = toApiMessages(room.messages).map((m) => (m.role === 'assistant' ? `[Claude]: ${m.content}` : m.content));
  return [
    'Here is the group chat so far:',
    '',
    lines.join('\n\n'),
    '',
    `Now reply as Claude to the latest message from ${asker}. Write only your reply, without a name tag.`,
  ].join('\n');
}

function askViaPip(room, client, pip) {
  const reply = addMessage(room, {
    id: crypto.randomUUID(), type: 'claude', author: 'Claude', text: '', ts: Date.now(),
    via: client.name, model: client.model, billing: 'pip', streaming: true,
  });
  const finish = (error, usage) => {
    if (!reply.streaming) return;
    clearTimeout(timer);
    reply.streaming = false;
    if (error) reply.error = error;
    if (usage) {
      reply.usage = { input: num(usage.input), output: num(usage.output) };
      if (typeof usage.model === 'string' && /^claude-[a-z0-9-]{3,40}$/.test(usage.model)) reply.model = usage.model;
      if (typeof usage.backup === 'string' && usage.backup) { reply.billing = 'backup'; reply.backupLabel = usage.backup.replace(/[^\w .:/·+-]/g, '').slice(0, 60); }
    }
    pip.runs.delete(reply.id);
    room.busy = null;
    broadcast(room, { t: 'done', msg: reply });
    saveRoom(room);
  };
  const timer = setTimeout(() => finish('Pip took too long to answer.'), 10 * 60 * 1000);
  pip.runs.set(reply.id, {
    delta: (text) => { reply.text += text; broadcast(room, { t: 'delta', id: reply.id, text }); },
    finish,
  });
  room.busy = { replyId: reply.id, by: client.name, abort: { abort: () => { pip.send({ t: 'stop', id: reply.id }); finish('Stopped.'); } } };
  pip.send({
    t: 'run', id: reply.id, system: systemPrompt(room, client.name), prompt: transcriptPrompt(room, client.name),
    model: client.model, effort: client.effort,
  });
}

const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

function handleCompanion(ws, m) {
  const send = (payload) => ws.readyState === 1 && ws.send(JSON.stringify(payload));
  const code = String(m.code || '').trim().toUpperCase();
  const room = validRoomId(m.room) && rooms.get(m.room);
  const owner = room && [...room.clients].find((c) => c.pairCode && c.pairCode === code);
  if (!room || !owner) {
    // Usually Pip is just quicker than the room window; it will try again.
    send({ t: 'companion-error', retry: true, text: 'Waiting for you to join the room…' });
    return ws.close();
  }
  const pip = { ws, send, runs: new Map() };
  room.companions.get(code)?.ws.close();
  room.companions.set(code, pip);
  send({ t: 'companion-ok', room: room.name, owner: owner.name });
  broadcast(room, { t: 'members', members: members(room) });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const run = pip.runs.get(msg.id);
    if (!run) return;
    if (msg.t === 'c-delta') run.delta(String(msg.text || ''));
    if (msg.t === 'c-done') run.finish(msg.error ? String(msg.error).slice(0, 500) : null, msg.usage && typeof msg.usage === 'object' ? msg.usage : null);
  });
  ws.on('close', () => {
    for (const run of pip.runs.values()) run.finish('Pip disconnected.');
    if (room.companions.get(code) === pip) room.companions.delete(code);
    broadcast(room, { t: 'members', members: members(room) });
  });
}

// ---------- websocket protocol ----------

function handleConnection(ws) {
  const client = { id: crypto.randomUUID(), ws, name: '', apiKey: '', model: DEFAULT_MODEL, effort: 'medium', billing: 'api', pairCode: '', room: null };
  let isCompanion = false;
  const send = (payload) => ws.readyState === 1 && ws.send(JSON.stringify(payload));
  const applySettings = (m) => {
    if (typeof m.apiKey === 'string') client.apiKey = m.apiKey.trim().slice(0, 300);
    if (MODELS[m.model]) client.model = m.model;
    if (EFFORTS.includes(m.effort)) client.effort = m.effort;
    if (m.billing === 'api' || m.billing === 'pip') client.billing = m.billing;
    if (typeof m.pairCode === 'string' && /^[A-Z0-9]{6,8}$/.test(m.pairCode)) client.pairCode = m.pairCode;
  };

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (isCompanion) return; // handled by handleCompanion's own listener

    if (m.t === 'companion' && !client.room) {
      isCompanion = true;
      return handleCompanion(ws, m);
    }

    if (m.t === 'join') {
      if (client.room || !validRoomId(m.room)) return send({ t: 'error', text: 'Invalid room link.' });
      const name = String(m.name || '').trim().slice(0, 40);
      if (!name) return send({ t: 'error', text: 'Pick a name first.' });
      client.name = name;
      applySettings(m);
      const room = loadRoom(m.room);
      if (m.roomName && room.messages.length === 0) room.name = String(m.roomName).trim().slice(0, 80) || room.name;
      client.room = room;
      room.clients.add(client);
      send({ t: 'hello', you: client.id, room: { id: room.id, name: room.name }, messages: room.messages, models: MODELS, busy: room.busy && { id: room.busy.replyId, by: room.busy.by } });
      broadcast(room, { t: 'members', members: members(room) });
      addMessage(room, { id: crypto.randomUUID(), type: 'system', text: `${name} joined`, ts: Date.now() });
      return;
    }

    const room = client.room;
    if (!room) return;

    if (m.t === 'settings') {
      applySettings(m);
      broadcast(room, { t: 'members', members: members(room) });
      return send({ t: 'settings-ok' });
    }

    if (m.t === 'rename') {
      room.name = String(m.name || '').trim().slice(0, 80) || room.name;
      broadcast(room, { t: 'room', room: { id: room.id, name: room.name } });
      saveRoom(room);
      return;
    }

    if (m.t === 'say') {
      const text = String(m.text || '').slice(0, MAX_MESSAGE_CHARS);
      if (!text.trim()) return;
      const ask = !!m.ask || /^\s*@claude\b/i.test(text);
      const pip = client.billing === 'pip' && client.pairCode ? room.companions.get(client.pairCode) : null;
      if (ask && client.billing === 'pip' && !pip) return send({ t: 'error', text: 'Your Pip desktop pet isn\'t connected. Connect it with your pairing code (Settings), or switch to an API key.' });
      if (ask && client.billing === 'api' && !client.apiKey) return send({ t: 'error', text: 'Add your Anthropic API key in Settings, or use your Claude subscription through Pip.' });
      if (ask && room.busy) return send({ t: 'error', text: `Claude is still answering ${room.busy.by}. Wait or press Stop.` });
      addMessage(room, { id: crypto.randomUUID(), type: 'human', author: client.name, text, ts: Date.now(), asked: ask });
      if (ask) { if (pip) askViaPip(room, client, pip); else askClaude(room, client); }
      return;
    }

    if (m.t === 'stop' && room.busy) {
      room.busy.abort.abort();
      return;
    }

    if (m.t === 'typing') {
      broadcast(room, { t: 'typing', name: client.name });
    }
  });

  ws.on('close', () => {
    if (isCompanion) return;
    const room = client.room;
    if (!room) return;
    room.clients.delete(client);
    broadcast(room, { t: 'members', members: members(room) });
    addMessage(room, { id: crypto.randomUUID(), type: 'system', text: `${client.name} left`, ts: Date.now() });
  });
}

// ---------- static files ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function handleHttp(req, res) {
  const url = new URL(req.url, 'http://x');
  let file = url.pathname === '/' || url.pathname.startsWith('/r/') ? '/index.html' : url.pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/**
 * Start a room server. Pip calls this to host rooms with one click.
 * opts: { port (0 = any free port), dataDir, host }
 * Resolves to { port, close() }.
 */
export function startRoomServer(opts = {}) {
  if (opts.dataDir) DATA_DIR = opts.dataDir;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const server = http.createServer(handleHttp);
  new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 }).on('connection', handleConnection);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 3000, opts.host, () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => { for (const room of rooms.values()) for (const c of room.clients) c.ws.terminate(); server.close(() => r()); }),
    }));
  });
}

// Run directly: `npm start` / `node server.js`
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { port } = await startRoomServer({ port: Number(process.env.PORT) || 3000 });
  console.log(`Claude Room running at http://localhost:${port}`);
}

// Runs the user's own, unmodified Claude Code CLI (`claude -p`) and streams its output.
// Claude Code uses whatever login the user set up themselves (`claude` then /login),
// so requests are billed to their own Claude subscription. Pip never reads or stores
// that login: it only starts the program and reads what it prints.

const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let resolvedBinary = null;

// Find the `claude` executable. On Windows an npm install is a .cmd shim, which
// can only be started through a shell.
function findClaude() {
  if (resolvedBinary) return resolvedBinary;
  if (process.env.PIP_CLAUDE_BIN) return (resolvedBinary = { cmd: process.env.PIP_CLAUDE_BIN, shell: false });
  if (process.platform === 'win32') {
    // The native installer puts it here; PATH may not be refreshed yet right after installing.
    const native = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    if (fs.existsSync(native)) return (resolvedBinary = { cmd: native, shell: false });
    try {
      const hits = execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
      const exe = hits.find((h) => h.toLowerCase().endsWith('.exe'));
      if (exe) return (resolvedBinary = { cmd: exe, shell: false });
      if (hits[0]) return (resolvedBinary = { cmd: hits[0], shell: true });
    } catch {}
    return { cmd: 'claude', shell: true };
  }
  // GUI apps on macOS don't inherit the shell PATH, so check the usual install spots too.
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return (resolvedBinary = { cmd: c, shell: false });
  return (resolvedBinary = { cmd: 'claude', shell: false });
}

const quote = (a) => (/^[\w./:@=-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`);

/**
 * Start one Claude Code turn.
 * opts: { prompt, systemPrompt, cwd, sessionId, tools: string|null, allowedTools: [], mcpConfigPath, model }
 * Emits: 'session' (id), 'text' (delta), 'tool' ({name,input}), 'done' ({text, error, sessionId, costUsd})
 */
function runClaude(opts) {
  const ev = new EventEmitter();
  const bin = findClaude();
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.model) args.push('--model', opts.model);
  if (opts.tools !== undefined && opts.tools !== null) args.push('--tools', opts.tools);
  if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath);
  args.push('--strict-mcp-config');
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
  if (opts.noPersist) args.push('--no-session-persistence');

  // Make sure Claude Code uses the person's own subscription login rather than
  // silently switching to an API key that happens to be in the environment.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;

  let child;
  try {
    child = spawn(bin.shell ? args.reduce((s, a) => `${s} ${quote(a)}`, quote(bin.cmd)) : bin.cmd, bin.shell ? [] : args, {
      cwd: opts.cwd, env, shell: bin.shell, windowsHide: true,
    });
  } catch (err) {
    setImmediate(() => ev.emit('done', { text: '', error: notInstalled() }));
    return ev;
  }

  let text = '';
  let buf = '';
  let stderr = '';
  let finished = false;
  let sessionId = opts.sessionId || null;
  let sawStreamText = false;
  const finish = (info) => {
    if (finished) return;
    finished = true;
    ev.emit('done', { text, sessionId, ...info });
  };

  child.stdin.end(opts.prompt);
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.session_id && !sessionId) { sessionId = m.session_id; ev.emit('session', sessionId); }
      if (m.type === 'stream_event' && !m.parent_tool_use_id) {
        const e = m.event;
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          sawStreamText = true;
          text += e.delta.text;
          ev.emit('text', e.delta.text);
        }
        if (e?.type === 'message_start' && text && !text.endsWith('\n')) {
          text += '\n\n';
          ev.emit('text', '\n\n');
        }
      } else if (m.type === 'assistant' && m.message?.content) {
        for (const block of m.message.content) {
          if (block.type === 'tool_use') ev.emit('tool', { name: block.name, input: block.input });
          if (block.type === 'text' && !sawStreamText) { text += block.text; ev.emit('text', block.text); }
        }
      } else if (m.type === 'result') {
        const errText = m.is_error ? friendly(String(m.result || m.error || 'Claude Code reported an error.')) : null;
        finish({ error: errText, costUsd: m.total_cost_usd });
      }
    }
  });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (err) => finish({ error: err.code === 'ENOENT' ? notInstalled() : `Could not start Claude Code: ${err.message}` }));
  child.on('close', (code) => {
    if (code === 0) return finish({});
    const msg = stderr.trim().split('\n').slice(-3).join(' ');
    if (bin.shell && /not recognized|not found/i.test(msg)) return finish({ error: notInstalled() });
    finish({ error: friendly(msg || `Claude Code exited with code ${code}.`) });
  });

  ev.stop = () => { try { child.kill(); } catch {} finish({ error: 'Stopped.' }); };
  return ev;
}

function notInstalled() {
  return 'Claude Code is not installed. Install it from https://claude.com/claude-code, run `claude` once in a terminal and sign in with your Claude subscription, then try again.';
}

function friendly(msg) {
  if (/log ?in|\/login|not logged|authenticat|invalid api key|oauth/i.test(msg)) {
    return 'Claude Code is not signed in yet. Tap "Sign in to Claude" below (or run `claude` in a terminal), sign in with your Claude subscription, then try again.';
  }
  if (/usage limit|rate limit|limit reached/i.test(msg)) return `You've hit your Claude usage limit: ${msg}`;
  return msg.length > 400 ? msg.slice(0, 400) + '…' : msg;
}

module.exports = { runClaude, findClaude };

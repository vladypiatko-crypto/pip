// Backup AI: keeps Pip working when your Claude plan's limit runs out.
//
// Pip still runs Claude Code (so every tool keeps working), but points it at another
// Anthropic-compatible service with Claude Code's own settings (ANTHROPIC_BASE_URL etc.):
//   - Ollama: a free model running on your own computer
//   - OpenRouter: hundreds of models from many companies, pay per use
//   - an Anthropic API key (pay per use)
//   - any other Anthropic-compatible server
// runSmart() tries your Claude subscription first and, if the limit is hit, switches to
// the backup until the limit resets.

const { EventEmitter } = require('node:events');
const { runClaude } = require('./claude');

const PROVIDERS = {
  ollama: { label: 'Ollama', url: 'http://localhost:11434', needsKey: false, model: 'qwen3-coder' },
  openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api', needsKey: true, model: '' },
  anthropic: { label: 'Anthropic API', url: '', needsKey: true, model: '' },
  custom: { label: 'Custom', url: '', needsKey: true, model: '' },
};

function backupLabel(cfg) {
  const p = PROVIDERS[cfg?.provider];
  if (!p) return null;
  return cfg.model ? `${p.label} · ${cfg.model}` : p.label;
}

/** Environment and model for running Claude Code on the backup service. */
function backupRun(cfg, key) {
  const p = PROVIDERS[cfg?.provider];
  if (!p) return null;
  const url = (cfg.url || p.url || '').replace(/\/+$/, '');
  const env = {};
  if (cfg.provider === 'anthropic') {
    env.ANTHROPIC_API_KEY = key;
  } else {
    env.ANTHROPIC_BASE_URL = url;
    env.ANTHROPIC_AUTH_TOKEN = key || 'ollama';
    env.ANTHROPIC_API_KEY = '';
  }
  const model = cfg.model || undefined;
  if (model) {
    // Use the same model for Claude Code's helper tasks too.
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  }
  return { env, model, label: backupLabel(cfg) };
}

/** Ask a local Ollama which models it has. */
async function ollamaModels(url) {
  const res = await fetch(`${(url || PROVIDERS.ollama.url).replace(/\/+$/, '')}/api/tags`);
  if (!res.ok) throw new Error(`Ollama said ${res.status}`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

/** When does the plan limit that was hit reset? (ms timestamp) */
function limitResetsAt(limits) {
  const wins = Object.values(limits?.unifiedWindows || {});
  const hit = wins.filter((w) => w.status === 'rejected' || (w.utilization ?? 0) >= 1);
  const times = (hit.length ? hit : wins).map((w) => (w.resetsAt || 0) * 1000).filter((t) => t > Date.now());
  return times.length ? Math.min(...times) : Date.now() + 60 * 60 * 1000;
}

/**
 * Run a turn on the Claude subscription, falling back to the backup when the limit is hit.
 * getBackup(): { cfg, key, auto } or null. state: { limitUntil } shared between turns.
 * Emits everything runClaude emits, plus 'switch' ({ label }) when moving to the backup.
 */
function runSmart(opts, { getBackup, state, forceBackup = false }) {
  const ev = new EventEmitter();
  let inner = null;
  let stopped = false;

  const start = (useBackup) => {
    let o = { ...opts };
    let label = null;
    if (useBackup) {
      const b = getBackup();
      const run = b && backupRun(b.cfg, b.key);
      if (!run) { ev.emit('done', { text: '', error: 'No backup AI is set up. Add one in Pip\'s settings.' }); return; }
      o = { ...o, env: { ...(o.env || {}), ...run.env }, model: run.model, effort: undefined };
      label = run.label;
      ev.emit('switch', { label });
    }
    inner = runClaude(o);
    for (const name of ['session', 'text', 'tool', 'limits']) inner.on(name, (v) => ev.emit(name, v));
    let lastLimits = null;
    inner.on('limits', (l) => { lastLimits = l; });
    inner.on('done', (r) => {
      const b = getBackup();
      if (!useBackup && !stopped && r.limitHit && b?.auto && backupRun(b.cfg, b.key)) {
        state.limitUntil = limitResetsAt(lastLimits);
        start(true);
        return;
      }
      if (label) r = { ...r, backup: label, usage: r.usage ? { ...r.usage, backup: label } : r.usage };
      ev.emit('done', r);
    });
  };

  const b = getBackup();
  const limited = state.limitUntil && Date.now() < state.limitUntil;
  setImmediate(() => start(forceBackup || (limited && b?.auto && !!backupRun(b.cfg, b.key))));
  ev.stop = () => { stopped = true; inner?.stop(); };
  return ev;
}

module.exports = { PROVIDERS, backupRun, backupLabel, ollamaModels, runSmart, limitResetsAt };

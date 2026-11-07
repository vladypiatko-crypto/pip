// Stand-in for the Electron bridge so renderer/index.html can be previewed in a
// normal browser. Replies are canned; nothing touches your computer.
const listeners = {};
const emit = (ch, v) => (listeners[ch] || []).forEach((f) => f(v));
const on = (ch) => (fn) => { (listeners[ch] ||= []).push(fn); };
const skins = await (await fetch('../assets/skins.json')).json();
const settings = { skin: new URLSearchParams(location.search).get('skin') || skins.default, wander: true, computerAccess: 'granted', room: null, skins, name: 'Vlad', model: '', effort: '', backup: { provider: '', auto: true }, recentRooms: [{ id: 'game-jam-3fa9c2', name: 'Game jam', hosted: true, ts: Date.now() - 7200e3 }, { id: 'x', name: "Sam's study room", link: 'https://x/r/x', ts: Date.now() - 86400e3 }] };

export default {
  async getSettings() { return { ...settings }; },
  async ask(text) {
    emit('pet:state', 'thinking');
    const steps = [
      [600, () => { emit('pet:state', 'working'); emit('pet:tool', '👀 Looking at your screen'); }],
      [1400, () => emit('pet:tool', '📝 Writing a file')],
      [2200, () => { emit('pet:state', 'talking'); }],
    ];
    for (const [ms, fn] of steps) setTimeout(fn, ms);
    const reply = `Okay! (This is preview mode, so I'm only pretending.) You said: "${text}". In the real app I'd do it with **your** Claude Code.`;
    let i = 0;
    setTimeout(function tick() {
      if (i < reply.length) { emit('pet:text', reply.slice(i, i + 4)); i += 4; setTimeout(tick, 30); }
      else { emit('pet:done', { error: null }); emit('pet:state', 'happy'); }
    }, 2300);
    return { ok: true };
  },
  skinPreview() {},
  deleteSkin() {},
  copy() {},
  hide() {},
  async backupSave(b) { Object.assign(settings.backup, b, { hasKey: !!b.key || settings.backup.hasKey, label: b.provider ? `${b.provider} · ${b.model}` : null }); return { ok: true }; },
  async backupModels() { return { models: ['qwen3-coder:latest', 'gpt-oss:20b'] }; },
  async backupTest() { return { ok: true, text: 'Backup AI works!' }; },
  async version() { return { sha: 'f64a24a0', date: new Date().toISOString() }; },
  async checkUpdate() { return { upToDate: false, latest: { sha: 'abc', date: new Date().toISOString(), message: 'Add a pip-pet update command' } }; },
  async update() { return { ok: true }; },
  onOpenView: on('pet:open-view'), onCheckUpdate: on('pet:check-update'), onUpdateAvailable: on('pet:update-available'),
  async listChats() { return [{ id: 'a', title: 'Help me build a game', updated: Date.now() - 3600e3, count: 6 }, { id: 'b', title: 'Design yourself a pirate skin', updated: Date.now() - 86400e3 * 2, count: 2 }]; },
  async openChat() { return { messages: [{ role: 'me', text: 'Help me build a game' }, { role: 'pip', text: 'Done! I made **Star Hopper** in your Pip Projects folder.' }] }; },
  deleteChat() {},
  async getUsage() {
    const days = Array.from({ length: 14 }, (_, i) => ({ day: `d${i}`, tokens: Math.round(20000 + Math.random() * 90000), requests: 5 }));
    const r = { requests: 12, input: 184200, output: 9400, apiValueUsd: 1.37, byModel: { 'claude-opus-5-5': { requests: 9, input: 150000, output: 8000 }, 'claude-sonnet-5-5': { requests: 3, input: 34200, output: 1400 } }, bySource: { chat: { requests: 10, input: 170000, output: 8000 }, room: { requests: 2, input: 14200, output: 1400 } } };
    return { limits: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.37, resetsAt: Date.now() / 1000 + 7200 }, seven_day: { utilization: 0.72, resetsAt: Date.now() / 1000 + 300000 } } }, limitsAt: Date.now() - 60000, today: r, week: r, month: r, days };
  },
  async hostRoom() { return { invite: 'https://lucky-otter-demo.trycloudflare.com/r/game-jam-3fa9c2', public: true }; },
  async joinRoom() { return { ok: true }; },
  async stopHosting() { return { ok: true }; },
  forgetRoom() {},
  onChatsChanged: on('chats:changed'),
  onUsageChanged: on('usage:changed'),
  stop() { emit('pet:done', { error: 'Stopped.' }); },
  newChat() {},
  ignoreMouse() {},
  drag() {},
  chatOpen() {},
  updateSettings(patch) { Object.assign(settings, patch); emit('pet:settings', { ...settings }); },
  openFolder() {},
  openLogin() {},
  quit() {},
  async roomConnect() { emit('room:status', { state: 'error', text: 'Not available in preview.' }); },
  roomDisconnect() {},
  onState: on('pet:state'), onText: on('pet:text'), onTool: on('pet:tool'), onDone: on('pet:done'),
  onMoving: on('pet:moving'), onSettings: on('pet:settings'), onOpenChat: on('pet:open-chat'), onRoomStatus: on('room:status'),
};

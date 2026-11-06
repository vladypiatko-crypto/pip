// Stand-in for the Electron bridge so renderer/index.html can be previewed in a
// normal browser. Replies are canned; nothing touches your computer.
const listeners = {};
const emit = (ch, v) => (listeners[ch] || []).forEach((f) => f(v));
const on = (ch) => (fn) => { (listeners[ch] ||= []).push(fn); };
const skins = await (await fetch('../assets/skins.json')).json();
const settings = { skin: new URLSearchParams(location.search).get('skin') || skins.default, wander: true, computerAccess: 'granted', room: null, skins };

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

// Claude Room browser client.
(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d = '') { try { return localStorage.getItem('claude-room:' + k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('claude-room:' + k, v); } catch {} },
  };

  // A per-browser secret that pairs your Pip desktop pet with you.
  if (!/^[A-Z0-9]{6,8}$/.test(store.get('pairCode'))) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    store.set('pairCode', Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => abc[b % abc.length]).join(''));
  }

  const state = { ws: null, you: null, name: '', roomId: '', messages: new Map(), models: {}, busy: null, retry: 0, joinedOnce: false };

  // ---------- routing ----------
  const match = location.pathname.match(/^\/r\/([a-z0-9-]{4,40})/);
  state.roomId = match ? match[1] : '';

  function showSetup() {
    $('setup').hidden = false;
    $('f-name').value = store.get('name');
    $('f-key').value = store.get('apiKey');
    if (state.roomId) {
      $('new-room-fields').hidden = true;
      $('joining').hidden = false;
      $('joining-id').textContent = state.roomId;
      $('setup-submit').textContent = 'Join room';
    }
    ($('f-name').value ? $('f-key') : $('f-name')).focus();
  }

  $('setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    store.set('name', $('f-name').value.trim());
    store.set('apiKey', $('f-key').value.trim());
    if (!state.roomId) {
      const slug = $('f-room').value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20);
      const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
      state.roomId = (slug ? slug + '-' : '') + rand;
      state.newRoomName = $('f-room').value.trim();
      history.replaceState(null, '', '/r/' + state.roomId);
    }
    $('setup').hidden = true;
    connect();
  });

  // ---------- connection ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    state.ws = ws;
    ws.onopen = () => {
      state.retry = 0;
      send({
        t: 'join', room: state.roomId, name: store.get('name'), apiKey: store.get('apiKey'),
        model: store.get('model', 'claude-opus-5-5'), effort: store.get('effort', 'medium'), roomName: state.newRoomName,
        billing: store.get('billing', 'api'), pairCode: store.get('pairCode'),
      });
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = () => {
      if (!state.joinedOnce) return;
      toast('Disconnected. Reconnecting...');
      setTimeout(connect, Math.min(1000 * 2 ** state.retry++, 15000));
    };
  }
  const send = (m) => state.ws?.readyState === 1 && state.ws.send(JSON.stringify(m));

  function handle(m) {
    switch (m.t) {
      case 'hello':
        state.joinedOnce = true;
        state.you = m.you;
        state.name = store.get('name');
        state.models = m.models;
        $('app').hidden = false;
        setRoom(m.room);
        $('messages').innerHTML = '';
        state.messages.clear();
        m.messages.forEach(renderMessage);
        setBusy(m.busy);
        scrollDown(true);
        $('input').focus();
        if (!store.get('apiKey') && store.get('billing', 'api') === 'api') toast('You can chat now. Add an API key or connect Pip in Settings to ask Claude.');
        break;
      case 'room': setRoom(m.room); break;
      case 'members': renderMembers(m.members); break;
      case 'msg':
        renderMessage(m.msg);
        if (m.msg.type === 'claude' && m.msg.streaming) setBusy({ id: m.msg.id, by: m.msg.via });
        scrollDown(m.msg.author === state.name);
        break;
      case 'delta': {
        const msg = state.messages.get(m.id);
        if (!msg) break;
        msg.text += m.text;
        updateMessage(msg);
        scrollDown();
        break;
      }
      case 'done':
        state.messages.set(m.msg.id, m.msg);
        updateMessage(m.msg);
        setBusy(null);
        scrollDown();
        break;
      case 'typing': showTyping(m.name); break;
      case 'error': toast(m.text); break;
      case 'settings-ok': toast('Settings saved'); break;
    }
  }

  // ---------- rendering ----------
  function setRoom(room) {
    $('room-name').textContent = room.name;
    document.title = `${room.name} · Claude Room`;
  }

  const colorFor = (name) => {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h} 45% 45%)`;
  };
  function avatar(name, isClaude) {
    const el = document.createElement('div');
    el.className = 'avatar';
    if (isClaude) { el.style.background = 'var(--accent)'; el.textContent = '✳'; }
    else { el.style.background = colorFor(name); el.textContent = name.slice(0, 1).toUpperCase(); }
    return el;
  }

  function renderMembers(list) {
    const ul = $('member-list');
    ul.innerHTML = '';
    const seen = new Set();
    for (const p of list) {
      const li = document.createElement('li');
      li.append(avatar(p.name));
      const n = document.createElement('span');
      n.textContent = p.name + (p.id === state.you ? ' (you)' : '');
      li.append(n);
      if (p.billing === 'pip' ? p.hasPip : p.hasKey) {
        const k = document.createElement('span');
        k.className = 'model';
        k.title = p.billing === 'pip' ? 'Uses their Claude subscription through Pip' : 'Has an API key set';
        k.textContent = p.billing === 'pip' ? '🐾 Pip' : '🔑 ' + (state.models[p.model]?.label || '');
        li.append(k);
      }
      if (p.id === state.you) state.myPip = p.hasPip;
      ul.append(li);
      seen.add(p.name);
    }
    $('people-count').textContent = seen.size;
  }

  function renderMessage(msg) {
    state.messages.set(msg.id, msg);
    const box = $('messages');
    if (msg.type === 'system') {
      const el = document.createElement('div');
      el.className = 'system';
      el.textContent = `${msg.text} · ${time(msg.ts)}`;
      box.append(el);
      return;
    }
    const el = document.createElement('div');
    el.id = 'm-' + msg.id;
    el.className = 'msg ' + (msg.type === 'claude' ? 'claude' : msg.author === state.name ? 'mine' : '');
    el.append(avatar(msg.author, msg.type === 'claude'));
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = `<div class="meta"></div><div class="text"></div><div class="error" hidden></div><div class="footer" hidden></div>`;
    const meta = bubble.querySelector('.meta');
    const who = document.createElement('strong');
    who.textContent = msg.author;
    meta.append(who);
    if (msg.type === 'claude') meta.append(tag(`asked by ${msg.via}`));
    else if (msg.asked) meta.append(tag('asked Claude'));
    const t = document.createElement('span');
    t.textContent = time(msg.ts);
    meta.append(t);
    el.append(bubble);
    box.append(el);
    updateMessage(msg);
  }

  function updateMessage(msg) {
    const el = $('m-' + msg.id);
    if (!el) return;
    const text = el.querySelector('.text');
    text.innerHTML = markdown(msg.text || '');
    text.classList.toggle('thinking', !!msg.streaming && !msg.text);
    text.classList.toggle('cursor', !!msg.streaming && !!msg.text);
    const err = el.querySelector('.error');
    err.hidden = !msg.error;
    err.textContent = msg.error || '';
    const foot = el.querySelector('.footer');
    if (msg.type === 'claude' && !msg.streaming && (msg.usage || (msg.model === 'claude-code' && !msg.error))) {
      const model = msg.model === 'claude-code' ? 'Claude Code via Pip' : state.models[msg.model]?.label || msg.model;
      const u = msg.usage ? ` · ${fmt(msg.usage.input)} in / ${fmt(msg.usage.output)} out tokens` : '';
      const payer = msg.model === 'claude-code' ? `${msg.via}'s Claude subscription` : msg.via;
      foot.textContent = `${model} · paid by ${payer}${u}`;
      foot.hidden = false;
    }
  }

  const tag = (s) => Object.assign(document.createElement('span'), { className: 'tag', textContent: s });
  const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

  function scrollDown(force) {
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    if (force || nearBottom) box.scrollTop = box.scrollHeight;
  }

  function setBusy(busy) {
    state.busy = busy;
    $('stop').hidden = !busy;
    $('ask').disabled = !!busy;
  }

  let typingTimer;
  function showTyping(name) {
    if (name === state.name) return;
    $('typing').textContent = `${name} is typing...`;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => ($('typing').textContent = ''), 2500);
  }

  let toastTimer;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  // Small, safe markdown renderer: escapes everything first, then adds formatting.
  function markdown(src) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const out = [];
    const parts = src.split(/```/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const code = part.replace(/^[^\n]*\n/, '');
        out.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
        return;
      }
      let list = null;
      let para = [];
      const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
      const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.type}>`); list = null; } };
      for (const line of part.split('\n')) {
        const h = line.match(/^(#{1,4})\s+(.*)/);
        const ul = line.match(/^\s*[-*]\s+(.*)/);
        const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
        if (h) { flushPara(); flushList(); out.push(`<h4>${inline(h[2])}</h4>`); }
        else if (ul || ol) {
          flushPara();
          const type = ul ? 'ul' : 'ol';
          if (list && list.type !== type) flushList();
          list = list || { type, items: [] };
          list.items.push((ul || ol)[1]);
        } else if (!line.trim()) { flushPara(); flushList(); }
        else { flushList(); para.push(line); }
      }
      flushPara(); flushList();
    });
    return out.join('');
  }

  // ---------- composer ----------
  const input = $('input');
  function submit(ask) {
    const text = input.value;
    if (!text.trim()) return;
    if (ask && store.get('billing', 'api') === 'api' && !store.get('apiKey')) { openSettings(); toast('Add your API key, or use your subscription through Pip.'); return; }
    send({ t: 'say', text, ask });
    input.value = '';
    autosize();
  }
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); submit(false); });
  $('ask').addEventListener('click', () => submit(true));
  $('stop').addEventListener('click', () => send({ t: 'stop' }));
  let lastTyping = 0;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(true); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(false); }
  });
  input.addEventListener('input', () => {
    autosize();
    if (Date.now() - lastTyping > 1500) { lastTyping = Date.now(); send({ t: 'typing' }); }
  });
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, 200) + 'px'; }

  // ---------- header actions ----------
  $('invite').addEventListener('click', async () => {
    const link = `${location.origin}/r/${state.roomId}`;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied. Anyone with it can join.'); }
    catch { prompt('Share this link:', link); }
  });
  $('room-name').addEventListener('click', () => {
    const name = prompt('Rename room', $('room-name').textContent);
    if (name && name.trim()) send({ t: 'rename', name: name.trim() });
  });
  $('toggle-people').addEventListener('click', () => $('people').classList.toggle('open'));

  // ---------- settings ----------
  function openSettings() {
    const sel = $('s-model');
    sel.innerHTML = '';
    for (const [id, m] of Object.entries(state.models)) sel.append(new Option(m.label, id));
    sel.value = store.get('model', 'claude-opus-5-5');
    $('s-effort').value = store.get('effort', 'medium');
    $('s-name').value = store.get('name');
    $('s-key').value = store.get('apiKey');
    $('s-billing').value = store.get('billing', 'api');
    $('pair-link').textContent = `${location.origin}/r/${state.roomId}`;
    $('pair-code').textContent = store.get('pairCode');
    showBilling();
    $('settings').showModal();
  }
  function showBilling() {
    const pip = $('s-billing').value === 'pip';
    $('billing-api').hidden = pip;
    $('billing-pip').hidden = !pip;
    $('pip-status').textContent = state.myPip ? 'Pip is connected ✓' : 'Pip is not connected yet. Enter these in Pip, then press Save here.';
  }
  $('s-billing').addEventListener('change', showBilling);
  $('open-settings').addEventListener('click', openSettings);
  $('settings').addEventListener('close', () => {
    if ($('settings').returnValue !== 'save') return;
    store.set('apiKey', $('s-key').value.trim());
    store.set('model', $('s-model').value);
    store.set('effort', $('s-effort').value);
    store.set('billing', $('s-billing').value);
    send({ t: 'settings', apiKey: store.get('apiKey'), model: store.get('model'), effort: store.get('effort'), billing: store.get('billing'), pairCode: store.get('pairCode') });
  });

  showSetup();
})();

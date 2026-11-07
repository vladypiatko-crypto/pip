// One-click room hosting: starts the Claude Room server inside Pip and opens a free
// public link (a Cloudflare quick tunnel) so friends anywhere can join.
// If the public link can't be made, friends on the same Wi-Fi can still join.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let hosting = null; // { port, localUrl, lanUrl, publicUrl, close }

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

async function openTunnel(port) {
  const cf = require('cloudflared');
  if (!fs.existsSync(cf.bin)) await cf.install(cf.bin);
  const tunnel = cf.Tunnel.quick(`http://localhost:${port}`);
  const url = await new Promise((resolve) => {
    let link = null;
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => done(null), 25000);
    tunnel.once('url', (u) => { link = u; });
    tunnel.once('connected', () => done(link));
    tunnel.once('exit', () => done(null));
    tunnel.once('error', () => done(null));
  });
  if (!url) { try { tunnel.stop(); } catch {} return null; }
  return { url, stop: () => { try { tunnel.stop(); } catch {} } };
}

/** Start hosting (or return the running host). dataDir keeps room history across updates. */
async function startHosting({ dataDir, onStatus = () => {} }) {
  if (hosting) return hosting;
  onStatus('Starting the room server…');
  const { startRoomServer } = await import(pathToFileURL(path.join(__dirname, '..', 'room', 'server.js')).href);
  // Prefer the same port every time (keeps the room window's saved state); fall back to any free one.
  const server = await startRoomServer({ port: 4517, dataDir }).catch(() => startRoomServer({ port: 0, dataDir }));
  const lan = lanAddress();
  const info = {
    port: server.port,
    localUrl: `http://localhost:${server.port}`,
    lanUrl: lan ? `http://${lan}:${server.port}` : null,
    publicUrl: null,
  };
  hosting = info;
  onStatus('Making a public link…');
  const tunnel = process.env.PIP_NO_TUNNEL ? null : await openTunnel(server.port).catch(() => null); // PIP_NO_TUNNEL=1: same-Wi-Fi only
  info.publicUrl = tunnel?.url || null;
  info.close = async () => { tunnel?.stop(); await server.close(); hosting = null; };
  return info;
}

async function stopHosting() {
  if (hosting?.close) await hosting.close();
  hosting = null;
}

const currentHost = () => hosting;

module.exports = { startHosting, stopHosting, currentHost };

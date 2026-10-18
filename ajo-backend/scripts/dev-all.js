// One command for development: starts the local MongoDB, waits until it is really ready, then starts the API.
// Ctrl+C stops both. Use this so the backend is never running without its database.
const { spawn } = require('child_process');
const net = require('net');

const children = [];
const run = (cmd, args) => { const c = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' }); children.push(c); return c; };
const stopAll = (code = 0) => { children.forEach((c) => { try { c.kill('SIGTERM'); } catch { /* already gone */ } }); setTimeout(() => process.exit(code), 1500); };
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

const portOpen = () => new Promise((resolve) => {
  const s = net.connect(27017, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

(async () => {
  if (await portOpen()) {
    console.log('[dev] MongoDB is already running on :27017, using it.');
  } else {
    const db = run('node', ['scripts/dev-db.js']);
    db.on('exit', (code) => { console.error(`[dev] the database stopped (code ${code}).`); stopAll(code ?? 1); });
    for (let i = 0; i < 120 && !(await portOpen()); i++) await new Promise((r) => setTimeout(r, 1000));
    if (!(await portOpen())) { console.error('[dev] MongoDB did not start within 2 minutes.'); return stopAll(1); }
    await new Promise((r) => setTimeout(r, 2000)); // let the replica set elect its primary
  }
  const api = run('npx', ['ts-node-dev', '--respawn', '--transpile-only', 'src/server.ts']);
  api.on('exit', (code) => stopAll(code ?? 0));
})();

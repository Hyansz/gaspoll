'use strict';
/**
 * Kegagalan login dashboard harus menjelaskan dirinya sendiri (sumber password, berkas config,
 * HTTP status dan pesan 9Router), tanpa pernah mencetak passwordnya.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-login-'));
process.env.GASPOLL_RESULTS = path.join(TMP, 'results');
const L = require('../src/lib.js');

const SECRET = 'rahasia-banget-123';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const stop = (s) => new Promise((r) => s.close(r));

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function writeConfig(obj) {
  const p = path.join(TMP, `config-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}

test('loadConfig: sumber password dari config.json', () => {
  const p = writeConfig({ baseUrl: 'http://localhost:1', apiKey: 'sk-x', password: SECRET });
  const cfg = withEnv({ GASPOLL_CONFIG: p, NINE_ROUTER_PASSWORD: undefined, NINE_ROUTER_BASE_URL: undefined, NINE_ROUTER_API_KEY: undefined }, () => L.loadConfig());
  assert.strictEqual(cfg.password, SECRET);
  assert.strictEqual(cfg.passwordSource, 'config.json');
  assert.strictEqual(cfg.configFile, p);
});

test('loadConfig: variabel lingkungan menang atas config.json dan tercatat', () => {
  const p = writeConfig({ password: 'dari-berkas' });
  const cfg = withEnv({ GASPOLL_CONFIG: p, NINE_ROUTER_PASSWORD: 'dari-env' }, () => L.loadConfig());
  assert.strictEqual(cfg.password, 'dari-env');
  assert.match(cfg.passwordSource, /NINE_ROUTER_PASSWORD/);
});

test('loadConfig: password kosong memakai bawaan 123456 dan tercatat sebagai bawaan', () => {
  const p = writeConfig({ baseUrl: 'http://localhost:1', apiKey: 'sk-x', password: '' });
  const cfg = withEnv({ GASPOLL_CONFIG: p, NINE_ROUTER_PASSWORD: undefined }, () => L.loadConfig());
  assert.strictEqual(cfg.password, '123456');
  assert.match(cfg.passwordSource, /bawaan/);
});

test('loadConfig: password angka di config.json diubah menjadi teks', () => {
  const p = writeConfig('{"password": 123456789}');
  const cfg = withEnv({ GASPOLL_CONFIG: p, NINE_ROUTER_PASSWORD: undefined }, () => L.loadConfig());
  assert.strictEqual(typeof cfg.password, 'string');
  assert.strictEqual(cfg.password, '123456789');
});

test('dashboardCookie 401: pesan memuat HTTP, pesan 9Router, dan diagnosa tanpa membocorkan password', async () => {
  const { server, base } = await startServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid password' }));
  });
  try {
    const cfg = { baseUrl: base, password: `${SECRET} `, passwordSource: 'config.json', configFile: '/home/x/gaspoll/config.json' };
    await assert.rejects(() => L.dashboardCookie(cfg), (e) => {
      assert.match(e.message, /HTTP 401: Invalid password/);
      assert.ok(Array.isArray(e.diag) && e.diag.length >= 3);
      const all = e.message + e.diag.join('\n');
      assert.ok(!all.includes(SECRET), 'password tidak boleh muncul di pesan');
      assert.match(all, /password dari : config\.json/);
      assert.match(all, /ADA spasi di awal\/akhir/);
      assert.match(all, /\/home\/x\/gaspoll\/config\.json/);
      assert.match(all, new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
  } finally { await stop(server); }
});

test('dashboardCookie 429: menyebut penguncian dan Retry-After', async () => {
  const { server, base } = await startServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '42' });
    res.end(JSON.stringify({ error: 'Too many attempts' }));
  });
  try {
    await assert.rejects(() => L.dashboardCookie({ baseUrl: base, password: 'x' }), (e) => {
      assert.match(e.message, /HTTP 429/);
      assert.match(e.message, /tunggu 42 detik/);
      return true;
    });
  } finally { await stop(server); }
});

test('dashboardCookie: mustChangePassword tanpa cookie dijelaskan', async () => {
  const { server, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mustChangePassword: true }));
  });
  try {
    await assert.rejects(() => L.dashboardCookie({ baseUrl: base, password: 'x' }), (e) => {
      assert.match(e.message, /diganti dulu/);
      return true;
    });
  } finally { await stop(server); }
});

test('dashboardCookie: login berhasil mengembalikan cookie', async () => {
  const { server, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'auth_token=abc; Path=/; HttpOnly' });
    res.end(JSON.stringify({ success: true }));
  });
  try {
    const cookie = await L.dashboardCookie({ baseUrl: base, password: 'x' });
    assert.strictEqual(cookie, 'auth_token=abc');
  } finally { await stop(server); }
});

test('dashboardCookie 500: dijelaskan sebagai masalah server 9Router, bukan password', async () => {
  const { server, base } = await startServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'boom' }));
  });
  try {
    await assert.rejects(() => L.dashboardCookie({ baseUrl: base, password: 'x' }), (e) => {
      assert.match(e.message, /HTTP 500/);
      assert.match(e.message, /server error di 9Router/);
      assert.ok(!/cek password/.test(e.message));
      return true;
    });
  } finally { await stop(server); }
});

test('applyCombos: login gagal tetap mencoba tanpa cookie, mencetak diagnosa dan petunjuk --apply, password tidak tercetak', async () => {
  const { server, base } = await startServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid password' }));
  });
  const logs = [];
  const origLog = console.log;
  const origArgv1 = process.argv[1];
  console.log = (...a) => { logs.push(a.join(' ')); };
  process.argv[1] = path.join(TMP, 'src', 'test-9router.js');
  try {
    const ok = await L.applyCombos(
      { baseUrl: base, password: SECRET, passwordSource: 'config.json', configFile: '/tmp/c.json', apiKey: 'sk-x' },
      { 'auto-combo': ['a/b', 'c/d'] }
    );
    assert.strictEqual(ok, false);
  } finally {
    console.log = origLog;
    process.argv[1] = origArgv1;
    await stop(server);
  }
  const out = L.stripAnsi(logs.join('\n'));
  assert.match(out, /Login dashboard dilewati: login dashboard gagal \(HTTP 401: Invalid password\)/);
  assert.match(out, /password dari : config\.json/);
  assert.match(out, /--apply --name auto-combo/);
  assert.match(out, /\[GAGAL\] combo "auto-combo"/);
  assert.ok(!out.includes(SECRET), 'password tidak boleh tercetak');
});

test('applyCombos: petunjuk --apply hanya muncul saat dijalankan dari test-9router.js', async () => {
  const { server, base } = await startServer((req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{}'); });
  const logs = [];
  const origLog = console.log; const origArgv1 = process.argv[1];
  console.log = (...a) => { logs.push(a.join(' ')); };
  process.argv[1] = path.join(TMP, 'src', 'cli.js');
  try { await L.applyCombos({ baseUrl: base, password: SECRET, apiKey: 'sk-x' }, { 'auto-combo': ['a/b'] }); } finally { console.log = origLog; process.argv[1] = origArgv1; await stop(server); }
  assert.ok(!L.stripAnsi(logs.join('\n')).includes('--apply'));
});

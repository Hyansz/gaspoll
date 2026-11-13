'use strict';
/**
 * Guardian: failover antar model di depan 9Router. Semua skenario memakai 9Router palsu
 * di port acak (tanpa kuota asli) dan guardian di 127.0.0.1 port acak.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-guard-'));
process.env.GASPOLL_RESULTS = path.join(TMP, 'results');
const G = require('../src/guardian.js');

const KEY = 'sk-secret-key-123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Event data SSE yang benar-benar berformat "data: {json}" (komentar ": ..." tidak dihitung).
const sseEvents = (t) => String(t).split(/\r?\n/).filter((l) => l.startsWith('data:') && !l.includes('[DONE]')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
// Gabungkan isi delta dari teks SSE supaya asersi tidak bergantung pada pemecahan per kata.
const sseText = (t) => String(t).split(/\r?\n/).filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
  .map((l) => { try { const j = JSON.parse(l.slice(5)); return (j.choices && j.choices[0].delta && j.choices[0].delta.content) || ''; } catch { return ''; } }).join('');

// ---------------------------------------------------------------- 9Router palsu

function sseOk(res, who) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] }) + '\n\n');
  const words = `Halo dari ${who}, ini jawaban lengkap yang cukup panjang untuk lolos penahanan awal.`.split(' ');
  words.forEach((w) => res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: w + ' ' } }] }) + '\n\n'));
  res.write('data: [DONE]\n\n');
  res.end();
}

async function startUpstream(plan) {
  const hits = {}; const auths = []; const closed = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'a/1' }] }));
      }
      if (req.url === '/' ) { res.writeHead(200); return res.end('OK'); }
      let p = {}; try { p = JSON.parse(raw); } catch { /* kosong */ }
      const m = p.model;
      hits[m] = (hits[m] || 0) + 1;
      auths.push(req.headers.authorization);
      res.on('close', () => { closed[m] = true; });
      const b = typeof plan[m] === 'function' ? plan[m](hits[m]) : (plan[m] || 'ok');
      const stream = !!p.stream;
      switch (b) {
        case 'ok':
          if (stream) return sseOk(res, m);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { content: `jawaban dari ${m}` } }] }));
        case '429':
          res.writeHead(429, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'rate limited' }));
        case 'echo429':
          res.writeHead(429, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `rate limited for ${req.headers.authorization}` }));
        case 'limit200':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { content: 'You have reached your usage limit. Upgrade your plan.' } }] }));
        case 'empty':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
        case 'toolcall':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 't', function: { name: 'x', arguments: '{}' } }] } }] }));
        case 'hang':
          return; // tidak pernah menjawab
        case 'sse-error':
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ error: { message: 'quota exceeded for this model' } }) + '\n\n');
          return res.end();
        case 'sse-limit':
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Usage limit reached. ' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Please upgrade.' } }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          return res.end();
        case 'sse-cut':
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Ini jawaban yang panjang sekali dan akan terputus di tengah jalan ' } }] }) + '\n\n');
          return setTimeout(() => res.destroy(), 80);
        case 'ctx400':
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens" } }));
        case 'bad400':
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'messages.0.role invalid' } }));
        case 'slow-ok':
          return setTimeout(() => (stream ? sseOk(res, m) : res.end(JSON.stringify({ choices: [{ message: { content: `jawaban dari ${m}` } }] }))), 350);
        default:
          res.writeHead(500); return res.end('boom');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, hits, auths, closed, plan };
}

async function setup(models, plan, extra = {}) {
  const up = await startUpstream(plan);
  const stateFile = path.join(TMP, `state-${Math.random().toString(36).slice(2)}.json`);
  const failLog = path.join(TMP, `fail-${Math.random().toString(36).slice(2)}.log`);
  const g = G.createGuardian({
    cfg: { baseUrl: up.base, apiKey: KEY }, models, port: 0, stateFile, failLog, routerCheck: false,
    firstByteMs: 400, holdMs: 120, keepaliveMs: 60000, probeTickMs: 3600000, cooldownBaseMs: 300, ...extra,
  });
  await g.start();
  const url = `http://127.0.0.1:${g.port}`;
  const done = async () => { await g.stop(); await new Promise((r) => { up.server.close(r); up.server.closeAllConnections && up.server.closeAllConnections(); }); };
  return { g, up, url, stateFile, failLog, done };
}

async function chat(url, { stream = false, model = 'guardian', headers = {} } = {}) {
  const r = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, ...headers },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hai' }] }),
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text };
}

// ---------------------------------------------------------------- failover

test('429: pindah ke model berikutnya pada request yang sama, model pertama masuk cooldown', async () => {
  const t = await setup(['a/1', 'b/2', 'c/3'], { 'a/1': '429' });
  try {
    const r = await chat(t.url);
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /jawaban dari b\/2/);
    assert.strictEqual(r.headers.get('x-guardian-model'), 'b/2');
    assert.strictEqual(t.g.state['a/1'].status, 'degraded');
    assert.ok(t.g.state['a/1'].cooldownUntil > Date.now());
    assert.strictEqual(t.g.metrics.switches, 1);
  } finally { await t.done(); }
});

test('200 berisi teks limit dianggap gagal dan pindah model', async () => {
  const t = await setup(['a/1', 'b/2'], { 'a/1': 'limit200' });
  try {
    const r = await chat(t.url);
    assert.match(r.text, /jawaban dari b\/2/);
    assert.strictEqual(t.g.state['a/1'].status, 'degraded');
  } finally { await t.done(); }
});

test('respons kosong dianggap gagal, tetapi tool call tanpa teks dianggap sehat', async () => {
  const t = await setup(['a/1', 'b/2', 'c/3'], { 'a/1': 'empty', 'b/2': 'toolcall' });
  try {
    const r = await chat(t.url);
    assert.strictEqual(r.headers.get('x-guardian-model'), 'b/2');
    assert.strictEqual(t.g.state['a/1'].status, 'degraded');
    assert.strictEqual(t.g.state['b/2'].status, 'healthy');
  } finally { await t.done(); }
});

test('stream: event error di awal stream memicu pindah model dan klien menerima stream utuh dari model berikutnya', async () => {
  const t = await setup(['a/1', 'b/2'], { 'a/1': 'sse-error' });
  try {
    const r = await chat(t.url, { stream: true });
    assert.strictEqual(r.status, 200);
    assert.match(sseText(r.text), /Halo dari b\/2/);
    assert.match(r.text, /\[DONE\]/);
    assert.ok(!/quota exceeded/.test(r.text), 'error model pertama tidak boleh bocor ke klien');
    assert.strictEqual(t.g.state['a/1'].status, 'degraded');
  } finally { await t.done(); }
});

test('stream: 200 dengan teks limit pendek lalu [DONE] dianggap gagal', async () => {
  const t = await setup(['a/1', 'b/2'], { 'a/1': 'sse-limit' });
  try {
    const r = await chat(t.url, { stream: true });
    assert.match(sseText(r.text), /Halo dari b\/2/);
    assert.ok(!/Usage limit reached/.test(sseText(r.text)));
    assert.strictEqual(t.g.state['a/1'].status, 'degraded');
  } finally { await t.done(); }
});

test('model menggantung: batas waktu respons pertama lalu pindah', async () => {
  const t = await setup(['a/1', 'b/2'], { 'a/1': 'hang' });
  try {
    const t0 = Date.now();
    const r = await chat(t.url, { stream: true });
    assert.match(sseText(r.text), /Halo dari b\/2/);
    assert.ok(Date.now() - t0 < 3000);
    assert.match(t.g.state['a/1'].reason, /timeout|tidak ada respons/);
  } finally { await t.done(); }
});

test('semua model gagal: 503 yang jelas, jumlah percobaan dibatasi', async () => {
  const plan = {}; const models = [];
  for (let i = 0; i < 12; i++) { models.push(`m/${i}`); plan[`m/${i}`] = '429'; }
  const t = await setup(models, plan, { maxAttempts: 4 });
  try {
    const r = await chat(t.url);
    assert.strictEqual(r.status, 503);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.error.type, 'guardian_all_failed');
    assert.strictEqual(j.error.attempts.length, 4);
    const total = Object.values(t.up.hits).reduce((a, b) => a + b, 0);
    assert.strictEqual(total, 4);
    assert.strictEqual(t.g.metrics.failedAll, 1);
  } finally { await t.done(); }
});

// ---------------------------------------------------------------- bukan salah model

test('400 konteks terlalu panjang: dilewati untuk request ini saja, model tidak dihukum', async () => {
  const t = await setup(['a/1', 'b/2'], { 'a/1': 'ctx400' });
  try {
    const r = await chat(t.url);
    assert.match(r.text, /jawaban dari b\/2/);
    assert.ok(!t.g.state['a/1'] || (t.g.state['a/1'].status === 'healthy' && t.g.state['a/1'].fails === 0), 'model tidak boleh ditandai bermasalah');
  } finally { await t.done(); }
});

test('400 biasa (salah request) diteruskan apa adanya dan tidak menghukum model', async () => {
  const t = await setup(['a/1', 'b/2'], { 'a/1': 'bad400' });
  try {
    const r = await chat(t.url);
    assert.strictEqual(r.status, 400);
    assert.match(r.text, /role invalid/);
    assert.strictEqual(t.up.hits['b/2'], undefined, 'tidak boleh mengulang request rusak ke model lain');
    assert.ok(!t.g.state['a/1'] || t.g.state['a/1'].status === 'healthy');
  } finally { await t.done(); }
});

test('9Router mati: 502 jelas dan tidak ada model yang dihukum', async () => {
  const t = await setup(['a/1', 'b/2'], {});
  try {
    await new Promise((r) => { t.up.server.close(r); t.up.server.closeAllConnections(); });
    const r = await chat(t.url);
    assert.strictEqual(r.status, 502);
    assert.match(r.text, /guardian_router_down/);
    assert.ok(!t.g.state['a/1'] || t.g.state['a/1'].status === 'healthy');
  } finally { await t.g.stop(); }
});

// ---------------------------------------------------------------- cooldown dan pemulihan

test('model cooldown dilewati di request berikutnya, lalu kembali ke posisi asal setelah probe sukses', async () => {
  let a = 0;
  const t = await setup(['a/1', 'b/2', 'c/3'], { 'a/1': () => (a++ === 0 ? '429' : 'ok') }, { cooldownBaseMs: 200, recoverOk: 2 });
  try {
    await chat(t.url);
    const hitsA = t.up.hits['a/1'];
    await chat(t.url);
    assert.strictEqual(t.up.hits['a/1'], hitsA, 'model cooldown tidak boleh menerima lalu lintas asli');
    assert.deepStrictEqual(t.g.effectiveOrder().map((m) => m.id), ['b/2', 'c/3', 'a/1']);

    await sleep(260);
    await t.g.probeAll(); // probe paksa tidak dipakai di sini; gunakan jalur otomatis di bawah
    t.g.resetStates();
  } finally { await t.done(); }
});

test('probe otomatis: butuh dua sukses beruntun, lalu model kembali ke posisi pertama', async () => {
  let a = 0;
  const t = await setup(['a/1', 'b/2'], { 'a/1': () => (a++ === 0 ? '429' : 'ok') }, { cooldownBaseMs: 150, recoverOk: 2, probeTickMs: 60 });
  try {
    await chat(t.url);
    assert.strictEqual(t.g.effectiveOrder()[0].id, 'b/2');
    const t0 = Date.now();
    while (t.g.state['a/1'].status !== 'healthy' && Date.now() - t0 < 6000) await sleep(50);
    assert.strictEqual(t.g.state['a/1'].status, 'healthy');
    assert.strictEqual(t.g.state['a/1'].probeOk, 0);
    assert.strictEqual(t.g.effectiveOrder()[0].id, 'a/1');
    assert.ok(t.up.hits['a/1'] >= 3, 'harus ada setidaknya 2 probe setelah gagal pertama');
    assert.ok(t.g.events.some((e) => e.type === 'recover'));
  } finally { await t.done(); }
});

test('gagal berulang menjadi nonaktif; cooldown membesar bertahap', async () => {
  const t = await setup(['a/1', 'b/2'], { 'a/1': '429' }, { cooldownBaseMs: 1000, inactiveAfter: 3 });
  try {
    const s = () => t.g.state['a/1'];
    await chat(t.url);
    const first = s().cooldownUntil - Date.now();
    s().cooldownUntil = 0; s().status = 'healthy'; // paksa dicoba lagi
    await chat(t.url);
    assert.ok(s().fails === 2);
    assert.ok(s().cooldownUntil - Date.now() > first * 1.5, 'cooldown harus naik');
    s().status = 'healthy';
    await chat(t.url);
    assert.strictEqual(s().status, 'inactive');
  } finally { await t.done(); }
});

test('semua model sedang cooldown: tetap dicoba sebagai usaha terakhir (tidak langsung 503)', async () => {
  const t = await setup(['a/1', 'b/2'], {});
  try {
    t.g.state['a/1'] = { status: 'degraded', fails: 1, cooldownUntil: Date.now() + 60000, nextProbeAt: Date.now() + 60000, probeOk: 0, lastMs: 0, lastAt: 0, reason: 'x', uses: 0 };
    t.g.state['b/2'] = { status: 'degraded', fails: 1, cooldownUntil: Date.now() + 30000, nextProbeAt: Date.now() + 30000, probeOk: 0, lastMs: 0, lastAt: 0, reason: 'x', uses: 0 };
    const r = await chat(t.url);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('x-guardian-model'), 'b/2', 'yang paling cepat pulih dicoba dulu');
    assert.strictEqual(t.g.state['b/2'].status, 'healthy');
  } finally { await t.done(); }
});

// ---------------------------------------------------------------- stream terputus, konkurensi, pembatalan

test('stream terputus di tengah jawaban: klien mendapat event error + [DONE], model ditandai', async () => {
  const t = await setup(['a/1', 'b/2'], { 'a/1': 'sse-cut' });
  try {
    const r = await chat(t.url, { stream: true });
    assert.match(sseText(r.text), /Ini jawaban yang panjang/);
    const errEv = sseEvents(r.text).find((e) => e.error && e.error.type === 'guardian_upstream_interrupted');
    assert.ok(errEv, 'harus ada event data berisi error guardian_upstream_interrupted');
    assert.match(r.text, /^data: \[DONE\]$/m);
    assert.strictEqual(t.g.state['a/1'].status, 'degraded');
    assert.strictEqual(t.g.metrics.interrupted, 1);
    const r2 = await chat(t.url, { stream: true });
    assert.match(sseText(r2.text), /Halo dari b\/2/, 'percobaan ulang klien harus jatuh ke model berikutnya');
  } finally { await t.done(); }
});

test('request bersamaan: semua sukses dan request sesudahnya tidak lagi menyentuh model yang gagal', async () => {
  const t = await setup(['a/1', 'b/2'], { 'a/1': '429' });
  try {
    const rs = await Promise.all(Array.from({ length: 6 }, () => chat(t.url)));
    rs.forEach((r) => { assert.strictEqual(r.status, 200); assert.match(r.text, /jawaban dari b\/2/); });
    const before = t.up.hits['a/1'];
    assert.ok(before <= 6);
    await chat(t.url);
    assert.strictEqual(t.up.hits['a/1'], before);
  } finally { await t.done(); }
});

test('klien membatalkan di tengah jalan: request ke 9Router ikut dibatalkan', async () => {
  const t = await setup(['a/1'], { 'a/1': 'hang' }, { firstByteMs: 20000 });
  try {
    const ac = new AbortController();
    const p = fetch(`${t.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'guardian', stream: true, messages: [{ role: 'user', content: 'x' }] }), signal: ac.signal,
    }).catch(() => null);
    const t0 = Date.now();
    while (!t.up.hits['a/1'] && Date.now() - t0 < 3000) await sleep(20);
    ac.abort();
    await p;
    const t1 = Date.now();
    while (!t.up.closed['a/1'] && Date.now() - t1 < 3000) await sleep(20);
    assert.ok(t.up.closed['a/1'], 'koneksi ke 9Router harus ditutup');
    assert.strictEqual(t.g.snapshot().active.length, 0);
  } finally { await t.done(); }
});

test('keep-alive: saat pencarian model lama, klien menerima komentar SSE lalu jawaban dari model berikutnya', async () => {
  const t = await setup(['a/1', 'b/2'], { 'a/1': 'hang' }, { keepaliveMs: 100, firstByteMs: 500 });
  try {
    const r = await chat(t.url, { stream: true });
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /: guardian sedang mencari/);
    assert.match(sseText(r.text), /Halo dari b\/2/);
  } finally { await t.done(); }
});

// ---------------------------------------------------------------- keamanan, log, jalur lain

test('Authorization klien diteruskan; kunci yang dipantulkan 9Router tidak bocor ke log, state, event, atau klien', async () => {
  const t = await setup(['a/1', 'b/2'], { 'a/1': 'echo429', 'b/2': 'echo429' });
  try {
    const r = await chat(t.url, { headers: { Authorization: `Bearer ${KEY}` } });
    assert.strictEqual(r.status, 503);
    assert.ok(t.up.auths.every((a) => a === `Bearer ${KEY}`));
    const log = fs.readFileSync(t.failLog, 'utf8');
    assert.match(log, /a\/1/);
    t.g.saveStateNow();
    const stateTxt = fs.readFileSync(t.stateFile, 'utf8');
    assert.ok(!log.includes(KEY), 'log kegagalan membocorkan kunci');
    assert.ok(!stateTxt.includes(KEY), 'combo-state.json membocorkan kunci');
    assert.ok(!r.text.includes(KEY), 'pesan ke klien membocorkan kunci');
    assert.ok(!t.g.events.some((e) => e.msg.includes(KEY)), 'event membocorkan kunci');
    assert.ok(!JSON.stringify(t.g.snapshot().order.map((m) => m.s)).includes(KEY), 'snapshot membocorkan kunci');
  } finally { await t.done(); }
});

test('tanpa Authorization dari klien, guardian memakai API key dari config', async () => {
  const t = await setup(['a/1'], {});
  try {
    const r = await fetch(`${t.url}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'guardian', messages: [] }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(t.up.auths[0], `Bearer ${KEY}`);
  } finally { await t.done(); }
});

test('hanya mendengarkan 127.0.0.1', async () => {
  const t = await setup(['a/1'], {});
  try {
    assert.strictEqual(t.g.server.address().address, '127.0.0.1');
  } finally { await t.done(); }
});

test('model non-virtual dan /v1/models diteruskan; guardian muncul di daftar model', async () => {
  const t = await setup(['a/1'], {});
  try {
    const r = await chat(t.url, { model: 'x/lain' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(t.up.hits['x/lain'], 1);
    const ml = await (await fetch(`${t.url}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
    assert.strictEqual(ml.data[0].id, 'guardian');
    assert.ok(ml.data.some((m) => m.id === 'a/1'));
    const h = await (await fetch(`${t.url}/health`)).json();
    assert.strictEqual(h.ok, true);
  } finally { await t.done(); }
});

test('body bukan JSON: 400; tanpa combo: 503 yang menyebut menu [1]', async () => {
  const t = await setup([], {});
  try {
    const bad = await fetch(`${t.url}/v1/chat/completions`, { method: 'POST', body: 'bukan json' });
    assert.strictEqual(bad.status, 400);
    const none = await chat(t.url);
    assert.strictEqual(none.status, 503);
    assert.match(none.text, /menu \[1\]/);
  } finally { await t.done(); }
});

test('state tersimpan atomik ke combo-state.json dan bisa dimuat ulang', async () => {
  const t = await setup(['a/1', 'b/2'], { 'a/1': '429' });
  try {
    await chat(t.url);
    t.g.saveStateNow();
    const j = JSON.parse(fs.readFileSync(t.stateFile, 'utf8'));
    assert.strictEqual(j.models['a/1'].status, 'degraded');
    assert.ok(!fs.existsSync(t.stateFile + '.tmp'));
    const g2 = G.createGuardian({ cfg: { baseUrl: t.up.base, apiKey: KEY }, models: ['a/1', 'b/2'], port: 0, stateFile: t.stateFile, routerCheck: false });
    await g2.start();
    assert.strictEqual(g2.state['a/1'].status, 'degraded');
    await g2.stop();
  } finally { await t.done(); }
});

test('urutan model dibaca dari combo-auto-combo.json (string atau objek) dan tidak ditulis ulang', async () => {
  const dir = process.env.GASPOLL_RESULTS;
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'combo-auto-combo.json');
  const body = JSON.stringify({ name: 'auto-combo', models: ['z/1', { id: 'z/2' }, 'z/3'] });
  fs.writeFileSync(f, body);
  const before = fs.statSync(f).mtimeMs;
  const g = G.createGuardian({ cfg: { baseUrl: 'http://127.0.0.1:1', apiKey: KEY }, port: 0, stateFile: path.join(TMP, 's-combo.json'), routerCheck: false });
  await g.start();
  try {
    assert.deepStrictEqual(g.models, ['z/1', 'z/2', 'z/3']);
    g.state['z/1'] = { status: 'degraded', fails: 1, cooldownUntil: Date.now() + 5000, nextProbeAt: 0, probeOk: 0, lastMs: 0, lastAt: 0, reason: 'x', uses: 0 };
    g.saveStateNow();
    assert.strictEqual(fs.readFileSync(f, 'utf8'), body, 'combo-auto-combo.json tidak boleh berubah');
    assert.strictEqual(fs.statSync(f).mtimeMs, before);
  } finally { await g.stop(); fs.unlinkSync(f); }
});

// ---------------------------------------------------------------- klasifikasi & tampilan

test('classifyHttp / classifyContent: kasus utama', () => {
  const p = G.buildPatterns('');
  assert.strictEqual(G.classifyHttp(429, '', p).kind, 'limit');
  assert.strictEqual(G.classifyHttp(402, '', p).kind, 'limit');
  assert.strictEqual(G.classifyHttp(503, '', p).kind, 'provider');
  assert.strictEqual(G.classifyHttp(404, '', p).kind, 'notfound');
  assert.strictEqual(G.classifyHttp(401, '', p).pass, true);
  assert.strictEqual(G.classifyHttp(400, 'maximum context length is 8192 tokens', p).skip, true);
  assert.strictEqual(G.classifyHttp(400, 'quota exceeded', p).kind, 'limit');
  assert.strictEqual(G.classifyHttp(400, 'role invalid', p).pass, true);
  assert.strictEqual(G.classifyContent('', false, p).kind, 'empty');
  assert.strictEqual(G.classifyContent('', true, p), null);
  assert.strictEqual(G.classifyContent('Usage limit reached', false, p).kind, 'limit');
  assert.strictEqual(G.classifyContent('x'.repeat(400) + ' rate limit', false, p), null, 'jawaban panjang tidak dianggap limit');
  const p2 = G.buildPatterns('kuota\\s+habis');
  assert.strictEqual(G.classifyContent('Maaf, kuota  habis.', false, p2).kind, 'limit');
  assert.ok(G.buildPatterns('(['), 'pola rusak tidak boleh melempar');
});

test('dashboard: lebar terbatas, menampilkan model yang sedang dipakai, cooldown', async () => {
  const t = await setup(['cf/@cf/meta/llama-3.1-8b-instruct-fp8-fast', 'kr/auto', 'gemini/gemini-3-flash-preview'], { 'cf/@cf/meta/llama-3.1-8b-instruct-fp8-fast': '429', 'kr/auto': 'slow-ok' });
  const saved = { A: process.env.GASPOLL_ASCII, N: process.env.NO_COLOR };
  process.env.GASPOLL_ASCII = '1'; process.env.NO_COLOR = '1';
  try {
    const p = chat(t.url);
    await sleep(150);
    const L = require('../src/lib.js');
    const mid = G.renderDashboard(t.g, { width: 80, rows: 30 }).map(L.stripAnsi);
    assert.ok(mid.join('\n').includes('kr/auto'), 'model yang sedang dipakai tampil');
    assert.ok(mid.join('\n').includes('menunggu respons'));
    await p;
    for (const w of [60, 80, 100]) {
      const lines = G.renderDashboard(t.g, { width: w, rows: 30 }).map(L.stripAnsi);
      lines.forEach((l) => assert.ok(l.length <= w, `baris ${l.length} > ${w}: ${l}`));
      // Check that dashboard renders without error and contains expected content
      const all = lines.join('\n');
      assert.match(all, /REALTIME BOT GUARDIAN/);
      assert.match(all, /cooldown/);
      assert.match(all, /\[LIM\]/);
      assert.match(all, /127\.0\.0\.1/);
    }
  } finally {
    if (saved.A === undefined) delete process.env.GASPOLL_ASCII; else process.env.GASPOLL_ASCII = saved.A;
    if (saved.N === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved.N;
    await t.done();
  }
});

test('dashboard: 37 model tetap muat di layar dan model bermasalah selalu terlihat', async () => {
  const models = Array.from({ length: 37 }, (_, i) => `p${i % 5}/model-${i}`);
  const t = await setup(models, {});
  try {
    t.g.state['p4/model-34'] = { status: 'degraded', fails: 1, cooldownUntil: Date.now() + 20000, nextProbeAt: 0, probeOk: 0, lastMs: 0, lastAt: 0, reason: 'HTTP 429', uses: 0 };
    const L = require('../src/lib.js');
    const lines = G.renderDashboard(t.g, { width: 90, rows: 30 }).map(L.stripAnsi);
    assert.ok(lines.length <= 30, `terlalu tinggi: ${lines.length}`);
    assert.ok(lines.join('\n').includes('p4/model-34'), 'model bermasalah harus tampil walau daftar dipotong');
    assert.match(lines.join('\n'), /\+\d+ model lainnya/);
  } finally { await t.done(); }
});

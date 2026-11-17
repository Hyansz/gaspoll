'use strict';
/**
 * test/update-check.test.js
 * Tes fitur cek update: badge versi, cache 60 menit, deteksi update, dan
 * sambungan menu [u] ke "git pull origin <branch>".
 * Tidak ada panggilan jaringan: GASPOLL_UPDATE_OFF=1 dipasang sebelum require.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-update-'));
process.env.GASPOLL_RESULTS = resultsDir;
process.env.NO_COLOR = '1';
process.env.GASPOLL_ASCII = '1';
process.env.GASPOLL_UPDATE_OFF = '1';

const UPDATE = require('../src/update.js');
const UI = require('../src/ui.js');

test.after(() => {
  delete process.env.GASPOLL_UPDATE_OFF;
  delete process.env.GASPOLL_UPDATE_INTERVAL_MS;
  try { fs.rmSync(resultsDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------- badge & tagline

test('badge ASCII: ok/ahead -> [OK], update -> [UPD], lainnya -> [?]', () => {
  assert.deepStrictEqual(UI.updateBadge({ state: 'ok' }), { text: '[OK]', tone: 'ok' });
  assert.deepStrictEqual(UI.updateBadge({ state: 'ahead' }), { text: '[OK]', tone: 'ok' });
  assert.deepStrictEqual(UI.updateBadge({ state: 'update' }), { text: '[UPD]', tone: 'update' });
  assert.strictEqual(UI.updateBadge({ state: 'unknown' }).text, '[?]');
  assert.strictEqual(UI.updateBadge({ state: 'checking' }).text, '[?]');
  assert.strictEqual(UI.updateBadge({ state: 'no-git' }).text, '[?]');
  assert.strictEqual(UI.updateBadge(null).text, '[?]');
});

test('versionParts: versi + badge, dan versi GitHub saat update tersedia', () => {
  assert.strictEqual(UI.versionParts('1.2.9').plain, 'v1.2.9');
  assert.strictEqual(UI.versionParts('v1.2.9').plain, 'v1.2.9');
  assert.strictEqual(UI.versionParts('1.2.9', { state: 'ok' }).plain, 'v1.2.9 [OK]');
  assert.strictEqual(
    UI.versionParts('1.2.9', { state: 'update', remoteVersion: '1.2.10' }).plain,
    'v1.2.9 -> v1.2.10 [UPD]'
  );
  assert.strictEqual(
    UI.versionParts('1.2.9', { state: 'update' }).plain,
    'v1.2.9 [UPD]'
  );
  // remoteVersion sama dengan versi lokal: jangan tampilkan panah ganda.
  assert.strictEqual(
    UI.versionParts('1.2.9', { state: 'update', remoteVersion: '1.2.9' }).plain,
    'v1.2.9 [UPD]'
  );
  // Versi lokal lebih tinggi (belum dirilis): arah panah tidak ditampilkan.
  assert.strictEqual(
    UI.versionParts('1.2.10', { state: 'update', remoteVersion: '1.2.9' }).plain,
    'v1.2.10 [UPD]'
  );
  // Perbandingan numerik, bukan alfabetis.
  assert.strictEqual(
    UI.versionParts('1.2.9', { state: 'update', remoteVersion: '1.2.10' }).plain,
    'v1.2.9 -> v1.2.10 [UPD]'
  );
});

test('renderMenu: badge [OK] menempel pada versi di tagline', () => {
  const data = {
    baseUrl: 'http://localhost:20128',
    apiKey: 'sk-abcdefgh1234',
    alive: { ok: true },
    t: null,
    b: null,
    update: { state: 'ok', localVersion: pkg.version },
  };
  const lines = UI.renderMenu(data, { version: pkg.version, width: 100, compact: true }).map(UI.stripAnsi);
  const tag = lines.find((l) => l.includes('Tes provider'));
  assert.ok(tag, 'baris tagline harus ada');
  assert.ok(tag.includes(`v${pkg.version} [OK]`), `tagline harus memuat versi + [OK]: ${tag}`);
});

test('renderMenu: update tersedia menampilkan [UPD] dan saran tekan u', () => {
  const data = {
    baseUrl: 'http://localhost:20128',
    apiKey: 'sk-abcdefgh1234',
    alive: { ok: true },
    t: null,
    b: null,
    update: { state: 'update', localVersion: pkg.version, remoteVersion: '9.9.9' },
  };
  const all = UI.renderMenu(data, { version: pkg.version, width: 100, compact: true }).map(UI.stripAnsi).join('\n');
  assert.ok(all.includes('[UPD]'), 'badge [UPD] harus tampil');
  assert.ok(all.includes('v9.9.9'), 'versi GitHub harus tampil saat diketahui');
  assert.ok(/Saran: tekan \[u\]/.test(all), 'saran harus mengarah ke tombol u');
  assert.ok(all.includes('[u] Cek update tool'), 'item menu [u] harus tampil');
});

test('renderMenu: menu [u] tetap muat di terminal sempit', () => {
  const data = {
    baseUrl: 'http://localhost:20128',
    apiKey: 'sk-abcdefgh1234',
    alive: { ok: true },
    t: null,
    b: null,
    update: { state: 'ok' },
  };
  for (const width of [50, 60, 80]) {
    const lines = UI.renderMenu(data, { version: pkg.version, width }).map(UI.stripAnsi);
    const all = lines.join('\n');
    assert.ok(all.includes('[u] Cek update tool'), `lebar ${width}: item [u] hilang`);
    assert.ok(all.includes('[1-8, u, g, q]'), `lebar ${width}: prompt harus memuat u`);
    lines.forEach((l) => assert.ok(UI.visualWidth(l) <= width, `lebar ${width}: baris melebihi (${l})`));
  }
});

// ---------------------------------------------------------------- repo & URL

test('slugOf mengenali URL GitHub HTTPS, SSH, dan scp-like', () => {
  assert.strictEqual(UPDATE.slugOf('https://github.com/Hyansz/gaspoll.git'), 'Hyansz/gaspoll');
  assert.strictEqual(UPDATE.slugOf('https://github.com/Hyansz/gaspoll'), 'Hyansz/gaspoll');
  assert.strictEqual(UPDATE.slugOf('https://github.com/Hyansz/gaspoll/'), 'Hyansz/gaspoll');
  assert.strictEqual(UPDATE.slugOf('git@github.com:Hyansz/gaspoll.git'), 'Hyansz/gaspoll');
  assert.strictEqual(UPDATE.slugOf('ssh://git@github.com/Hyansz/gaspoll.git'), 'Hyansz/gaspoll');
  assert.strictEqual(UPDATE.slugOf(''), '');
  assert.strictEqual(UPDATE.slugOf(null), '');
});

test('default repo, branch, dan interval 60 menit', () => {
  assert.strictEqual(UPDATE.DEFAULT_SLUG, 'Hyansz/gaspoll');
  assert.strictEqual(UPDATE.DEFAULT_BRANCH, 'main');
  delete process.env.GASPOLL_UPDATE_INTERVAL_MS;
  assert.strictEqual(UPDATE.intervalMs(), 60 * 60 * 1000);
  process.env.GASPOLL_UPDATE_INTERVAL_MS = '5000';
  assert.strictEqual(UPDATE.intervalMs(), 5000);
  process.env.GASPOLL_UPDATE_INTERVAL_MS = 'abc';
  assert.strictEqual(UPDATE.intervalMs(), 60 * 60 * 1000);
  delete process.env.GASPOLL_UPDATE_INTERVAL_MS;
});

test('localVersion membaca versi package.json', () => {
  assert.strictEqual(UPDATE.localVersion(), pkg.version);
});

// ---------------------------------------------------------------- cache & TTL

test('cache update tersimpan dan terbaca kembali', () => {
  const state = {
    state: 'update',
    checkedAt: Date.now(),
    slug: 'Hyansz/gaspoll',
    branch: 'main',
    localHash: 'aaaaaaa',
    remoteHash: 'bbbbbbb',
    localVersion: pkg.version,
    remoteVersion: '9.9.9',
    dirty: 0,
    via: 'api',
    error: '',
  };
  UPDATE.writeCache(state);
  const back = UPDATE.readCache();
  assert.deepStrictEqual(back, state);
  assert.ok(fs.existsSync(UPDATE.cachePath()), 'berkas cache harus dibuat');
});

test('TTL cache: hasil baru dianggap segar, yang lewat 60 menit tidak', () => {
  process.env.GASPOLL_UPDATE_INTERVAL_MS = '60000';
  const now = Date.now();
  assert.strictEqual(UPDATE.isFresh({ checkedAt: now }), true);
  assert.strictEqual(UPDATE.isFresh({ checkedAt: now - 120000 }), false);
  assert.strictEqual(UPDATE.isFresh(null), false);
  assert.strictEqual(UPDATE.isFresh({}), false);
  delete process.env.GASPOLL_UPDATE_INTERVAL_MS;
});

test('getStatus memakai cache segar tanpa menyentuh jaringan', async () => {
  process.env.GASPOLL_UPDATE_INTERVAL_MS = '60000';
  const state = { state: 'ok', checkedAt: Date.now(), localVersion: pkg.version };
  UPDATE.writeCache(state);
  const u = await UPDATE.getStatus({ waitIfMissing: true });
  assert.strictEqual(u.state, 'ok');
  assert.strictEqual(u.fresh, true);
  delete process.env.GASPOLL_UPDATE_INTERVAL_MS;
});

test('pemeriksaan otomatis mati saat GASPOLL_UPDATE_OFF=1', () => {
  assert.strictEqual(UPDATE.disabled(), true);
  assert.strictEqual(UPDATE.autoEnabled(), false);
});

test('pemeriksaan otomatis bisa dipaksa lewat GASPOLL_UPDATE_CHECK=1', () => {
  delete process.env.GASPOLL_UPDATE_OFF;
  process.env.GASPOLL_UPDATE_CHECK = '1';
  try {
    assert.strictEqual(UPDATE.autoEnabled(), true);
  } finally {
    delete process.env.GASPOLL_UPDATE_CHECK;
    process.env.GASPOLL_UPDATE_OFF = '1';
  }
});

test('checkNow saat dimatikan tidak menyentuh jaringan dan menjelaskan alasannya', async () => {
  const u = await UPDATE.checkNow();
  assert.ok(typeof u.error === 'string' && u.error.includes('dimatikan'), `error harus menjelaskan: ${u.error}`);
});

// ---------------------------------------------------------------- sambungan menu

test('cli.js menerima u, 9, update, /update dan menutup pemeriksaan saat keluar', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  assert.match(cli, /k === 'u'/);
  assert.match(cli, /k === '9'/);
  assert.match(cli, /k === 'update'/);
  assert.match(cli, /k === '\/update'/);
  assert.match(cli, /await actionUpdate\(\)/);
  assert.match(cli, /UPDATE\.getStatus\(/);
  assert.match(cli, /UPDATE\.cancel\(\)/);
  assert.match(cli, /Ketik 1-8, u, g, atau q\./);
});

test('update.js melakukan git pull origin <branch> dan tidak memakai emoji', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'update.js'), 'utf8');
  assert.match(src, /'pull', 'origin', branch/);
  const cli = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  assert.match(cli, /git pull origin \$\{branch\}/);
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(src), 'update.js tidak boleh memakai emoji');
});

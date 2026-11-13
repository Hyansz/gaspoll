'use strict';
/**
 * Keluaran Menu [1] (src/test-9router.js) harus ringkas:
 * satu baris HASIL, combo 10 teratas, tabel hanya provider yang lolos,
 * provider tanpa lolos dikelompokkan, dan "Perintah setara" hanya dengan GASPOLL_VERBOSE=1.
 * Memakai mock router di port sendiri supaya tidak bentrok dengan tes lain.
 */

process.env.MOCK_PORT = process.env.MOCK_PORT || '20997';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const mockRouter = require('./mock-router.js');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'src', 'test-9router.js');
const BASE = `http://localhost:${mockRouter.PORT}`;
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function runScript(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const results = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-tidy-'));
    const env = { ...process.env };
    for (const k of ['GASPOLL_ASCII', 'GASPOLL_UNICODE', 'GASPOLL_VERBOSE', 'GASPOLL_COMPACT']) delete env[k];
    Object.assign(env, {
      GASPOLL_RESULTS: results,
      GASPOLL_CONFIG: path.join(results, 'tidak-ada.json'),
      GASPOLL_NOCLEAR: '1',
      GASPOLL_FROM_MENU: '1',
      NINE_ROUTER_BASE_URL: BASE,
      NINE_ROUTER_API_KEY: 'sk-mock-test-key-000',
      NINE_ROUTER_PASSWORD: 'mock-password',
      NO_COLOR: '1',
    }, extraEnv);
    const child = spawn(process.execPath, [SCRIPT, '--name', 'tidy', '--timeout', '10'], { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('skrip tidak selesai dalam 60 detik')); }, 60000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { fs.rmSync(results, { recursive: true, force: true }); } catch { /* abaikan */ }
      resolve({ code, out: stripAnsi(out) });
    });
  });
}

async function withMock(fn) {
  await mockRouter.start();
  try {
    mockRouter.clearScenarios();
    return await fn();
  } finally {
    mockRouter.clearScenarios();
    await mockRouter.stop();
  }
}

const allModels = () => mockRouter.getModels().map((m) => m.id);
const lineList = (out) => out.split(/\r?\n/);
const numberedCombo = (lines) => lines.filter((l) => /^\s{0,3}\d+\. \S+/.test(l));

test('menu [1]: sebagian provider gagal, keluaran ringkas', async () => {
  await withMock(async () => {
    const geminiIds = allModels().filter((id) => id.startsWith('gemini/'));
    assert.ok(geminiIds.length > 0, 'mock harus punya model gemini');
    geminiIds.forEach((id) => mockRouter.setScenario(id, '503'));

    const r = await runScript();
    assert.strictEqual(r.code, 0, r.out);
    const lines = lineList(r.out);

    assert.ok(!/Ringkasan Gagal/.test(r.out), 'blok "Ringkasan Gagal" tidak boleh ada');
    assert.ok(!/RINGKASAN TES/.test(r.out), 'kotak RINGKASAN TES tidak boleh ada');
    assert.ok(!/Selesai dalam/.test(r.out), 'baris "Selesai dalam" tidak boleh ada');
    assert.match(r.out, /HASIL: \d+ lolos, \d+ gagal, waktu \d\d:\d\d/);

    const header = r.out.match(/COMBO "tidy" \((\d+) model, urutan fallback\)/);
    assert.ok(header, 'judul combo memuat jumlah model');
    const n = Number(header[1]);
    assert.ok(n > 10, `perlu lebih dari 10 model untuk menguji pemotongan (dapat ${n})`);
    assert.strictEqual(numberedCombo(lines).length, 10, 'hanya 10 baris combo yang dicetak');
    assert.match(r.out, new RegExp(`\\.\\.\\. \\+${n - 10} lainnya \\(daftar lengkap: combo-tidy\\.txt\\)`));

    const iWin = lines.findIndex((l) => /PROVIDER YANG LOLOS/.test(l));
    const iLose = lines.findIndex((l) => /TIDAK ADA YANG LOLOS/.test(l));
    assert.ok(iWin >= 0, 'ada bagian PROVIDER YANG LOLOS');
    assert.ok(iLose > iWin, 'bagian TIDAK ADA YANG LOLOS ada setelah tabel');
    const table = lines.slice(iWin, iLose);
    assert.ok(table.some((l) => /^\s+cf\s+\d+\/\d+/.test(l)), 'provider cf ada di tabel');
    assert.ok(!table.some((l) => /^\s+gemini\s/.test(l)), 'provider 0/N tidak boleh ada di tabel');
    assert.match(lines[iLose], new RegExp(`TIDAK ADA YANG LOLOS \\(1 provider, ${geminiIds.length} model\\)`));
    assert.ok(lines.some((l) => new RegExp(`gemini 0/${geminiIds.length} \\S`).test(l)), 'entri gemini 0/N ada');
    assert.match(r.out, /Detail per alasan: Riwayat & log > Yang gagal/);
    const longLines = lines.filter((l) => !/^(Hasil lengkap|Daftar model)/.test(l)).filter((l) => l.length > 100);
    assert.deepStrictEqual(longLines, [], 'baris lebih dari 100 kolom: ' + JSON.stringify(longLines));
  });
});

test('menu [1]: semua lolos, tanpa bagian "tidak ada yang lolos"', async () => {
  await withMock(async () => {
    const r = await runScript();
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /HASIL: \d+ lolos, 0 gagal/);
    assert.match(r.out, /PROVIDER YANG LOLOS/);
    assert.ok(!/TIDAK ADA YANG LOLOS/.test(r.out));
    assert.ok(!/Ringkasan Gagal/.test(r.out));
  });
});

test('menu [1]: tidak ada yang lolos tetap menjelaskan alasannya', async () => {
  await withMock(async () => {
    const ids = allModels();
    ids.forEach((id) => mockRouter.setScenario(id, '503'));
    const providers = new Set(ids.map((id) => id.split('/')[0]));

    const r = await runScript();
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /Tidak ada model yang lolos/);
    assert.match(r.out, new RegExp(`TIDAK ADA YANG LOLOS \\(${providers.size} provider, ${ids.length} model\\)`));
    assert.ok(!/PROVIDER YANG LOLOS/.test(r.out), 'tabel provider lolos tidak ada bila semuanya gagal');
    assert.ok(!/Ringkasan Gagal/.test(r.out));
  });
});

test('menu [1]: mode ASCII murni', async () => {
  await withMock(async () => {
    allModels().filter((id) => id.startsWith('gemini/')).forEach((id) => mockRouter.setScenario(id, '503'));
    const r = await runScript({ GASPOLL_ASCII: '1' });
    assert.strictEqual(r.code, 0, r.out);
    const bad = lineList(r.out)
      .filter((l) => !/^(Hasil lengkap|Daftar model)/.test(l))
      .filter((l) => /[^\x00-\x7F]/.test(l));
    assert.deepStrictEqual(bad, [], 'baris dengan karakter non-ASCII: ' + JSON.stringify(bad));
    assert.match(r.out, /TIDAK ADA YANG LOLOS/);
  });
});

test('menu [1]: GASPOLL_VERBOSE=1 mencetak seluruh combo', async () => {
  await withMock(async () => {
    const r = await runScript({ GASPOLL_VERBOSE: '1' });
    assert.strictEqual(r.code, 0, r.out);
    const n = Number(r.out.match(/COMBO "tidy" \((\d+) model/)[1]);
    assert.strictEqual(numberedCombo(lineList(r.out)).length, n, 'semua baris combo dicetak');
    assert.ok(!/lainnya \(daftar lengkap/.test(r.out));
  });
});

test('cli.js: "Perintah setara" hanya tampil dengan GASPOLL_VERBOSE=1', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  const line = src.split(/\r?\n/).find((l) => l.includes('Perintah setara'));
  assert.ok(line, 'baris "Perintah setara" ada di cli.js');
  assert.ok(/GASPOLL_VERBOSE/.test(line), 'baris itu harus dijaga GASPOLL_VERBOSE');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const UI = require('../src/ui');

function stripAnsi(str) {
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}

test('mode ringkas (compact): tanpa banner, header 1 baris, tidak ada asap', () => {
  const oldNoColor = process.env.NO_COLOR;
  const oldCompact = process.env.GASPOLL_COMPACT;
  process.env.NO_COLOR = '1';
  process.env.GASPOLL_COMPACT = '1';
  try {
    const data = {
      baseUrl: 'http://localhost:20128',
      apiKey: 'sk-c1a2b3c4d5e6c181',
      alive: { ok: true, baseUrl: 'http://localhost:20128' },
      t: { tested_at: new Date(Date.now() - 2 * 3600e3).toISOString(), name: 'auto-combo', models: [1, 2, 3] },
      b: { tested_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
    };
    const lines = UI.renderMenu(data, { version: pkg.version, width: 80, compact: true }).map(stripAnsi);
    assert.ok(lines[0].includes('GASPOLL'), 'Baris 1 harus memuat GASPOLL');
    assert.ok(!lines.slice(1, 4).some(l => l.includes('\u2588')), 'Mode ringkas tidak boleh ada banner art');
    assert.ok(!lines.some(l => /[\u2591\u2592\u2593]/.test(l)), 'Mode ringkas tidak boleh ada karakter asap');
  } finally {
    if (oldNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldNoColor;
    if (oldCompact === undefined) delete process.env.GASPOLL_COMPACT; else process.env.GASPOLL_COMPACT = oldCompact;
  }
});

test('T1 ringkas Unicode w=80', () => {
  const oldNoColor = process.env.NO_COLOR;
  const oldUni = process.env.GASPOLL_UNICODE;
  const oldCompact = process.env.GASPOLL_COMPACT;
  process.env.NO_COLOR = '1';
  process.env.GASPOLL_UNICODE = '1';
  process.env.GASPOLL_COMPACT = '1';
  try {
    const data = {
      baseUrl: 'http://localhost:20128',
      apiKey: 'sk-c1a2b3c4d5e6c181',
      alive: { ok: true, baseUrl: 'http://localhost:20128' },
      t: { tested_at: new Date(Date.now() - 2 * 3600e3).toISOString(), name: 'auto-combo', models: [1, 2, 3] },
      b: { tested_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
    };
    const lines = UI.renderMenu(data, { version: pkg.version, width: 80, compact: true }).map(stripAnsi);
    assert.ok(lines[0].includes('GASPOLL'), 'Header memuat GASPOLL');
    assert.ok(lines[1].includes(pkg.version), 'Header memuat versi di ujung kanan');
    assert.ok(!lines.some(l => l.includes('\u2588') || /[\u2591\u2592\u2593]/.test(l)), 'Tanpa baris banner atau asap');
    assert.ok(lines.length < 24, 'Total baris < 24');
    const divider = lines.find(l => l.includes('\u2500'));
    assert.ok(divider && divider.trim().length <= 78, 'Garis pemisah <= 78 kolom');
  } finally {
    if (oldNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldNoColor;
    if (oldUni === undefined) delete process.env.GASPOLL_UNICODE; else process.env.GASPOLL_UNICODE = oldUni;
    if (oldCompact === undefined) delete process.env.GASPOLL_COMPACT; else process.env.GASPOLL_COMPACT = oldCompact;
  }
});

test('T2 ringkas compact layout w=80 renders without error', () => {
  const oldNoColor = process.env.NO_COLOR;
  const oldAscii = process.env.GASPOLL_ASCII;
  const oldCompact = process.env.GASPOLL_COMPACT;
  process.env.NO_COLOR = '1';
  process.env.GASPOLL_ASCII = '1';
  process.env.GASPOLL_COMPACT = '1';
  try {
    const data = {
      baseUrl: 'http://localhost:20128',
      apiKey: 'sk-c1a2b3c4d5e6c181',
      alive: { ok: true, baseUrl: 'http://localhost:20128' },
      t: { tested_at: new Date(Date.now() - 2 * 3600e3).toISOString(), name: 'auto-combo', models: [1, 2, 3] },
      b: { tested_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
    };
    const lines = UI.renderMenu(data, { version: pkg.version, width: 80, compact: true }).map(stripAnsi);
    assert.ok(!lines.some(l => l.includes('#')), 'Tanpa baris banner #');
    assert.ok(lines.some(l => l.includes('GASPOLL')), 'Header memuat GASPOLL');
    // Compact render works without crashes, regardless of Unicode vs ASCII
    assert.ok(lines.length > 0, 'Menu rendered with content');
  } finally {
    if (oldNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldNoColor;
    if (oldAscii === undefined) delete process.env.GASPOLL_ASCII; else process.env.GASPOLL_ASCII = oldAscii;
    if (oldCompact === undefined) delete process.env.GASPOLL_COMPACT; else process.env.GASPOLL_COMPACT = oldCompact;
  }
});

test('T3 penuh Unicode w=120', () => {
  const oldNoColor = process.env.NO_COLOR;
  const oldUni = process.env.GASPOLL_UNICODE;
  const oldCompact = process.env.GASPOLL_COMPACT;
  process.env.NO_COLOR = '1';
  process.env.GASPOLL_UNICODE = '1';
  process.env.GASPOLL_COMPACT = '0';
  try {
    const rawLines = [];
    for (let i = 0; i < 8; i++) {
      rawLines.push(stripAnsi(UI.bannerLine(i, 120)));
    }
    assert.ok(rawLines.some(l => l.includes('\u2588')), 'Baris banner memuat U+2588');
    
    const smoke3 = rawLines[3].slice(2, 18);
    assert.ok(smoke3.includes('\u2593'), 'Baris indeks 3 memuat U+2593');

    rawLines.forEach(l => {
      assert.ok(l.length <= 79, 'Lebar terlihat baris banner <= 79');
    });

    const data = {
      baseUrl: 'http://localhost:20128',
      apiKey: 'sk-c1a2b3c4d5e6c181',
      alive: { ok: true, baseUrl: 'http://localhost:20128' },
      t: { tested_at: new Date(Date.now() - 2 * 3600e3).toISOString(), name: 'auto-combo', models: [1, 2, 3] },
      b: { tested_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
    };
    const lines = UI.renderMenu(data, { version: pkg.version, width: 120 }).map(stripAnsi);
    const divider = lines.find(l => l.includes('\u2500'));
    assert.ok(divider && divider.trim().length <= 79, 'Garis pemisah <= 79 kolom');
  } finally {
    if (oldNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldNoColor;
    if (oldUni === undefined) delete process.env.GASPOLL_UNICODE; else process.env.GASPOLL_UNICODE = oldUni;
    if (oldCompact === undefined) delete process.env.GASPOLL_COMPACT; else process.env.GASPOLL_COMPACT = oldCompact;
  }
});

test('T4 penuh Unicode w=78', () => {
  const oldNoColor = process.env.NO_COLOR;
  const oldUni = process.env.GASPOLL_UNICODE;
  const oldCompact = process.env.GASPOLL_COMPACT;
  process.env.NO_COLOR = '1';
  process.env.GASPOLL_UNICODE = '1';
  process.env.GASPOLL_COMPACT = '0';
  try {
    for (let i = 0; i < 8; i++) {
      const line = stripAnsi(UI.bannerLine(i, 78));
      const firstBlock = line.indexOf('\u2588');
      if (firstBlock >= 0) {
        const prefix = line.slice(0, firstBlock);
        assert.ok(!/[\u00b7\u2591\u2592\u2593]/.test(prefix), 'Zona asap kosong di w=78');
      }
    }
    const data = {
      baseUrl: 'http://localhost:20128',
      apiKey: 'sk-c1a2b3c4d5e6c181',
      alive: { ok: true, baseUrl: 'http://localhost:20128' },
      t: { tested_at: new Date(Date.now() - 2 * 3600e3).toISOString(), name: 'auto-combo', models: [1, 2, 3] },
      b: { tested_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
    };
    const lines = UI.renderMenu(data, { version: pkg.version, width: 78 }).map(stripAnsi);
    const divider = lines.find(l => l.includes('\u2500'));
    assert.ok(divider && divider.trim().length <= 76, 'Garis pemisah <= 76 kolom');
  } finally {
    if (oldNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldNoColor;
    if (oldUni === undefined) delete process.env.GASPOLL_UNICODE; else process.env.GASPOLL_UNICODE = oldUni;
    if (oldCompact === undefined) delete process.env.GASPOLL_COMPACT; else process.env.GASPOLL_COMPACT = oldCompact;
  }
});

test('T5 status', () => {
  const oldNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const dataWithKey = {
      baseUrl: 'http://localhost:20128',
      apiKey: 'sk-c1a2b3c4d5e6c181',
      alive: { ok: true, baseUrl: 'http://localhost:20128' },
      t: { tested_at: new Date(Date.now() - 2 * 3600e3).toISOString(), name: 'auto-combo', models: [1, 2, 3] },
      b: { tested_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
    };
    const linesKey = UI.renderMenu(dataWithKey, { version: pkg.version, width: 80, compact: true }).map(stripAnsi);
    const txtKey = linesKey.join('\n');
    assert.ok(txtKey.includes('sk-c****c181'), 'Memuat API key tersamarkan');
    assert.ok(!txtKey.includes('sk-c1a2b3c4d5e6c181'), 'Tidak memuat kunci penuh');

    const dataEmptyKey = { ...dataWithKey, apiKey: '' };
    const linesEmpty = UI.renderMenu(dataEmptyKey, { version: pkg.version, width: 80, compact: true }).map(stripAnsi);
    const txtEmpty = linesEmpty.join('\n');
    assert.ok(txtEmpty.includes('belum diatur'), 'Memuat "belum diatur"');
    assert.ok(!txtEmpty.includes('****'), 'Tidak memuat bintang tersamarkan');

    const dataNoCombo = { ...dataWithKey, t: null };
    const linesNoCombo = UI.renderMenu(dataNoCombo, { version: pkg.version, width: 80, compact: true }).map(stripAnsi);
    const txtNoCombo = linesNoCombo.join('\n');
    assert.ok(txtNoCombo.includes('belum dibuat'), 'Memuat "belum dibuat"');

    const txtKeyFull = linesKey.join('\n');
    assert.ok(txtKeyFull.includes('auto-combo'), 'Memuat nama combo');
    assert.ok(txtKeyFull.includes('3 model'), 'Memuat jumlah model');
    assert.ok(txtKeyFull.includes('API key'), 'Label API key ada');
    assert.ok(txtKeyFull.includes('tes terakhir'), 'Label tes terakhir ada');
    assert.ok(txtKeyFull.includes('bench terakhir'), 'Label bench terakhir ada');
  } finally {
    if (oldNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldNoColor;
  }
});

test('T6 label menu', () => {
  const oldNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const data = {
      baseUrl: 'http://localhost:20128',
      apiKey: 'sk-c1a2b3c4d5e6c181',
      alive: { ok: true, baseUrl: 'http://localhost:20128' },
      t: { tested_at: new Date(Date.now() - 2 * 3600e3).toISOString(), name: 'auto-combo', models: [1, 2, 3] },
      b: { tested_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
    };
    const lines = UI.renderMenu(data, { version: pkg.version, width: 80, compact: true }).map(stripAnsi);
    const txt = lines.join('\n');
    assert.ok(txt.includes('Tes provider & buat combo'), 'Label 1 ada');
    assert.ok(txt.includes('Tes + benchmark berurutan'), 'Label 3 ada');

    const root = path.resolve(__dirname, '..');
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.ok(!readme.includes('Test provider'), 'README tidak memuat Test provider');
    assert.ok(!readme.includes('Jalankan semua'), 'README tidak memuat Jalankan semua');
  } finally {
    if (oldNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldNoColor;
  }
});

test('T7 keputusan ringkas', () => {
  const oldNoColor = process.env.NO_COLOR;
  const oldCompact = process.env.GASPOLL_COMPACT;
  process.env.NO_COLOR = '1';
  try {
    const data = {
      baseUrl: 'http://localhost:20128',
      apiKey: 'sk-c1a2b3c4d5e6c181',
      alive: { ok: true, baseUrl: 'http://localhost:20128' },
      t: { tested_at: new Date(Date.now() - 2 * 3600e3).toISOString(), name: 'auto-combo', models: [1, 2, 3] },
      b: { tested_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
    };

    delete process.env.GASPOLL_COMPACT;
    const linesCompact = UI.renderMenu(data, { version: pkg.version, width: 80, compact: true }).map(stripAnsi);
    assert.ok(linesCompact[0].includes('GASPOLL'), 'opts.compact=true ringkas');

    const linesFull = UI.renderMenu(data, { version: pkg.version, width: 80, compact: false }).map(stripAnsi);
    assert.ok(!linesFull[0].includes('GASPOLL'), 'opts.compact=false penuh');

    process.env.GASPOLL_COMPACT = '1';
    const linesEnvCompact = UI.renderMenu(data, { version: pkg.version, width: 80 }).map(stripAnsi);
    assert.ok(linesEnvCompact[0].includes('GASPOLL'), 'GASPOLL_COMPACT=1 ringkas');

    process.env.GASPOLL_COMPACT = '0';
    const linesEnvFull = UI.renderMenu(data, { version: pkg.version, width: 80 }).map(stripAnsi);
    assert.ok(!linesEnvFull[0].includes('GASPOLL'), 'GASPOLL_COMPACT=0 penuh');
  } finally {
    if (oldNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldNoColor;
    if (oldCompact === undefined) delete process.env.GASPOLL_COMPACT; else process.env.GASPOLL_COMPACT = oldCompact;
  }
});

test('T8 alur (g lalu kembali ke menu lalu q)', async () => {
  const CLI = path.join(__dirname, '..', 'src', 'cli.js');
  const stubPath = path.join(os.tmpdir(), `gaspoll-clip-${Date.now()}.txt`);
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-res-'));
  const env = {
    ...process.env,
    GASPOLL_FORCE_TTY: '1',
    GASPOLL_NOCLEAR: '',
    GASPOLL_CLIP_STUB: stubPath,
    GASPOLL_UNICODE: '1',
    FORCE_COLOR: '1',
    GASPOLL_RESULTS: resultsDir,
  };
  delete env.NO_COLOR;
  delete env.TERM;
  delete env.WT_SESSION;
  delete env.TERM_PROGRAM;

  const child = cp.spawn(process.execPath, [CLI], { env });
  let stdout = '', idx = 0, idleTimer = null, stallTimer = null;
  const linesToSend = ['g', '', 'q'];

  return new Promise((resolve) => {
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, 15000);
    const feed = () => {
      clearTimeout(idleTimer); clearTimeout(stallTimer);
      if (child.exitCode !== null || child.killed) return;
      if (idx >= linesToSend.length) { try { child.stdin.end(); } catch {} return; }
      try { child.stdin.write(linesToSend[idx++] + '\n'); } catch { return; }
      stallTimer = setTimeout(feed, 400);
    };
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      clearTimeout(idleTimer); clearTimeout(stallTimer);
      idleTimer = setTimeout(feed, 300);
    });
    child.on('close', () => {
      clearTimeout(idleTimer); clearTimeout(stallTimer); clearTimeout(killer);
      try { fs.rmSync(resultsDir, { recursive: true, force: true }); } catch {}
      try { fs.unlinkSync(stubPath); } catch {}

      const cleanStdout = stripAnsi(stdout);
      const bannerMatches = cleanStdout.match(/\u2588{3,}/g) || [];
      assert.ok(bannerMatches.length >= 1, `Banner art harus muncul, dapat ${bannerMatches.length}`);

      const promptMatches = cleanStdout.match(/Pilih \[1-8, g, q\]/g) || [];
      assert.ok(promptMatches.length >= 2, `Prompt harus muncul >= 2 kali, dapat ${promptMatches.length}`);

      const parts = cleanStdout.split('Pilih [1-8, g, q]');
      assert.ok(parts.length >= 3, 'Harus ada setidaknya 2 layar menu');
      const secondMenu = parts[1];
      assert.ok(secondMenu.includes('\u2588'), 'Menu kedua (render kedua) harus memuat banner art');

      resolve();
    });
  });
});

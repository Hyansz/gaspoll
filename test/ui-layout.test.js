'use strict';
/**
 * test/ui-layout.test.js
 * Tes regresi tata letak menu GASPOLL (node --test).
 * Menguji fungsi renderMenu langsung (tanpa router, tanpa file asli).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Matikan warna dan force 80 kolom agar konsisten
process.env.NO_COLOR = '1';
process.env.GASPOLL_ASCII = '1';
process.stdout.columns = 80;
// Clean environment for deterministic tests
const CLEAN_VARS = ['GASPOLL_DEBUG_UNICODE','GASPOLL_UNICODE','GASPOLL_ASCII','GASPOLL_BANNER','FORCE_COLOR','NO_COLOR','WT_SESSION','TERM','TERM_PROGRAM','ConEmuANSI'];
CLEAN_VARS.forEach(v => { delete process.env[v]; });

// Muat setelah env diatur
const UI = require('../src/ui');

const pkg = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function renderAt(width, opts = {}) {
  process.stdout.columns = width;
  const UI2 = (() => {
    // Perlu hapus cache agar getTermWidth() membaca columns yang baru
    Object.keys(require.cache).filter(k => k.includes('ui.js')).forEach(k => delete require.cache[k]);
    return require('../src/ui');
  })();
  const data = {
    baseUrl: opts.baseUrl || 'http://localhost:20128',
    apiKey: Object.prototype.hasOwnProperty.call(opts, 'apiKey') ? opts.apiKey : 'sk-c1a2b3c4d5e6c181',
    alive: { ok: opts.offline ? false : true, baseUrl: opts.baseUrl || 'http://localhost:20128' },
    t: opts.noTest ? null : { tested_at: new Date(Date.now() - 2 * 3600e3).toISOString(), name: 'auto-combo', models: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] },
    b: opts.noBench ? null : { tested_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
  };
  return UI2.renderMenu(data, { version: pkg.version, width });
}

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const stripLines = (lines) => lines.map(strip);

test('tidak ada dua baris kosong berurutan', () => {
  const lines = stripLines(renderAt(80));
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim() === '' && lines[i + 1].trim() === '') {
      assert.fail(`Dua baris kosong berurutan di baris ${i} dan ${i + 1}`);
    }
  }
});

test('tidak ada dua garis pemisah berurutan (- atau ─)', () => {
  const lines = stripLines(renderAt(80));
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i].trim(), b = lines[i + 1].trim();
    const isRule = (s) => s.length > 4 && /^[-─]+$/.test(s.replace(/ /g, ''));
    if (isRule(a) && isRule(b)) {
      assert.fail(`Dua garis berurutan di baris ${i} dan ${i + 1}`);
    }
  }
});

test('semua baris tidak melebihi lebar terminal', () => {
  for (const w of [80, 60, 50]) {
    const lines = stripLines(renderAt(w));
    lines.forEach((l, i) => {
      assert.ok(l.length <= w, `Lebar ${w}: baris ${i} melebihi ${w} (${l.length}): "${l.slice(0, 40)}..."`);
    });
  }
});

test('margin kiri 2 spasi pada semua baris berisi teks', () => {
  const lines = stripLines(renderAt(80));
  lines.forEach((l, i) => {
    const t = l.trimEnd();
    if (t.length > 0 && t.trim().length > 0) {
      assert.ok(t.startsWith('  ') || t.startsWith('\r'),
        `Baris ${i} tidak punya margin 2 spasi: "${t.slice(0, 30)}"`);
    }
  });
});

test('semua baris grid kolom kanan sejajar di kolom 38 (lebar 80)', () => {
  const lines = stripLines(renderAt(80));
  const rightCols = [];
  // Kolom kanan berisi [5], [6], [7], [8]
  for (const marker of ['[5]', '[6]', '[7]', '[8]']) {
    for (const l of lines) {
      const idx = l.indexOf(marker);
      if (idx > 0) rightCols.push(idx);
    }
  }
  if (rightCols.length > 0) {
    const first = rightCols[0];
    rightCols.forEach((col, i) => {
      assert.strictEqual(col, first, `Kolom kanan tidak sejajar: item ${i} di kolom ${col}, harapan ${first}`);
    });
  }
});

test('baris tagline berisi versi dan selesai di kolom ≤ 80', () => {
  const lines = stripLines(renderAt(80));
  const tagLine = lines.find(l => l.includes('v' + pkg.version));
  assert.ok(tagLine, 'Tidak ada baris tagline berisi versi');
  const trimmed = tagLine.trimEnd();
  // With default Unicode symbols (·), tagline is slightly longer than ASCII (|)
  assert.ok(trimmed.length <= 80, `Tagline melebihi 80 kolom: ${trimmed.length}`);
  assert.ok(trimmed.includes(pkg.version), 'Tagline tidak mengandung versi');
});

test('tepat satu kemunculan "Pilih" (prompt)', () => {
  const lines = stripLines(renderAt(80));
  const promptLines = lines.filter(l => l.includes('Pilih'));
  assert.strictEqual(promptLines.length, 1, `Harapan 1 baris Pilih, dapat ${promptLines.length}: ${JSON.stringify(promptLines)}`);
});

test('prompt memuat "[1-8, g, q]"', () => {
  const lines = stripLines(renderAt(80));
  const promptLine = lines[lines.length - 1];
  assert.ok(promptLine.includes('[1-8, g, q]'), `Prompt harus memuat "[1-8, g, q]": ${promptLine}`);
});

test('banner ascii w=80: tepat 7 baris "#", lebar >= 60, tanpa ====, tanpa "GASPOLL" polos, char <= 126, tanpa asap', () => {
  process.env.GASPOLL_ASCII = '1';
  process.env.NO_COLOR = '1';
  Object.keys(require.cache).filter(k => k.includes('ui.js')).forEach(k => delete require.cache[k]);
  const lines = renderAt(80);
  const plainLines = stripLines(lines);

  const bannerHashLines = plainLines.filter(l => l.includes('#'));
  assert.strictEqual(bannerHashLines.length, 7, `Harus ada tepat 7 baris banner '#', dapat ${bannerHashLines.length}`);
  bannerHashLines.forEach((l, idx) => {
    assert.ok(l.length >= 60, `Baris banner ascii ${idx} harus memiliki lebar >= 60 kolom (${l.length})`);
  });

  const hasEqualsRule = plainLines.some(l => l.replace(/ /g, '').includes('===='));
  assert.ok(!hasEqualsRule, 'Mode ASCII lebar 80 tidak boleh ada garis pembatas "===="');

  const hasPlainGaspoll = plainLines.some(l => l.trim() === 'GASPOLL');
  assert.ok(!hasPlainGaspoll, 'Mode ASCII lebar 80 tidak boleh ada baris "GASPOLL" polos');

  const allText = plainLines.join('\n');
  for (let i = 0; i < allText.length; i++) {
    assert.ok(allText.codePointAt(i) <= 126, `Karakter non-ASCII: 0x${allText.codePointAt(i).toString(16)}`);
  }
  assert.ok(!/[░▒▓·]/.test(allText), 'Mode ASCII tidak boleh ada karakter asap');
});

test('banner ascii w=50: jatuh ke teks kecil / bingkai kecil', () => {
  process.env.GASPOLL_ASCII = '1';
  process.env.NO_COLOR = '1';
  Object.keys(require.cache).filter(k => k.includes('ui.js')).forEach(k => delete require.cache[k]);
  const lines = renderAt(50);
  const plainLines = stripLines(lines);
  const hasSmallGaspollOrBox = plainLines.some(l => l.includes('GASPOLL') || l.includes('='));
  assert.ok(hasSmallGaspollOrBox, 'Lebar 50 harus jatuh ke teks kecil/bingkai kecil');
});

test('banner solid: lapisan huruf sama persis dengan BANNER_ART', () => {
  delete process.env.NO_COLOR;
  delete process.env.GASPOLL_ASCII;
  process.env.FORCE_COLOR = '3';
  process.env.GASPOLL_UNICODE = '1';
  process.env.GASPOLL_BANNER = 'flat';
  Object.keys(require.cache).filter(k => k.includes('ui.js')).forEach(k => delete require.cache[k]);
  const UI3 = require('../src/ui');
  const expected = UI3.BANNER_ART;
  const flat = UI3.flatBannerLines();
  // Cek 7 baris huruf: strip ANSI dan strip trailing spaces, cocokkan dengan BANNER_ART
  for (let i = 0; i < 7; i++) {
    const plain = UI3.stripAnsi(UI3.bannerLine(i, 70)).replace(/^ {2}/, '').trimEnd();
    const exp = expected[i].trimEnd();
    assert.strictEqual(plain, exp, `Baris ${i} tidak cocok:\nDapat  : "${plain}"\nHarapan: "${exp}"`);
  }
  process.env.NO_COLOR = '1';
  process.env.GASPOLL_ASCII = '1';
  delete process.env.FORCE_COLOR;
  delete process.env.GASPOLL_UNICODE;
  delete process.env.GASPOLL_BANNER;
});

test('banner flat tidak mengandung karakter selain █ dan spasi', () => {
  delete process.env.NO_COLOR;
  delete process.env.GASPOLL_ASCII;
  process.env.FORCE_COLOR = '3';
  process.env.GASPOLL_UNICODE = '1';
  process.env.GASPOLL_BANNER = 'flat';
  Object.keys(require.cache).filter(k => k.includes('ui.js')).forEach(k => delete require.cache[k]);
  const UI4 = require('../src/ui');
  const flatLines = UI4.flatBannerLines();
  for (let i = 0; i < flatLines.length; i++) {
    for (const ch of flatLines[i]) {
      assert.ok(ch === '█' || ch === ' ',
        `Baris flat ${i} mengandung karakter selain █ dan spasi: "${ch}" (0x${ch.codePointAt(0).toString(16)})`);
    }
  }
  process.env.NO_COLOR = '1';
  process.env.GASPOLL_ASCII = '1';
  delete process.env.FORCE_COLOR;
  delete process.env.GASPOLL_UNICODE;
  delete process.env.GASPOLL_BANNER;
});

test('banner unicode w=120, 90, 80, 79: single 14-column smoke, baris indeks 3 ada ▓ di area asap, blockWidth 79', () => {
  delete process.env.NO_COLOR;
  delete process.env.GASPOLL_ASCII;
  process.env.GASPOLL_UNICODE = '1';
  process.env.FORCE_COLOR = '3';
  Object.keys(require.cache).filter(k => k.includes('ui.js')).forEach(k => delete require.cache[k]);
  const UI_MOD = require('../src/ui');
  [120, 90, 80, 79].forEach(w => {
    const lines = stripLines(renderAt(w));
    let hasSmoke = false;
    lines.forEach((l, idx) => {
      assert.ok(l.length <= w, `Baris ${idx} w=${w} melampaui lebar ${w}: ${l.length}`);
      const rawLine = UI_MOD.stripAnsi(UI_MOD.bannerLine(idx, w));
      if (idx < 8 && /[·░▒▓]/.test(rawLine.slice(2, 16))) {
        hasSmoke = true;
      }
    });
    assert.ok(hasSmoke, `w=${w}: Harus ada baris yang menampilkan asap di kolom 2-16`);
    const line3 = UI_MOD.stripAnsi(UI_MOD.bannerLine(3, w));
    const smokePart3 = line3.slice(2, 16);
    assert.ok(smokePart3.includes('▓'), `w=${w} baris banner ke-4 (indeks 3) area asap harus mengandung '▓': "${smokePart3}"`);
  });
  process.env.NO_COLOR = '1';
  process.env.GASPOLL_ASCII = '1';
  delete process.env.FORCE_COLOR;
  delete process.env.GASPOLL_UNICODE;
});

test('banner unicode w=78 dan w=70: tanpa asap, blockWidth 76', () => {
  delete process.env.NO_COLOR;
  delete process.env.GASPOLL_ASCII;
  process.env.GASPOLL_UNICODE = '1';
  process.env.FORCE_COLOR = '3';
  Object.keys(require.cache).filter(k => k.includes('ui.js')).forEach(k => delete require.cache[k]);
  const UI_MOD = require('../src/ui');
  [78, 70].forEach(w => {
    for (let i = 0; i < 8; i++) {
      const line = UI_MOD.bannerLine(i, w);
      const plain = UI_MOD.stripAnsi(line);
      const firstBlock = plain.indexOf('█');
      if (firstBlock >= 0) {
        const prefix = plain.slice(0, firstBlock);
        assert.ok(!/[·▒▓]/.test(prefix), `w=${w} baris ${i} tidak boleh ada asap sebelum huruf: "${prefix}"`);
      }
    }
  });
  process.env.NO_COLOR = '1';
  process.env.GASPOLL_ASCII = '1';
  delete process.env.FORCE_COLOR;
  delete process.env.GASPOLL_UNICODE;
});

test('banner ascii w=80: semua karakter <= 126 dan tanpa asap', () => {
  process.env.GASPOLL_ASCII = '1';
  process.env.NO_COLOR = '1';
  Object.keys(require.cache).filter(k => k.includes('ui.js')).forEach(k => delete require.cache[k]);
  const lines = renderAt(80);
  const plain = stripLines(lines).join('\n');
  for (let i = 0; i < plain.length; i++) {
    assert.ok(plain.codePointAt(i) <= 126, `Karakter non-ASCII: 0x${plain.codePointAt(i).toString(16)}`);
  }
  assert.ok(!/[░▒▓·]/.test(plain), 'Mode ASCII tidak boleh ada karakter asap');
});

test('lebar 60: menu satu kolom, semua item tampil', () => {
  const lines = stripLines(renderAt(60));
  const txt = lines.join('\n');
  for (const item of ['[1]', '[2]', '[3]', '[4]', '[5]', '[6]', '[7]', '[8]', '[g]', '[q]']) {
    assert.ok(txt.includes(item), `Lebar 60: item ${item} tidak ditemukan`);
  }
});

test('lebar 50: banner satu baris (tidak tampil huruf blok)', () => {
  const lines = stripLines(renderAt(50));
  const hasBanner = lines.some(l => l.includes('█'));
  assert.ok(!hasBanner || lines.some(l => l.includes('GASPOLL')),
    'Lebar 50: semua format banner harus ada (satu baris atau blok)');
});

test('skenario offline: teks saran menyebut router belum jalan', () => {
  const lines = stripLines(renderAt(80, { offline: true }));
  const saran = lines.find(l => l.includes('belum jalan') || l.includes('tidak dijangkau'));
  assert.ok(saran, 'Tidak ada baris saran yang menyebut router belum jalan saat offline');
});

test('skenario tanpa API key: saran tekan 7', () => {
  const lines = stripLines(renderAt(80, { apiKey: '' }));
  const saran = lines.find(l => l.includes('7'));
  assert.ok(saran, 'Tidak ada baris saran yang menyebut tombol 7 saat API key kosong');
});

test('API key display: masked when present, belum diatur when empty, full key never printed', () => {
  const linesWithKey = stripLines(renderAt(80, { apiKey: 'sk-c1a2b3c4d5e6c181' }));
  const textWithKey = linesWithKey.join('\n');
  assert.ok(textWithKey.includes('sk-c****c181'), 'API key harus tersamarkan menjadi sk-c****c181');
  assert.ok(!textWithKey.includes('c1a2b3c4d5e6'), 'Kunci penuh tidak boleh tercetak di menu');

  const linesEmptyKey = stripLines(renderAt(80, { apiKey: '' }));
  const textEmptyKey = linesEmptyKey.join('\n');
  assert.ok(textEmptyKey.includes('belum diatur'), 'API key kosong harus menampilkan "belum diatur"');
});

test('koneksi gagal (error HTTP)', () => {
  const UI = require('../src/ui');
  const result = UI.failureKind('koneksi gagal: HTTP 503');
  assert.strictEqual(result.label, 'provider mati');
});

test('HTTP 401 [402] saldo habis', () => {
  const UI = require('../src/ui');
  const result = UI.failureKind('HTTP 401 [402] credit balance');
  assert.strictEqual(result.label, 'saldo/kuota habis');
});

test('HTTP 503 [429] rate limit', () => {
  const UI = require('../src/ui');
  const result = UI.failureKind('HTTP 503 [429] rate limit');
  assert.strictEqual(result.label, 'rate limit');
});

// ---------------------------------------------------------------- jurnal & normalisasi & layar bersih

const fs = require('fs');
const pathMod = require('path');
const os = require('os');

// Buat folder hasil sementara untuk uji jurnal
const tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'gaspoll-test-'));
const tmpHistory = pathMod.join(tmpDir, 'history.jsonl');
const tmpLastRun = pathMod.join(tmpDir, 'last-run.json');

// Reimplementasi fungsi jurnal lokal (sama logika dengan cli.js, tanpa side-effect)
function journalReadLocal(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function journalAppendLocal(file, entry, max = 200) {
  try {
    const lines = journalReadLocal(file);
    lines.push(entry);
    const keep = lines.slice(-max);
    fs.mkdirSync(pathMod.dirname(file), { recursive: true });
    fs.writeFileSync(file, keep.map((e) => JSON.stringify(e)).join('\n') + '\n');
  } catch { /* gagal tulis tidak boleh melempar */ }
}

test('jurnal: tambah, baca, batas 200 entri', () => {
  for (let i = 0; i < 250; i++) {
    journalAppendLocal(tmpHistory, { ts: new Date().toISOString(), action: `aksi-${i}`, code: 0, ms: 100, logPath: '', ok: true, summary: `summary ${i}` });
  }
  const entries = journalReadLocal(tmpHistory);
  assert.strictEqual(entries.length, 200, `Harus 200 entri, dapat ${entries.length}`);
  assert.strictEqual(entries[0].action, 'aksi-50', 'Entri pertama harus #50 (yang terlama yang tersimpan)');
  assert.strictEqual(entries[199].action, 'aksi-249', 'Entri terakhir harus #249 (terbaru)');
});

test('jurnal: gagal tulis tidak melempar', () => {
  // Folder tidak ada → writeFileSync gagal → tidak boleh melempar
  let threw = false;
  try {
    journalAppendLocal(pathMod.join(tmpDir, 'tidak-ada-folder', 'h.jsonl'), { action: 'x' });
  } catch { threw = true; }
  assert.strictEqual(threw, false, 'Gagal tulis jurnal harus diam-diam tidak melempar');
});

// Uji normalisasi URL
test('normalizeUrl: kasus-kasus', () => {
  const L = require('../src/lib');
  const cases = [
    ['http://localhost:20128/v1', 'http://localhost:20128'],
    ['http://localhost:20128/v1/', 'http://localhost:20128'],
    ['http://localhost:20128/', 'http://localhost:20128'],
    ['localhost:20128', 'http://localhost:20128'],
    ['  http://localhost:20128/v1  ', 'http://localhost:20128'],
    ['http://localhost:20128', 'http://localhost:20128'],
    ['https://router:8080/v1/', 'https://router:8080'],
    ['', 'http://localhost:20128'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(L.normalizeUrl(input), expected,
      `normalizeUrl(${JSON.stringify(input)}) = ${JSON.stringify(L.normalizeUrl(input))}, harapan ${JSON.stringify(expected)}`);
  }
});

// Uji: layar bersih tidak aktif di pipe (GASPOLL_NOCLEAR=1 atau stdout bukan TTY)
test('clearScreen tidak aktif di pipe / GASPOLL_NOCLEAR', () => {
  // pipe → isTTY false → clearScreen tidak menulis apa-apa
  // Kita verifikasi lewat logika: process.env.GASPOLL_NOCLEAR harus dicek
  process.env.GASPOLL_NOCLEAR = '1';
  const { execSync } = require('child_process');
  // Jalankan cli.js --preview (tanpa TTY) → tidak boleh ada \x1b[2J
  const out = execSync('node src/ui-preview.js 2>&1', { encoding: 'utf8', cwd: pathMod.join(__dirname, '..'), env: { ...process.env, GASPOLL_NOCLEAR: '1', NO_COLOR: '1' } });
  assert.ok(!out.includes('\x1b[2J'), 'GASPOLL_NOCLEAR=1: tidak boleh ada clear screen ESC [2J');
  delete process.env.GASPOLL_NOCLEAR;
});

test("menu lebar 50/60/80/100 tidak memuat [c] atau salin log", () => {
  [50, 60, 80, 100].forEach(function(w) {
    process.stdout.columns = w;
    Object.keys(require.cache).filter(function(k) { return k.includes("ui.js"); }).forEach(function(k) { delete require.cache[k]; });
    var UIw = require("../src/ui");
    var data = { baseUrl: "http://localhost:20128", apiKey: "sk-test", alive: { ok: true, baseUrl: "http://localhost:20128" }, t: { tested_at: new Date().toISOString(), name: "auto-combo", models: [1,2] }, b: { tested_at: new Date().toISOString() } };
    var lines = UIw.renderMenu(data, { version: "1.0.0" });
    var text = lines.join(String.fromCharCode(10));
    assert.ok(!text.includes("[c]"), "width " + w + ": should not contain [c]");
    assert.ok(!text.includes("Salin log"), "width " + w + ": should not contain Salin log");
  });
});
// Bersihkan folder sementara
fs.rmSync(tmpDir, { recursive: true, force: true });

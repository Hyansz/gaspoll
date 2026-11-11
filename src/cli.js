#!/usr/bin/env node
'use strict';
/**
 * cli.js - menu interaktif 9Router Tools (dibuka oleh gaspoll.bat).
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const readline = require('readline');
const L = require('./lib');
const UI = require('./ui');
const { paginateViewLines } = require('./paging');
const { col } = L;

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const TEST = path.join(__dirname, 'test-9router.js');
const BENCH = path.join(__dirname, 'bench-9router.js');
const SHOW = path.join(__dirname, 'show-results.js');

let cfg = L.loadConfig();

function readJson(filename) {
  try {
    const filePath = L.inResults(filename);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- input

function readClipboard() {
  try {
    let args, cmd;
    if (process.platform === 'win32') {
      cmd = 'powershell';
      args = ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'];
    } else if (process.platform === 'darwin') {
      cmd = 'pbpaste'; args = [];
    } else {
      for (const [c, a] of [['wl-paste', ['-n']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['-b', '-o']]]) {
        try {
          const r = cp.spawnSync(c, a, { encoding: 'utf8', timeout: 1000, windowsHide: true });
          if (r.status === 0 && r.stdout) return r.stdout.replace(/\r/g, '').replace(/\n/g, '').trim();
        } catch { /* next */ }
      }
      return '';
    }
    const r = cp.spawnSync(cmd, args, { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return '';
    return r.stdout.replace(/\r/g, '').replace(/\n/g, '').trim();
  } catch { return ''; }
}

async function askInput(promptText, { secret = false } = {}) {
  const tty = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';
  if (!tty) return ask(promptText, { secret });

  return new Promise((resolve) => {
    let buf = '';
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      process.stdin.removeListener('keypress', onKey);
      try { process.stdin.setRawMode(false); } catch {}
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(result);
    };

    const onKey = (ch, key) => {
      if (!key) return;
      const seq = key.sequence || ch || '';

      if (key.name === 'return' || key.name === 'enter') {
        finish(buf.trim());
        return;
      }
      if ((key.name === 'c' && key.ctrl) || (key.name === 'd' && key.ctrl)) {
        if (buf.length === 0) { finish(null); return; }
        return;
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      if ((key.name === 'v' && key.ctrl) || (key.name === 'insert' && key.shift)) {
        const pasted = readClipboard();
        if (pasted) {
          buf += pasted;
          process.stdout.write(secret ? '*'.repeat(pasted.length) : pasted);
        }
        return;
      }
      if (seq.startsWith('\x1b') && seq.length > 1) return;
      if (seq.charCodeAt(0) < 32 || seq.charCodeAt(0) === 127) return;
      buf += seq;
      process.stdout.write(secret ? '*' : seq);
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(promptText);
    process.stdin.on('keypress', onKey);
  });
}

function ask(promptText, { secret = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    const done = (val) => { if (answered) return; answered = true; rl.close(); resolve(val); };
    rl.on('close', () => done(null));
    if (secret) {
      process.stdout.write(promptText);
      rl.setPrompt('');
      rl.prompt();
      rl.once('line', (ans) => { process.stdout.write('\n'); done(String(ans).trim()); });
    } else {
      rl.setPrompt(promptText);
      rl.prompt();
      rl.on('line', (ans) => done(String(ans).trim()));
    }
  });
}

const promptPrefix = () => '  ';

// ---------------------------------------------------------------- menjalankan script

function runScript(script, args) {
  return new Promise((resolve) => {
    const guard = () => {};
    process.on('SIGINT', guard);
    const uni = UI.supportsUnicode();
    // Build env for child: preserve parent's GASPOLL_UNICODE/ASCII if already set
    const childEnv = { ...process.env };
    // Only set Unicode/ASCII if not already in parent env (let parent decision propagate or use default)
    if (process.env.GASPOLL_UNICODE === undefined && process.env.GASPOLL_ASCII === undefined) {
      // Parent didn't explicitly set Unicode mode: use parent's detection
      childEnv.GASPOLL_UNICODE = uni ? '1' : '0';
      childEnv.GASPOLL_ASCII = uni ? '0' : '1';
    }
    // Always pass these config values
    childEnv.NINE_ROUTER_BASE_URL = cfg.baseUrl;
    childEnv.NINE_ROUTER_API_KEY = cfg.apiKey;
    childEnv.NINE_ROUTER_PASSWORD = cfg.password;
    childEnv.GASPOLL_FROM_MENU = '1';

    const child = cp.spawn(process.execPath, [script, ...args], {
      stdio: 'inherit',
      env: childEnv,
    });
    child.on('error', (e) => {
      process.removeListener('SIGINT', guard);
      console.log(col.red(`[!] Gagal menjalankan script: ${e.message}`));
      resolve(1);
    });
    child.on('close', (code) => {
      process.removeListener('SIGINT', guard);
      resolve(code === null ? 1 : code);
    });
  });
}

const cmdText = (script, args) => `node ${path.join('src', path.basename(script))} ${args.map((a) => (/[\s|&"]/.test(a) ? `"${a}"` : a)).join(' ')}`.trim();

async function runStep(script, args) {
  console.log('');
  if (process.env.GASPOLL_VERBOSE === '1') L.cmdLine('Perintah setara (bisa disalin):', cmdText(script, args));
  const code = await runScript(script, args);
  return code;
}

// ---------------------------------------------------------------- aksi & jurnal

const HISTORY = L.inResults('history.jsonl');

function journalWrite(entry) {
  try {
    const p = HISTORY;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
  } catch {}
}

function journalRead() {
  try {
    const lines = fs.readFileSync(HISTORY, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function returnToMenu() {
  L.clearScreen();
}

async function finishAction(actionName, code, startTime) {
  const dur = Date.now() - startTime;
  const success = code === 0;
  const s = UI.sym();
  const icon = success ? s.success : s.fail;

  let summaryText = '-';
  const lr = readJson('last-run.json');
  if (lr && lr.action === actionName && new Date(lr.written_at || 0).getTime() >= startTime) {
    summaryText = lr.summary || (lr.ok ? `${lr.passed} lolos` : 'gagal');
  } else {
    if (['Lihat hasil terakhir', 'Buka folder hasil'].includes(actionName)) {
      summaryText = 'dibuka';
    } else if (success) {
      summaryText = 'selesai';
    } else if (code === 130) {
      summaryText = 'dihentikan pengguna';
    } else {
      let failReason = `berhenti kode ${code}`;
      const log = L.lastLogPath();
      if (log && fs.existsSync(log)) {
        try {
          const content = fs.readFileSync(log, 'utf8');
          const lines = content.split(/\r?\n/).filter(l => l.includes('[!]') || l.includes('GAGAL') || l.includes('Error'));
          if (lines.length > 0) {
            failReason = lines[lines.length - 1].replace(/^#\s*/, '').trim().slice(0, 50);
          }
        } catch {}
      }
      const lr = readJson('last-run.json');
      if (lr && lr.passed > 0 && actionName === 'Test provider') {
        summaryText = `Tes selesai (${lr.passed} lolos), tetapi penyusunan combo gagal: ${failReason}. Benchmark dihentikan.`;
      } else {
        summaryText = failReason;
      }
    }
  }

  L.line('');
  L.line(`  ${icon}  ${actionName}: ${summaryText}`);
  L.line(`  [Enter] kembali ke menu ${s.mid} [g] riwayat & log`);

  journalWrite({
    action: actionName,
    ok: success,
    ts: new Date().toISOString(),
    ms: dur,
    summary: summaryText,
    reason: success ? '' : summaryText,
    logPath: L.lastLogPath(),
    code,
  });

  const ans = await ask(promptPrefix() + col.dim(`Pilih ${s.arrow} `));
  if (/^g/i.test(ans)) {
    await actionHistory();
  }
  returnToMenu();
}

async function ensureRouter() {
  const r = await L.checkRouter(cfg, 5000);
  if (r.ok) return true;
  L.line('');
  L.line(col.red(`  [!] 9Router tidak bisa dihubungi di ${cfg.baseUrl}`));
  L.line(`    ${r.reason}`);
  L.line('    Pastikan 9Router sudah jalan, lalu coba lagi.');
  await ask(promptPrefix() + col.dim('[Enter] kembali ke menu: '));
  L.line('');
  return false;
}

const TEST_ARGS = ['--name', 'auto-combo', '--timeout', '60'];

async function actionTest() {
  L.clearScreen();
  try { fs.unlinkSync(L.inResults('last-run.json')); } catch {}
  if (!(await ensureRouter())) { returnToMenu(); return; }
  const t0 = Date.now();
  const code = await runStep(TEST, [...TEST_ARGS, '--create']);
  await finishAction('Test provider', code, t0);
}

async function actionBench() {
  L.clearScreen();
  try { fs.unlinkSync(L.inResults('last-run.json')); } catch {}
  if (!(await ensureRouter())) { returnToMenu(); return; }
  const t0 = Date.now();
  const code = await runStep(BENCH, ['--create']);
  if (code === 130 || code !== 0) {
    L.line(col.yellow('  Dihentikan, combo tidak diubah.'));
  }
  await finishAction('Benchmark', code, t0);
}

async function actionBoth() {
  L.clearScreen();
  try { fs.unlinkSync(L.inResults('last-run.json')); } catch {}
  if (!(await ensureRouter())) { returnToMenu(); return; }
  const t0 = Date.now();
  console.log(col.bold('\nLANGKAH 1 dari 2: TEST PROVIDER'));
  let code = await runStep(TEST, TEST_ARGS);
  if (code !== 0) {
    const lr = readJson('last-run.json');
    if (lr && lr.passed > 0) {
      let failReason = 'error';
      const log = L.lastLogPath();
      if (log && fs.existsSync(log)) {
        try {
          const content = fs.readFileSync(log, 'utf8');
          const lines = content.split(/\r?\n/).filter(l => l.includes('[!]') || l.includes('GAGAL') || l.includes('Error'));
          if (lines.length > 0) {
            failReason = lines[lines.length - 1].replace(/^#\s*/, '').trim().slice(0, 50);
          }
        } catch {}
      }
      L.line(col.red(`  Tes selesai (${lr.passed} lolos), tetapi penyusunan combo gagal: ${failReason}. Benchmark dihentikan.`));
    } else {
      L.line(col.red('  Test gagal total atau tidak ada model lolos, benchmark dihentikan.'));
    }
    await finishAction('Jalankan semua', code, t0);
    return;
  }
  console.log(col.bold('\nLANGKAH 2 dari 2: BENCHMARK AGENT CODING'));
  code = await runStep(BENCH, ['--create']);
  if (code === 130 || code !== 0) {
    L.line(col.yellow('  Dihentikan, combo tidak diubah.'));
  }
  await finishAction('Jalankan semua', code, t0);
}

async function actionShow() {
  L.clearScreen();
  try { fs.unlinkSync(L.inResults('last-run.json')); } catch {}
  const t0 = Date.now();
  const code = await runScript(SHOW, []);
  await finishAction('Lihat hasil terakhir', code, t0);
}

// ---------------------------------------------------------------- layar Realtime bot guardian [8]
// Layar live ada di guardian.js (perantara di depan 9Router). Menu hanya menjalankannya.

const GUARD = path.join(__dirname, 'guardian.js');

async function actionGuardian() {
  L.clearScreen();
  if (!(await ensureRouter())) { returnToMenu(); return; }
  const t0 = Date.now();
  const code = await runScript(GUARD, []);
  await finishAction('Realtime bot guardian', code, t0);
}

async function actionRetest() {
  L.clearScreen();
  try { fs.unlinkSync(L.inResults('last-run.json')); } catch {}
  if (!(await ensureRouter())) { returnToMenu(); return; }
  const known = new Set();
  [readJson('combo-auto-combo.json'), readJson('bench-results.json')].forEach((d) =>
    (d?.results || []).forEach((r) => r.id && known.add(L.prefixOf(r.id)))
  );
  L.line('');
  if (known.size) L.line(col.dim(`  Provider yang pernah dites: ${[...known].filter(Boolean).sort().join(', ')}`));
  const only = await ask(promptPrefix() + 'Prefix provider yang diulang (contoh: gemini atau cf): ');
  if (!only) { returnToMenu(); return; }
  if (!/^[A-Za-z0-9_.,-]+$/.test(only)) {
    L.line(col.red('  [!] Prefix hanya boleh huruf, angka, titik, minus, underscore, dan koma.'));
    await ask(promptPrefix() + col.dim('[Enter] kembali: '));
    returnToMenu();
    return;
  }
  const match = await ask(promptPrefix() + 'Filter nama model (regex, contoh: claude|gpt-5|grok), kosongkan jika tidak perlu: ');
  if (match === null) { returnToMenu(); return; }
  L.line('');
  const args = ['--only', only, '--provider-parallel', '2', '--create'];
  if (match) args.push('--match', match);
  const t0 = Date.now();
  const code = await runStep(BENCH, args);
  if (code === 130 || code !== 0) {
    L.line(col.yellow('  Dihentikan, combo tidak diubah.'));
  }
  await finishAction('Ulangi benchmark', code, t0);
}

// ---------------------------------------------------------------- layar Riwayat & log [g]

function renderHistoryTable() {
  const entries = journalRead().slice(-10).reverse();
  const s = UI.sym();
  L.line('  ' + col.bold('RIWAYAT & LOG'));
  L.line('  ' + col.dim(s.dash.repeat(60)));
  if (!entries.length) {
    L.line('  ' + col.dim('Belum ada riwayat.'));
    L.line('  ' + col.dim(s.dash.repeat(60)));
    L.line('  ' + col.dim('Enter = kembali ke menu utama'));
    L.line('');
    return;
  }
  const NOW = Date.now();
  const fmtRel = (ts) => {
    const diff = NOW - new Date(ts).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'baru saja';
    if (m < 60) return `${m} mnt lalu`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} jam lalu`;
    return `${Math.floor(h / 24)} hari lalu`;
  };
  entries.forEach((e, i) => {
    const icon = e.ok ? s.success : s.fail;
    const sum = e.summary && e.summary !== '-' ? e.summary : (e.ok ? 'berhasil' : (e.reason || 'gagal'));
    const relTime = fmtRel(e.ts);
    const timeCol = relTime.padEnd(12);
    const actionCol = (e.action || '-').padEnd(16);
    const maxSummaryWidth = Math.max(20, (process.stdout.columns || 80) - 36);
    const truncatedSum = UI.truncate(sum, maxSummaryWidth);
    L.line(`  ${String(i + 1).padStart(2)}  ${col.dim(timeCol)}  ${UI.c.white(actionCol)}  ${icon} ${col.dim(truncatedSum)}`);
  });
  L.line('  ' + col.dim(s.dash.repeat(60)));
  L.line('  ' + col.dim(`Ketik nomor (1-${entries.length}) lalu Enter untuk membuka detail`));
  L.line('  ' + col.dim('Enter kosong atau b = kembali ke menu utama'));
  L.line('');
}

async function viewLogPaged(entry) {
  if (!entry.logPath || !fs.existsSync(entry.logPath)) {
    L.clearScreen();
    L.line('');
    L.line(col.dim('  File log tidak ditemukan (mungkin sudah dipangkas).'));
    await ask(promptPrefix() + col.dim('[Enter] kembali: '));
    L.clearScreen();
    return;
  }
  const rawContent = fs.readFileSync(entry.logPath, 'utf8');
  const lines = rawContent.split(/\r?\n/);

  const getSummaryView = () => {
    const idx = lines.findIndex(l => l.includes('Selesai dalam') || l.includes('RINGKASAN'));
    return idx >= 0 ? lines.slice(idx) : lines.slice(-40);
  };
  const getPassedView = () => lines.filter(l => l.includes('✔') || l.includes('/100') || l.includes('model') || l.includes('score'));
  const getFailedView = () => lines.filter(l => l.includes('✖') || l.includes('⚠') || l.includes('[!]') || l.includes('GAGAL') || l.includes('gagal'));

  let title = 'Ringkasan akhir';
  let viewLines = getSummaryView();
  let page = 0;

  for (;;) {
    L.clearScreen();
    L.line('');
    const s = UI.sym();
    L.line('  ' + col.bold(`DETAIL RIWAYAT: ${entry.action || 'aktivitas'} ${s.mid} ${L.fmtTime(entry.ts)} ${s.mid} ${L.fmtDur(entry.ms || 0)} ${s.mid} ${entry.ok ? s.success : s.fail}`));
    L.line('  ' + col.dim(`Ringkasan: ${entry.summary || (entry.ok ? 'berhasil' : 'gagal')}`));
    L.line('  ' + col.dim(s.dash.repeat(65)));
    L.line('  ' + col.dim('[1] Ringkasan akhir   [2] Yang lolos / ranking   [3] Gagal   [4] Log lengkap'));
    L.line('  ' + col.dim('[o] Buka file log     [c] Salin tampilan          [b] Kembali   [m] Menu utama'));
    L.line('  ' + col.dim(s.dash.repeat(65)));

    const pageSize = Math.max(5, (process.stdout.rows || 24) - 10);
    const pages = paginateViewLines(viewLines, pageSize);
    const totalPages = Math.max(1, pages.length);
    if (page >= totalPages) page = totalPages - 1;

    L.line('  ' + col.cyan(title + (totalPages > 1 ? ` (Hal ${page + 1}/${totalPages})` : '') + ':'));
    L.line('');

    if (!viewLines.length) {
      L.line('  ' + col.dim('(tidak ada)'));
    } else {
      const slice = pages[page] || [];
      slice.forEach(l => L.line('    ' + l));
    }
    L.line('');

    if (totalPages > 1) {
      if (page < totalPages - 1) {
        L.line(col.dim(`  Enter = halaman berikut (${page + 2}/${totalPages})`));
      } else {
        L.line(col.dim(`  Enter = kembali ke halaman 1 (putar)`));
      }
    }

    const ans = await ask(promptPrefix() + col.dim(`Pilih (1-4, o, c, b, m) ${s.pointer} `));
    if (ans === null) { L.clearScreen(); return 'menu'; }
    const sc = ans.trim().toLowerCase();
    if (sc === 'm') { L.clearScreen(); return 'menu'; }
    if (sc === 'b') {
      L.clearScreen();
      return;
    }
    if (sc === '') {
      if (totalPages > 1) {
        page++;
        if (page >= totalPages) page = 0;
      }
      continue;
    }
    if (sc === '1') { title = 'Ringkasan akhir'; viewLines = getSummaryView(); page = 0; continue; }
    if (sc === '2') { title = 'Yang lolos / ranking'; viewLines = getPassedView(); page = 0; continue; }
    if (sc === '3') { title = 'Yang gagal'; viewLines = getFailedView(); page = 0; continue; }
    if (sc === '4') { title = 'Log lengkap'; viewLines = lines; page = 0; continue; }
    if (/^o/.test(sc)) { L.openPath(entry.logPath); continue; }
    if (/^c/.test(sc)) {
      const fullText = viewLines.join('\n');
      const ok = await L.copyText(fullText);
      if (ok) {
        L.line(col.green(`  ${s.success} Disalin ${viewLines.length} baris ke clipboard.`));
      } else {
        const fallbackPath = L.inResults('salin-log.txt');
        try {
          fs.writeFileSync(fallbackPath, fullText, 'utf8');
          L.line(col.yellow(`  ${s.fail} Gagal menyalin ke clipboard; berkas disimpan di ${fallbackPath}`));
        } catch (e) {
          L.line(col.red(`  ${s.fail} Gagal menyalin dan menyimpan: ${e.message}`));
        }
      }
      await ask(promptPrefix() + col.dim('[Enter] lanjut: '));
      continue;
    }
    if (totalPages > 1) {
      page++;
      if (page >= totalPages) page = 0;
    }
  }
}

async function actionHistory() {
  for (;;) {
    L.clearScreen();
    L.line('');
    renderHistoryTable();
    const s = UI.sym();
    const a = await ask(promptPrefix() + col.dim(`Pilih ${s.arrow} `));
    if (a === null) { L.clearScreen(); return; }
    const ac = a.trim().toLowerCase();
    if (ac === '' || ac === 'b' || ac === 'q' || ac === 'm') {
      L.clearScreen();
      return;
    }
    const num = parseInt(ac, 10);
    const entries = journalRead().slice(-10).reverse();
    if (num >= 1 && num <= entries.length) {
      const res = await viewLogPaged(entries[num - 1]);
      if (res === 'menu') {
        L.clearScreen();
        return;
      }
    } else if (/^o/.test(ac)) {
      openLog();
    } else {
      L.line(col.yellow(`  Nomor tidak ada (1-${entries.length})`));
      await L.sleep(1000);
    }
  }
}

async function openLog() {
  const log = L.lastLogPath();
  if (!log) return L.line(col.yellow('  Belum ada log.'));
  L.line(L.openPath(log) ? col.dim(`  Membuka ${log}`) : col.yellow(`  Tidak bisa membuka otomatis. File: ${log}`));
}

// ---------------------------------------------------------------- layar Pengaturan [7]
async function actionSettings() {
  const s = UI.sym();
  L.clearScreen();
  L.line('');
  L.line('  ' + UI.c.whiteBold('PENGATURAN'));
  L.line('  ' + UI.c.gray('Enter = pertahankan nilai sekarang.'));
  L.line('');

  const ask3 = async (n, label, currentText, isSecret, hintExtra = '') => {
    const paddedLabel = UI.padTo(label, 18);
    const hint = isSecret ? '   ' + UI.c.gray('(ketikan tampil sebagai *, Ctrl+V bisa)') : '';
    L.line(`  ${n}/3  ${UI.c.gray(paddedLabel)}  ${UI.c.white(`[${currentText}]`)}${hint}${hintExtra}`);
    const ans = await askInput(`  ${UI.c.accent('›')} `, { secret: isSecret });
    L.line('');
    if (ans === null || ans === '') return null;
    return ans;
  };

  // 1/3 Alamat
  const url = await ask3('1', 'Alamat 9Router', cfg.baseUrl, false);
  if (url !== null && url.trim() !== '') {
    cfg.baseUrl = L.normalizeUrl(url.trim());
  }

  // 2/3 Password
  const pwInput = await ask3('2', 'Password dashboard', cfg.password ? '******' : '123456', true);
  if (pwInput !== null && pwInput.trim() !== '') {
    cfg.password = pwInput.trim();
  }

  // 3/3 API key
  const paddedKeyLabel = UI.padTo('API key', 18);
  L.line(`  3/3  ${UI.c.gray(paddedKeyLabel)}  ${UI.c.white(`[${cfg.apiKey ? L.maskKey(cfg.apiKey) : '(kosong)'}]`)}   ${UI.c.gray('(ketik auto untuk ambil otomatis dari dashboard)')}`);
  const keyInput = await askInput(`  ${UI.c.accent('›')} `, { secret: true });
  L.line('');
  if (keyInput !== null) {
    const trimmedKey = keyInput.trim();
    if (trimmedKey.toLowerCase() === 'auto') {
      L.line('  ' + col.dim('Mengambil API key aktif dari dashboard...'));
      try {
        const autoKey = await L.fetchActiveApiKey(cfg);
        cfg.apiKey = autoKey;
        L.line('  ' + col.green(`[OK] Berhasil mendapatkan API key: ${L.maskKey(autoKey)}`));
      } catch (e) {
        L.line('  ' + col.red(`[!] Gagal mengambil API key otomatis: ${e.message}`));
        L.line('  ' + col.yellow('Silakan masukkan API key secara manual:'));
        const manualKey = await askInput(`  ${UI.c.accent('›')} `, { secret: true });
        L.line('');
        if (manualKey !== null && manualKey.trim() !== '') {
          cfg.apiKey = manualKey.trim();
        }
      }
    } else if (trimmedKey !== '') {
      cfg.apiKey = trimmedKey;
    }
  }

  try {
    L.saveConfig(cfg);
    L.line(`  ${s.success} ${UI.c.whiteBold('Tersimpan di config.json')}`);
    L.line(`  ${UI.c.gray('Alamat    ')} ${UI.c.white(cfg.baseUrl)}`);
    L.line(`  ${UI.c.gray('API key   ')} ${UI.c.white(cfg.apiKey ? L.maskKey(cfg.apiKey) : '(kosong)')}`);
    L.line(`  ${UI.c.gray('Password  ')} ${UI.c.white(cfg.password ? '******' : '123456')}`);
    L.line('');
    const r = await L.checkRouter(cfg, 2500);
    if (r.ok) L.line(`  ${s.success} ${UI.c.whiteBold('Router terhubung')}`);
    else L.line(`  ${(s.fail || s.error)} ${UI.c.whiteBold('Router tidak terjangkau')}  ${UI.c.gray(r.reason || '')}`);
  } catch (e) {
    L.line(`  ${UI.sym().warn} Gagal menyimpan config.json: ${e.message}`);
  }

  L.line('');
  L.line(`  [Enter] kembali ke menu ${s.mid} [g] riwayat & log`);
  const ans = await ask(promptPrefix() + col.dim(`Pilih ${s.arrow} `));
  if (/^g/i.test(ans)) {
    await actionHistory();
  }
  returnToMenu();
}

// ---------------------------------------------------------------- main

async function main() {
  process.on('uncaughtException', (e) => {
    console.log(col.red(`\n[!] Error tak terduga: ${e.message}`));
    if (e.stack) console.log(col.dim(e.stack));
    process.exit(1);
  });

  if (process.argv.includes('--preview')) {
    require('./ui-preview').preview();
    return;
  }

  if (cfg.source === 'config.bat') {
    try { L.saveConfig(cfg); } catch {}
  }

  for (;;) {
    const alive = await L.checkRouter(cfg, 2500);
    const t = readJson('combo-auto-combo.json');
    const b = readJson('bench-results.json');
    const data = {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      alive,
      t,
      b,
    };
    const lines = UI.renderMenu(data, { version: pkg.version });
    lines.slice(0, lines.length - 1).forEach((ln) => L.line(ln));
    const ans = await ask(lines[lines.length - 1]);
    if (ans === null) break;
    L.line('');
    if (ans === '') continue;
    const k = ans.trim().toLowerCase();
    if (k === 'q') break;
    else if (k === '1') await actionTest();
    else if (k === '2') await actionBench();
    else if (k === '3') await actionBoth();
    else if (k === '4') await actionGuardian();
    else if (k === '5') await actionShow();
    else if (k === '6') {
      const s = UI.sym();
      L.clearScreen();
      L.line(`  Membuka ${L.RESULTS}`);
      L.openPath(L.RESULTS);
      L.line(`  [Enter] kembali ke menu ${s.mid} [g] riwayat & log`);
      const ans2 = await ask(promptPrefix() + col.dim(`Pilih ${s.arrow} `));
      if (/^g/i.test(ans2)) await actionHistory();
      returnToMenu();
    }
    else if (k === '7') await actionRetest();
    else if (k === '8') await actionSettings();
    else if (k === 'g' || k === 'l') await actionHistory();
    else if (k) L.line(UI.c.gray(`  Pilihan "${ans}" tidak dikenal. Ketik 1-8, g, atau q.`));
  }
  L.line('  Sampai jumpa.');
}

main();

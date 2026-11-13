const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const stripAnsi = (str) => str.replace(/\u001b\[[0-9;]*m/g, '');

function runFlowFull(inputStr, envExtra = {}) {
  const stubPath = path.join(os.tmpdir(), `gaspoll-clip-${Date.now()}.txt`);
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-res-'));
  const env = {
    GASPOLL_FORCE_TTY: '1',
    GASPOLL_NOCLEAR: '',
    GASPOLL_CLIP_STUB: stubPath,
    FORCE_COLOR: '1',
    GASPOLL_RESULTS: resultsDir,
    ...envExtra,
  };
  // Only set GASPOLL_UNICODE if ASCII mode is not explicitly requested
  if (envExtra.GASPOLL_ASCII !== '1') {
    env.GASPOLL_UNICODE = '1';
  }
  try {
    const res = cp.spawnSync(process.execPath, [CLI], {
      input: inputStr,
      encoding: 'utf8',
      env,
      timeout: 5000,
    });
    return { res, stubPath };
  } finally {
    try { fs.rmSync(resultsDir, { recursive: true, force: true }); } catch {}
  }
}

function runFlowStaged(lines, envExtra = {}, { idleMs = 400, stallMs = 6000, totalMs = 30000 } = {}) {
  const stubPath = path.join(os.tmpdir(), `gaspoll-clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-res-'));
  const env = { ...process.env, GASPOLL_FORCE_TTY: '1', GASPOLL_NOCLEAR: '', GASPOLL_CLIP_STUB: stubPath, FORCE_COLOR: '1', GASPOLL_RESULTS: resultsDir, ...envExtra };
  // Only set GASPOLL_UNICODE if ASCII mode is not explicitly requested
  if (envExtra.GASPOLL_ASCII !== '1') {
    env.GASPOLL_UNICODE = '1';
  }
  delete env.NO_COLOR;
  delete env.TERM;
  delete env.WT_SESSION;
  delete env.TERM_PROGRAM;
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [CLI], { env });
    let stdout = '', stderr = '', idx = 0, idleTimer = null, stallTimer = null;
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, totalMs);
    const feed = () => {
      clearTimeout(idleTimer); clearTimeout(stallTimer);
      if (child.exitCode !== null || child.killed) return;
      if (idx >= lines.length) { try { child.stdin.end(); } catch {} return; }
      try { child.stdin.write(lines[idx++] + '\n'); } catch { return; }
      stallTimer = setTimeout(feed, stallMs);
    };
    child.stdout.on('data', (d) => { stdout += d; clearTimeout(idleTimer); clearTimeout(stallTimer); idleTimer = setTimeout(feed, idleMs); });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => {
      clearTimeout(idleTimer); clearTimeout(stallTimer); clearTimeout(killer);
      try { fs.rmSync(resultsDir, { recursive: true, force: true }); } catch {}
      resolve({ res: { status, stdout, stderr }, stubPath });
    });
  });
}

test('flow ASCII: cek >', () => {
  const { res } = runFlowFull('q\n', { GASPOLL_ASCII: '1' });
  assert.strictEqual(res.status, 0);
  assert.ok(stripAnsi(res.stdout).includes('Pilih [1-8, g, q] >'));
});

test('flow a: q langsung', () => {
  const { res } = runFlowFull('q\n');
  assert.strictEqual(res.status, 0);
  assert.ok(stripAnsi(res.stdout).includes('Pilih [1-8, g, q] ›'));
});

test('flow b: g lalu Enter lalu q', () => {
  const { res } = runFlowFull('g\n\nq\n');
  assert.strictEqual(res.status, 0);
  assert.ok(stripAnsi(res.stdout).includes('RIWAYAT & LOG'));
  const parts = res.stdout.split('\x1b[2J');
  const lastPart = parts[parts.length - 1];
  assert.ok(!stripAnsi(lastPart).includes('RIWAYAT & LOG'), 'Riwayat masih muncul setelah clear terakhir');
  assert.ok(stripAnsi(lastPart).includes('Pilih [1-8, g, q] ›'));
});

test('flow c: g lalu b lalu q', () => {
  const { res } = runFlowFull('g\nb\nq\n');
  assert.strictEqual(res.status, 0);
});

test('flow 5.1: g, pilih entri 1, tekan b kembali ke daftar riwayat', async () => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-res-'));
  const histPath = path.join(resultsDir, 'history.jsonl');
  const logDir = path.join(resultsDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const dummyLog = path.join(logDir, 'test-dummy-51.log');
  fs.writeFileSync(dummyLog, 'Selesai dalam 5s\n✔ model-1 lolos\n', 'utf8');
  fs.writeFileSync(histPath, JSON.stringify({ action: 'Test51', ok: true, ts: new Date().toISOString(), summary: '1 lolos', logPath: dummyLog, code: 0 }) + '\n', 'utf8');

  const { res } = await runFlowStaged(['g', '1', 'b', 'q'], { GASPOLL_RESULTS: resultsDir });
  try { fs.rmSync(resultsDir, { recursive: true, force: true }); } catch {}
  assert.strictEqual(res.status, 0);
  assert.ok(res.stdout.includes('RIWAYAT & LOG'), 'Harus kembali ke tampilan daftar riwayat');
  assert.ok(res.stdout.includes('Ketik nomor (1-') || res.stdout.includes('Ketik nomor'), 'Petunjuk daftar riwayat harus tampil');
});

test('flow d & e: g, pilih entri 1, navigasi detail & log, salin (c), m (menu utama)', async () => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-res-'));
  const histPath = path.join(resultsDir, 'history.jsonl');
  const logDir = path.join(resultsDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const dummyLog = path.join(logDir, 'test-dummy.log');
  fs.writeFileSync(dummyLog, 'Selesai dalam 10s\n✔ model-1 lolos\n✖ model-2 gagal\n', 'utf8');
  fs.writeFileSync(histPath, JSON.stringify({ action: 'TestOld', ok: true, ts: new Date().toISOString(), summary: '✔ selesai', logPath: dummyLog, code: 0 }) + '\n', 'utf8');
  const fresh = { action: 'TestNew', ok: true, ts: new Date().toISOString(), summary: 'selesai', logPath: dummyLog, code: 0 };
  fs.appendFileSync(histPath, JSON.stringify(fresh) + '\n', 'utf8');

  const { res, stubPath } = await runFlowStaged(['g', '2', '1', '2', '3', '4', 'c', 'm', 'q'], { GASPOLL_RESULTS: resultsDir });
  try { fs.rmSync(resultsDir, { recursive: true, force: true }); } catch {}
  assert.strictEqual(res.status, 0);
  assert.ok(fs.existsSync(stubPath), 'File clipboard stub harus tercipta');
  const clipContent = fs.readFileSync(stubPath, 'utf8');
  assert.ok(clipContent.length > 0, 'Isi clipboard stub tidak boleh kosong');
});

test('flow 5.4 & 5.5 & A: history listing single icon, entry count in prompt, enter hints in detail', async () => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-res-'));
  const histPath = path.join(resultsDir, 'history.jsonl');
  const logDir = path.join(resultsDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  let content = '';
  for (let i = 1; i <= 5; i++) {
    const log = path.join(logDir, `log${i}.log`);
    const longLog = Array.from({length: 30}, (_, j) => `Baris log nomor ${j + 1}`).join('\n');
    fs.writeFileSync(log, longLog, 'utf8');
    const entry = { action: `Test${i}`, ok: true, ts: new Date().toISOString(), summary: i === 1 ? '✔ selesai' : 'selesai', logPath: log, code: 0 };
    content += JSON.stringify(entry) + '\n';
  }
  fs.writeFileSync(histPath, content);

  const { res } = await runFlowStaged(['g', '1', '', '', 'b', 'q'], { GASPOLL_RESULTS: resultsDir });
  try { fs.rmSync(resultsDir, { recursive: true, force: true }); } catch {}
  assert.strictEqual(res.status, 0);
  assert.ok(res.stdout.includes('Ketik nomor (1-5)'), 'Prompt harus memuat (1-5)');
  assert.ok(res.stdout.includes('Enter = halaman berikut') || res.stdout.includes('Enter = kembali'), 'Baris petunjuk Enter harus tampil di halaman detail');
});

test('flow f: g, entri tak ada (99), lalu Enter', async () => {
  const { res } = await runFlowStaged(['g', '99', '', 'q']);
  assert.strictEqual(res.status, 0);
  assert.ok(res.stdout.includes('Nomor tidak ada'));
});

test('flow riwayat kosong', () => {
  const { res } = runFlowFull('g\n\nq\n');
  assert.strictEqual(res.status, 0);
  assert.ok(res.stdout.includes('Belum ada riwayat.'));
});

test('flow j: EOF (stdin ditutup)', () => {
  const { res } = runFlowFull('');
  assert.strictEqual(res.status, 0);
});

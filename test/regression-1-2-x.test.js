'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const mockRouter = require('./mock-router.js');
const UI = require('../src/ui.js');
const L = require('../src/lib.js');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function stripAnsi(str) {
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}

function getResultsHashState() {
  const resultsDir = path.join(__dirname, '..', 'results');
  const files = [];
  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
      } else {
        const content = fs.readFileSync(full);
        const h = crypto.createHash('sha256').update(content).digest('hex');
        files.push({ path: path.relative(resultsDir, full), hash: h });
      }
    }
  }
  scan(resultsDir);
  return files;
}

const initialResultsState = getResultsHashState();

function runAsyncSpawn(scriptPath, args, env) {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [scriptPath, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ status: code, stdout, stderr }));
  });
}

test('Regression (f): results ASLI hash tidak berubah sebelum dan sesudah suite', () => {
  const currentState = getResultsHashState();
  assert.deepStrictEqual(currentState, initialResultsState, 'Hash results ASLI harus sama persis');
});

test('Regression (a): test-9router.js menjalankan alur nyata terhadap mock router tanpa --help (mode ASCII & Unicode)', async () => {
  await mockRouter.start();
  const testScript = path.join(__dirname, '..', 'src', 'test-9router.js');
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-test-a-'));
  const cfgPath = path.join(resultsDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${mockRouter.PORT}`, apiKey: 'sk-mock', password: '123456' }));

  try {
    for (const mode of ['ascii', 'unicode']) {
      const env = {
        ...process.env,
        GASPOLL_RESULTS: resultsDir,
        GASPOLL_CONFIG: cfgPath,
      };
      if (mode === 'ascii') {
        env.GASPOLL_ASCII = '1';
        delete env.GASPOLL_UNICODE;
      } else {
        env.GASPOLL_UNICODE = '1';
        delete env.GASPOLL_ASCII;
      }

      const res = await runAsyncSpawn(testScript, ['--name', 'auto-combo', '--only', 'gemini', '--create', '--timeout', '10'], env);
      assert.strictEqual(res.status, 0, `Mode ${mode} exit code harus 0`);
      const stdout = res.stdout || '';
      const stderr = res.stderr || '';
      assert.ok(stdout.includes('COMBO "auto-combo"'), `Mode ${mode} stdout harus memuat COMBO "auto-combo"`);
      assert.ok(!stdout.includes('is not defined'), `Mode ${mode} stdout tidak boleh ada "is not defined"`);
      assert.ok(!stdout.includes('[!] Error'), `Mode ${mode} stdout tidak boleh ada "[!] Error"`);
      assert.ok(!stderr.includes('is not defined'), `Mode ${mode} stderr tidak boleh ada "is not defined"`);
    }
  } finally {
    try { fs.rmSync(resultsDir, { recursive: true, force: true }); } catch {}
    await mockRouter.stop();
  }
});

test('Regression (b): Pesan kegagalan di cli.js (1.2.2) memuat "penyusunan combo gagal" dan "Tes gagal total"', () => {
  const cliCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  assert.ok(cliCode.includes('penyusunan combo gagal'), 'cli.js harus memuat pesan "penyusunan combo gagal"');
  assert.ok(cliCode.includes('Test gagal total atau tidak ada model lolos'), 'cli.js harus memuat pesan gagal total');
});

test('Regression (c): Header ringkas (1.2.3) Unicode dan ASCII w=80', () => {
  const data = {
    baseUrl: 'http://localhost:20128',
    apiKey: 'sk-c1a2b3c4d5e6c181',
    alive: { ok: true, baseUrl: 'http://localhost:20128' },
    t: { tested_at: new Date().toISOString(), name: 'auto-combo', models: [1, 2] },
    b: null,
  };

  for (const mode of ['unicode', 'ascii']) {
    const oldUni = process.env.GASPOLL_UNICODE;
    const oldAsc = process.env.GASPOLL_ASCII;
    if (mode === 'unicode') process.env.GASPOLL_UNICODE = '1';
    else process.env.GASPOLL_ASCII = '1';

    try {
      const lines = UI.renderMenu(data, { version: pkg.version, width: 80, compact: true }).map(stripAnsi);
      const taglineLine = lines.find(l => l.includes('Tes provider')) || '';
      assert.ok(taglineLine.length > 0, 'Tagline harus ada');
      assert.ok(!taglineLine.trim().startsWith('\u00b7') && !taglineLine.trim().startsWith('|'), 'Tagline tidak boleh diawali separator');
      assert.ok(taglineLine.includes('v' + pkg.version) || taglineLine.includes(pkg.version), 'Versi harus tampil');

      const dashLines = lines.filter(l => l.includes('\u2500') || l.includes('-')).length;
      assert.ok(dashLines >= 1, 'Harus ada garis pemisah rule');
    } finally {
      if (oldUni === undefined) delete process.env.GASPOLL_UNICODE; else process.env.GASPOLL_UNICODE = oldUni;
      if (oldAsc === undefined) delete process.env.GASPOLL_ASCII; else process.env.GASPOLL_ASCII = oldAsc;
    }
  }
});

test('Regression (d): Alur menu banner penuh pada rows=40 dan ringkas pada rows=24 / GASPOLL_COMPACT=1', async () => {
  const CLI = path.join(__dirname, '..', 'src', 'cli.js');
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-menu-'));

  const env40 = {
    ...process.env,
    GASPOLL_FORCE_TTY: '1',
    GASPOLL_NOCLEAR: '1',
    GASPOLL_UNICODE: '1',
    GASPOLL_RESULTS: resultsDir,
  };
  const child40 = cp.spawnSync(process.execPath, [CLI], {
    input: 'g\n\nq\n',
    env: env40,
    encoding: 'utf8',
    timeout: 10000,
  });
  const out40 = stripAnsi(child40.stdout || '');
  const bannerCount40 = (out40.match(/\u2588{3,}/g) || []).length;
  assert.ok(bannerCount40 >= 2, `Pada rows tinggi, kedua render harus memuat banner penuh (dapat ${bannerCount40})`);

  const envCompact = {
    ...env40,
    GASPOLL_COMPACT: '1',
  };
  const childCompact = cp.spawnSync(process.execPath, [CLI], {
    input: 'g\n\nq\n',
    env: envCompact,
    encoding: 'utf8',
    timeout: 10000,
  });
  const outCompact = stripAnsi(childCompact.stdout || '');
  const bannerCountCompact = (outCompact.match(/\u2588{3,}/g) || []).length;
  assert.strictEqual(bannerCountCompact, 0, 'GASPOLL_COMPACT=1 tidak boleh memuat banner art');

  try { fs.rmSync(resultsDir, { recursive: true, force: true }); } catch {}
});

test('Regression (e): gaspoll.bat tidak memuat GASPOLL_UNICODE dan memuat chcp 65001', () => {
  const batPath = path.join(__dirname, '..', 'gaspoll.bat');
  const content = fs.readFileSync(batPath, 'utf8');
  assert.ok(!content.includes('GASPOLL_UNICODE'), 'gaspoll.bat tidak boleh memuat GASPOLL_UNICODE');
  assert.ok(content.includes('chcp 65001'), 'gaspoll.bat harus memuat chcp 65001');
});

test('Regression (writeLastRun-i): tidak ada model lolos -> last-run.json ok=false, passed=0, combo=null', async () => {
  await mockRouter.start();
  mockRouter.setScenario('gemini/gemini-flash', '429');
  mockRouter.setScenario('gemini/gemini-flash-2', '429');
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-wl1-'));
  const cfgPath = path.join(resultsDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${mockRouter.PORT}`, apiKey: 'sk-mock', password: '123456' }));

  try {
    const testScript = path.join(__dirname, '..', 'src', 'test-9router.js');
    await runAsyncSpawn(testScript, ['--name', 'auto-combo', '--only', 'gemini', '--timeout', '5'], {
      ...process.env,
      GASPOLL_ASCII: '1',
      GASPOLL_RESULTS: resultsDir,
      GASPOLL_CONFIG: cfgPath,
    });

    const lastRunPath = path.join(resultsDir, 'last-run.json');
    assert.ok(fs.existsSync(lastRunPath), 'last-run.json harus tercipta');
    const data = JSON.parse(fs.readFileSync(lastRunPath, 'utf8'));
    assert.strictEqual(data.ok, false);
    assert.strictEqual(data.passed, 0);
    assert.strictEqual(data.combo, null);
  } finally {
    mockRouter.clearScenarios();
    try { fs.rmSync(resultsDir, { recursive: true, force: true }); } catch {}
    await mockRouter.stop();
  }
});

test('Regression (writeLastRun-ii): sukses -> last-run.json combo="auto-combo" dan nilai ok=true, passed > 0', async () => {
  await mockRouter.start();
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-wl2-'));
  const cfgPath = path.join(resultsDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${mockRouter.PORT}`, apiKey: 'sk-mock', password: '123456' }));

  try {
    const testScript = path.join(__dirname, '..', 'src', 'test-9router.js');
    await runAsyncSpawn(testScript, ['--name', 'auto-combo', '--only', 'gemini', '--create', '--timeout', '10'], {
      ...process.env,
      GASPOLL_ASCII: '1',
      GASPOLL_RESULTS: resultsDir,
      GASPOLL_CONFIG: cfgPath,
    });

    const lastRunPath = path.join(resultsDir, 'last-run.json');
    assert.ok(fs.existsSync(lastRunPath), 'last-run.json harus tercipta');
    const data = JSON.parse(fs.readFileSync(lastRunPath, 'utf8'));
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.combo, 'auto-combo');
    assert.ok(data.passed > 0);
    assert.ok(data.comboApplied > 0);
  } finally {
    try { fs.rmSync(resultsDir, { recursive: true, force: true }); } catch {}
    await mockRouter.stop();
  }
});

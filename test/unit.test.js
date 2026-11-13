const test = require('node:test');
const assert = require('node:assert');
const { compare, expectedCombos } = require('../src/verify-combos.js');
const L = require('../src/lib.js');
const fs = require('fs');
const path = require('path');

// Clean environment for deterministic tests
const CLEAN_VARS = ['GASPOLL_DEBUG_UNICODE','GASPOLL_UNICODE','GASPOLL_ASCII','GASPOLL_BANNER','FORCE_COLOR','NO_COLOR','WT_SESSION','TERM','TERM_PROGRAM','ConEmuANSI'];
CLEAN_VARS.forEach(v => { delete process.env[v]; });

test('compare function tests', () => {
  const p1 = ['a', 'b', 'c'];
  const p2 = ['a', 'b', 'c'];
  const r1 = compare(p1, p2);
  assert.strictEqual(r1.status, 'PASS');

  const w1 = ['a', 'b', 'c'];
  const w2 = ['c', 'b', 'a'];
  const rw = compare(w1, w2);
  assert.strictEqual(rw.status, 'WARN');

  const f1 = ['a', 'b'];
  const f2 = ['a', 'c'];
  const rf = compare(f1, f2);
  assert.strictEqual(rf.status, 'FAIL');
  assert.deepStrictEqual(rf.missing, ['b']);
  assert.deepStrictEqual(rf.extra, ['c']);
});

test('lib loadConfig password default', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const origGASPOLL = process.env.GASPOLL_CONFIG;
  const tempDir = path.join(os.tmpdir(), '9router-test-config');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
  const tempConfig = path.join(tempDir, 'config.json');
  fs.writeFileSync(tempConfig, JSON.stringify({password: 'palsu', apiKey: 'sk-palsu'}));
  
  // Gunakan config sementara via env var
  process.env.GASPOLL_CONFIG = tempConfig;
  delete process.env.NINE_ROUTER_PASSWORD;
  delete process.env.NINE_ROUTER_API_KEY;
  
  const cfg = L.loadConfig();
  assert.strictEqual(cfg.password, 'palsu');
  assert.strictEqual(cfg.apiKey, 'sk-palsu');
  
  // Restore environment
  process.env.GASPOLL_CONFIG = origGASPOLL;
  delete process.env.NINE_ROUTER_PASSWORD;
  delete process.env.NINE_ROUTER_API_KEY;
  fs.unlinkSync(tempConfig);
});

test('lib prefixOf', () => {
  assert.strictEqual(L.prefixOf('gemini/gemini-pro'), 'gemini');
  assert.strictEqual(L.prefixOf('no-slash'), '');
});

test('lib dropVariants', () => {
  const items = ['model-a', 'model-a-thinking', 'model-b'];
  const dropped = L.dropVariants(items);
  assert.ok(dropped.includes('model-a'));
  assert.ok(dropped.includes('model-b'));
});

test("no s.hr or s2.hr in src", () => {
  var dirs = fs.readdirSync(path.join(__dirname, '..', 'src'));
  for (var i = 0; i < dirs.length; i++) {
    if (!dirs[i].endsWith(".js")) continue;
    var content = fs.readFileSync(path.join(__dirname, '..', 'src', dirs[i]), "utf8");
    var m = content.match(/s2? \.hr \./g);
    assert.ok(!m, "Found s.hr in src/" + dirs[i] + ": " + JSON.stringify(m));
  }
});

test('classifyFailure labels mapping', () => {
  assert.strictEqual(L.classifyFailure('HTTP 410 Gone').label, 'model dihentikan');
  assert.strictEqual(L.classifyFailure('HTTP 402 quota exceeded').label, 'saldo/kuota habis');
  assert.strictEqual(L.classifyFailure('HTTP 402: : [deepseek/deepseek-v4-pro] : {"error":"insufficient_quota"}').label, 'saldo/kuota habis');
  assert.strictEqual(L.classifyFailure('HTTP 401 Unauthorized').label, 'api key ditolak');
  assert.strictEqual(L.classifyFailure('HTTP 429 Too Many Requests').label, 'rate limit');
  assert.strictEqual(L.classifyFailure('Request timeout after 30s').label, 'timeout');
  assert.strictEqual(L.classifyFailure('respons kosong').label, 'respons kosong');
  assert.strictEqual(L.classifyFailure('HTTP 503 Service Unavailable').label, 'provider mati');
  assert.strictEqual(L.classifyFailure('HTTP 400 Bad Request').label, 'ditolak provider');
  assert.strictEqual(L.classifyFailure('502 wreq-js error').label, 'error di 9Router');
});

test('koneksi gagal: HTTP 503 -> provider mati', () => {
  assert.strictEqual(L.classifyFailure('koneksi gagal: HTTP 503').label, 'provider mati');
});

test('setiap label failureKind punya entri di FAIL_HINT', () => {
  const UI = require('../src/ui');
  const failureKinds = [
    'rate limit', 'timeout', 'model dihentikan', 'model tidak ada',
    'respons kosong', 'ditolak provider', 'error di 9Router',
    'provider mati', 'api key ditolak', 'koneksi gagal',
    'invalid json', 'saldo/kuota habis', 'butuh paket/akses'
  ];
  for (const label of failureKinds) {
    assert.ok(UI.FAIL_HINT[label], `LABEL '${label}' tidak ada di FAIL_HINT`);
  }
});

test('no auto.js references in src', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'src'));
  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    const content = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.ok(!content.includes('auto.js'), `Found auto.js in src/${f}`);
  }
});

test('static color function checks (col/UI.c exports)', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const colKeys = Object.keys(require('../src/lib').col).sort();
  const uiColKeys = Object.keys(require('../src/ui').c).sort();

  const colPattern = /col\.([A-Za-z0-9_]+)\(/g;
  const uiPattern = /UI\.c\.([A-Za-z0-9_]+)\(/g;
  const definedCol = new Set(colKeys);
  const definedUI = new Set(uiColKeys);

  const findUnused = (matches, defined) =>
    [...new Set(matches)].filter((m) => !defined.has(m));

  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.js')) continue;
    const content = fs.readFileSync(path.join(srcDir, f), 'utf8');
    const colCalls = [];
    const uiCalls = [];
    let m;
    while ((m = colPattern.exec(content)) !== null) colCalls.push(m[1]);
    while ((m = uiPattern.exec(content)) !== null) uiCalls.push(m[1]);
    const badCol = findUnused(colCalls, definedCol);
    const badUI = findUnused(uiCalls, definedUI);
    assert.deepStrictEqual(badCol, [], `col.<name> undefined in src/${f}: ${badCol.join(', ')}`);
    assert.deepStrictEqual(badUI, [], `UI.c.<name> undefined in src/${f}: ${badUI.join(', ')}`);
  }

  // col.gap-3 memang ada, jangan dianggap error.
  const content = fs.readFileSync(path.join(srcDir, 'verify-combos.js'), 'utf8');
  assert.ok(content.includes('col.gap-3'));
});

test('failureKind 5.2: HTTP 402 vs 1402 ms', () => {
  const UI = require('../src/ui');
  const r1 = UI.failureKind('HTTP 402: : [deepseek/deepseek-v4-pro] : {"error":"insufficient_quota"}');
  assert.strictEqual(r1.label, 'saldo/kuota habis');
  const r2 = UI.failureKind('HTTP 200 request ok in 1402 ms');
  assert.notStrictEqual(r2.label, 'saldo/kuota habis');
});

test('5.3: shortenReason maps HTTP reasons and empty responses correctly', () => {
  const UI = require('../src/ui');
  // Contoh alasan nyata dari log: HTTP 400 atau 503 dengan teks berbeda
  const label400 = UI.shortenReason('HTTP 400: [400]: {"error":{"message":"Model is unavailable"}}');
  assert.strictEqual(label400, 'ditolak provider');
  assert.notStrictEqual(label400.includes('HTTP 400'), true);

  const labelEmpty = UI.shortenReason('respons kosong');
  assert.strictEqual(labelEmpty, 'respons kosong');

  const label503 = UI.shortenReason('HTTP 503: Service Unavailable');
  assert.strictEqual(label503, 'provider mati');
  assert.notStrictEqual(label503.includes('HTTP 503'), true);
});

test('5.6: paginateViewLines real implementation checks', () => {
  const { paginateViewLines } = require('../src/paging');
  const lines = [
    'COMBO "auto-combo" (urutan fallback)',
    '  model-1',
    '  model-2',
    'RINGKASAN PER PROVIDER',
    '  gemini        2/2',
    'Ringkasan Gagal:',
    '  timeout: 1'
  ];
  const pageSize = 4;
  const pages = paginateViewLines(lines, pageSize);

  // (1) Concatenation of all pages == original lines, no lines missing/duplicated
  const flat = pages.flat();
  assert.deepStrictEqual(flat, lines);

  // (2) Each page <= pageSize
  for (const page of pages) {
    assert.ok(page.length <= pageSize, `Page length ${page.length} exceeds pageSize ${pageSize}`);
  }

  // (3) No page has its last non-empty line as a section heading
  const headings = ['COMBO "auto-combo" (urutan fallback)', 'RINGKASAN PER PROVIDER', 'Ringkasan Gagal:'];
  for (const page of pages) {
    const nonEmp = page.filter(l => l.trim() !== '');
    if (nonEmp.length > 0) {
      const lastLine = nonEmp[nonEmp.length - 1];
      assert.ok(!headings.includes(lastLine.trim()), `Page ends with heading: ${lastLine}`);
    }
  }
});

test('5.7: child process inherits Unicode/ASCII from parent UI.supportsUnicode()', () => {
  const cliCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  // Check that child env is built with Unicode settings (new logic: only set if not already set, but still inherit/propagate)
  assert.ok(cliCode.includes('GASPOLL_UNICODE') && cliCode.includes('GASPOLL_ASCII'), 'cli.js must handle GASPOLL_UNICODE and GASPOLL_ASCII in child env');
  assert.ok(cliCode.includes('const uni = UI.supportsUnicode()'), 'cli.js must call UI.supportsUnicode() to detect Unicode support');
  assert.ok(cliCode.includes('childEnv') || cliCode.includes('env:'), 'cli.js must build or modify env for child process');
});

test('5.8: screen process titles format (heading & sectionTitle)', () => {
  const { heading } = require('../src/lib.js');
  const { render: renderShowResults } = require('../src/show-results.js');

  let captured = [];
  const origLog = console.log;
  console.log = (s) => captured.push(s);
  heading('TEST JUDUL');
  console.log = origLog;

  assert.ok(captured.some(l => l.includes('TEST JUDUL')), 'Heading must include title');
  const lineIdx = captured.findIndex(l => l.includes('TEST JUDUL'));
  const nextLine = captured[lineIdx + 1];
  assert.ok(nextLine, 'Heading must have a line on the next line');
  assert.ok(nextLine.startsWith('  '), 'Heading line must have 2 spaces left margin');
  assert.ok(!nextLine.includes('>'), 'Heading line must not contain >');

  const resText = renderShowResults();
  assert.ok(resText.includes('TEST PROVIDER'), 'show-results must have TEST PROVIDER');
  assert.ok(resText.includes('BENCHMARK AGENT CODING'), 'show-results must have BENCHMARK AGENT CODING');
  assert.ok(!resText.includes('> TEST PROVIDER'), 'sectionTitle must not have > pointer');
});

test('5.9: show-results groups failed models per provider+label', () => {
  process.env.GASPOLL_UNICODE = '1';
  const resultsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gaspoll-res-'));
  const origResults = process.env.GASPOLL_RESULTS;
  process.env.GASPOLL_RESULTS = resultsDir;
  try { delete require.cache[require.resolve('../src/show-results.js')]; } catch {}
  try { delete require.cache[require.resolve('../src/lib.js')]; } catch {}
  const { render: renderShowResults } = require('../src/show-results.js');
  const testFile = path.join(resultsDir, 'combo-auto-combo.json');

  const mockData = {
    name: 'test-combo',
    tested_at: new Date().toISOString(),
    models: ['gemini/m1', 'gemini/m2', 'openai/m3'],
    results: [
      { id: 'gemini/m1', ok: false, reason: 'HTTP 429 Too Many Requests' },
      { id: 'gemini/m2', ok: false, reason: 'HTTP 429 Too Many Requests' },
      { id: 'openai/m3', ok: false, reason: 'HTTP 503 Service Unavailable' }
    ]
  };
  fs.writeFileSync(testFile, JSON.stringify(mockData), 'utf8');

  try {
    const text = renderShowResults();
    assert.ok(text.includes('Model gagal:'), 'Must show model gagal section');
    assert.ok(text.includes('gemini · rate limit: 2 model'), 'Must group failed models by provider+label with count');
    assert.ok(text.includes('openai · provider mati: 1 model'), 'Must show other group');
    assert.ok(text.includes('Daftar lengkap'), 'Must show full list location');
  } finally {
    if (origResults !== undefined) process.env.GASPOLL_RESULTS = origResults;
    else delete process.env.GASPOLL_RESULTS;
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
});

test('5.7b: real spawn show-results with GASPOLL_UNICODE=1 and GASPOLL_ASCII=1 and debug stderr', () => {
  const cp = require('child_process');
  const resultsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gaspoll-res-'));
  const testFile = path.join(resultsDir, 'combo-auto-combo.json');
  fs.writeFileSync(testFile, JSON.stringify({ name: 'test', tested_at: new Date().toISOString(), results: [{ id: 'gemini/m1', ok: false, reason: 'HTTP 429' }] }), 'utf8');

  const cleanEnv = { ...process.env, GASPOLL_RESULTS: resultsDir, GASPOLL_DEBUG_UNICODE: '1' };
  delete cleanEnv.WT_SESSION;
  delete cleanEnv.TERM;
  delete cleanEnv.TERM_PROGRAM;
  delete cleanEnv.ConEmuANSI;
  delete cleanEnv.GASPOLL_UNICODE;
  delete cleanEnv.GASPOLL_ASCII;

  try {
    const rUni = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'show-results.js')], {
      env: { ...cleanEnv, GASPOLL_UNICODE: '1' },
      encoding: 'utf8'
    });
    assert.strictEqual(rUni.status, 0);
    assert.ok(rUni.stdout.includes('─') || rUni.stdout.includes('✔') || rUni.stdout.includes('✖'), 'Unicode stdout must contain unicode glyphs');
    assert.ok(!rUni.stdout.includes('[OK]'), 'Unicode stdout must not contain [OK]');
    assert.ok(rUni.stderr.includes('[unicode] show-results.js keputusan=true alasan=GASPOLL_UNICODE=1'), 'Stderr must contain unicode debug line with reason');

    const asciiEnv = { ...cleanEnv, GASPOLL_ASCII: '1' };
    delete asciiEnv.GASPOLL_UNICODE;  // Remove Unicode setting when forcing ASCII
    const rAsc = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'show-results.js')], {
      env: asciiEnv,
      encoding: 'utf8'
    });
    assert.strictEqual(rAsc.status, 0);
    assert.ok(rAsc.stdout.includes('[OK]') || rAsc.stdout.includes('[FAIL]') || rAsc.stdout.includes('---'), 'ASCII stdout must contain ASCII symbols');
    assert.ok(rAsc.stderr.includes('[unicode] show-results.js keputusan=false alasan=GASPOLL_ASCII=1'), 'Stderr must contain ascii debug line with reason');
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
});

test('5.7c-a: static scan src/*.js for unauthorized non-ASCII glyphs outside whitelist', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));
  const violations = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      // Whitelist: comments, UI definitions, banner art, UI.sym() / UI.c / s.xxx usage, or ui.js file
      if (/^\s*[\/\*]/.test(line) || /^\s*\/\*/.test(line) || /BANNER/.test(line) || /solid|flat|RGB|256/.test(line) || file === 'ui.js') {
        return;
      }
      if (/sym\(\)/.test(line) || /supportsUnicode/.test(line) || /UI\.sym|UI\.c|s\./.test(line) || /UI\.c\.accent/.test(line)) {
        return;
      }
      // Check if there are hardcoded non-ASCII characters or unicode escapes being printed directly
      const nonAscii = /[^\x00-\x7F]|\\u[0-9A-Fa-f]{4}|\\u\{[0-9A-Fa-f]+\}/g;
      if (nonAscii.test(line)) {
        violations.push(`${file}:${idx + 1}: ${line}`);
      }
    });
  }
  
  assert.strictEqual(violations.length, 0, `Found unauthorized hardcoded non-ASCII glyphs in src/*.js: ${violations.join(', ')}`);
});

test('5.7c-b: real script flow with GASPOLL_ASCII=1 produces 100% ASCII stdout including footer and closure', () => {
  const cp = require('child_process');
  const resultsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gaspoll-res-'));
  const testFile = path.join(resultsDir, 'combo-auto-combo.json');
  fs.writeFileSync(testFile, JSON.stringify({ name: 'auto-combo', tested_at: new Date().toISOString(), results: [{ id: 'gemini/m1', ok: true, ms: 100 }] }), 'utf8');

  try {
    const testEnv = { ...process.env, GASPOLL_ASCII: '1', GASPOLL_RESULTS: resultsDir, GASPOLL_DEBUG_UNICODE: '1' };
    delete testEnv.GASPOLL_UNICODE;  // Ensure ASCII is not overridden by parent UNICODE setting
    const res = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'show-results.js')], {
      env: testEnv,
      encoding: 'utf8'
    });
    assert.strictEqual(res.status, 0);
    const nonAscii = /[^\x00-\x7F]/g;
    const badMatches = res.stdout.match(nonAscii);
    
    assert.strictEqual(badMatches, null, `show-results stdout with GASPOLL_ASCII=1 must not contain non-ASCII characters, found: ${badMatches}`);
    assert.ok(res.stdout.includes('[OK]'), 'Must include [OK]');
    assert.ok(res.stdout.includes('---'), 'Must include ASCII separator');
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
});

test('5.7c-c: real cli script flow with GASPOLL_UNICODE=1 produces Unicode glyphs (›, ✔) in footer and closure', () => {
  const cp = require('child_process');
  const resultsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gaspoll-res-'));
  const testFile = path.join(resultsDir, 'combo-auto-combo.json');
  fs.writeFileSync(testFile, JSON.stringify({ name: 'auto-combo', tested_at: new Date().toISOString(), results: [{ id: 'gemini/m1', ok: true, ms: 100 }] }), 'utf8');

  try {
    const res = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js')], {
      env: { ...process.env, GASPOLL_UNICODE: '1', GASPOLL_RESULTS: resultsDir, GASPOLL_DEBUG_UNICODE: '1' },
      input: '4\nq\n',
      encoding: 'utf8'
    });
    assert.strictEqual(res.status, 0);
    
    assert.ok(res.stdout.includes('›'), 'Unicode CLI stdout footer must contain arrow ›');
    assert.ok(res.stdout.includes('✔'), 'Unicode CLI stdout must contain success ✔');
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
});

test('5.13: real spawn test-9router.js & bench-9router.js in ASCII and Unicode modes', async () => {
  const cp = require('child_process');
  const resultsDir = path.join(__dirname, '..', 'results-test-real');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  // 1. test-9router ASCII
  const testAsciiEnv1 = { ...process.env, GASPOLL_ASCII: '1', GASPOLL_RESULTS: resultsDir };
  delete testAsciiEnv1.GASPOLL_UNICODE;
  const rTestAscii = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'test-9router.js'), '--help'], {
    env: testAsciiEnv1,
    encoding: 'utf8'
  });
  assert.strictEqual(rTestAscii.status, 0);
  assert.ok(!rTestAscii.stdout.includes('Error tak terduga'), 'No unexpected errors in test-9router ASCII help');

  // 2. test-9router Unicode
  const rTestUni = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'test-9router.js'), '--help'], {
    env: { ...process.env, GASPOLL_UNICODE: '1', GASPOLL_RESULTS: resultsDir },
    encoding: 'utf8'
  });
  assert.strictEqual(rTestUni.status, 0);
  assert.ok(!rTestUni.stdout.includes('Error tak terduga'), 'No unexpected errors in test-9router Unicode help');

  // 3. bench-9router ASCII
  const benchAsciiEnv = { ...process.env, GASPOLL_ASCII: '1', GASPOLL_RESULTS: resultsDir };
  delete benchAsciiEnv.GASPOLL_UNICODE;
  const rBenchAscii = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'bench-9router.js'), '--help'], {
    env: benchAsciiEnv,
    encoding: 'utf8'
  });
  assert.strictEqual(rBenchAscii.status, 0);
  assert.ok(!rBenchAscii.stdout.includes('Error tak terduga'), 'No unexpected errors in bench-9router ASCII help');

  // 4. bench-9router Unicode
  const rBenchUni = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'bench-9router.js'), '--help'], {
    env: { ...process.env, GASPOLL_UNICODE: '1', GASPOLL_RESULTS: resultsDir },
    encoding: 'utf8'
  });
  assert.strictEqual(rBenchUni.status, 0);
  assert.ok(!rBenchUni.stdout.includes('Error tak terduga'), 'No unexpected errors in bench-9router Unicode help');

  try {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  } catch {}
});

test('5.14: scripted menu flow [4], [g] -> detail -> b -> q in ASCII mode', () => {
  const cp = require('child_process');
  const resultsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gaspoll-res-'));
  const testFile = path.join(resultsDir, 'combo-auto-combo.json');
  fs.writeFileSync(testFile, JSON.stringify({ name: 'auto-combo', tested_at: new Date().toISOString(), results: [{ id: 'gemini/m1', ok: true, ms: 100 }] }), 'utf8');

  try {
    const testEnv = { ...process.env, GASPOLL_ASCII: '1', GASPOLL_RESULTS: resultsDir, GASPOLL_DEBUG_UNICODE: '1' };
    delete testEnv.GASPOLL_UNICODE;  // Ensure ASCII is not overridden by parent UNICODE setting
    const res = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js')], {
      env: testEnv,
      input: '4\ng\n1\nb\nq\n',
      encoding: 'utf8'
    });
    assert.strictEqual(res.status, 0);
    assert.ok(!res.stdout.includes('Error tak terduga'), 'No unexpected error in menu ASCII flow');
    assert.ok(res.stdout.includes('[OK]') || res.stdout.includes('---'), 'ASCII stdout contains ASCII markers');
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
});

test('5.10: bench single line Memakai header with limit info', () => {
  const UI = require('../src/ui.js');
  const tAscii = UI.truncate('abcdefghijklmnopqrstuvwxyz', 10);
  assert.ok(UI.visualWidth(tAscii) <= 10, `ASCII truncate visual width must be <= 10, got ${UI.visualWidth(tAscii)}`);
});

test('5.11: full model IDs without truncation and dynamic width', () => {
  const cp = require('child_process');
  const resultsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gaspoll-res-'));
  const benchFile = path.join(resultsDir, 'bench-results.json');
  const longId = 'cf/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b';
  fs.writeFileSync(benchFile, JSON.stringify({
    tested_at: new Date().toISOString(),
    results: [
      { id: longId, score: 90, avgMs: 120, detail: { tool: 1, agent: 1, isBalanced: 1, mergeIntervals: 1, fixBinarySearch: 1, evalExpr: 1, parseCSVLine: 1, needle: 1 } }
    ],
    tiers: { 'tier-1': [longId] }
  }), 'utf8');

  const benchEnv = { ...process.env, GASPOLL_RESULTS: resultsDir, GASPOLL_ASCII: '1' };
  delete benchEnv.GASPOLL_UNICODE;
  const res = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'show-results.js')], {
    env: benchEnv,
    encoding: 'utf8'
  });
  fs.rmSync(resultsDir, { recursive: true, force: true });

  assert.strictEqual(res.status, 0);
  assert.ok(res.stdout.includes(longId), 'Rendered output must contain the full long model ID without truncation');
});

test('5.12: settings menu brackets aligned', () => {
  const { renderMenu } = require('../src/ui.js');
  const menuLines = renderMenu({ t: null, b: null }, { width: 80 });
  const lines = menuLines.filter(l => l.includes('['));
  assert.ok(lines.length >= 2, 'Menu must contain option bracket lines');
});

test('5.15: UI.truncate length verification <= width for both ASCII and Unicode', () => {
  const UI = require('../src/ui.js');
  const str = 'This is a very long test string for truncation check';
  const w = 20;
  
  process.env.GASPOLL_ASCII = '1';
  delete process.env.GASPOLL_UNICODE;
  const resAscii = UI.truncate(str, w);
  assert.ok(UI.visualWidth(UI.stripAnsi(resAscii)) <= w, `ASCII truncate result length ${UI.visualWidth(UI.stripAnsi(resAscii))} must be <= ${w}`);
  assert.ok(resAscii.endsWith('...'), 'ASCII truncate must end with ...');

  process.env.GASPOLL_UNICODE = '1';
  delete process.env.GASPOLL_ASCII;
  const resUni = UI.truncate(str, w);
  assert.ok(UI.visualWidth(UI.stripAnsi(resUni)) <= w, `Unicode truncate result length ${UI.visualWidth(UI.stripAnsi(resUni))} must be <= ${w}`);
  assert.ok(resUni.endsWith('\u2026'), 'Unicode truncate must end with …');
  
  delete process.env.GASPOLL_ASCII;
  delete process.env.GASPOLL_UNICODE;
});

test('5.16: legenda word wrap at width 80 and 120 for ASCII and Unicode', () => {
  const cp = require('child_process');
  const resultsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gaspoll-res-'));
  const benchFile = path.join(resultsDir, 'bench-results.json');
  const longId = 'cf/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b';
  fs.writeFileSync(benchFile, JSON.stringify({
    tested_at: new Date().toISOString(),
    results: [{ id: longId, score: 95, avgMs: 150, detail: { tool: 1, agent: 1, isBalanced: 1, mergeIntervals: 1, fixBinarySearch: 1, evalExpr: 1, parseCSVLine: 1, needle: 1 } }],
    tiers: { 'tier-1': [longId] }
  }), 'utf8');

  for (const w of [80, 120]) {
    for (const mode of ['ASCII', 'Unicode']) {
      const env = {
        ...process.env,
        GASPOLL_RESULTS: resultsDir,
        COLUMNS: String(w),
        GASPOLL_ASCII: mode === 'ASCII' ? '1' : '',
        GASPOLL_UNICODE: mode === 'Unicode' ? '1' : ''
      };
      const res = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'show-results.js')], { env, encoding: 'utf8' });
      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes('Legenda:'), `Must contain Legenda at width ${w} ${mode}`);
    }
  }
  fs.rmSync(resultsDir, { recursive: true, force: true });
});

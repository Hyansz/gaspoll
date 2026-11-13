const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

test('openPath robustness on non-win32 platforms without tools', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-test-open-'));
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  const origPath = process.env.PATH;
  process.env.PATH = tmpDir; // empty path so xdg-open doesn't exist

  delete require.cache[require.resolve('../src/lib')];
  const L = require('../src/lib');
  const res = L.openPath(tmpDir);
  assert.strictEqual(res, true, 'openPath should return true without throwing');

  await new Promise(r => setTimeout(r, 500));

  process.env.PATH = origPath;
  Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('copyText fallback on non-win32 platforms without clipboard tools', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaspoll-test-clip-'));
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  const origPath = process.env.PATH;
  process.env.PATH = tmpDir;
  const origResults = process.env.GASPOLL_RESULTS;
  process.env.GASPOLL_RESULTS = tmpDir;

  delete require.cache[require.resolve('../src/lib')];
  const L = require('../src/lib');
  const ok = await L.copyText('halo dunia');
  assert.strictEqual(ok, false, 'copyText should resolve false when no tools available');

  const logFile = path.join(tmpDir, 'salin-log.txt');
  assert.strictEqual(fs.existsSync(logFile), true, 'salin-log.txt fallback should be created');
  assert.strictEqual(fs.readFileSync(logFile, 'utf8'), 'halo dunia');

  process.env.GASPOLL_RESULTS = origResults;
  process.env.PATH = origPath;
  Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('supportsUnicode locale detection on non-win32 platforms', () => {
  delete require.cache[require.resolve('../src/ui')];
  const UI = require('../src/ui');
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

  const check = (envVals) => {
    const origEnv = { ...process.env };
    delete process.env.WT_SESSION;
    delete process.env.TERM_PROGRAM;
    delete process.env.ConEmuANSI;
    delete process.env.VSCODE_PID;
    delete process.env.GASPOLL_UNICODE;
    delete process.env.GASPOLL_ASCII;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    process.env.TERM = 'linux'; // terminal 'linux' bypasses TERM check, falling back to LC/LANG
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    delete process.env.LANG;
    Object.assign(process.env, envVals);
    const res = UI.supportsUnicode();
    process.env = origEnv;
    return res;
  };

  assert.strictEqual(check({ LC_ALL: 'en_US.UTF-8' }), true);
  assert.strictEqual(check({ LANG: 'en_US.UTF-8' }), true);
  assert.strictEqual(check({ LC_ALL: 'C', LANG: 'en_US.UTF-8' }), false);
  assert.strictEqual(check({ LANG: 'C' }), false);
  assert.strictEqual(check({}), false);

  Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
});

test('gaspoll.sh script checks version and execs cli.js', () => {
  const p = path.join(__dirname, '..', 'gaspoll.sh');
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.includes('-lt 18'), 'gaspoll.sh must check node version (-lt 18)');
  assert.ok(content.includes('exec node src/cli.js'), 'gaspoll.sh must exec cli.js');
  const lines = content.split(/\r?\n/);
  assert.strictEqual(lines[0], '#!/usr/bin/env sh');
  const raw = fs.readFileSync(p);
  for (let i = 0; i < raw.length; i++) {
    assert.notStrictEqual(raw[i], 0x0d, 'No CRLF allowed in gaspoll.sh');
  }
});

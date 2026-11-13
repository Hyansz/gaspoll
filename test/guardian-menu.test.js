'use strict';
/**
 * Menu [8] (Realtime bot guardian) harus tampil di menu, ikut di prompt [1-8], dan tersambung ke guardian.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.NO_COLOR = '1';
const UI = require('../src/ui.js');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const data = { baseUrl: 'http://localhost:20128', apiKey: 'sk-abcdefgh1234', alive: { ok: true }, t: null, b: null };

for (const width of [60, 80, 100]) {
  test(`menu lebar ${width}: ada pilihan [8] Realtime bot guardian dan prompt [1-8, g, q]`, () => {
    const lines = UI.renderMenu(data, { width, compact: true }).map(UI.stripAnsi);
    const all = lines.join('\n');
    assert.ok(/\[8\] Realtime bot guardian/.test(all), 'item [8] tidak tampil');
    assert.ok(all.includes('[1-8, g, q]'), 'prompt harus [1-8, g, q]');
    // Ditulis terpisah agar skrip penggantian "1-7" -> "1-8" tidak mengubah pemeriksaan ini.
    assert.ok(!all.includes('[1-' + '7, g, q]'), 'prompt lama [1-7] tidak boleh muncul');
    lines.forEach((l) => assert.ok(UI.visualWidth(l) <= width, `baris melebihi ${width}: ${l}`));
  });
}

test('cli.js: pilihan 8 menjalankan guardian.js lewat runScript, dan pesan pilihan tidak dikenal menyebut 1-8', () => {
  const cli = read('src/cli.js');
  assert.match(cli, /else if \(k === '8'\) await actionGuardian\(\);/);
  assert.match(cli, /const GUARD = path\.join\(__dirname, 'guardian\.js'\);/);
  assert.match(cli, /runScript\(GUARD, \[\]\)/);
  assert.match(cli, /Ketik 1-8, g, atau q\./);
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'guardian.js')), 'src/guardian.js tidak ada');
});

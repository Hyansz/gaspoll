#!/usr/bin/env node
'use strict';
/**
 * ui-preview.js - pratinjau tampilan menu utama GASPOLL (data palsu, tanpa router).
 *
 *   node src/cli.js --preview                          (keadaan normal)
 *   node src/cli.js --preview --scenario offline
 *   node src/cli.js --preview --scenario no-key
 *   node src/cli.js --preview --scenario no-test
 *   node src/cli.js --preview --width 60
 *   node src/cli.js --preview --width 50
 *   node src/cli.js --preview --ascii
 *
 * Opsi: --scenario <offline|no-key|no-test|normal>, --width <n>, --ascii/--unicode.
 * TIDAK memanggil router dan TIDAK menulis file hasil.
 */

const fs = require('fs');
const path = require('path');
const L = require('./lib');
const UI = require('./ui');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// ---------------------------------------------------------------- parse opsi pratinjau

const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const hasFlag = (n) => args.includes(`--${n}`);

const scenario = argVal('scenario', 'normal');
const previewWidth = Number(argVal('width', 0)) || 0;
if (hasFlag('ascii')) process.env.GASPOLL_ASCII = '1';
if (hasFlag('unicode')) process.env.GASPOLL_UNICODE = '1';

// ---------------------------------------------------------------- data palsu

function fakeData() {
  const base = {
    alive: { ok: true, baseUrl: 'http://localhost:20128', reason: '' },
    apiKey: 'dummy-key-sample',
    t: { tested_at: new Date(Date.now() - 2 * 3600e3).toISOString(), name: 'auto-combo', models: 13 },
    b: { tested_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
  };
  switch (scenario) {
    case 'offline':
      return { ...base, alive: { ok: false, baseUrl: 'http://localhost:20128', reason: '' }, t: null, b: null };
    case 'no-key':
      return { ...base, apiKey: '' };
    case 'no-test':
      return { ...base, t: null, b: null };
    default:
      return base;
  }
}

// ---------------------------------------------------------------- saran (prioritas dari atas)

function suggest(alive, t, b, apiKey) {
  if (!alive.ok) return { key: null, text: '9Router belum jalan di localhost:20128. Jalankan dulu, lalu tekan Enter.' };
  if (!apiKey) return { key: '7', text: 'API key belum diisi: tekan 7.' };
  if (!t) return { key: '1', text: 'Saran: tekan 1 (belum pernah tes provider)' };
  if (!b || (t.tested_at && b.tested_at && new Date(t.tested_at) > new Date(b.tested_at))) {
    return { key: '2', text: !b ? 'Saran: tekan 2 (belum pernah benchmark)' : 'Saran: tekan 2 (tes lebih baru dari benchmark)' };
  }
  return { key: '4', text: 'Saran: tekan 4 untuk melihat hasil terakhir' };
}

// ---------------------------------------------------------------- render menu

function preview() {
  const data = fakeData();
  const lines = UI.renderMenu({
    baseUrl: data.alive.baseUrl,
    apiKey: data.apiKey,
    alive: data.alive,
    t: data.t,
    b: data.b,
  }, { version: pkg.version, width: previewWidth || undefined });
  lines.forEach((ln) => L.line(ln));
}

module.exports = { preview };

if (require.main === module) {
  preview();
}

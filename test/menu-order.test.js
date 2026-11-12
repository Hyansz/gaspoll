'use strict';
/**
 * Urutan menu utama: tombol 1-8 berurutan. Dua kolom: UTAMA berisi 1-4 dan ALAT berisi 5-8 (dibaca dari atas ke bawah),
 * lalu satu baris kosong, lalu [g] di kolom kiri dan [q] di kolom kanan.
 * Satu kolom (terminal sempit): UTAMA 1-4, lalu ALAT 5-8, lalu g dan q.
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.NO_COLOR = '1';
const UI = require('../src/ui.js');

const data = { baseUrl: 'http://localhost:20128', apiKey: 'sk-abcdefgh1234', alive: { ok: true }, t: null, b: null };
const menuLines = (width) => UI.renderMenu(data, { width, compact: true }).map(UI.stripAnsi);

// Posisi kolom tiap tombol [k] pada tiap baris: { k: { row, col } }
function keyPositions(lines) {
  const pos = {};
  lines.forEach((l, row) => {
    for (const m of l.matchAll(/\[(\d|g|q)\]/g)) {
      if (!(m[1] in pos)) pos[m[1]] = { row, col: m.index };
    }
  });
  return pos;
}

for (const width of [80, 100]) {
  test(`menu dua kolom (lebar ${width}): kiri 1-4, kanan 5-8, urut dari atas ke bawah`, () => {
    const lines = menuLines(width);
    const pos = keyPositions(lines);
    const head = lines.find((l) => /UTAMA/.test(l));
    assert.ok(head && /ALAT/.test(head), 'judul UTAMA dan ALAT harus satu baris');
    assert.ok(!lines.some((l) => /PROSES|HASIL & ALAT/.test(l)), 'judul lama tidak boleh muncul');
    const split = head.indexOf('ALAT');
    for (const k of ['1', '2', '3', '4']) assert.ok(pos[k].col < split, `[${k}] harus di kolom kiri`);
    for (const k of ['5', '6', '7', '8']) assert.ok(pos[k].col >= split, `[${k}] harus di kolom kanan`);
    for (let i = 1; i < 4; i++) assert.ok(pos[String(i)].row < pos[String(i + 1)].row, `[${i}] harus di atas [${i + 1}]`);
    for (let i = 5; i < 8; i++) assert.ok(pos[String(i)].row < pos[String(i + 1)].row, `[${i}] harus di atas [${i + 1}]`);
    // baris yang sama: 1 dengan 5, 2 dengan 6, 3 dengan 7, 4 dengan 8
    for (let i = 1; i <= 4; i++) assert.strictEqual(pos[String(i)].row, pos[String(i + 4)].row, `[${i}] dan [${i + 4}] harus sebaris`);
    // satu baris kosong, lalu [g] di kolom kiri dan [q] di kolom kanan (sejajar dengan [5]-[8])
    assert.strictEqual(lines[pos['4'].row + 1].trim(), '', 'harus ada satu baris kosong setelah baris [4] dan [8]');
    assert.strictEqual(pos.g.row, pos['4'].row + 2, '[g] harus tepat di bawah baris kosong');
    assert.strictEqual(pos.q.row, pos.g.row, '[g] dan [q] harus sebaris');
    assert.ok(pos.g.col < split, '[g] harus di kolom kiri');
    assert.strictEqual(pos.q.col, pos['5'].col, '[q] harus sejajar dengan kolom kanan ([5]-[8])');
    assert.strictEqual(pos.g.col, pos['1'].col, '[g] harus sejajar dengan kolom kiri ([1]-[4])');
    lines.forEach((l) => assert.ok(UI.visualWidth(l) <= width, `baris melebihi ${width}: ${l}`));
  });
}

test('menu satu kolom (lebar 60): 1 sampai 8 berurutan, lalu g dan q, dengan judul UTAMA dan ALAT sekali saja', () => {
  const lines = menuLines(60);
  const order = [];
  lines.forEach((l) => { for (const m of l.matchAll(/\[(\d|g|q)\]/g)) order.push(m[1]); });
  assert.deepStrictEqual(order.slice(0, 10), ['1', '2', '3', '4', '5', '6', '7', '8', 'g', 'q']);
  assert.strictEqual(lines.filter((l) => l.trim() === 'UTAMA').length, 1, 'judul UTAMA harus sekali dan sendirian');
  assert.strictEqual(lines.filter((l) => l.trim() === 'ALAT').length, 1, 'judul ALAT harus sekali dan sendirian');
  const iU = lines.findIndex((l) => l.trim() === 'UTAMA');
  const iA = lines.findIndex((l) => l.trim() === 'ALAT');
  const p = keyPositions(lines);
  assert.ok(iU < p['1'].row && p['4'].row < iA && iA < p['5'].row, 'tombol 1-4 di bawah UTAMA, 5-8 di bawah ALAT');
  lines.forEach((l) => assert.ok(UI.visualWidth(l) <= 60, `baris melebihi 60: ${l}`));
});

test('label dan tombol menu tidak berubah (hanya urutan yang berubah)', () => {
  const all = menuLines(100).join('\n');
  for (const label of [
    '[1] Tes provider & buat combo', '[2] Benchmark agent coding', '[3] Tes + benchmark berurutan',
    '[4] Lihat hasil terakhir', '[5] Buka folder hasil', '[6] Ulangi benchmark 1 provider',
    '[7] Pengaturan', '[8] Realtime bot guardian', '[g] Riwayat & log', '[q] Keluar',
  ]) assert.ok(all.includes(label), `hilang: ${label}`);
  assert.ok(all.includes('[1-8, g, q]'), 'prompt [1-8, g, q] harus tetap ada');
});

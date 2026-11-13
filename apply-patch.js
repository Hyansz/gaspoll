#!/usr/bin/env node
'use strict';
/**
 * apply-patch.js: menerapkan tambalan berbasis anchor, aman terhadap CRLF/LF dan BOM.
 *
 * Pakai (dari akar repo):
 *   node apply-patch.js <berkas-tambalan> [--check]
 *
 * Format berkas tambalan:
 *   @@FILE src/lib.js
 *   @@OLD
 *   (teks lama, persis)
 *   @@NEW
 *   (teks baru)
 *   @@END
 * Satu berkas boleh punya beberapa blok. Setiap teks lama harus ada TEPAT SATU kali.
 * Semua blok harus cocok, kalau tidak, tidak ada berkas yang diubah.
 * --check: hanya memeriksa anchor, tanpa menulis.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const patchFile = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!patchFile) { console.error('Pakai: node apply-patch.js <berkas-tambalan> [--check]'); process.exit(2); }

const root = process.cwd();
const spec = fs.readFileSync(patchFile, 'utf8').replace(/\r\n/g, '\n').split('\n');

const blocks = [];
let cur = null;
let mode = null;
for (const line of spec) {
  if (line.startsWith('@@FILE ')) { cur = { file: line.slice(7).trim(), old: [], neu: [] }; mode = 'file'; continue; }
  if (line === '@@OLD') { mode = 'old'; continue; }
  if (line === '@@NEW') { mode = 'new'; continue; }
  if (line === '@@END') { blocks.push(cur); cur = null; mode = null; continue; }
  if (mode === 'old') cur.old.push(line);
  else if (mode === 'new') cur.neu.push(line);
}
if (cur) { console.error('Berkas tambalan tidak ditutup dengan @@END'); process.exit(2); }

const files = new Map();
function load(rel) {
  if (files.has(rel)) return files.get(rel);
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) { console.error(`TIDAK ADA: ${rel} (jalankan dari akar repo)`); process.exit(1); }
  let text = fs.readFileSync(p, 'utf8');
  const bom = text.charCodeAt(0) === 0xFEFF;
  if (bom) text = text.slice(1);
  const crlf = text.includes('\r\n');
  const lone = (text.replace(/\r\n/g, '').match(/\n/g) || []).length;
  if (crlf && lone > 0) { console.error(`${rel}: akhir baris campuran (CRLF dan LF), berhenti`); process.exit(1); }
  const f = { p, rel, bom, crlf, text: text.replace(/\r\n/g, '\n'), before: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') };
  files.set(rel, f);
  return f;
}

let failed = false;
blocks.forEach((b, i) => {
  const f = load(b.file);
  const oldText = b.old.join('\n');
  const newText = b.neu.join('\n');
  const n = f.text.split(oldText).length - 1;
  if (n !== 1) {
    console.error(`BLOK ${i + 1} (${b.file}): teks lama ditemukan ${n} kali (harus 1). Berkas tidak diubah.`);
    failed = true;
    return;
  }
  f.text = f.text.replace(oldText, () => newText);
  console.log(`blok ${i + 1} (${b.file}): cocok`);
});
if (failed) process.exit(1);
if (checkOnly) { console.log('--check: semua anchor cocok, tidak ada yang ditulis.'); process.exit(0); }

for (const f of files.values()) {
  const out = (f.bom ? '﻿' : '') + (f.crlf ? f.text.replace(/\n/g, '\r\n') : f.text);
  fs.writeFileSync(f.p, out, 'utf8');
  console.log(`ditulis: ${f.rel} (${f.crlf ? 'CRLF' : 'LF'}${f.bom ? ', BOM' : ''})`);
}

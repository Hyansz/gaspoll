'use strict';
// Menu sekarang punya pilihan 8, jadi prompt menjadi "[1-8, g, q]". Perbarui tes lama yang masih memakai "[1-7, g, q]".
// Jalankan dari akar repo: node fix-tests-1-8.js
const fs = require('fs');
const path = require('path');
const dir = path.join(process.cwd(), 'test');
if (!fs.existsSync(dir)) { console.error('Folder test tidak ditemukan. Jalankan dari akar repo.'); process.exit(1); }
let n = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
  const p = path.join(dir, f);
  const s = fs.readFileSync(p, 'utf8');
  const c = s.split('1-7, g, q').length - 1;
  if (!c) continue;
  fs.writeFileSync(p, s.split('1-7, g, q').join('1-8, g, q'), 'utf8');
  console.log(`diubah: test/${f} (${c} tempat)`);
  n += c;
}
console.log(n ? `selesai: ${n} penggantian` : 'tidak ada yang perlu diubah');

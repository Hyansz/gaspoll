#!/usr/bin/env node
/**
 * show-results.js
 * Menampilkan hasil tes terakhir dari folder results (tanpa menghubungi router).
 *   node src/show-results.js          tampilkan
 *   node src/show-results.js --copy   tampilkan dan salin ringkasan ke clipboard
 */
const fs = require('fs');
const L = require('./lib');
const UI = require('./ui');
const { col } = L;

function read(file) {
  const f = L.inResults(file);
  if (!fs.existsSync(f)) return { data: null };
  try { return { data: JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch (e) {
    return { data: null, error: `${file} rusak (${e.message}). Jalankan tes ulang.` };
  }
}

const flag = (v) => (v === 1 ? col.green('1') : v === 0 ? col.red('0') : col.yellow(String(v ?? '?')));

function sectionTitle(title) {
  const s = UI.sym();
  const termW = UI.getTermWidth ? UI.getTermWidth() : 80;
  const w = Math.max(10, Math.min(termW, 74) - 2);
  const ch = s.dash || s.horiz || '─';
  return [
    '',
    `  ${col.cyan(col.bold(title))}`,
    col.dim('  ' + ch.repeat(w)),
    ''
  ].join('\n');
}

function render() {
  const out = [];
  const p = (s = '') => out.push(s);
  const S = UI.sym();
  const test = read('combo-auto-combo.json');
  const bench = read('bench-results.json');

  p(sectionTitle('TEST PROVIDER'));
  if (test.error) p(col.red(test.error));
  else if (!test.data) p(col.dim('  Belum ada hasil. Jalankan menu [1] dulu.'));
  else {
    const t = test.data;
    const res = t.results || [];
    const ok = res.filter((r) => r.ok);
    const skipped = res.filter((r) => !r.ok && r.skipped);
    const bad = res.filter((r) => !r.ok && !r.skipped);
    p(`  Waktu : ${L.fmtTime(t.tested_at)}  (${UI.relativeTime(t.tested_at)})`);
    const head = [`${S.success} ${col.green(String(ok.length))} lolos`];
    if (skipped.length) head.push(`${S.warn} ${col.yellow(String(skipped.length))} dilewati (tidak diuji)`);
    head.push(`${S.fail} ${col.red(String(bad.length))} gagal`);
    p('  ' + head.join('    '));
    p('');
    p(`  ${col.bold(`Combo "${t.name}":`)}`);
    (t.models || []).forEach((m, i) => {
      const pColor = UI.colors.provider(L.prefixOf(m));
      p(`    ${col.dim(L.lpad(i + 1, 2))}. ${pColor(m)}`);
    });
    // Label memakai kategori baru bila ada (hasil tes 1.2.9+), kalau tidak jatuh ke tebakan lama.
    const labelOf = (r) => r.category || L.classifyFailure(r.reason).label;
    const groupLines = (list, icon, keyOf) => {
      const groups = {};
      list.forEach((r) => {
        const key = `${L.prefixOf(r.id) || 'unknown'} ${S.mid} ${keyOf(r)}`;
        groups[key] = (groups[key] || 0) + 1;
      });
      const sorted = Object.entries(groups).sort((a, b) => b[1] - a[1]);
      const maxGroups = 12;
      sorted.slice(0, maxGroups).forEach(([k, count]) => {
        p(`    ${icon} ${k}: ${count} model`);
      });
      if (sorted.length > maxGroups) {
        p(`    ${col.dim(`+${sorted.length - maxGroups} kelompok lain`)}`);
      }
    };
    if (skipped.length) {
      p('');
      p(`  ${col.bold('Dilewati (tidak diuji):')}`);
      groupLines(skipped, S.warn, (r) => r.category || 'dilewati');
    }
    if (bad.length) {
      p('');
      p(`  ${col.bold('Model gagal:')}`);
      groupLines(bad, S.fail, labelOf);
    }
    const advice = L.CATEGORY_ADVICE || {};
    const cats = {};
    skipped.concat(bad).forEach((r) => {
      if (!r.category || !advice[r.category]) return;
      const e = (cats[r.category] = cats[r.category] || new Set());
      e.add(L.prefixOf(r.id) || 'unknown');
    });
    const catList = Object.entries(cats).sort((a, b) => b[1].size - a[1].size);
    if (catList.length) {
      p('');
      p(`  ${col.bold('Saran:')}`);
      catList.forEach(([c, provs]) => {
        p(`    ${c} (${provs.size} provider): ${advice[c]}`);
      });
    }
    if (bad.length || skipped.length) {
      p(`    ${col.dim(`Daftar lengkap: results\\combo-auto-combo.json`)}`);
    }
  }
  p('');
  p(sectionTitle('BENCHMARK AGENT CODING'));
  if (bench.error) p(col.red(bench.error));
  else if (!bench.data) p(col.dim('  Belum ada hasil. Jalankan menu [2] dulu.'));
  else {
    const b = bench.data;
    p(`  Waktu : ${L.fmtTime(b.tested_at)}  (${UI.relativeTime(b.tested_at)})`);
    p('');
    p(`  ${col.bold('Skor per model (maks 100):')}`);
    p(col.dim(UI.wrapLegend('Legenda: tool=tool calling, agent=loop agent, bal=isBalanced, merge=mergeIntervals, fix=fixBinarySearch, expr=evalExpr, csv=parseCSVLine, ctx=konteks panjang')));
    const resultsList = b.results || [];
    const maxIdWidth = resultsList.length ? Math.max(...resultsList.map((r) => UI.visualWidth(r.id || ''))) : 0;
    resultsList.forEach((r) => {
      const d = r.detail || {};
      const sc = r.score >= 85 ? col.green : r.score >= 65 ? col.yellow : col.red;
      const pColor = UI.colors.provider(L.prefixOf(r.id || ''));
      const mark = d.errors ? col.yellow(`  ${S.warn} ${d.errors} error`) : '';
      const modelId = r.id || '?';
      const paddedId = modelId + ' '.repeat(Math.max(0, maxIdWidth - UI.visualWidth(modelId)));
      const modelCol = pColor(paddedId);
      const scorePart = `  ${sc(L.lpad(r.score, 3))}`;
      const detailsPart = `tool:${flag(d.tool)} agent:${flag(d.agent)} bal:${flag(d.isBalanced)} merge:${flag(d.mergeIntervals)} fix:${flag(d.fixBinarySearch)} expr:${flag(d.evalExpr)} csv:${flag(d.parseCSVLine)} ctx:${d.ctxError ? '?' : flag(d.needle)}  ${col.dim(r.avgMs ? r.avgMs + ' ms' : '-')}${mark}`;
      const line1 = `${scorePart}  ${modelCol}  ${detailsPart}`;
      const termWidth = UI.getTermWidth() || process.stdout.columns || 80;
      if (UI.visualWidth(line1) > termWidth) {
        p(`${scorePart}  ${modelCol}`);
        p(`         ${detailsPart}`);
      } else {
        p(line1);
      }
    });
    p('');
    p(`  ${col.bold('Combo bertingkat:')}`);
    for (const [name, ids] of Object.entries(b.tiers || {})) {
      p('');
      p(`    ${col.cyan(col.bold(name))}${ids.length ? '' : col.yellow('  (kosong)')}`);
      ids.forEach((id, i) => {
        const pColor = UI.colors.provider(L.prefixOf(id));
        p(`      ${col.dim(L.lpad(i + 1, 2))}. ${pColor(id)}`);
      });
    }
  }
  return out.join('\n');
}

if (require.main === module) {
  const text = render();
  console.log(text);
  if (process.argv.includes('--copy')) {
    L.copyText(L.stripAnsi(text)).then((ok) => {
      console.log(ok ? col.green('\n[OK] Ringkasan disalin ke clipboard.') : col.yellow('\n[!] Clipboard tidak tersedia di sistem ini.'));
    });
  }
}

module.exports = { render };

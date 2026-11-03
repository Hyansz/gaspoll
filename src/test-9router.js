#!/usr/bin/env node
/**
 * test-9router.js
 * Tes semua model/provider di 9Router, lalu susun combo (urutan fallback) dari yang lolos.
 * Tanpa dependency, butuh Node 18+.
 *
 * Contoh:
 *   node src/test-9router.js
 *   node src/test-9router.js --per-provider 8
 *   node src/test-9router.js --only gemini,cf
 *   node src/test-9router.js --apply            (buat combo dari hasil terakhir, tanpa tes ulang)
 *
 * Opsi:
 *   --apply             buat combo dari hasil tes terakhir (tanpa tes ulang)
 *   --create            setelah tes, langsung kirim combo ke 9Router
 *   --name <nama>       nama combo (default: auto-combo)
 *   --max <n>           batasi jumlah model di combo (default: 0 = semua yang lolos)
 *   --priority a,b,c    prefix provider yang didahulukan (mis. cc,cx,glm,kr). Sisanya urut kecepatan
 *   --only a,b          hanya tes provider dengan prefix ini
 *   --exclude a,b       lewati provider dengan prefix ini
 *   --password <pw>     password dashboard (default: dari config)
 *   --include-weak      masukkan juga model yang menjawab tapi gagal tes hitung sederhana
 *   --skip-model <re>   regex model yang dilewati
 *   --provider-parallel <n>  model satu provider yang dites bersamaan (default: 2)
 *   --per-provider <n>  maksimal model per provider di combo (default: 0 (tanpa batas))
 *   --all-variants      ikutkan varian -thinking / -agentic
 *   --timeout <detik>   timeout per model (default: 30)
 *   --concurrency <n>   jumlah provider yang dites bersamaan (default: 4)
 *   --help              tampilkan bantuan ini
 *
 * Hasil selalu disimpan di folder results/ (tidak tergantung dari mana script dijalankan),
 * dan seluruh output ikut disimpan ke results/logs/.
 */

const fs = require('fs');
const path = require('path');
const L = require('./lib');
const UI = require('./ui');
const { col } = L;

const A = L.makeArgs();
const { has, opt, list, num } = A;
const KNOWN = ['apply', 'create', 'name', 'max', 'priority', 'only', 'exclude', 'password', 'include-weak',
  'skip-model', 'provider-parallel', 'per-provider', 'all-variants', 'timeout', 'concurrency', 'help'];

const cfg = L.loadConfig();
if (opt('password', '')) cfg.password = opt('password', '');
const headers = L.authHeaders(cfg);

const COMBO_NAME = opt('name', 'auto-combo');
const MAX_MODELS = Math.max(0, Math.floor(num('max', 0)));
const TIMEOUT_MS = Math.max(1, num('timeout', 30)) * 1000;
const CONCURRENCY = Math.max(1, Math.floor(num('concurrency', 4)));
const PROVIDER_PARALLEL = Math.max(1, Math.floor(num('provider-parallel', 2)));
const PER_PROVIDER = Math.max(0, Math.floor(num('per-provider', 0)));
const PRIORITY = list(opt('priority', ''));
const ONLY = list(opt('only', ''));
const EXCLUDE = list(opt('exclude', ''));
const ALL_VARIANTS = has('all-variants');
const INCLUDE_WEAK = has('include-weak');
const RETRY_MS = parseInt(process.env.TEST_RETRY_MS || '10000', 10);
const RATE_RE = /\[429\]|HTTP 429|too many requests|rate.?limit/i;
const SKIP_MODEL = new RegExp(opt('skip-model', L.SKIP_MODEL_DEFAULT), 'i');
const FILE = L.inResults(`combo-${COMBO_NAME}.json`);
const prefixOf = L.prefixOf;

let stopping = false;
let sigCount = 0;

// ---------------------------------------------------------------- tes satu model

async function testOnce(id) {
  const started = Date.now();
  try {
    const { res, body } = await L.fetchJson(
      `${cfg.baseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: id,
          messages: [{ role: 'user', content: 'Berapa 17 x 23? Jawab hanya angkanya.' }],
          max_tokens: 512,
          stream: false,
        }),
      },
      TIMEOUT_MS
    );
    const ms = Date.now() - started;
    if (!res.ok) return { id, ok: false, ms, status: res.status, reason: `HTTP ${res.status}: ${L.errText(body, res)}` };
    const m = body?.choices?.[0]?.message;
    const text = `${m?.content || ''} ${m?.reasoning_content || ''}`;
    if (!text.trim()) return { id, ok: false, ms, reason: 'respons kosong' };
    const smart = text.includes('391');
    return { id, ok: true, smart, ms, reason: smart ? '' : '(jawaban salah/aneh, dianggap lemah)' };
  } catch (e) {
    return { id, ok: false, ms: Date.now() - started, reason: e.message };
  }
}

// Jika provider mengembalikan 429 (rate limit), provider itu dijeda lalu dicoba lagi. Kalau 429 terus
// berturut-turut, sisa modelnya dilewati supaya tidak membebani provider (dan tidak menghabiskan kuota).
const pauseUntil = {};
const consecutive429 = {};
const MAX_CONSECUTIVE_429 = 12;
const consecutiveTimeout = {};
const MAX_CONSECUTIVE_TIMEOUT = 3;

async function testModel(id) {
  const p = prefixOf(id);
  if ((consecutiveTimeout[p] || 0) >= MAX_CONSECUTIVE_TIMEOUT) {
    return { id, ok: false, ms: 0, reason: 'dilewati: provider timeout berturut-turut (tampaknya menggantung)' };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((consecutive429[p] || 0) >= MAX_CONSECUTIVE_429) {
      return { id, ok: false, ms: 0, rateLimited: true, reason: 'dilewati: provider kena rate limit, ulangi nanti' };
    }
    const wait = (pauseUntil[p] || 0) - Date.now();
    if (wait > 0) await L.sleep(wait);
    const r = await testOnce(id);
    if (!r.ok && RATE_RE.test(r.reason)) {
      consecutive429[p] = (consecutive429[p] || 0) + 1;
      pauseUntil[p] = Date.now() + RETRY_MS * (attempt + 1);
      if (attempt < 2) continue;
      return { ...r, rateLimited: true, reason: `RATE-LIMIT ${r.reason}` };
    }
    consecutive429[p] = 0;
    consecutiveTimeout[p] = !r.ok && /^timeout/.test(r.reason) ? (consecutiveTimeout[p] || 0) + 1 : 0;
    return r;
  }
  return { id, ok: false, ms: 0, reason: 'error tak terduga' };
}

// ---------------------------------------------------------------- susun combo

function sortForCombo(passed) {
  const rank = (id) => {
    const i = PRIORITY.indexOf(prefixOf(id));
    return i === -1 ? PRIORITY.length : i;
  };
  return [...passed].sort((a, b) => rank(a.id) - rank(b.id) || a.ms - b.ms);
}

// Bergiliran antar provider (round-robin) supaya satu provider tidak mendominasi combo.
function pickDiverse(sorted, max) {
  if (!(max > 0)) max = Infinity;
  const cap = PER_PROVIDER > 0 ? PER_PROVIDER : Infinity;
  const groups = new Map();
  for (const r of sorted) {
    const p = prefixOf(r.id);
    if (!groups.has(p)) groups.set(p, []);
    if (groups.get(p).length < cap) groups.get(p).push(r);
  }
  const out = [];
  while (out.length < max && [...groups.values()].some((g) => g.length)) {
    for (const g of groups.values()) {
      if (g.length && out.length < max) out.push(g.shift());
    }
  }
  return out;
}

function providerSummary(results, chosen) {
  const by = {};
  for (const r of results) {
    const p = prefixOf(r.id) || '(tanpa prefix)';
    const e = (by[p] = by[p] || { ok: 0, total: 0, reasons: {} });
    e.total++;
    if (r.ok) e.ok++;
    else {
      const k = UI.shortenReason(r.reason) || 'error lain';
      e.reasons[k] = (e.reasons[k] || 0) + 1;
    }
  }
  const inCombo = {};
  chosen.forEach((id) => { const p = prefixOf(id); inCombo[p] = (inCombo[p] || 0) + 1; });

  L.line('');
  const s = UI.sym();
  L.line(col.cyan(col.bold('  RINGKASAN PER PROVIDER')));
  L.line(col.dim('  ' + s.horiz.repeat(56)));
  L.line(col.dim(`  ${L.pad('Provider', 14)} ${L.pad('Lolos', 6)} ${L.pad('Di combo', 9)} Alasan gagal`));
  Object.entries(by)
    .sort((a, b) => b[1].ok - a[1].ok)
    .forEach(([p, e]) => {
      const why = Object.entries(e.reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} x${n}`).join(', ');
      const frac = `${e.ok}/${e.total}`;
      const color = e.ok === 0 ? col.red : e.ok < e.total ? col.yellow : col.green;
      L.line(`  ${L.pad(p, 14)} ${color(L.pad(frac, 6))} ${L.pad(inCombo[p] || 0, 9)} ${col.dim(why || '')}`);
    });
}

// ---------------------------------------------------------------- main

function nextSteps(extra = []) {
  // Saat GASPOLL_FROM_MENU=1, kotak "Langkah berikut" tidak ditampilkan
  if (process.env.GASPOLL_FROM_MENU === '1') return;
  L.line('');
  L.line(col.bold('Langkah berikut (salin barisnya):'));
  extra.forEach(([label, cmd]) => L.cmdLine(label, cmd));
}

// Tulis ringkasan terakhir ke results/last-run.json (dipakai oleh cli.js untuk jurnal)
function writeLastRun({ ok, passed, failed, duration, combo, comboApplied }) {
  try {
    const s = UI.sym();
    const summary = [
      ok ? `${passed} lolos ${s.mid} ${failed} gagal` : 'gagal',
      comboApplied ? `${combo} diperbarui (${comboApplied} model)` : null,
      `durasi ${L.fmtDur(duration)}`,
    ].filter(Boolean).join(` ${s.mid} `);
    const p = L.inResults('last-run.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      ok, passed, failed, duration,
      combo: combo || null,
      comboApplied: comboApplied || 0,
      summary,
    }));
  } catch { /* gagal tulis tidak boleh menggagalkan */ }
}

async function main() {
  const s = UI.sym();
  L.installCrashHandlers();
  if (has('help')) {
    const src = fs.readFileSync(__filename, 'utf8');
    console.log(src.split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?\n?/, '').replace(/^ \* ?/gm, ''));
    return;
  }
  L.startLog(has('apply') ? 'test-apply' : 'test', [`args: ${A.argv.join(' ') || '(tanpa opsi)'}`, `router: ${cfg.baseUrl}`]);
  L.warnUnknown(A.argv, KNOWN);

  process.on('SIGINT', () => {
    sigCount++;
    if (sigCount > 1) { L.line(col.red('\nKeluar paksa.')); process.exit(130); }
    stopping = true;
    L.line(col.yellow('\n[!] Dihentikan. Menunggu request yang sedang berjalan selesai (Ctrl+C lagi = keluar paksa).'));
  });

  // --apply: buat combo dari hasil tes terakhir tanpa mengetes ulang
  if (has('apply')) {
    if (!fs.existsSync(FILE)) {
      L.line(col.red(`[!] ${FILE} belum ada. Jalankan test dulu (menu 1).`));
      process.exitCode = 1;
      return;
    }
    let saved;
    try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
      L.line(col.red(`[!] ${FILE} rusak (${e.message}). Jalankan test ulang.`));
      process.exitCode = 1;
      return;
    }
    L.heading(`BUAT COMBO "${COMBO_NAME}"`);
    const ok = await L.applyCombos(cfg, { [COMBO_NAME]: saved.models || [] });
    process.exitCode = ok ? 0 : 1;
    return;
  }

  L.heading('TEST SEMUA PROVIDER');
  L.line(col.dim('  Menguji semua model untuk menemukan yang paling cepat dan andal'));
  L.line(`  Router  : ${cfg.baseUrl}`);
  L.line(`  API key : ${L.maskKey(cfg.apiKey)}`);
  const alive = await L.checkRouter(cfg);
  if (!alive.ok) {
    L.line(col.red(`\n[!] 9Router tidak bisa dihubungi di ${cfg.baseUrl}: ${alive.reason}`));
    process.exitCode = 1;
    return;
  }

  let models = await L.fetchAllModelIds(cfg);
  const total0 = models.length;
  const skipped = [];
  models = models.filter((id) => {
    const p = prefixOf(id);
    if (ONLY.length && !ONLY.includes(p)) return false;
    if (EXCLUDE.includes(p)) return false;
    if (SKIP_MODEL.test(id)) { skipped.push(id); return false; }
    return true;
  });
  if (skipped.length) {
    L.line(col.dim(`Dilewati oleh filter nama (${skipped.length}): ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ', ...' : ''}`));
    L.line(col.dim('  (ubah dengan --skip-model "regex" jika ada model chat yang ikut terfilter)'));
  }
  if (!ALL_VARIANTS) {
    const before = models.length;
    models = L.dropVariants(models);
    if (before - models.length) L.line(col.dim(`${before - models.length} varian -thinking/-agentic tidak dites (pakai --all-variants untuk ikut menguji).`));
  }
  if (!models.length) {
    L.line(col.red(`\nTidak ada model untuk dites (dari ${total0} model di router).`));
    L.line('Pastikan provider sudah terhubung di dashboard, atau cek filter --only/--exclude.');
    process.exitCode = 1;
    return;
  }
  L.line(`\nMenguji ${models.length} model (maks ${CONCURRENCY} provider bersamaan, ${PROVIDER_PARALLEL} model per provider)...`);
  L.line(col.dim('Ctrl+C untuk berhenti. Setiap hasil dicetak sebagai baris biasa, jadi bisa di-scroll dan di-copy.\n'));

  const t0 = Date.now();
  let done = 0;
  let okN = 0;
  const results = await L.runByProvider(
    models,
    async (id) => {
      const r = await testModel(id);
      done++;
      if (r.ok) okN++;
      const p = prefixOf(id);
      const pCol = UI.colors.provider(p);
      const s = UI.sym();
      const tag = r.ok
        ? col.green(`${s.success}  `)
        : r.rateLimited || /429|rate/i.test(r.reason || '')
          ? col.yellow(`${s.warn}  `)
          : col.red(`${s.fail}  `);
      const reason = r.reason ? col.dim(UI.shortenReason(r.reason)) : '';
      const verbose = has('verbose') || process.env.GASPOLL_VERBOSE === '1';
      const isQuiet = (process.env.GASPOLL_FROM_MENU === '1' || has('quiet-fail')) && !verbose;
      if (r.ok || !isQuiet) {
        L.line(`${col.dim(`[${L.lpad(done, String(models.length).length)}/${models.length}]`)} ${tag}${pCol(L.pad(id, 40))} ${L.lpad(r.ms, 6)} ms  ${reason}`);
      } else {
        const logFile = L.lastLogPath();
        if (logFile) {
          try {
            const s = UI.sym();
            fs.appendFileSync(logFile, `[${done}/${models.length}] ${s.fail} ${id}  ${r.reason}\n`, 'utf8');
          } catch {}
        }
      }
      const failN = done - okN;
      L.status(`${done}/${models.length} ${s.mid} ${s.success} ${okN} ${s.mid} ${s.fail} ${failN} ${s.mid} ${L.fmtDur(Date.now() - t0)}`);
      return r;
    },
    CONCURRENCY,
    PROVIDER_PARALLEL,
    () => stopping
  );
  L.status('');

  if (stopping) {
    L.line(col.yellow(`\nDibatalkan setelah ${results.length}/${models.length} model. Combo dan file hasil lama tidak diubah.`));
    process.exitCode = 130;
    return;
  }

  L.line('');
  const s2 = UI.sym();
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const totalMs = Date.now() - t0;

  // Satu kotak ringkasan tunggal dengan kelompok kegagalan
  const failureGroups = {};
  failed.forEach((r) => {
    const p = prefixOf(r.id) || 'unknown';
    const classified = L.classifyFailure(r.reason);
    const key = `${p} ${s2.mid} ${classified.label}`;
    failureGroups[key] = (failureGroups[key] || 0) + 1;
  });
  const sortedFailures = Object.entries(failureGroups).sort((a, b) => b[1] - a[1]);

  const summaryLines = [
    `${s2.success} ${col.green(String(passed.length))} lolos   ${s2.fail} ${col.red(String(failed.length))} gagal   Waktu: ${L.fmtDur(totalMs)}`,
  ];
  if (sortedFailures.length) {
    summaryLines.push('');
    summaryLines.push('Ringkasan Gagal:');
    const maxLines = 12;
    sortedFailures.slice(0, maxLines).forEach(([k, count]) => {
      summaryLines.push(`  ${k}: ${count}`);
    });
    if (sortedFailures.length > maxLines) {
      summaryLines.push(`  +${sortedFailures.length - maxLines} kelompok lain (lihat Riwayat & log › Yang gagal)`);
    }
  }
  L.line(UI.box('RINGKASAN TES', summaryLines, { borderColor: failed.length > 0 ? 'yellow' : 'green' }));

  L.line(`\nSelesai dalam ${L.fmtDur(totalMs)}. ${col.green(`Lolos: ${passed.length}`)} | ${failed.length ? col.red(`Gagal: ${failed.length}`) : 'Gagal: 0'}`);

  if (!passed.length) {
    const auth = results.filter((r) => r.status === 401 || r.status === 403).length;
    if (auth > results.length / 2) L.line(col.red('Hampir semua ditolak 401/403: API key salah. Ganti lewat menu [7].'));
    L.line(col.red('Tidak ada model yang lolos, combo tidak dibuat.'));
    writeLastRun({ ok: false, passed: 0, failed: failed.length, duration: totalMs, combo: null, comboApplied: 0 });
    process.exitCode = 1;
    return;
  }
  writeLastRun({ ok: false, passed: passed.length, failed: failed.length, duration: totalMs, combo: COMBO_NAME, comboApplied: 0 });
  const pool = INCLUDE_WEAK ? passed : passed.filter((r) => r.smart);
  if (!pool.length) {
    L.line(col.red('Semua yang lolos ternyata lemah (jawaban hitungan salah).'));
    nextSteps([['Jalankan ulang dengan menyertakan yang lemah:', `node ${L.relCmd('test-9router.js')} --include-weak`]]);
    process.exitCode = 1;
    return;
  }
  const candidates = ALL_VARIANTS ? pool : L.dropVariants(pool, (r) => r.id);
  const chosen = pickDiverse(sortForCombo(candidates), MAX_MODELS).map((r) => r.id);

  L.line('');
  L.line(col.cyan(col.bold(`  COMBO "${COMBO_NAME}" (urutan fallback)`)));
  L.line(col.dim('  ' + s.horiz.repeat(56)));
  chosen.forEach((id, i) => {
    const p = prefixOf(id);
    const pCol = UI.colors.provider(p);
    L.line(`  ${col.dim(L.lpad(i + 1, 2))}. ${pCol(id)}`);
  });
  providerSummary(results, chosen);

  // Tampilkan model lolos yang tidak masuk combo dengan penanda redup
  const chosenSet = new Set(chosen);
  const notChosen = passed.filter((r) => !chosenSet.has(r.id));
  if (notChosen.length) {
    L.line('');
    L.line(col.yellow('  Model lolos namun tidak masuk combo:'));
    notChosen.forEach((r) => {
      const isVariant = (r.id.includes('thinking') || r.id.includes('agentic'));
      const s3 = UI.sym();
      const note = isVariant ? `${s3.mid} varian, tidak masuk combo` : `${s3.mid} lemah, tidak masuk combo`;
      L.line(col.dim(`    - ${r.id}  ${note}`));
    });
  }
fs.writeFileSync(FILE, JSON.stringify({ name: COMBO_NAME, models: chosen, tested_at: new Date().toISOString(), results }, null, 2));
  const txt = FILE.replace(/\.json$/, '.txt');
  fs.writeFileSync(txt, chosen.join('\n') + '\n');
  L.line('');
  L.line(`Hasil lengkap : ${FILE}`);
  L.line(`Daftar model  : ${txt}  (satu model per baris, tinggal paste di Dashboard > Combos)`);

  if (has('create')) {
    const ok = await L.applyCombos(cfg, { [COMBO_NAME]: chosen });
    if (!ok) L.line(col.yellow('Buat manual di Dashboard > Combos, lalu paste urutan model di atas.'));
    writeLastRun({ ok: true, passed: passed.length, failed: failed.length, duration: totalMs, combo: COMBO_NAME, comboApplied: chosen.length });
  } else {
    nextSteps([
      ['Buat combo di 9Router dari hasil ini:', `node ${L.relCmd('test-9router.js')} --apply --name ${COMBO_NAME}`],
      ['Lanjut benchmark agent coding:', `node ${L.relCmd('bench-9router.js')}`],
    ]);
    writeLastRun({ ok: true, passed: passed.length, failed: failed.length, duration: totalMs, combo: COMBO_NAME, comboApplied: 0 });
  }
}

main().catch((e) => {
  L.line(col.red(`\n[!] Error: ${e.message}`));
  if (L.lastLogPath()) L.line(col.dim(`Log lengkap: ${L.lastLogPath()}`));
  process.exitCode = 1;
});

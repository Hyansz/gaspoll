#!/usr/bin/env node
/**
 * bench-9router.js
 * Benchmark model di 9Router untuk kebutuhan agent coding, lalu menyusun
 * 3 combo bertingkat: coding-easy, coding-medium, coding-hard.
 *
 * Tes per model (skor 0-100):
 *   - Tool calling dasar (10)   : memanggil read_file dengan argumen benar
 *   - Loop agent 2 langkah (20) : baca config.json lalu tulis ulang dengan PORT 8080 (hasil tool dikirim balik)
 *   - Kode mudah (5 + 10)       : isBalanced, mergeIntervals
 *   - Perbaikan bug (10)        : binarySearch yang rusak (harus benar semua)
 *   - Kode sulit (20 + 15)      : evalExpr (parser aritmetika), parseCSVLine (kutip dan escape)
 *   - Konteks panjang (10)      : mencari kode rahasia di tengah teks panjang
 *
 * Contoh:
 *   node src/bench-9router.js                  # tes model yang lolos di combo-auto-combo.json
 *   node src/bench-9router.js --all            # tes semua model dari /v1/models
 *   node src/bench-9router.js --only gemini    # ulangi satu provider (digabung dengan hasil lama)
 *   node src/bench-9router.js --apply          # buat 3 combo dari hasil terakhir
 *
 * Opsi:
 *   --apply             buat 3 combo dari hasil benchmark terakhir (tanpa tes ulang)
 *   --create            setelah benchmark, langsung buat 3 combo di 9Router
 *   --password <pw>     password dashboard (default: dari config)
 *   --all               tes semua model, bukan hanya yang lolos di tes sebelumnya
 *   --file <path>       hasil tes sebelumnya (default: combo-auto-combo.json di folder results)
 *   --only a,b          hanya provider dengan prefix ini (hasil digabung dengan hasil lama)
 *   --exclude a,b       lewati provider dengan prefix ini
 *   --max <n>           maksimal model per combo (default: 6)
 *   --prefix <nama>     awalan nama combo (default: coding)
 *   --timeout <detik>   timeout per request (default: 90)
 *   --max-per-provider <n>  maksimal model per provider yang dites (default: 8, 0 = semua)
 *   --match <regex>     hanya uji model yang namanya cocok, mis. "claude|gpt-5|grok|deepseek"
 *   --all-variants      uji juga varian -thinking / -agentic (default: hanya versi polos)
 *   --provider-parallel <n>  model satu provider yang dites bersamaan (default: 3)
 *   --concurrency <n>   provider yang dites paralel (default: 4)
 *   --help              tampilkan bantuan ini
 *
 * Ctrl+C sekali = berhenti rapi dan hasil sementara tetap disimpan (digabung dengan hasil lama).
 * Seluruh output ikut disimpan ke results/logs/.
 *
 * Catatan: kode hasil model dijalankan di node:vm tanpa akses require/fs/network,
 * dengan timeout. Itu cukup untuk fungsi murni, tapi vm bukan sandbox keamanan penuh.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = require('./lib');
const UI = require('./ui');
const { col } = L;

const A = L.makeArgs();
const { has, opt, list, num } = A;
const KNOWN = ['apply', 'create', 'password', 'all', 'file', 'only', 'exclude', 'max', 'prefix', 'timeout',
  'max-per-provider', 'match', 'all-variants', 'provider-parallel', 'concurrency', 'max-bench', 'help'];

const cfg = L.loadConfig();
if (opt('password', '')) cfg.password = opt('password', '');
const headers = L.authHeaders(cfg);

const FILE = L.inResults(opt('file', 'combo-auto-combo.json'));
const RESULT_FILE = L.inResults('bench-results.json');
const ONLY = list(opt('only', ''));
const EXCLUDE = list(opt('exclude', ''));
const MAX = Math.max(1, Math.floor(num('max', 6)));
const MAX_BENCH = Math.max(0, Math.floor(num('max-bench', 30)));
const PREFIX = opt('prefix', 'coding');
const TIMEOUT_MS = Math.max(1, num('timeout', 90)) * 1000;
const ALL_VARIANTS = has('all-variants');
const MAX_PER_PROVIDER = Math.max(0, Math.floor(num('max-per-provider', 8))); // 0 = semua
let MATCH = null;
try { MATCH = opt('match', '') ? new RegExp(opt('match', ''), 'i') : null; } catch (e) {
  console.log(`[!] Regex --match tidak valid (${e.message}), filter diabaikan.`);
}
const PROVIDER_PARALLEL = Math.max(1, Math.floor(num('provider-parallel', 3)));
const CONCURRENCY = Math.max(1, Math.floor(num('concurrency', 4)));
const SKIP_MODEL = new RegExp(L.SKIP_MODEL_DEFAULT, 'i');
const prefixOf = L.prefixOf;

// ---------- Definisi tes ----------

const CODE_TASKS = [
  {
    key: 'isBalanced',
    weight: 5,
    prompt:
      'Tulis fungsi JavaScript `isBalanced(s)` yang mengembalikan true jika semua kurung ' +
      '()[]{} pada string s seimbang dan bersarang dengan benar, selain itu false. ' +
      'String kosong dianggap true. Balas HANYA dengan satu blok kode ```js```, tanpa penjelasan.',
    cases: [
      [['()[]{}'], true],
      [['(]'], false],
      [['([{}])'], true],
      [['(('], false],
      [[''], true],
      [['{[}]'], false],
    ],
  },
  {
    key: 'mergeIntervals',
    weight: 10,
    prompt:
      'Tulis fungsi JavaScript `mergeIntervals(intervals)` yang menerima array [start, end] ' +
      '(belum tentu terurut) dan mengembalikan array interval yang digabung jika saling tumpang ' +
      'tindih atau bersentuhan (mis. [1,4] dan [4,5] menjadi [1,5]), terurut berdasarkan start. ' +
      'Balas HANYA dengan satu blok kode ```js```, tanpa penjelasan.',
    cases: [
      [[[[1, 3], [2, 6], [8, 10], [15, 18]]], [[1, 6], [8, 10], [15, 18]]],
      [[[[1, 4], [4, 5]]], [[1, 5]]],
      [[[]], []],
      [[[[5, 6], [1, 3]]], [[1, 3], [5, 6]]],
      [[[[1, 10], [2, 3]]], [[1, 10]]],
    ],
  },
  {
    key: 'fixBinarySearch',
    fn: 'binarySearch',
    weight: 10,
    strict: true, // perbaikan bug harus benar semua, bukan sebagian
    prompt:
      'Fungsi berikut punya bug (bisa infinite loop dan salah hasil). Perbaiki. Pertahankan ' +
      'nama fungsi `binarySearch(arr, target)` yang mengembalikan index atau -1 untuk array ' +
      'terurut naik. Balas HANYA dengan satu blok kode ```js``` berisi fungsi yang sudah benar.\n\n' +
      '```js\nfunction binarySearch(arr, target) {\n  let lo = 0, hi = arr.length;\n' +
      '  while (lo < hi) {\n    const mid = Math.floor((lo + hi) / 2);\n' +
      '    if (arr[mid] === target) return mid;\n' +
      '    if (arr[mid] < target) lo = mid; else hi = mid - 1;\n  }\n  return -1;\n}\n```',
    cases: [
      [[[1, 3, 5, 7, 9], 7], 3],
      [[[1, 3, 5, 7, 9], 1], 0],
      [[[1, 3, 5, 7, 9], 9], 4],
      [[[1, 3, 5, 7, 9], 4], -1],
      [[[], 1], -1],
      [[[2], 2], 0],
      [[[1, 3, 5, 7, 9, 11, 13], 13], 6],
      [[[1, 3, 5, 7, 9, 11, 13], 14], -1],
      [[[1, 3, 5, 7, 9, 11, 13], 0], -1],
    ],
  },
  {
    key: 'evalExpr',
    weight: 20,
    prompt:
      'Tulis fungsi JavaScript `evalExpr(str)` yang menghitung ekspresi aritmetika dari string ' +
      'tanpa memakai eval atau new Function. Dukung bilangan desimal, operator + - * / dengan ' +
      'prioritas yang benar, kurung bersarang, minus unary (mis. "-(2+3)*2" dan "7 - -3"), dan spasi. ' +
      'Kembalikan angka. Balas HANYA dengan satu blok kode ```js```, tanpa penjelasan.',
    cases: [
      [['1+2*3'], 7],
      [['(1+2)*3'], 9],
      [['-(2+3)*2'], -10],
      [['10/4'], 2.5],
      [['2*(3+(4-1))*2'], 24],
      [[' 7 - -3 '], 10],
      [['2*3*4/6'], 4],
      [['8/2/2'], 2],
      [['1.5+2.25'], 3.75],
      [['-3*-3'], 9],
    ],
  },
  {
    key: 'parseCSVLine',
    weight: 15,
    prompt:
      'Tulis fungsi JavaScript `parseCSVLine(line)` yang memecah satu baris CSV menjadi array string. ' +
      'Pemisah koma. Field boleh diapit tanda kutip ganda sehingga boleh berisi koma, dan dua tanda ' +
      'kutip berurutan di dalam field berkutip berarti satu tanda kutip literal. Field kosong dipertahankan. ' +
      'Baris kosong menghasilkan [""]. Balas HANYA dengan satu blok kode ```js```, tanpa penjelasan.',
    cases: [
      [['a,b,c'], ['a', 'b', 'c']],
      [['"a,b",c'], ['a,b', 'c']],
      [['"he said ""hi""",x'], ['he said "hi"', 'x']],
      [[''], ['']],
      [['a,,b'], ['a', '', 'b']],
      [['a,'], ['a', '']],
      [['"",x'], ['', 'x']],
      [['x,"y z",""'], ['x', 'y z', '']],
    ],
  },
];

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Membaca isi sebuah file di proyek.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path file relatif' } },
        required: ['path'],
      },
    },
  },
];

const AGENT_TOOLS = [
  ...TOOLS,
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Menulis (menimpa) isi sebuah file di proyek.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path file relatif' },
          content: { type: 'string', description: 'Isi baru file secara lengkap' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

function buildNeedlePrompt() {
  const lines = [];
  for (let i = 0; i < 260; i++) {
    lines.push(`Catatan ${i}: kucing tidur di sofa nomor ${i * 7} sementara hujan turun pelan di luar.`);
  }
  lines.splice(130, 0, 'KODE RAHASIA PROYEK: ZX-4471-QR.');
  return `${lines.join('\n')}\n\nPertanyaan: apa KODE RAHASIA PROYEK? Jawab hanya kodenya.`;
}

// ---------- Eksekusi kode hasil model (vm) ----------

function extractCode(text) {
  const m = text.match(/```(?:js|javascript|node)?\s*\n([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
}

function runTests(code, fnName, cases) {
  const sandbox = { module: { exports: {} }, console: { log() {}, error() {} } };
  sandbox.exports = sandbox.module.exports;
  try {
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { timeout: 2000 });
  } catch {
    return 0;
  }
  const resolve =
    `(typeof ${fnName}==='function'?${fnName}:` +
    `(typeof module.exports==='function'?module.exports:module.exports.${fnName}))`;
  let pass = 0;
  for (const [args, expected] of cases) {
    try {
      sandbox.__args = JSON.stringify(args);
      const out = vm.runInContext(`JSON.stringify(${resolve}(...JSON.parse(__args)))`, sandbox, {
        timeout: 1000,
      });
      if (out === JSON.stringify(expected)) pass++;
    } catch {
      /* salah / timeout / error -> tidak lulus */
    }
  }
  return pass / cases.length;
}

// ---------- HTTP ----------

const RETRY_MS = parseInt(process.env.BENCH_RETRY_MS || '8000', 10);

async function chat(model, payload) {
  // 429/502/503/504 (kuota atau beban) dicoba ulang dengan jeda; timeout tidak diulang.
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = Date.now();
    try {
      const { res, body } = await L.fetchJson(
        `${cfg.baseUrl}/v1/chat/completions`,
        { method: 'POST', headers, body: JSON.stringify({ model, stream: false, ...payload }) },
        TIMEOUT_MS
      );
      const ms = Date.now() - started;
      if (res.ok) return { ok: true, ms, message: body?.choices?.[0]?.message || {}, finish: body?.choices?.[0]?.finish_reason };
      if ([429, 502, 503, 504].includes(res.status) && attempt < 2) {
        await L.sleep(RETRY_MS * (attempt + 1));
        continue;
      }
      // 4xx selain 429 (mis. 400 "tool tidak didukung") adalah hasil tes yang sah, bukan error sementara.
      return { ok: false, ms, error: `HTTP ${res.status}`, transient: res.status === 429 || res.status >= 500 };
    } catch (e) {
      return { ok: false, ms: Date.now() - started, error: e.message, transient: true };
    }
  }
  return { ok: false, ms: 0, error: 'gagal setelah 3 percobaan', transient: true };
}

// ---------- Benchmark satu model ----------

// Loop agent 2 langkah: model harus membaca file, menerima hasil tool, lalu menulis file yang benar.
async function agentLoopTest(call) {
  const messages = [
    {
      role: 'user',
      content:
        'File config.json berisi nilai PORT. Baca file itu dengan read_file, lalu ubah PORT menjadi 8080 ' +
        'dan simpan seluruh isi file dengan write_file. Gunakan tool, jangan hanya menjelaskan.',
    },
  ];
  for (let turn = 0; turn < 4; turn++) {
    const r = await call({ messages, tools: AGENT_TOOLS, tool_choice: 'auto', max_tokens: 1024 });
    if (!r.ok) return false;
    const calls = r.message.tool_calls || [];
    if (!calls.length) return false;
    messages.push({ role: 'assistant', content: r.message.content || null, tool_calls: calls });
    for (let i = 0; i < calls.length; i++) {
      const tc = calls[i];
      const callId = tc.id || `call_${turn}_${i}`;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { return false; }
      const name = tc.function?.name;
      if (name === 'write_file') {
        const content = String(args.content || '');
        return String(args.path || '').includes('config.json') && /8080/.test(content) && /localhost/.test(content) && !/3000/.test(content);
      }
      const reply = name === 'read_file' ? '{\n  "HOST": "localhost",\n  "PORT": 3000\n}' : 'error: tool tidak dikenal';
      messages.push({ role: 'tool', tool_call_id: callId, content: reply });
    }
  }
  return false;
}

async function benchModel(id, needlePrompt) {
  const detail = {};
  let score = 0;
  let errors = 0; // request yang gagal (timeout, 429, 5xx), beda dengan jawaban yang salah
  const codeMs = [];
  const call = async (payload) => {
    const r = await chat(id, payload);
    if (!r.ok && r.transient) errors++;
    return r;
  };

  // 1. tool calling dasar (10)
  const t = await call({
    messages: [{ role: 'user', content: 'Aku perlu tahu isi config.json di root proyek. Gunakan tool yang tersedia.' }],
    tools: TOOLS,
    tool_choice: 'auto',
    max_tokens: 512,
  });
  let toolOk = false;
  if (t.ok) {
    const tc = t.message.tool_calls?.[0];
    if (tc?.function?.name === 'read_file') {
      try {
        toolOk = String(JSON.parse(tc.function.arguments || '{}').path || '').includes('config.json');
      } catch { /* argumen bukan JSON valid */ }
    }
  }
  detail.tool = toolOk ? 1 : 0;
  if (toolOk) score += 10;

  // 2. loop agent 2 langkah (20)
  const agentOk = toolOk ? await agentLoopTest(call) : false;
  detail.agent = agentOk ? 1 : 0;
  if (agentOk) score += 20;

  // 3. tugas kode
  for (const task of CODE_TASKS) {
    let r = await call({ messages: [{ role: 'user', content: task.prompt }], max_tokens: 3500 });
    // Jawaban terpotong (model thinking menghabiskan token untuk berpikir): coba sekali lagi dengan batas lebih besar.
    if (r.ok && r.finish === 'length') r = await call({ messages: [{ role: 'user', content: task.prompt }], max_tokens: 9000 });
    let ratio = 0;
    if (r.ok) {
      ratio = runTests(extractCode(`${r.message.content || ''}`), task.fn || task.key, task.cases);
      if (task.strict && ratio < 1) ratio = 0;
      codeMs.push(r.ms);
    }
    detail[task.key] = Number(ratio.toFixed(2));
    score += ratio * task.weight;
  }

  // 4. konteks panjang (10)
  const n = await chat(id, { messages: [{ role: 'user', content: needlePrompt }], max_tokens: 200 });
  const needleOk = n.ok && `${n.message.content || ''}`.includes('ZX-4471-QR');
  detail.needle = needleOk ? 1 : 0;
  detail.ctxError = n.ok ? 0 : 1; // request gagal: skor konteks tidak pasti, tapi bukan error model
  if (needleOk) score += 10;

  const avgMs = codeMs.length ? Math.round(codeMs.reduce((a, b) => a + b, 0) / codeMs.length) : null;
  detail.errors = errors;
  return { id, score: Math.round(score), avgMs, detail };
}

// ---------- Daftar model ----------

function modelsFromFile() {
  if (has('all')) return { ids: [], source: '--all', total: 0 };
  if (!fs.existsSync(FILE)) {
    L.line(col.yellow(`[!] ${FILE} tidak ada. Jalankan test [1] dulu.`));
    return { ids: [], source: 'auto-combo', total: 0 };
  }
  try {
    const prev = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (prev.models && Array.isArray(prev.models) && !has('all-passed')) {
      const total = prev.models.length;
      let ids = prev.models;
      const source = has('only') ? '--only' : 'auto-combo';
      if (MAX_BENCH > 0 && !has('only')) {
        ids = ids.slice(0, MAX_BENCH);
      }
      return { ids, source, total };
    }
    if (has('all-passed')) {
      const passed = (prev.results || []).filter((r) => r.ok).map((r) => r.id);
      return { ids: passed, source: '--all-passed', total: passed.length };
    }
    L.line(col.yellow(`[!] ${FILE} tidak memiliki daftar models, jatuh ke perilaku lama.`));
    const results = (prev.results || []).filter((r) => r.ok && r.smart !== false);
    const ids = results.sort((a, b) => (a.ms || 1e9) - (b.ms || 1e9)).map((r) => r.id);
    return { ids, source: 'auto-combo', total: ids.length };
  } catch (e) {
    L.line(col.yellow(`[!] ${FILE} rusak (${e.message}), memakai daftar dari /v1/models.`));
    return { ids: [], source: '--all', total: 0 };
  }
}


// ---------- Tier & combo ----------

function buildTiers(results) {
  const byScore = (x, y) => y.score - x.score || (x.avgMs ?? 1e9) - (y.avgMs ?? 1e9);
  const bySpeed = (x, y) => (x.avgMs ?? 1e9) - (y.avgMs ?? 1e9) || y.score - x.score;
  // Model yang pernah error request (429, timeout, 5xx) hasilnya tidak pasti, jadi tidak dimasukkan.
  const sure = results.filter((r) => !r.detail.errors);
  // Agent wajib lolos tool calling dan loop 2 langkah untuk hard dan medium.
  const agentReady = sure.filter((r) => r.detail.tool === 1 && r.detail.agent === 1);
  return {
    [`${PREFIX}-hard`]: agentReady.filter((r) => r.score >= 85).sort(byScore).slice(0, MAX),
    [`${PREFIX}-medium`]: agentReady.filter((r) => r.score >= 65).sort(bySpeed).slice(0, MAX),
    [`${PREFIX}-easy`]: sure.filter((r) => r.score >= 40).sort(bySpeed).slice(0, MAX),
  };
}

const tiersToIds = (tiers) => Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, v.map((r) => r.id)]));

const flag = (v) => (v === 1 ? col.green('1') : v === 0 ? col.red('0') : col.yellow(String(v)));

function formatRow(r, idx, total, maxIdWidth) {
  const d = r.detail;
  const s = UI.sym();
  const pColor = UI.colors.provider(L.prefixOf(r.id || ''));
  const sc = r.score >= 85 ? col.green : r.score >= 65 ? col.yellow : col.red;
  const counter = idx ? col.dim(`[${L.lpad(idx, String(total).length)}/${total}] `) : '';
  const mark = d.errors ? col.yellow(`  ${s.warn} ${d.errors} error`) : '';
  const modelId = r.id || '?';
  const paddedId = modelId + ' '.repeat(Math.max(0, (maxIdWidth || UI.visualWidth(modelId)) - UI.visualWidth(modelId)));
  const modelCol = pColor(paddedId);
  const scorePart = `${counter}${sc(L.lpad(r.score, 3) + '/100')}  ${modelCol}`;
  const detailsPart = `tool:${flag(d.tool)} agent:${flag(d.agent)} bal:${flag(d.isBalanced)} merge:${flag(d.mergeIntervals)} fix:${flag(d.fixBinarySearch)} expr:${flag(d.evalExpr)} csv:${flag(d.parseCSVLine)} ctx:${d.ctxError ? '?' : flag(d.needle)}  ${col.dim(r.avgMs ? r.avgMs + ' ms' : '-')}${mark}`;
  
  const line1 = `${scorePart}  ${detailsPart}`;
  const termWidth = UI.getTermWidth() || process.stdout.columns || 80;
  if (UI.visualWidth(line1) > termWidth) {
    const line2 = `       ${detailsPart}`;
    return `${scorePart}\n${line2}`;
  }
  return line1;
}

// Menyimpan hasil. Kalau run-nya sebagian (--only, --match, atau dihentikan), digabung dengan hasil lama
// supaya model lain tidak hilang dari combo.
function saveResults(fresh, partial) {
  let results = fresh;
  if (partial && fs.existsSync(RESULT_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')).results || [];
      const redone = new Set(fresh.map((r) => r.id));
      results = [...prev.filter((r) => !redone.has(r.id)), ...fresh];
    } catch { /* abaikan file lama yang rusak */ }
  }
  results.sort((a, b) => b.score - a.score);
  const tiers = buildTiers(results);
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ tested_at: new Date().toISOString(), tiers: tiersToIds(tiers), results }, null, 2));
  const txt = Object.entries(tiers)
    .map(([name, rs]) => `# ${name}\n${rs.map((r) => r.id).join('\n')}\n`)
    .join('\n');
  fs.writeFileSync(L.inResults('bench-combos.txt'), txt);
  return { results, tiers };
}

function printSummary({ results, tiers }) {
  const s = UI.sym();
  L.line('');
  L.line(col.cyan(col.bold('  COMBO BERTINGKAT')));
  L.line(col.dim('  ' + s.horiz.repeat(56)));
  for (const [name, rs] of Object.entries(tiers)) {
    L.line('');
    L.line(`  ${col.cyan(col.bold(name))}${rs.length ? '' : col.yellow('  (kosong: tidak ada model yang memenuhi syarat)')}`);
    rs.forEach((r, i) => {
      const pColor = UI.colors.provider(L.prefixOf(r.id));
      L.line(`    ${col.dim(L.lpad(i + 1, 2))}. ${pColor(r.id)}  ${col.dim(`(skor ${r.score})`)}`);
    });
  }
  const uncertain = results.filter((r) => r.detail.errors);
  if (uncertain.length) {
    L.line('');
    L.line(col.yellow(`  ${s.warn} Hasil tidak pasti (ada request error, tidak dimasukkan ke combo):`));
    uncertain.forEach((r) => L.line(`    ${s.fail} ${r.id}  skor ${r.score}, ${r.detail.errors} request error`));
  }
  return uncertain;
}

// ---------- Main ----------

async function applyFromSaved() {
  L.heading('BUAT COMBO DARI HASIL BENCHMARK');
  if (!fs.existsSync(RESULT_FILE)) {
    L.line(col.red('[!] bench-results.json belum ada. Jalankan benchmark dulu (menu 2).'));
    process.exitCode = 1;
    return;
  }
  let saved;
  try { saved = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')); } catch (e) {
    L.line(col.red(`[!] bench-results.json rusak (${e.message}). Jalankan benchmark ulang.`));
    process.exitCode = 1;
    return;
  }
  const ok = await L.applyCombos(cfg, saved.tiers || {});
  process.exitCode = ok ? 0 : 1;
}

async function main() {
  L.installCrashHandlers();
  if (has('help')) {
    const src = fs.readFileSync(__filename, 'utf8');
    console.log(src.split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?\n?/, '').replace(/^ \* ?/gm, ''));
    return;
  }
  L.startLog(has('apply') ? 'bench-apply' : 'bench', [`args: ${A.argv.join(' ') || '(tanpa opsi)'}`, `router: ${cfg.baseUrl}`]);
  L.warnUnknown(A.argv, KNOWN);
  if (has('apply')) return applyFromSaved();

  L.heading('BENCHMARK AGENT CODING');
  L.line(col.dim('  Menguji kemampuan tool calling, agent loop, dan koding kompleks'));
  L.line(`  Router  : ${cfg.baseUrl}`);
  L.line(`  API key : ${L.maskKey(cfg.apiKey)}`);
  const alive = await L.checkRouter(cfg);
  if (!alive.ok) {
    L.line(col.red(`\n[!] 9Router tidak bisa dihubungi di ${cfg.baseUrl}: ${alive.reason}`));
    process.exitCode = 1;
    return;
  }

  const inScope = (id) => {
    const p = prefixOf(id);
    if (SKIP_MODEL.test(id)) return false;
    if (ONLY.length && !ONLY.includes(p)) return false;
    return !EXCLUDE.includes(p);
  };
  const mf = modelsFromFile();
  let ids = mf.ids;
  const source = mf.source;
  const total = mf.total;

  if (has('all')) {
    ids = [];
  }

  let scoped = ids.filter(inScope);
  if (!scoped.length) {
    // Provider yang dipilih tidak ada di hasil tes sebelumnya (mis. dulu gagal semua): ambil dari router langsung.
    if (ids.length) L.line(col.dim('Provider itu tidak ada di hasil tes sebelumnya, mengambil daftar dari /v1/models...'));
    scoped = (await L.fetchAllModelIds(cfg)).filter(inScope);
  }
  ids = scoped;

  if (!ALL_VARIANTS) {
    const before = ids.length;
    ids = L.dropVariants(ids);
    if (before - ids.length) L.line(col.dim(`${before - ids.length} varian -thinking/-agentic dilewati (pakai --all-variants untuk menguji semuanya).`));
  }
  if (MATCH) {
    ids = ids.filter((id) => MATCH.test(id));
    L.line(`Filter nama /${MATCH.source}/: ${ids.length} model cocok.`);
  }

  const count = ids.length;
  let limitInfo = '';
  if (MAX_BENCH > 0 && !has('only') && total > MAX_BENCH && source === 'auto-combo') {
    limitInfo = ` (batas ${MAX_BENCH}, ubah dengan --max-bench)`;
  }
  let hintInfo = '';
  if (source !== '--all') {
    hintInfo = ` (pakai --all untuk semua model)`;
  }
  L.line(`Memakai ${count} model dari ${source === '--all-passed' ? 'auto-combo' : source}${limitInfo}${hintInfo}.`);
  L.line(col.dim(L.UI.wrapLegend('Legenda: tool=tool calling, agent=loop agent, bal=isBalanced, merge=mergeIntervals, fix=fixBinarySearch, expr=evalExpr, csv=parseCSVLine, ctx=konteks panjang')));
  if (MAX_PER_PROVIDER > 0) {
    // Urutan ids sudah dari yang tercepat. Supaya satu provider besar (mis. cl) tidak membanjiri tes,
    // tiap provider dibatasi; pakai --match untuk memilih model tertentu, atau --max-per-provider 0 untuk semua.
    const count = {};
    const trimmed = {};
    ids = ids.filter((id) => {
      const p = prefixOf(id);
      count[p] = (count[p] || 0) + 1;
      if (count[p] > MAX_PER_PROVIDER) { trimmed[p] = (trimmed[p] || 0) + 1; return false; }
      return true;
    });
    const t = Object.entries(trimmed).map(([p, n]) => `${p} -${n}`).join(', ');
    if (t) L.line(col.dim(`Dibatasi ${MAX_PER_PROVIDER} model per provider (${t}). Pakai --match atau --max-per-provider 0 untuk mengubah.`));
  }
  if (!ids.length) {
    L.line(col.red('\nTidak ada model untuk dites.'));
    process.exitCode = 1;
    return;
  }
  const partialRun = ONLY.length > 0 || Boolean(MATCH);
  L.line(`\nBenchmark ${ids.length} model x 8 tes. Model satu provider dites berurutan (bisa 10 menit lebih).`);
  L.line(col.dim('Ctrl+C = berhenti rapi, hasil sementara tetap disimpan. Setiap hasil dicetak sebagai baris biasa.\n'));

  const needle = buildNeedlePrompt();
  const collected = [];
  let stopping = false;
  let sigCount = 0;
  const t0 = Date.now();
  const maxIdWidth = ids.length ? Math.max(...ids.map(id => UI.visualWidth(id))) : 0;

  process.on('SIGINT', () => {
    sigCount++;
    if (sigCount > 1) {
      L.status('');
      L.line(col.red('\nKeluar paksa. Menyimpan hasil sementara...'));
      if (collected.length) { saveResults(collected, true); L.line(`Tersimpan: ${RESULT_FILE}`); }
      process.exit(130);
    }
    stopping = true;
    L.line(col.yellow('\n[!] Dihentikan. Menunggu model yang sedang berjalan selesai (Ctrl+C lagi = keluar paksa, hasil sementara disimpan).'));
  });

  await L.runByProvider(
    ids,
    async (id) => {
      let r;
      try {
        r = await benchModel(id, needle);
      } catch (e) {
        // Satu model yang error tidak boleh menjatuhkan seluruh benchmark.
        r = { id, score: 0, avgMs: null, detail: { tool: 0, agent: 0, isBalanced: 0, mergeIntervals: 0, fixBinarySearch: 0, evalExpr: 0, parseCSVLine: 0, needle: 0, errors: 1 } };
        L.line(col.red(`[!] ${id}: error tak terduga (${e.message}), ditandai tidak pasti.`));
      }
      collected.push(r);
      L.line(formatRow(r, collected.length, ids.length, maxIdWidth));
      L.status(`${UI.bar(collected.length, ids.length, { width: 20 })} ${L.fmtDur(Date.now() - t0)}`);
      return r;
    },
    CONCURRENCY,
    PROVIDER_PARALLEL,
    () => stopping
  );
  L.status('');

  if (!collected.length) {
    L.line(col.yellow('Dihentikan sebelum ada model yang selesai. Tidak ada yang disimpan.'));
    process.exitCode = 130;
    return;
  }
  const saved = saveResults(collected, partialRun || stopping);
  L.line(`\nSelesai dalam ${L.fmtDur(Date.now() - t0)} (${collected.length}/${ids.length} model).${stopping ? col.yellow(' Dihentikan lebih awal, hasil digabung dengan hasil lama.') : ''}`);
  const uncertain = printSummary(saved);

  L.line('');
  L.line(`Hasil lengkap : ${RESULT_FILE}`);
  L.line(`Daftar combo  : ${L.inResults('bench-combos.txt')}  (satu model per baris, siap paste di Dashboard > Combos)`);

  if (stopping) { process.exitCode = 130; return; }
  if (has('create')) {
    await L.applyCombos(cfg, tiersToIds(saved.tiers));
    writeLastRunBench({ ok: true, duration: Date.now() - t0, comboApplied: 3 });
  } else {
    // Saat GASPOLL_FROM_MENU=1, kotak "Langkah berikut" tidak ditampilkan
    if (process.env.GASPOLL_FROM_MENU !== '1') {
      L.line('');
      L.line(col.bold('Langkah berikut (salin barisnya):'));
      L.cmdLine('Buat 3 combo di 9Router dari hasil ini:', `node ${L.relCmd('bench-9router.js')} --apply`);
      if (uncertain.length) {
        const prefixes = [...new Set(uncertain.map((r) => prefixOf(r.id)))].join(',');
        L.cmdLine('Ulangi model yang hasilnya tidak pasti:', `node ${L.relCmd('bench-9router.js')} --only ${prefixes} --provider-parallel 2`);
      }
    }
    writeLastRunBench({ ok: true, duration: Date.now() - t0, comboApplied: 0 });
  }
}

function writeLastRunBench({ ok, duration, comboApplied }) {
  try {
    const L2 = require('./lib');
    const UI2 = require('./ui');
    const s = UI2.sym();
    const p = L2.inResults('last-run.json');
    const summary = ok
      ? `benchmark selesai ${s.mid} ${comboApplied ? `3 combo dibuat` : 'combo belum diterapkan'} ${s.mid} durasi ${L2.fmtDur(duration)}`
      : 'benchmark gagal';
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ok, duration, comboApplied, summary }));
  } catch { /* gagal tulis tidak boleh menggagalkan */ }
}

module.exports = { runTests, extractCode, CODE_TASKS };

if (require.main === module) {
  main().catch((e) => {
    L.line(col.red(`\n[!] Error: ${e.message}`));
    if (L.lastLogPath()) L.line(col.dim(`Log lengkap: ${L.lastLogPath()}`));
    process.exitCode = 1;
  });
}

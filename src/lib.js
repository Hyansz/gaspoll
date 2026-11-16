
// ---------------------------------------------------------------- clearScreen
function clearScreen() {
  const forceTTY = process.env.GASPOLL_FORCE_TTY === '1';
  const isTermTTY = forceTTY || (Boolean(process.stdout.isTTY) && !process.env.CI);
  if (!isTermTTY || process.env.GASPOLL_NOCLEAR) return;

  const methodsUsed = [];
  try {
    if (process.platform === 'win32') {
      const res = cp.spawnSync('cmd', ['/c', 'cls'], { stdio: 'inherit', windowsHide: true });
      methodsUsed.push(`cmd/cls:status=${res.status}`);
    }
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    methodsUsed.push('esc:2J3JH');
  } catch (e) {
    methodsUsed.push(`error:${e.message}`);
  }

  if (process.env.GASPOLL_DEBUG_CLEAR === '1') {
    try {
      const logDir = path.join(RESULTS, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const dbgLog = path.join(logDir, 'clear-debug.log');
      const stack = new Error().stack.split('\n')[2] || '';
      const caller = stack.trim();
      const lineStr = `${new Date().toISOString()} | caller: ${caller} | isTTY: ${Boolean(process.stdout.isTTY)} | methods: ${methodsUsed.join(',')}\n`;
      fs.appendFileSync(dbgLog, lineStr, 'utf8');
    } catch {}
  }
}

// ---------------------------------------------------------------- URL normalisasi
function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  u = u.replace(/\/v1\/?\/?$/i, '');
  u = u.replace(/\/+$/, '');
  if (u && !/^https?:/i.test(u)) u = 'http://' + u;
  return u || 'http://localhost:20128';
}

function classifyFailure(reasonStr) {
  return UI.failureKind(reasonStr);
}

// ---------------------------------------------------------------- fetchActiveApiKey
async function fetchActiveApiKey(cfg) {
  const cookie = await dashboardCookie(cfg);
  const h = { ...authHeaders(cfg), Cookie: cookie };
  const r = await fetchJson(cfg.baseUrl + '/api/keys', { headers: h }, 10000);
  if (!r.res.ok) throw new Error('Gagal GET /api/keys (HTTP ' + r.res.status + ')');
  const keys = r.body?.keys || [];
  const key = keys.find((k) => k.isActive) || keys[0];
  if (!key || !key.key) throw new Error('Tidak ada API key aktif di dashboard.');
  return key.key;
}

'use strict';
/**
 * lib.js - kode bersama untuk semua script 9Router Tools.
 * Isi: baca/simpan config, tampilan terminal (warna, baris status), log otomatis ke file,
 * salin ke clipboard, HTTP dengan timeout yang benar, daftar model, dan API combo.
 * Tanpa dependency, butuh Node 18+.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const UI = require('./ui');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = process.env.GASPOLL_RESULTS || path.join(ROOT, 'results');
const LOGS = path.join(RESULTS, 'logs');
try { fs.mkdirSync(LOGS, { recursive: true }); } catch { /* folder read-only, log dimatikan */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prefixOf = (id) => (id.includes('/') ? id.split('/')[0] : '');
const inResults = (f) => (path.isAbsolute(f) ? f : path.join(RESULTS, f));
const relCmd = (script) => path.join('src', script); // src\bench-9router.js di Windows

// ---------------------------------------------------------------- argumen

function makeArgs(argv = process.argv.slice(2)) {
  const has = (n) => argv.includes(`--${n}`);
  const opt = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const num = (n, d) => {
    const v = Number(opt(n, String(d)));
    return Number.isFinite(v) ? v : d;
  };
  return { argv, has, opt, list, num };
}

// Peringatan kalau salah ketik opsi (mis. --per-provder), supaya tidak diam-diam diabaikan.
function warnUnknown(argv, known) {
  const bad = argv.filter((a) => a.startsWith('--') && !known.includes(a.slice(2)));
  if (bad.length) {
    line(col.yellow(`[!] Opsi tidak dikenal diabaikan: ${bad.join(' ')}`));
    line(col.dim(`    Opsi yang tersedia: ${known.map((k) => '--' + k).join(' ')}`));
  }
}

// ---------------------------------------------------------------- config

let CONFIG_JSON = path.join(ROOT, 'config.json');
let CONFIG_BAT = path.join(ROOT, 'config.bat'); // format lama, tetap dibaca supaya tidak perlu isi ulang

function parseBat(text) {
  const out = {};
  for (const m of text.matchAll(/^\s*set\s+"?([A-Za-z_]+)=(.*?)"?\s*$/gim)) out[m[1]] = m[2];
  return out;
}

function loadConfig() {
  const cfg = { baseUrl: 'http://localhost:20128', apiKey: '', password: '', source: 'default' };
  try {
    const cfgPath = process.env.GASPOLL_CONFIG || CONFIG_JSON;
    if (fs.existsSync(cfgPath)) {
      Object.assign(cfg, JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')), { source: 'config.json' });
      cfg.configFile = cfgPath;
    } else if (fs.existsSync(CONFIG_BAT)) {
      const b = parseBat(fs.readFileSync(CONFIG_BAT, 'utf8'));
      if (b.NINE_ROUTER_BASE_URL) cfg.baseUrl = b.NINE_ROUTER_BASE_URL;
      if (b.NINE_ROUTER_API_KEY) cfg.apiKey = b.NINE_ROUTER_API_KEY;
      if (b.NINE_ROUTER_PASSWORD) cfg.password = b.NINE_ROUTER_PASSWORD;
      cfg.source = 'config.bat';
      cfg.configFile = CONFIG_BAT;
    }
  } catch (e) {
    line(col.yellow(`[!] Config rusak dan diabaikan: ${e.message}`));
  }
  const env = process.env;
  if (env.NINE_ROUTER_BASE_URL) cfg.baseUrl = env.NINE_ROUTER_BASE_URL;
  if (env.NINE_ROUTER_API_KEY) cfg.apiKey = env.NINE_ROUTER_API_KEY;
  if (env.NINE_ROUTER_PASSWORD) {
    cfg.password = env.NINE_ROUTER_PASSWORD;
    cfg.passwordSource = 'variabel lingkungan NINE_ROUTER_PASSWORD';
  }
  // Normalisasi alamat (tanpa /v1, tanpa trailing slash) setelah load
  cfg.baseUrl = normalizeUrl(cfg.baseUrl);
  if (cfg.password != null && typeof cfg.password !== 'string') cfg.password = String(cfg.password);
  if (!cfg.password) {
    cfg.password = '123456';
    cfg.passwordSource = 'bawaan 123456 (password belum diatur)';
  } else if (!cfg.passwordSource) {
    cfg.passwordSource = cfg.source === 'default' ? 'bawaan' : cfg.source;
  }
  return cfg;
}

function saveConfig(cfg) {
  const data = { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, password: cfg.password };
  fs.writeFileSync(CONFIG_JSON, JSON.stringify(data, null, 2), { mode: 0o600 });
}

const maskKey = (k) => (!k ? '(kosong)' : k.length <= 8 ? '****' : `${k.slice(0, 4)}****${k.slice(-4)}`);
const authHeaders = (cfg) => ({
  'Content-Type': 'application/json',
  ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
});

// ---------------------------------------------------------------- tampilan

const colorOn = () => {
  if (process.env.NO_COLOR || process.env.FORCE_COLOR === '0') return false;
  return Boolean(process.env.FORCE_COLOR) || Boolean(process.stdout.isTTY);
};
const paint = (code) => (s) => (colorOn() ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const col = {
  bold: paint(1), dim: paint(90), red: paint(31), green: paint(32),
  yellow: paint(33), cyan: paint(36), magenta: paint(35),
};
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const isTTY = () => Boolean(process.stdout.isTTY) && !process.env.CI;
let statusText = '';

// Baris status satu baris di paling bawah (hanya di terminal interaktif, tidak masuk log).
function status(text) {
  statusText = text;
  if (!isTTY()) return;
  const w = (process.stdout.columns || 100) - 1;
  process.stdout.write(text ? `\r${stripAnsi(text).slice(0, w)}\x1b[K` : '\r\x1b[2K');
}

// Semua hasil dicetak sebagai baris biasa (bukan ditimpa), jadi bisa di-scroll dan di-copy.
function line(s = '') {
  if (statusText && isTTY()) process.stdout.write('\r\x1b[2K');
  console.log(s);
  if (statusText && isTTY()) status(statusText);
}

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const rule = (ch = '=', n = 62) => ch.repeat(n);
function heading(title) {
  line('');
  line(col.cyan(col.bold(`  ${title}`)));
  const termW = UI.getTermWidth ? UI.getTermWidth() : 80;
  const w = Math.max(10, Math.min(termW, 74) - 2);
  const s = UI.sym ? UI.sym() : { dash: '─' };
  const ch = s.dash || s.horiz || '─';
  line(col.dim('  ' + ch.repeat(w)));
  line('');
}
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('id-ID') : '-');
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// Perintah dicetak di barisnya sendiri, tanpa hiasan, supaya bisa diblok dan disalin utuh.
function cmdLine(label, cmd) {
  line(col.dim(label));
  line(`  ${cmd}`);
}

// ---------------------------------------------------------------- log ke file

let logPath = null;

function startLog(name, header = []) {
  try {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    logPath = path.join(LOGS, `${name}-${ts}.log`);
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    stream.on('error', () => {});
    const tee = (target) => {
      const orig = target.write.bind(target);
      target.write = (chunk, ...rest) => {
        try {
          const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
          if (!s.startsWith('\r')) stream.write(stripAnsi(s).replace(/\r?\n/g, os.EOL)); // baris status tidak ikut
        } catch { /* log tidak boleh merusak proses */ }
        return orig(chunk, ...rest);
      };
    };
    tee(process.stdout);
    tee(process.stderr);
    fs.writeFileSync(path.join(LOGS, 'latest.txt'), logPath);
    pruneLogs(40);
    const head1 = `# ${name} | ${d.toLocaleString('id-ID')} | node ${process.version} | ${process.platform}`;
    const headRest = header.map((h) => `# ${h}`);
    if (process.env.GASPOLL_FROM_MENU === '1') {
      stream.write(head1 + os.EOL);
      headRest.forEach((h) => stream.write(h + os.EOL));
    } else {
      console.log(head1);
      headRest.forEach((h) => console.log(h));
    }
  } catch { /* tanpa log */ }
  return logPath;
}

function pruneLogs(keep) {
  try {
    const files = fs.readdirSync(LOGS).filter((f) => f.endsWith('.log')).sort();
    files.slice(0, Math.max(0, files.length - keep)).forEach((f) => fs.unlinkSync(path.join(LOGS, f)));
  } catch { /* abaikan */ }
}

function lastLogPath() {
  try {
    const p = fs.readFileSync(path.join(LOGS, 'latest.txt'), 'utf8').trim();
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- clipboard & buka file

function copyText(text) {
  if (process.env.GASPOLL_CLIP_STUB) {
    try { require('fs').writeFileSync(process.env.GASPOLL_CLIP_STUB, String(text), 'utf8'); return Promise.resolve(true); } catch { return Promise.resolve(false); }
  }

  const tries = [];
  if (process.platform === 'win32') {
    // clip.exe membaca UTF-16 LE dengan BOM dengan benar (huruf non-ASCII tidak rusak)
    tries.push(['clip', [], Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(text), 'utf16le')])]);
  } else if (process.platform === 'darwin') {
    tries.push(['pbcopy', [], Buffer.from(String(text))]);
  } else {
    tries.push(['wl-copy', [], Buffer.from(String(text))]);
    tries.push(['xclip', ['-selection', 'clipboard'], Buffer.from(String(text))]);
    tries.push(['xsel', ['--clipboard', '--input'], Buffer.from(String(text))]);
  }
  const attempt = ([cmd, args, buf]) => new Promise((resolve) => {
    try {
      const c = cp.spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      c.on('error', () => resolve(false));
      c.on('close', (code) => resolve(code === 0));
      c.stdin.on('error', () => {});
      c.stdin.end(buf);
    } catch { resolve(false); }
  });
  const fallbackWin = async () => {
    if (process.platform !== 'win32') return false;
    try {
      const os = require('os');
      const fs2 = require('fs');
      const path2 = require('path');
      const tmp = path2.join(os.tmpdir(), `gaspoll-clip-${Date.now()}.txt`);
      fs2.writeFileSync(tmp, String(text), 'utf8');
      const r = cp.spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Get-Content -Raw -Encoding UTF8 -LiteralPath '${tmp.replace(/'/g, "''")}' | Set-Clipboard`], { windowsHide: true, timeout: 5000 });
      try { fs2.unlinkSync(tmp); } catch {}
      return r.status === 0;
    } catch { return false; }
  };
  return (async () => {
    for (const t of tries) if (await attempt(t)) return true;
    if (await fallbackWin()) return true;
    try {
      const os2 = require('os');
      const fs3 = require('fs');
      const path3 = require('path');
      const p = path3.join(RESULTS, 'salin-log.txt');
      fs3.writeFileSync(p, String(text), 'utf8');
    } catch {}
    return false;
  })();
}

function openPath(target) {
  try {
    if (process.platform === 'win32') cp.exec(`start "" "${target}"`, { windowsHide: true });
    else {
      const child = cp.spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
    }
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- HTTP

// Timeout berlaku sampai seluruh body selesai dibaca. Sebelumnya abort saat membaca body
// diam-diam dianggap "bukan JSON", sehingga daftar model tampak kosong atau respons tampak kosong.
async function fetchJson(url, init = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* bukan JSON */ }
    return { res, body, text };
  } catch (e) {
    const err = new Error();
    if (ctrl.signal.aborted || e.name === 'AbortError') {
      err.code = 'TIMEOUT';
      err.message = `timeout > ${timeoutMs / 1000}s`;
    } else {
      const c = e.cause && (e.cause.code || e.cause.message);
      err.code = c === 'ECONNREFUSED' ? 'REFUSED' : 'NETWORK';
      err.message = c ? `${e.message} (${c})` : e.message;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const errText = (body, res, limit = 160) => {
  const m = body?.error?.message ?? body?.error ?? body?.message ?? '';
  const s = typeof m === 'string' ? m : JSON.stringify(m);
  return (s || (res ? `HTTP ${res.status}` : '')).replace(/\s+/g, ' ').slice(0, limit);
};

// ---------------------------------------------------------------- klasifikasi kegagalan tes provider
// 9Router membungkus error upstream dengan HTTP 500/502/503; status aslinya ada di dalam pesan
// ("[429]", "[402]"). Karena itu isi pesan dibaca lebih dulu, baru status luar.
// level: 'provider' = berlaku untuk seluruh provider (kredensial, saldo, akun)
//        'soft'     = baru dianggap masalah provider kalau berulang dan belum ada model yang lolos
//        'model'    = hanya model itu sendiri
const FAIL_RE = {
  noCred: /no active credentials/i,
  balance: /insufficient[ _]balance|credit balance (is )?(too )?low|run out of credits|out of credits|insufficient[_ ]quota|add (usage )?credits|credits required|payment required/i,
  plan: /not available on[^.]{0,40}plan|workers free plan|requires? (a )?(paid|pro) (plan|subscription)|paid model|upgrade (your )?(plan|subscription)/i,
  quota: /exceeded (your )?(current )?(quota|usage)|quota (has been )?(exceeded|exhausted|used)|used up (today|your)|usage limit|free[- ]usage[- ]exhausted|daily (limit|quota|free)|reached (the|your) (limit|quota)/i,
  rate: /rate.?limit|too many requests|requests? per (second|minute|hour)|slow down/i,
  auth: /account (has been )?(disabled|suspended|banned)|invalid (api )?key|api key[^.]{0,30}(invalid|blocked|revoked|expired)|unauthori[sz]ed|authentication (failed|required)|login expired|request illegal|forbidden|invalid token|token (expired|rejected)/i,
  gone: /has been (deprecated|removed|retired|discontinued)|end of life|no longer (available|supported)|model_gone|deprecated/i,
  noModel: /unsupported ?model|no such model|model[^.]{0,60}(not found|does not exist|not available|not supported)|requested entity was not found|please check the model|unknown model|invalid model/i,
  timeout: /^timeout|timed out/i,
  network: /econnrefused|enotfound|econnreset|fetch failed|socket hang up|network/i,
  empty: /^respons kosong/i,
};

function innerStatus(text) {
  const m = String(text || '').match(/\[(\d{3})\]/) || String(text || '').match(/"code"\s*:\s*(\d{3})(?!\d)/);
  const n = m ? parseInt(m[1], 10) : null;
  return n && n >= 400 && n <= 599 ? n : null;
}

function classifyTestFailure(reason, httpStatus) {
  const text = String(reason || '');
  const code = innerStatus(text) || httpStatus || null;
  const out = (category, level, extra) => ({ category, level, code, ...(extra || {}) });

  if (FAIL_RE.timeout.test(text)) return out('timeout', 'soft');
  if (FAIL_RE.noCred.test(text)) return out('tanpa kredensial', 'provider');
  if (FAIL_RE.balance.test(text) || code === 402) return out('saldo habis', 'provider');
  if (FAIL_RE.quota.test(text)) return out('kuota habis', 'soft');
  if (FAIL_RE.plan.test(text)) return out('batasan paket', 'model');
  if (FAIL_RE.rate.test(text) || code === 429) return out('rate limit', 'model', { retry: true });
  if (FAIL_RE.auth.test(text) || code === 401 || code === 403) return out('auth ditolak', 'provider');
  if (FAIL_RE.gone.test(text) || code === 410) return out('model dihentikan', 'model');
  if (FAIL_RE.noModel.test(text) || code === 404) return out('model tidak ada', 'model');
  if (FAIL_RE.empty.test(text)) return out('respons kosong', 'model');
  if (FAIL_RE.network.test(text) && !code) return out('koneksi gagal', 'model');
  if (code >= 500) return out('error server', 'soft');
  if (code === 400) return out('ditolak provider', 'model');
  return out('error lain', 'model');
}

// Aturan pemutus per provider. 'distinct' = jumlah model BERBEDA dengan kategori itu,
// 'streak' = kegagalan berturut-turut dengan kategori yang sama. Provider yang sudah punya
// minimal satu model lolos tidak pernah dilewati penuh.
const BREAKER_RULES = {
  'tanpa kredensial': { need: 2, mode: 'distinct' },
  'saldo habis': { need: 2, mode: 'distinct' },
  'auth ditolak': { need: 3, mode: 'distinct' },
  'kuota habis': { need: 4, mode: 'streak' },
  'timeout': { need: 3, mode: 'streak' },
  'error server': { need: 3, mode: 'streak' },
};

function createProviderBreaker(rules = BREAKER_RULES) {
  const st = {};
  const get = (p) => (st[p] = st[p] || { passed: 0, distinct: {}, streakCat: null, streak: 0, skip: null });
  return {
    // null = lanjut menguji; objek = lewati provider ini ({ category, count })
    check(p) { const s = st[p]; return s && s.skip ? { ...s.skip } : null; },
    record(p, id, result) {
      const s = get(p);
      if (result.ok) { s.passed++; s.skip = null; s.streakCat = null; s.streak = 0; return null; }
      if (result.skipped) return s.skip;
      const cat = result.category || 'error lain';
      if (s.streakCat === cat) s.streak++; else { s.streakCat = cat; s.streak = 1; }
      (s.distinct[cat] = s.distinct[cat] || new Set()).add(id);
      if (s.passed > 0 || s.skip) return s.skip;
      const rule = rules[cat];
      if (!rule) return null;
      const n = rule.mode === 'streak' ? s.streak : s.distinct[cat].size;
      if (n >= rule.need) s.skip = { category: cat, count: n };
      return s.skip;
    },
  };
}

const SKIP_TEXT = {
  'tanpa kredensial': 'provider belum terhubung di 9Router (No active credentials)',
  'saldo habis': 'saldo/kredit provider habis',
  'auth ditolak': 'akses/akun ditolak provider',
  'kuota habis': 'kuota provider habis berturut-turut',
  'timeout': 'provider timeout berturut-turut (tampaknya menggantung)',
  'error server': 'provider error server berturut-turut',
};
const skipReason = (category) => `dilewati: ${SKIP_TEXT[category] || category}`;

// Saran tindakan untuk user (ASCII saja, maksimal ~48 karakter supaya muat di layar 100 kolom).
const CATEGORY_ADVICE = {
  'tanpa kredensial': 'isi API key/login di dashboard 9Router',
  'saldo habis': 'isi saldo atau hapus koneksi tak terpakai',
  'auth ditolak': 'cek akun/API key (login kedaluwarsa?)',
  'kuota habis': 'tunggu kuota reset atau pakai provider lain',
  'rate limit': 'ulangi nanti atau pakai --provider-parallel 1',
  'batasan paket': 'model butuh paket berbayar, abaikan saja',
  'model dihentikan': 'model sudah pensiun, hapus dari combo',
  'model tidak ada': 'nama model tak dikenal provider, cek namanya',
  'timeout': 'provider lambat/mati, naikkan --timeout',
  'error server': 'provider/9Router bermasalah, coba lagi nanti',
  'respons kosong': 'model tidak menjawab, mungkin bukan model chat',
  'koneksi gagal': 'pastikan 9Router masih berjalan',
  'ditolak provider': 'permintaan ditolak, cek model/parameter',
};

async function checkRouter(cfg, timeoutMs = 5000) {
  try {
    await fetchJson(cfg.baseUrl, {}, timeoutMs);
    return { ok: true };
  } catch (e) {
    const why = e.code === 'REFUSED' ? 'tidak ada yang mendengarkan di alamat itu (9Router belum jalan?)' : e.message;
    return { ok: false, reason: why };
  }
}

// ---------------------------------------------------------------- model

const SKIP_MODEL_DEFAULT =
  'parakeet|whisper|embed|rerank|(^|[-/_])(asr|tts)($|[-/_.])|image|voxtral|audio|safeguard|guard|lyria|:batch|llama-3\\.2-(1b|3b)';

// Cache model IDs
const MODELS_CACHE_FILE = path.join(RESULTS, 'models-cache.json');
const MODELS_CACHE_FRESH_MS = 60_000;       // 60 detik: pakai cache, tanpa jaringan
const MODELS_CACHE_STALE_MS = 24 * 3_600_000; // 24 jam: stale-while-revalidate
const MODELS_FETCH_TIMEOUT_MS = () => {
  const env = parseInt(process.env.GASPOLL_MODELS_TIMEOUT_MS, 10);
  return Number.isFinite(env) && env > 0 ? env : 15000;
};
const MODELS_CACHE_INFLIGHT = new Map(); // key -> Promise (dedupe in-flight)

// Hash sederhana untuk kunci cache (tanpa menulis API key)
function modelCacheKey(baseUrl, apiKey) {
  const crypto = require('crypto');
  const keyHash = crypto.createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 16);
  return `${baseUrl}|${keyHash}`;
}

// Baca cache (atomik, toleran terhadap file rusak)
function readModelsCache() {
  try {
    if (!fs.existsSync(MODELS_CACHE_FILE)) return { version: 1, entries: {} };
    const raw = fs.readFileSync(MODELS_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
      return { version: 1, entries: {} };
    }
    return parsed;
  } catch {
    return { version: 1, entries: {} };
  }
}

// Tulis cache (atomik: .tmp lalu rename)
function writeModelsCache(cache) {
  try {
    const tmp = MODELS_CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, MODELS_CACHE_FILE);
  } catch { /* tulis cache gagal: tidak fatal */ }
}

// Ambil model dari 9Router (fetch asli, tanpa cache)
async function fetchModelsFromRouter(cfg, timeoutMs) {
  const r = await fetchJson(`${cfg.baseUrl}/v1/models`, { headers: authHeaders(cfg) }, timeoutMs);
  const { res, body } = r;
  if (res.status === 401 || res.status === 403) throw new Error(`API key ditolak (HTTP ${res.status}). Ganti lewat menu [7] di gaspoll.bat.`);
  if (!res.ok) throw new Error(`GET /v1/models gagal (HTTP ${res.status}). Cek alamat router dan API key.`);
  if (!body || !Array.isArray(body.data)) throw new Error('Respons /v1/models bukan daftar model yang valid.');
  return body.data.filter((m) => m.owned_by !== 'combo' && m.type !== 'combo').map((m) => m.id);
}

async function fetchAllModelIds(cfg) {
  const key = modelCacheKey(cfg.baseUrl, cfg.apiKey);
  const noCache = process.env.GASPOLL_NO_MODELS_CACHE === '1';
  const timeoutMs = MODELS_FETCH_TIMEOUT_MS();
  const cache = readModelsCache();
  const entry = cache.entries[key];
  const now = Date.now();

  // 1. Cache segar (< 60 detik): kembalikan cache, tanpa jaringan
  if (!noCache && entry && now - entry.fetchedAt < MODELS_CACHE_FRESH_MS) {
    return entry.ids;
  }

  // 2. Cache stale (60 dtk - 24 jam): kembalikan cache segera, refresh di latar belakang
  if (!noCache && entry && entry.ids && entry.ids.length > 0 && now - entry.fetchedAt < MODELS_CACHE_STALE_MS) {
    // In-flight dedupe: kalau sudah ada refresh yang sedang jalan, pakai itu
    if (MODELS_CACHE_INFLIGHT.has(key)) {
      return entry.ids; // kembalikan cache, refresh sudah berjalan
    }
    // Mulai refresh di latar belakang (tidak menahan)
    const refreshPromise = fetchModelsFromRouter(cfg, timeoutMs)
      .then((ids) => {
        if (ids && ids.length > 0) {
          const freshCache = readModelsCache();
          freshCache.entries[key] = { fetchedAt: Date.now(), ids };
          writeModelsCache(freshCache);
        }
      })
      .catch(() => { /* refresh gagal: pakai cache lama */ })
      .finally(() => MODELS_CACHE_INFLIGHT.delete(key));
    MODELS_CACHE_INFLIGHT.set(key, refreshPromise);
    return entry.ids;
  }

  // 3. Tidak ada cache / cache > 24 jam / noCache: fetch biasa (menunggu)
  // Cetak pesan jika fetch membutuhkan waktu
  const fetchStart = Date.now();
  let slowMsgShown = false;
  const slowTimer = setTimeout(() => {
    slowMsgShown = true;
    line(col.yellow('Memuat daftar model dari 9Router (pertama kali bisa lama bila model banyak)...'));
  }, 2000);

  let ids;
  try {
    ids = await fetchModelsFromRouter(cfg, timeoutMs);
  } catch (e) {
    clearTimeout(slowTimer);
    // Fetch gagal: pakai cache lama kalau ada
    if (entry && entry.ids && entry.ids.length > 0) {
      line(col.yellow(`Fetch gagal, memakai cache lama (${Math.round((now - entry.fetchedAt) / 60000)} menit lalu).`));
      return entry.ids;
    }
    if (e.message && (e.message.includes('timeout') || e.message.includes(`dalam ${Math.round(timeoutMs / 1000)} detik`))) {
      throw new Error(`9Router belum membalas /v1/models dalam ${Math.round(timeoutMs / 1000)} detik. Coba lagi atau naikkan GASPOLL_MODELS_TIMEOUT_MS.`);
    }
    throw e;
  }
  clearTimeout(slowTimer);

  // 4. Tulis cache baru
  cache.entries[key] = { fetchedAt: Date.now(), ids };
  writeModelsCache(cache);
  return ids;
}

// Varian -thinking / -agentic dianggap model yang sama; ambil versi paling polos saja.
function dropVariants(items, getId = (x) => x) {
  const best = new Map();
  for (const it of items) {
    const id = getId(it);
    const key = id.replace(/-(thinking|agentic)/g, '');
    if (!best.has(key) || id.length < getId(best.get(key)).length) best.set(key, it);
  }
  const keep = new Set(best.values());
  return items.filter((it) => keep.has(it));
}

// ---------------------------------------------------------------- pool

// Worker yang melempar error tidak boleh menjatuhkan seluruh run (dan membuang hasil puluhan menit).
async function runPool(items, worker, size, shouldStop = () => false) {
  const out = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (idx < items.length && !shouldStop()) {
      const my = idx++;
      try { out[my] = await worker(items[my], my); } catch (e) {
        line(col.red(`[!] Error tak terduga pada ${items[my]}: ${e.message}`));
      }
    }
  });
  await Promise.all(runners);
  return out;
}

// Provider berbeda jalan bersamaan; model dalam satu provider dibatasi supaya tidak kena rate limit.
async function runByProvider(ids, worker, groupsParallel, perProvider, shouldStop) {
  const groups = {};
  ids.forEach((id) => { (groups[prefixOf(id)] = groups[prefixOf(id)] || []).push(id); });
  const out = {};
  await runPool(
    Object.values(groups),
    (g) => runPool(g, async (id) => { out[id] = await worker(id); }, perProvider, shouldStop),
    groupsParallel,
    shouldStop
  );
  return ids.map((id) => out[id]).filter(Boolean);
}

// ---------------------------------------------------------------- combo

async function dashboardCookie(cfg) {
  let r;
  try {
    r = await fetchJson(`${cfg.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: cfg.password }),
    }, 15000);
  } catch (e) { throw new Error(`login dashboard gagal: ${e.message}`); }
  if (!r.res.ok) {
    const pw = String(cfg.password || '');
    const st = r.res.status;
    const detail = errText(r.body, r.res);
    const hint = st === 429
      ? `terlalu banyak percobaan login, tunggu ${r.res.headers.get('retry-after') || 'beberapa'} detik lalu coba lagi`
      : st >= 500
        ? 'server error di 9Router, bukan masalah password'
        : r.body && r.body.mustChangePassword
          ? '9Router meminta password diganti dulu: buka dashboard di browser dan atur password'
          : 'cek password di menu [7]';
    const err = new Error(`login dashboard gagal (HTTP ${st}${detail && !/^HTTP \d+$/.test(detail) ? `: ${detail}` : ''}), ${hint}`);
    err.diag = [
      `password dari : ${cfg.passwordSource || 'config'} (${pw.length} karakter${pw !== pw.trim() ? ', ADA spasi di awal/akhir' : ''})`,
      `berkas config : ${cfg.configFile || '(tidak ada config.json, memakai bawaan)'}`,
      `alamat router : ${cfg.baseUrl}`,
      'Password harus sama dengan yang dipakai login ke dashboard 9Router di browser.',
    ];
    throw err;
  }
  const sc = r.res.headers.getSetCookie ? r.res.headers.getSetCookie() : [r.res.headers.get('set-cookie')];
  const cookie = sc.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  if (!cookie && r.body && r.body.mustChangePassword) {
    const err = new Error('login dashboard ditolak: 9Router meminta password diganti dulu. Buka dashboard di browser, atur password, lalu isi di menu [7]');
    err.diag = [`alamat router : ${cfg.baseUrl}`];
    throw err;
  }
  return cookie;
}

async function updateCombo(cfg, h, name, models) {
  try {
    const lr = await fetchJson(`${cfg.baseUrl}/api/combos`, { headers: h }, 15000);
    const arr = Array.isArray(lr.body) ? lr.body : lr.body?.combos || [];
    const found = arr.find((c) => c.name === name);
    if (!lr.res.ok || !found?.id) return { ok: false, reason: 'sudah ada dan tidak bisa ditemukan untuk diperbarui' };

    // Coba PUT ke /api/combos/:id
    const pr = await fetchJson(`${cfg.baseUrl}/api/combos/${found.id}`, {
      method: 'PUT', headers: h, body: JSON.stringify({ name, models }),
    }, 15000);

    let success = pr.res.ok;
    if (success) {
      // Verifikasi read-after-write
      const vr = await fetchJson(`${cfg.baseUrl}/api/combos`, { headers: h }, 15000);
      const varr = Array.isArray(vr.body) ? vr.body : vr.body?.combos || [];
      const vfound = varr.find((c) => c.name === name);
      if (vfound && Array.isArray(vfound.models) && JSON.stringify(vfound.models) === JSON.stringify(models)) {
        return { ok: true, updated: true };
      }
      success = false; // PUT berhasil tapi isi belum sinkron, coba fallback DELETE + POST
    }

    if (!success) {
      // Fallback: DELETE lalu POST ulang
      const dr = await fetchJson(`${cfg.baseUrl}/api/combos/${found.id}`, {
        method: 'DELETE', headers: h,
      }, 15000);
      if (!dr.res.ok) return { ok: false, reason: `gagal memperbarui (DELETE lama gagal HTTP ${dr.res.status})` };

      // POST baru, dengan retry 1x jika gagal (untuk antisipasi timeout/network)
      let sr = await fetchJson(`${cfg.baseUrl}/api/combos`, {
        method: 'POST', headers: h, body: JSON.stringify({ name, models }),
      }, 15000);
      if (!sr.res.ok) {
        sr = await fetchJson(`${cfg.baseUrl}/api/combos`, {
          method: 'POST', headers: h, body: JSON.stringify({ name, models }),
        }, 15000);
      }
      if (!sr.res.ok) return { ok: false, reason: `gagal memperbarui (POST baru gagal HTTP ${sr.res.status}) ${errText(sr.body, sr.res)}. Combo lama sudah terhapus, jalankan lagi --apply untuk membuat ulang.` };

      // Verifikasi read-after-write akhir
      const vr2 = await fetchJson(`${cfg.baseUrl}/api/combos`, { headers: h }, 15000);
      const varr2 = Array.isArray(vr2.body) ? vr2.body : vr2.body?.combos || [];
      const vfound2 = varr2.find((c) => c.name === name);
      if (vfound2 && Array.isArray(vfound2.models) && JSON.stringify(vfound2.models) === JSON.stringify(models)) {
        return { ok: true, updated: true };
      }
      return { ok: false, reason: 'gagal verifikasi read-after-write setelah DELETE+POST' };
    }

    return { ok: true, updated: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

async function saveCombo(cfg, cookie, name, models) {
  const h = { ...authHeaders(cfg), ...(cookie ? { Cookie: cookie } : {}) };
  try {
    const { res, body, text } = await fetchJson(`${cfg.baseUrl}/api/combos`, {
      method: 'POST', headers: h, body: JSON.stringify({ name, models }),
    }, 15000);
    if (res.ok) return { ok: true };
    if (/already exists/i.test(text || '')) return updateCombo(cfg, h, name, models);
    if (res.status === 401) return { ok: false, reason: 'ditolak (401), password dashboard salah atau kosong' };
    return { ok: false, reason: `HTTP ${res.status} ${errText(body, res)}` };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// tierMap: { namaCombo: [idModel, ...] }. Mengembalikan true jika semua yang dicoba berhasil.
async function applyCombos(cfg, tierMap) {
  let cookie = '';
  if (cfg.password) {
    try { cookie = await dashboardCookie(cfg); } catch (e) {
      line(col.yellow(`[!] Login dashboard dilewati: ${e.message} (mencoba tanpa cookie)`));
      (e.diag || []).forEach((d) => line(col.dim(`        ${d}`)));
      if (path.basename(process.argv[1] || '') === 'test-9router.js') {
        line(col.dim(`        Tanpa tes ulang: node ${relCmd('test-9router.js')} --apply --name ${Object.keys(tierMap)[0] || 'auto-combo'}`));
      }
      cookie = '';
    }
  }
  let allOk = true;
  for (const [name, ids] of Object.entries(tierMap)) {
    if (!ids.length) { line(col.yellow(`[LEWAT] combo "${name}" kosong, tidak dibuat`)); continue; }
    const r = await saveCombo(cfg, cookie, name, ids);
    if (r.ok) line(col.green(`[OK] combo "${name}" ${r.updated ? 'diperbarui' : 'dibuat'} (${ids.length} model)`));
    else { allOk = false; line(col.red(`[GAGAL] combo "${name}": ${r.reason}`)); }
  }
  return allOk;
}

// ---------------------------------------------------------------- error tak terduga

function installCrashHandlers() {
  const crash = (e) => {
    line('');
    line(col.red(`[!] Error tak terduga: ${e && e.message ? e.message : e}`));
    if (e && e.stack) line(col.dim(e.stack.split('\n').slice(1, 6).join('\n')));
    if (logPath) line(col.dim(`Log lengkap: ${logPath}`));
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
}

module.exports = {
  ROOT, RESULTS, LOGS, sleep, prefixOf, inResults, relCmd,
  makeArgs, warnUnknown, loadConfig, saveConfig, maskKey, authHeaders, CONFIG_JSON,
  normalizeUrl, classifyFailure, fetchActiveApiKey, clearScreen,
  col, stripAnsi, status, line, pad, lpad, rule, heading, fmtTime, fmtDur, cmdLine, UI,
  startLog, lastLogPath, copyText, openPath,
  fetchJson, errText, checkRouter, SKIP_MODEL_DEFAULT, fetchAllModelIds, dropVariants,
  classifyTestFailure, createProviderBreaker, BREAKER_RULES, skipReason, CATEGORY_ADVICE,
  modelCacheKey, // export untuk test
  runPool, runByProvider, dashboardCookie, saveCombo, applyCombos, installCrashHandlers,
};

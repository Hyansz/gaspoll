'use strict';
const fs = require('fs');
const path = require('path');

const getVersion = () => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
};

/**
 * ui.js - CLI UI helpers.
 *
 * Dua lapisan:
 *  1. Helper generik lama (box, badge, kv, bar, relativeTime, shortenReason, failureKind, FAIL_HINT,
 *     visualWidth, truncate, sym, hr, colors) - dipakai oleh layar proses
 *     (test-9router, bench-9router, show-results, auto). TIDAK diubah perilakunya.
 *  2. Desain GASPOLL Metalik (c, renderBanner, supportsColor/Unicode, getColorDepth)
 *     - khusus menu utama di cli.js dan pratinjau.
 *
 * Zero-dependency, ANSI escape code (16/256/truecolor).
 */

// ---------------------------------------------------------------- deteksi kemampuan

const supportsColor = () => {
  if (process.env.NO_COLOR || process.env.FORCE_COLOR === '0') return false;
  const depth = getColorDepth();
  if (depth <= 1) return false;
  return true;
};

const getColorDepth = () => {
  if (process.env.NO_COLOR) return 1;
  if (process.env.FORCE_COLOR === '0') return 1;
  if (process.env.FORCE_COLOR === '3') return 24;
  if (process.env.FORCE_COLOR === '2') return 8;
  if (process.env.FORCE_COLOR === '1') return 4;
  if (typeof process.stdout.getColorDepth === 'function') {
    const d = process.stdout.getColorDepth();
    if (d === 24) return 24;
    if (d === 256) return 8;
    if (d === 16) return 4;
  }
  return process.stdout.isTTY ? 8 : 1;
};

// Unicode aktif bila: GASPOLL_UNICODE=1 / --unicode, atau WT_SESSION, TERM_PROGRAM,
// ConEmuANSI terisi, atau TERM terisi dan bukan linux/dumb, atau non-win32 + TTY.
// Override: GASPOLL_ASCII=1 / --ascii memaksa ASCII.
const supportsUnicode = () => {
  let reason = 'default_ascii';
  let res = false;

  if (process.env.GASPOLL_ASCII === '1') {
    reason = 'GASPOLL_ASCII=1';
    res = false;
  } else if (process.argv.slice(2).includes('--ascii')) {
    reason = 'argv --ascii';
    res = false;
  } else if (process.env.GASPOLL_UNICODE === '1' || process.argv.slice(2).includes('--unicode')) {
    reason = process.env.GASPOLL_UNICODE === '1' ? 'GASPOLL_UNICODE=1' : 'argv --unicode';
    res = true;
  } else if (process.env.NO_COLOR || process.env.FORCE_COLOR === '0') {
    reason = 'NO_COLOR or FORCE_COLOR=0';
    res = false;
  } else {
    const env = process.env;
    if (env.WT_SESSION) { reason = 'env.WT_SESSION'; res = true; }
    else if (env.TERM_PROGRAM) { reason = 'env.TERM_PROGRAM'; res = true; }
    else if (env.ConEmuANSI) { reason = 'env.ConEmuANSI'; res = true; }
    else {
      const term = String(env.TERM || '');
      if (term && term !== 'linux' && term !== 'dumb') {
        reason = `env.TERM=${term}`;
        res = true;
      } else if (process.platform !== 'win32' && env.LANG && /UTF-8|UTF8/i.test(env.LANG)) {
        reason = `env.LANG=${env.LANG}`;
        res = true;
      } else {
        reason = 'default fallback (no terminal hint)';
        res = false;
      }
    }
  }

  if (process.env.GASPOLL_DEBUG_UNICODE === '1') {
    const path = require('path');
    const scriptName = path.basename(process.argv[1] || 'script');
    console.error(`[unicode] ${scriptName} keputusan=${res} alasan=${reason}`);
  }

  return res;
};

const getTermWidth = () => {
  const w = process.stdout.columns || 80;
  return Math.max(40, Math.min(w, 120));
};

// ---------------------------------------------------------------- helper generik (kontrak lama)

const paint = (code) => (s) => (supportsColor() ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const colors = {
  bold: paint(1), dim: paint(90), red: paint(31), green: paint(32),
  yellow: paint(33), cyan: paint(36), magenta: paint(35),
  blue: paint(34),
  provider: (p) => {
    const name = String(p || '').toLowerCase();
    if (name.includes('gemini') || name.includes('google')) return paint(36);
    if (name.includes('claude') || name.includes('anthropic')) return paint(33);
    if (name.includes('openai') || name.includes('gpt')) return paint(32);
    if (name.includes('deepseek')) return paint(35);
    if (name.includes('groq')) return paint(34);
    if (name.includes('cf') || name.includes('cloudflare')) return paint(31);
    return paint(36);
  },
};

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const VISUAL_CACHE = new Map();
function visualWidth(s) {
  if (VISUAL_CACHE.has(s)) return VISUAL_CACHE.get(s);
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ? 2 : 1;
  }
  VISUAL_CACHE.set(s, w);
  return w;
}

// Simbol menu GASPOLL dengan fallback ASCII
const sym = () => {
  const uni = supportsUnicode();
  return {
    bullet: uni ? '●' : '*',
    circle: uni ? '○' : 'o',
    pointer: uni ? '▸' : '>',
    arrow: uni ? '›' : '>',
    mid: uni ? '·' : '|',
    dash: uni ? '─' : '-',
    // Simbol layar proses (dipakai helper generik lama)
    boxTopLeft: uni ? '╭' : '+',
    boxTopRight: uni ? '╮' : '+',
    boxBottomLeft: uni ? '╰' : '+',
    boxBottomRight: uni ? '╯' : '+',
    horiz: uni ? '─' : '-',
    vert: uni ? '│' : '|',
    success: uni ? '✔' : '[OK]',
    error: uni ? '✖' : '[FAIL]',
    fail: uni ? '✖' : '[FAIL]',
    warn: uni ? '⚠' : '[!]',
    spinner: uni ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['-', '\\', '|', '/'],
  };
};

function hr(char = '-', length) {
  const len = length || Math.min(getTermWidth(), 52);
  const uni = supportsUnicode();
  const ch = char === '=' ? (uni ? '━' : '=') : uni ? '─' : '-';
  return colors.dim(ch.repeat(len));
}

function truncate(s, maxWidth) {
  const plain = stripAnsi(s);
  if (visualWidth(plain) <= maxWidth) return s;
  const isUni = supportsUnicode();
  const ellipsis = isUni ? '\u2026' : '...';
  const ellipsisW = visualWidth(ellipsis);
  const targetW = Math.max(0, maxWidth - ellipsisW);

  let colorCode = '';
  const ansiOpen = /\x1b\[[0-9;]*m/g;
  for (const m of s.matchAll(ansiOpen)) {
    if (m[0] !== '\x1b[0m') colorCode = m[0];
  }
  let cut = '';
  let vw = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    const cw = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ? 2 : 1;
    if (vw + cw > targetW) break;
    vw += cw;
    cut += ch;
  }
  const result = cut + ellipsis;
  return colorCode ? colorCode + result + '\x1b[0m' : result;
}

function box(title, lines = [], { borderColor = 'cyan', width = 78 } = {}) {
  const s = sym();
  const borderFn = colors[borderColor] || colors.cyan;
  const w = Math.min(width, getTermWidth());
  const innerW = w - 4;
  const titlePart = ` ${title} `;
  const titleLen = visualWidth(titlePart);
  const dashTotal = Math.max(0, w - 2 - titleLen);
  const leftDashes = Math.ceil(dashTotal / 2);
  const rightDashes = dashTotal - leftDashes;
  const top = `${s.boxTopLeft}${s.horiz.repeat(leftDashes)}${titlePart}${s.horiz.repeat(rightDashes)}${s.boxTopRight}`;
  const bottom = s.boxBottomLeft + s.horiz.repeat(w - 2) + s.boxBottomRight;
  const out = [borderFn(truncate(top, w))];
  for (let line of lines) {
    line = truncate(line, innerW);
    const pad = Math.max(0, innerW - visualWidth(line));
    out.push(`${borderFn(s.vert)} ${line}${' '.repeat(pad)} ${borderFn(s.vert)}`);
  }
  out.push(borderFn(bottom));
  return out.join('\n');
}

function badge(text, tone = 'info') {
  const tones = { success: colors.green, error: colors.red, warn: colors.yellow, info: colors.cyan, dim: colors.dim };
  const fn = tones[tone] || colors.cyan;
  return fn(`[ ${text} ]`);
}

function kv(label, value, { width = 14 } = {}) {
  const paddedLabel = String(label).padEnd(width);
  return `${colors.dim(paddedLabel)} : ${value}`;
}

function bar(done, total, { width = 20 } = {}) {
  if (!total || total <= 0) total = 1;
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(width * ratio);
  const empty = width - filled;
  const fillChar = supportsUnicode() ? '█' : '#';
  const emptyChar = supportsUnicode() ? '░' : '-';
  const barStr = fillChar.repeat(filled) + emptyChar.repeat(empty);
  const pct = Math.round(ratio * 100);
  return `${colors.cyan(barStr)} ${colors.dim(`${pct}% (${done}/${total})`)}`;
}

function relativeTime(iso) {
  if (!iso) return 'belum pernah';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'baru saja';
  if (mins < 60) return `${mins} menit lalu`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  return `${days} hari lalu`;
}

function failureKind(reason) {
  const raw = String(reason || '').replace(/^RATE-LIMIT\s*/i, '');
  let code = null; let upstreamCode = null; let msg = raw;
  const mHttp = raw.match(/\bHTTP\s+(\d{3})\b/i);
  if (mHttp) code = parseInt(mHttp[1], 10);
  const mUp = raw.match(/\[\s*(\d{3})\]/);
  if (mUp) upstreamCode = parseInt(mUp[1], 10);
  msg = raw.replace(/\bHTTP\s+\d{3}\b/gi, '')
           .replace(/\[\s*\d{3}\]/g, '')
           .replace(/[|]+/g, ' ')
           .trim();
  if (code === 429 || /rate.?limit|too many|429/i.test(msg)) return { label: 'rate limit',   detail: msg, code };
  if (code === 402) return { label: 'saldo/kuota habis', detail: msg, code };
  if (code === 408 || /timeout|timed out|> \d+s/i.test(raw))   return { label: 'timeout',    detail: msg, code };
  if (code === 410 || /gone|deprecated|dihentikan/i.test(msg)) return { label: 'model dihentikan', detail: msg, code };
  if (code === 404 || /not found/i.test(msg))                  return { label: 'model tidak ada',  detail: msg, code };
  if (/empty turn/i.test(msg)) return { label: 'respons kosong', detail: msg, code };
  if (code === 400 || /bad request|ditolak/i.test(msg)) return { label: 'ditolak provider', detail: msg, code };
  if (code === 502 || /cannot find module|wreq-js|internal/i.test(msg)) return { label: 'error di 9Router', detail: msg, code };
  if (code === 503) {
    if (upstreamCode && upstreamCode !== 503) return failureKind("HTTP " + upstreamCode + ": " + msg);
  }
  if (/service unavailable|provider.*mati|503/i.test(msg) || code === 503)  return { label: 'provider mati',  detail: msg, code };
  if (code === 401 || code === 403) {
    if (upstreamCode && upstreamCode !== code) return failureKind('HTTP ' + upstreamCode + ': ' + msg);
    if (/quota|credit balance|kehabisan/i.test(msg)) return { label: 'saldo/kuota habis', detail: msg, code };
    return { label: 'api key ditolak', detail: msg, code };
  }
  if (/kosong|empty(?!d)/i.test(msg) && !/empty turn/.test(msg)) return { label: 'respons kosong', detail: msg, code };
  if (/refused|connect|network|ECONNREFUSED/i.test(raw))        return { label: 'koneksi gagal',  detail: msg, code };
  if (/json|parse|syntax/i.test(msg))                          return { label: 'invalid json',   detail: msg, code };
  if (/credit balance|quota|saldo|kehabisan/i.test(msg))        return { label: 'saldo/kuota habis', detail: msg, code };
  if (/free plan|subscription|passthrough/i.test(msg))          return { label: 'butuh paket/akses', detail: msg, code };
  return { label: raw.length > 35 ? raw.slice(0, 32) + '...' : raw, detail: msg, code };
}

function shortenReason(reason) {
  return failureKind(reason).label;
}

// ---------------------------------------------------------------- PENYEBAB GAGAL (failureKind)
const FAIL_HINT = {
  'timeout': 'Model tidak mengirim respons dalam waktu yang ditentukan.',
  'rate limit': 'Provider membatasi laju permintaan. Tunggu atau kurangi paralel.',
  'saldo/kuota habis': 'Akun provider kehabisan saldo atau kuota.',
  'butuh paket/akses': 'Model butuh langganan atau akses khusus (bukan Free plan).',
  'api key ditolak': '9Router menolak API key (401/403 langsung tanpa kode upstream).',
  'model dihentikan': 'Model sudah tidak tersedia (410 Gone / deprecated).',
  'model tidak ada': 'Model tidak ditemukan di daftar 9Router (404).',
  'respons kosong': 'Model balas tanpa content atau reasoning_content kosong.',
  'ditolak provider': 'Provider menolak permintaan (HTTP 400 / bad request).',
  'error di 9Router': 'Error internal di 9Router (502 / module not found / wreq-js).',
  'provider mati': 'Provider tidak terjangkau (HTTP 503 / service unavailable).',
  'koneksi gagal': 'Koneksi ditolak atau jaringan tidak tersedia.',
  'invalid json': 'Respons bukan JSON yang valid.'
};


// ---------------------------------------------------------------- PALET GASPOLL METALIK
// Monokrom netral + satu aksen biru baja kalem. Dilarang warna jenuh lain.
//
// Peran                          truecolor     256      16 warna
// textWhite  (nilai/teks utama)  #f2f2f2      255      97
// silver     (tombol [1]..[5])   #c8c8c8      251      37
// gray       (label/keterangan)  #8c8c8c      245      90
// border     (garis/bayangan)    #4f4f4f      240      90 (dim)
// accent     (●, ▸, ›, keycap)  #8ab4d8      110      36
// keycapBg   (latar tombol saran #8ab4d8      110      36
// keycapFg   (huruf keycap)      #0c0c0c      232      30
//
// Huruf banner: gradien putih→abu per baris, bayangan #4f4f4f.

const c = {
  white: (s) => (supportsColor()
    ? (getColorDepth() >= 24 ? `\x1b[38;2;242;242;242m${s}\x1b[0m`
      : getColorDepth() >= 8 ? `\x1b[38;5;255m${s}\x1b[0m`
        : `\x1b[97m${s}\x1b[0m`)
    : String(s)),
  whiteBold: (s) => (supportsColor()
    ? (getColorDepth() >= 24 ? `\x1b[1;38;2;242;242;242m${s}\x1b[0m`
      : getColorDepth() >= 8 ? `\x1b[1;38;5;255m${s}\x1b[0m`
        : `\x1b[1;97m${s}\x1b[0m`)
    : String(s)),
  silver: (s) => (supportsColor()
    ? (getColorDepth() >= 24 ? `\x1b[38;2;200;200;200m${s}\x1b[0m`
      : getColorDepth() >= 8 ? `\x1b[38;5;251m${s}\x1b[0m`
        : `\x1b[37m${s}\x1b[0m`)
    : String(s)),
  gray: (s) => (supportsColor()
    ? (getColorDepth() >= 24 ? `\x1b[38;2;140;140;140m${s}\x1b[0m`
      : getColorDepth() >= 8 ? `\x1b[38;5;245m${s}\x1b[0m`
        : `\x1b[90m${s}\x1b[0m`)
    : String(s)),
  border: (s) => (supportsColor()
    ? (getColorDepth() >= 24 ? `\x1b[38;2;79;79;79m${s}\x1b[0m`
      : getColorDepth() >= 8 ? `\x1b[38;5;240m${s}\x1b[0m`
        : `\x1b[90m${s}\x1b[0m`)
    : String(s)),
  accent: (s) => (supportsColor()
    ? (getColorDepth() >= 24 ? `\x1b[38;2;138;180;216m${s}\x1b[0m`
      : getColorDepth() >= 8 ? `\x1b[38;5;110m${s}\x1b[0m`
        : `\x1b[36m${s}\x1b[0m`)
    : String(s)),
  keycap: (key) => {
    // Tombol yang disarankan: blok aksen dengan huruf gelap tebal
    if (!supportsColor()) return `[${key}]`;
    const d = getColorDepth();
    if (d >= 24) return `\x1b[1;38;2;12;12;12;48;2;138;180;216m[${key}]\x1b[0m`;
    if (d >= 8) return `\x1b[1;38;5;232;48;5;110m[${key}]\x1b[0m`;
    return `\x1b[7m[${key}]\x1b[0m`;
  },
};

// Banner "GASPOLL" - varian:
// - "pixel" (default): 7 baris huruf █ + 1 baris bayangan █ gelap (total 8 baris).
//   Gradien huruf: #ffffff #eeeeee #dddddd #cccccc #bbbbbb #aaaaaa #9a9a9a
//   256 warna: 255 254 252 250 248 246 245
//   16 warna: putih terang (97) untuk semua baris (tidak ada bayangan).
//   Bayangan: #2b2b2b (truecolor), 236 (256 warna). Tidak ada bayangan di 16 warna / no-color / terminal pendek.
// - "flat": 7 baris huruf saja, tanpa bayangan.
// - "shadow": ANSI Shadow lama (6 baris, karakter garis).
// Pilih lewat env GASPOLL_BANNER=<pixel|flat|shadow> (alias lama: solid->pixel, classic->shadow) atau argumen --banner <solid|flat|classic>.


const BANNER_ART = [
  ' ██████    ████    ██████  ███████   ██████  ██       ██      ',
  '██    ██  ██  ██  ██    ██ ██    ██ ██    ██ ██       ██      ',
  '██       ██    ██ ██       ██    ██ ██    ██ ██       ██      ',
  '██  ████ ████████  ██████  ███████  ██    ██ ██       ██      ',
  '██    ██ ██    ██       ██ ██       ██    ██ ██       ██      ',
  '██    ██ ██    ██ ██    ██ ██       ██    ██ ██       ██      ',
  ' ██████  ██    ██  ██████  ██        ██████  ████████ ████████',
];

const SOLID_RGB = [
  [255, 255, 255], [238, 238, 238], [221, 221, 221],
  [204, 204, 204], [187, 187, 187], [170, 170, 170], [154, 154, 154],
];
const SOLID_256 = [255, 254, 252, 250, 248, 246, 245];
const SHADOW_RGB = [43, 43, 43];
const SHADOW_256 = 236;

const BANNER_LINES = [
  "███╗   ███╗ █████╗ ██╗  ██╗███╗   ███╗██╗   ██╗██████╗",
  "████╗ ████║██╔══██╗██║ ██╔╝████╗ ████║██║   ██║██╔══██╗",
  "██╔████╔██║███████║█████╔╝ ██╔████╔██║██║   ██║██████╔╝",
  "██║╚██╔╝██║██╔══██║██╔═██╗ ██║╚██╔╝██║██║   ██║██╔══██╗",
  "██║ ╚═╝ ██║██║  ██║██║  ██╗██║ ╚═╝ ██║╚╚████╔╝██║  ██║",
  "╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝",
];
const BANNER_RGB = [
  [255, 255, 255], [230, 230, 230], [207, 207, 207],
  [184, 184, 184], [162, 162, 162], [143, 143, 143],
];

const SMOKE_W = 14;
const SMOKE_MIN_W = 2 + SMOKE_W + 63; // 79
const SMOKE_ROWS = [
  '              ',
  '              ',
  '        ·░░▒░ ',
  ' ·░░▒▒▓▓▓▓▓▒░ ',
  '·░▒▒▓▓▓▓▓▓▓▒░ ',
  '         ░▒▒░ ',
  '              ',
  '              ',
].map((s) => s.padEnd(SMOKE_W - 1).slice(0, SMOKE_W - 1) + ' ');

function smokeFor(w) {
  const asciiMode = !supportsUnicode() || process.env.GASPOLL_ASCII === '1';
  if (asciiMode) return null;
  if (w >= SMOKE_MIN_W) return { w: SMOKE_W, rows: SMOKE_ROWS };
  return null;
}

function smokePrefix(idx, set) {
  const row = set.rows[idx] || ' '.repeat(set.w);
  if (!supportsColor()) return row;
  const d = getColorDepth();
  const T = { '▓': [[200,200,200],250], '▒': [[150,150,150],244], '░': [[100,100,100],238], '·': [[100,100,100],238] };
  let o = '';
  for (const ch of row) {
    const t = T[ch];
    if (!t) { o += ch; continue; }
    if (d >= 24) o += '\x1b[38;2;' + t[0].join(';') + 'm' + ch + '\x1b[0m';
    else if (d >= 8) o += '\x1b[38;5;' + t[1] + 'm' + ch + '\x1b[0m';
    else o += '\x1b[90m' + ch + '\x1b[0m';
  }
  return o;
}

function bannerVariant() {
  const argIdx = process.argv.indexOf('--banner');
  const argVal = argIdx >= 0 ? process.argv[argIdx + 1] : null;
  let v = process.env.GASPOLL_BANNER || argVal || 'pixel';
  if (v === 'solid') v = 'pixel';
  if (v === 'classic') v = 'shadow';
  return v;
}

function buildShadowGrid() {
  const grid = Array.from({ length: 8 }, () => Array(63).fill(' '));
  for (let r = 0; r < BANNER_ART.length; r++) {
    for (let c = 0; c < BANNER_ART[r].length; c++) {
      grid[r][c] = BANNER_ART[r][c];
    }
  }
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < BANNER_ART[r].length; c++) {
      if (BANNER_ART[r][c] === '█') {
        const nr = r + 1;
        const nc = c + 1;
        if (nr < 8 && nc < 63) {
          const isLetterBelowRight = (nr < 7 && nc < BANNER_ART[nr].length && BANNER_ART[nr][nc] === '█');
          if (!isLetterBelowRight && grid[nr][nc] !== '█') {
            grid[nr][nc] = '░';
          }
        }
      }
    }
  }
  return grid.map(row => row.join(''));
}

function solidBannerLines() {
  return buildShadowGrid();
}

function flatBannerLines() {
  return BANNER_ART.map(line => line.padEnd(62, ' '));
}

function bannerRowCount(variant, w, rows) {
  if (w < 66) return 0;
  const asciiMode = !supportsUnicode() || process.env.GASPOLL_ASCII === '1';
  if (asciiMode) return 7;
  if (variant === 'flat') return 7;
  return 8;
}

function bannerLine(idx, w = getTermWidth()) {
  const asciiMode = !supportsUnicode() || process.env.GASPOLL_ASCII === '1';
  const variant = bannerVariant();

  if (asciiMode) {
    const artRow = BANNER_ART[idx];
    if (!artRow) return '';
    const out = ['  '];
    for (let c = 0; c < artRow.length; c++) {
      const ch = artRow[c];
      out.push(ch === '█' ? '#' : ' ');
    }
    return out.join('');
  }

  const smokeSet = smokeFor(w);

  if (variant === 'flat') {
    const artRow = BANNER_ART[idx];
    if (!artRow) return '';
    const out = ['  '];
    if (smokeSet) out.push(smokePrefix(idx, smokeSet));
    const d = getColorDepth();
    for (let c = 0; c < artRow.length; c++) {
      const ch = artRow[c];
      if (ch === ' ') { out.push(' '); continue; }
      if (ch === '█') {
        if (!supportsColor()) { out.push('█'); continue; }
        if (d >= 24) out.push('\x1b[38;2;' + SOLID_RGB[idx].join(';') + 'm█\x1b[0m');
        else if (d >= 8) out.push('\x1b[38;5;' + SOLID_256[idx] + 'm█\x1b[0m');
        else out.push('\x1b[97m█\x1b[0m');
      }
    }
    return out.join('');
  }

  const shadowGrid = buildShadowGrid();
  const row = shadowGrid[idx];
  if (!row) return '';
  const out = ['  '];
  if (smokeSet) out.push(smokePrefix(idx, smokeSet));
  const d = getColorDepth();
  const letterR = idx < 7 ? idx : -1;

  for (let c = 0; c < row.length; c++) {
    const ch = row[c];
    if (ch === ' ') { out.push(' '); continue; }
    if (ch === '█') {
      if (!supportsColor()) { out.push('█'); continue; }
      if (letterR >= 0) {
        if (d >= 24) out.push('\x1b[38;2;' + SOLID_RGB[letterR].join(';') + 'm█');
        else if (d >= 8) out.push('\x1b[38;5;' + SOLID_256[letterR] + 'm█');
        else out.push('\x1b[97m█');
      }
      continue;
    }
    if (ch === '░') {
      if (!supportsColor() || d <= 4) { out.push('░'); continue; }
      if (d >= 24) out.push('\x1b[38;2;' + SHADOW_RGB.join(';') + 'm░');
      else if (d >= 8) out.push('\x1b[38;5;' + SHADOW_256 + 'm░');
      else out.push('\x1b[90m░');
      continue;
    }
  }
  out.push('\x1b[0m');

  return out.join('');
}

function renderBanner() {
  const w = getTermWidth();
  if (w < 66) {
    const eq = '='.repeat(Math.min(w, 52));
    console.log(c.border(eq));
    console.log(c.whiteBold('  GASPOLL'));
    console.log(c.border(eq));
    return;
  }
  const variant = bannerVariant();
  const n = bannerRowCount(variant, w, process.stdout.rows);
  for (let i = 0; i < n; i++) console.log(bannerLine(i, w));
}


// ---------------------------------------------------------------- LAYOUT MENU
// Margin kiri 2 spasi; dua kolom mulai di kolom 2 dan kolom 38 (0-based, lebar kiri 36 visual);
// label blok status selebar 7 kolom. Semua padding dihitung dengan visualWidth (ANSI dibuang).
const LAYOUT = {
  margin: 2,
  col2Start: 38, // 0-based
  leftW: 36,
  labelW: 7,
};

function padTo(str, width) {
  const vw = visualWidth(str);
  return str + ' '.repeat(Math.max(0, width - vw));
}

// Grid dua kolom: konten kiri & kanan di-strip margin 2 spasi, lalu kiri di-pad ke lebar
// (col2Start - margin - 1), hasil = margin + kiri + 1 spasi + kanan. Kolom kanan mulai tepat
// di col2Start.
function gridLine(left, right, leftW = LAYOUT.leftW, col2Start = LAYOUT.col2Start) {
  const m = LAYOUT.margin;
  const colW = col2Start - m - 1;
  const l = padTo(String(left || '').replace(/^ {2}/, ''), colW);
  const r = String(right || '').replace(/^ {2}/, '');
  return ' '.repeat(m) + l + ' ' + r;
}

// Grid blok status: "  <label(7)> <nilai>" di kiri, "<label(7)> <nilai>" mulai di col2Start.
function statusLine(label, leftVal, rightLabel, rightVal) {
  const m = LAYOUT.margin, c2 = LAYOUT.col2Start, lw = LAYOUT.labelW;
  const rightW = 14; // fixed width for right label
  const leftPart = ' '.repeat(m) + c.gray(String(label).padEnd(lw)) + ' ' + leftVal;
  if (rightVal === undefined || rightLabel === undefined || rightLabel === '') return leftPart;
  const leftVW = visualWidth(leftPart);
  const gap = Math.max(0, c2 - leftVW);
  return leftPart + ' '.repeat(gap) + c.gray(String(rightLabel).padEnd(rightW)) + ' ' + rightVal;
}

function blockWidth(w, hasSmoke) {
  if (hasSmoke) {
    const set = smokeFor(w);
    if (set) return 2 + set.w + 63;
  }
  return Math.min(w, 76);
}

// tagLine: "Tes provider · Benchmark coding · Susun combo" + versi rata kanan.
// Jika tagline + versi tidak muat dalam termW, hanya tampilkan tagline (versi dipotong).
function tagLine(version, termW) {
  const m = LAYOUT.margin;
  const s = sym();
  const vStr = String(version).startsWith('v') ? String(version) : 'v' + String(version);
  const tag = `Tes provider ${s.mid} Benchmark coding ${s.mid} Susun combo`;
  const smoke = smokeFor(termW);
  const bw = blockWidth(termW, !!smoke);
  const maxW = bw - m;
  const tagVW = visualWidth(tag);
  const verVW = visualWidth(vStr);
  const totalNeed = tagVW + 1 + verVW;
  if (totalNeed > maxW) {
    // Tidak muat: potong tagline jika perlu, abaikan versi
    const tagTrunc = tag.slice(0, Math.max(0, maxW));
    return ' '.repeat(m) + c.gray(tagTrunc);
  }
  const gap = maxW - tagVW - verVW;
  return ' '.repeat(m) + c.gray(tag) + ' '.repeat(gap) + c.gray(vStr);
}

// ---------------------------------------------------------------- render menu (SATU fungsi untuk menu asli & pratinjau)
// data: { baseUrl, apiKey, t (combo auto), b (bench), alive }
// opts: { width } lebar tampilan eksplisit (pratinjau); jika tidak ada, pakai getTermWidth().
function renderMenu(data, opts = {}) {
  const s = sym();
  const out = [];
  const w = opts.width || getTermWidth();
  const twoCol = w >= 76;
  const m = LAYOUT.margin, c2 = LAYOUT.col2Start;
  const rows = process.stdout && process.stdout.rows ? process.stdout.rows : 40;
  const envCompact = process.env.GASPOLL_COMPACT === '1';
  const forceCompact = process.env.GASPOLL_COMPACT === '0';
  let useCompact = false;
  if (typeof opts.compact !== 'undefined') {
    useCompact = opts.compact;
  } else if (envCompact) {
    useCompact = true;
  } else if (forceCompact) {
    useCompact = false;
  } else if (rows < 30 || w < 64) {
    useCompact = true;
  } else {
    useCompact = false;
  }

  const smoke = smokeFor(w);
  const bw = blockWidth(w, !!smoke);
  const dash = s.dash;
  const dashLine = ' '.repeat(m) + c.border(dash.repeat(Math.max(10, bw - m)));

  if (useCompact) {
    const versionRaw = String(opts.version || getVersion());
    const versionStr = versionRaw.startsWith('v') ? versionRaw : 'v' + versionRaw;
    const tag = `Tes provider ${s.mid} Benchmark coding ${s.mid} Susun combo`;
    const maxW = Math.max(10, bw - m);
    const tagVW = visualWidth(tag);
    const verVW = visualWidth(versionStr);
    const totalNeed = tagVW + 1 + verVW;
    out.push('  ' + c.whiteBold('GASPOLL'));
    if (totalNeed > maxW) {
      const tagTrunc = tag.slice(0, Math.max(0, maxW));
      out.push(' '.repeat(m) + c.gray(tagTrunc));
    } else {
      const gap = Math.max(0, maxW - tagVW - verVW);
      out.push(' '.repeat(m) + c.gray(tag) + ' '.repeat(gap) + c.gray(versionStr));
    }
  } else {
    // --- banner: 1 baris kosong, banner (solid/classic atau satu baris bingkai), 1 baris kosong
    out.push('');
    const variant = bannerVariant();
    if (w >= 64) {
      const n = bannerRowCount(variant, w, process.stdout.rows);
      for (let i = 0; i < n; i++) out.push(bannerLine(i, w));
    } else {
      const eq = '='.repeat(Math.max(16, Math.min(w - 4, 48)));
      out.push(' '.repeat(m) + c.border(eq));
      out.push(' '.repeat(m) + c.whiteBold('GASPOLL'));
      out.push(' '.repeat(m) + c.border(eq));
    }
    out.push('');

    // --- tagline + versi rata kanan
    out.push(tagLine(String(opts.version || getVersion()).replace(/^v/, ''), w));
  }

  // --- blok status: 1 garis, 3 baris status, 1 garis
  out.push(dashLine);
  const alive = data.alive || { ok: true };
  const host = String(data.baseUrl || 'localhost:20128').replace(/^https?:\/\//, '');
  const onlineDot = alive.ok ? c.accent(s.bullet) : c.white(s.circle);
  const statusWord = alive.ok ? c.whiteBold('ONLINE') : c.whiteBold('OFFLINE');
  out.push('  ' + onlineDot + ' ' + statusWord + '   ' + c.white(host));
  const comboVal = data.t && (data.t.models || []).length
    ? c.white(truncate(`${data.t.name} ${s.mid} ${data.t.models.length} model`, 28)) : c.gray('belum dibuat');
  const keyVal = data.apiKey ? c.white(maskKeyCompat(data.apiKey)) : c.white('belum diatur');
  const tesVal = data.t ? c.white(relativeTime(data.t.tested_at)) : c.gray('belum pernah');
  const benchVal = data.b ? c.white(relativeTime(data.b.tested_at)) : c.gray('belum pernah');
  // Untuk terminal sempit (<76), hanya cetak satu kolom untuk status
  if (twoCol) {
    out.push(statusLine('combo', comboVal, 'tes terakhir', tesVal));
    out.push(statusLine('API key', keyVal, 'bench terakhir', benchVal));
  } else {
    const lw = 14;
    out.push('  ' + c.gray('combo'.padEnd(lw)) + ' ' + comboVal);
    out.push('  ' + c.gray('API key'.padEnd(lw)) + ' ' + keyVal);
    out.push('  ' + c.gray('tes terakhir'.padEnd(lw)) + ' ' + tesVal);
    out.push('  ' + c.gray('bench terakhir'.padEnd(lw)) + ' ' + benchVal);
  }

  // --- menu
  const sug = suggestMenu(alive, data.t, data.b, data.apiKey);
  const keycap = (k) => sug.key === k ? c.keycap(k) : c.silver(`[${k}]`);
  const item = (k, label) => `  ${keycap(k)} ${c.white(label)}`;

  out.push(dashLine);
  // judul kolom: PROSES di kolom 2, HASIL & ALAT di col2Start
  out.push(' '.repeat(m) + c.gray('PROSES') + ' '.repeat(Math.max(0, c2 - m - visualWidth('PROSES'))) + c.gray('HASIL & ALAT'));

  if (twoCol) {
    out.push(gridLine(item('1', 'Tes provider & buat combo'), item('4', 'Lihat hasil terakhir')));
    out.push(gridLine(item('2', 'Benchmark agent coding'), item('5', 'Buka folder hasil')));
    out.push(gridLine(item('3', 'Tes + benchmark berurutan'), item('6', 'Ulangi benchmark 1 provider')));
    out.push(gridLine('', item('7', 'Pengaturan')));
    out.push(gridLine(c.gray('[g] Riwayat & log   [q] Keluar'), ''));
  } else {
    out.push(item('1', 'Tes provider & buat combo'));
    out.push(item('2', 'Benchmark agent coding'));
    out.push(item('3', 'Tes + benchmark berurutan'));
    out.push(c.gray(' '.repeat(m) + 'HASIL & ALAT'));
    out.push(item('4', 'Lihat hasil terakhir'));
    out.push(item('5', 'Buka folder hasil'));
    out.push(item('6', 'Ulangi benchmark 1 provider'));
    out.push(item('7', 'Pengaturan'));
    out.push(item('g', 'Riwayat & log'));
    out.push(c.gray(' '.repeat(m) + '[q] Keluar'));
  }

  // --- saran + prompt
  out.push(dashLine);
  // Format saran: "▸ Saran: tekan [X] (alasan)" - keycap di posisi setelah "tekan "
  // Harus masuk dalam lebar terminal; bungkus di baris kedua bila perlu (lebar < 76).
  {
    const ptr = c.accent(s.pointer);
    let saranLine;
    if (sug.key) {
      // Bangun teks saran dengan keycap di posisi "tekan [X]"
      const kc = c.keycap(sug.key);
      const rawText = sug.text; // mis. "Saran: tekan 2 (tes lebih baru dari benchmark)"
      // Ganti "tekan N" dengan "tekan [N]keycap"
      const replaced = rawText.replace(/tekan (\d+|[a-zA-Z])/,
        (_, k) => k === sug.key ? `tekan ${kc}` : `tekan ${k}`);
      const fullTextWithPtr = `  ${ptr} ${replaced}`;
      if (visualWidth(fullTextWithPtr) <= w) {
        saranLine = [fullTextWithPtr];
      } else {
        const prefix = `  ${ptr} `;
        const words = replaced.split(' ');
        let line1Words = [];
        let line2Words = [];
        let curVW = visualWidth(prefix);
        let onLine1 = true;

        for (const word of words) {
          const wVW = visualWidth(word) + (line1Words.length > 0 ? 1 : 0);
          if (onLine1 && curVW + wVW <= w) {
            line1Words.push(word);
            curVW += wVW;
          } else {
            onLine1 = false;
            line2Words.push(word);
          }
        }
        if (line1Words.length === 0 && words.length > 0) {
          line1Words.push(words[0]);
          line2Words = words.slice(1);
        }
        saranLine = [
          prefix + line1Words.join(' '),
          '    ' + c.gray(line2Words.join(' ')),
        ];
      }
    } else {
      const fullTextWithPtr = `  ${ptr} ${sug.text}`;
      if (visualWidth(fullTextWithPtr) <= w) {
        saranLine = [fullTextWithPtr];
      } else {
        const prefix = `  ${ptr} `;
        const words = sug.text.split(' ');
        let line1Words = [];
        let line2Words = [];
        let curVW = visualWidth(prefix);
        let onLine1 = true;

        for (const word of words) {
          const wVW = visualWidth(word) + (line1Words.length > 0 ? 1 : 0);
          if (onLine1 && curVW + wVW <= w) {
            line1Words.push(word);
            curVW += wVW;
          } else {
            onLine1 = false;
            line2Words.push(word);
          }
        }
        if (line1Words.length === 0 && words.length > 0) {
          line1Words.push(words[0]);
          line2Words = words.slice(1);
        }
        saranLine = [
          prefix + line1Words.join(' '),
          '    ' + c.gray(line2Words.join(' ')),
        ];
      }
    }
    saranLine.forEach(l => out.push(l));
  }
  out.push('');
  const brackets = c.gray('[1-7, g, q]');
  out.push(' '.repeat(m) + c.gray('Pilih ') + brackets + ' ' + c.accent(s.arrow) + ' ');
  return out;
}

// Logika saran (dipakai menu asli & pratinjau)
function suggestMenu(alive, t, b, apiKey) {
  const host = String(alive.baseUrl || 'localhost:20128');
  if (!alive.ok) return { key: null, text: `Saran: 9Router belum jalan di ${host}. Jalankan dulu, lalu tekan Enter.` };
  if (!apiKey) return { key: '7', text: 'Saran: tekan 7 untuk mengisi API key' };
  if (!t) return { key: '1', text: 'Saran: tekan 1 (belum pernah tes provider)' };
  if (!b || (t.tested_at && b.tested_at && new Date(t.tested_at) > new Date(b.tested_at))) {
    return { key: '2', text: !b ? 'Saran: tekan 2 (belum pernah benchmark)' : 'Saran: tekan 2 (tes lebih baru dari benchmark)' };
  }
  return { key: '4', text: 'Saran: tekan 4 untuk melihat hasil terakhir' };
}

// maskKey sama seperti di lib.js (duplikat ringan agar renderMenu mandiri)
function maskKeyCompat(k) {
  if (!k) return '(kosong)';
  return k.length <= 8 ? '****' : `${k.slice(0, 4)}****${k.slice(-4)}`;
}

function wrapLegend(text, termW = getTermWidth()) {
  const maxW = Math.max(20, termW - 2);
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (visualWidth(testLine) <= maxW) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.map((l) => `  ${l}`).join('\n');
}

module.exports = {
  supportsColor, supportsUnicode, getTermWidth, getColorDepth,
  c, sym, hr, bannerLine, renderBanner, BANNER_LINES, BANNER_ART,
  SOLID_256, SHADOW_256, bannerVariant, solidBannerLines, flatBannerLines, bannerRowCount, buildShadowGrid,
  LAYOUT, gridLine, statusLine, tagLine,
  renderMenu, suggestMenu, wrapLegend,
  colors, stripAnsi, visualWidth, truncate,
  box, badge, kv, bar, relativeTime, shortenReason, failureKind, FAIL_HINT,
};

'use strict';
/**
 * update.js - cek apakah ada push baru di repo GitHub gaspoll, lalu (kalau diminta)
 * perbarui salinan lokal dengan "git pull origin <branch>".
 *
 * Cara kerja:
 *  - Hash lokal dibaca dari git (git rev-parse HEAD).
 *  - Hash terbaru dibaca lewat "git ls-remote origin refs/heads/<branch>",
 *    dengan cadangan GitHub API (tanpa token: 60 permintaan/jam).
 *  - Hasil disimpan di results/update-state.json dan dipakai ulang selama
 *    GASPOLL_UPDATE_INTERVAL_MS (bawaan 60 menit), jadi jaringan hanya disentuh
 *    sekali per jam dan menu tetap ringan.
 *  - Pemeriksaan otomatis di latar belakang hanya jalan di terminal interaktif.
 *
 * Tanpa dependency. Butuh Node 18+ (fetch). git opsional: tanpa git, status
 * menjadi "no-git" dan pengguna diarahkan memperbarui manual dari GitHub.
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const L = require('./lib');

const ROOT = L.ROOT;
const DEFAULT_SLUG = 'Hyansz/gaspoll';
const DEFAULT_BRANCH = 'main';
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const BOOT_WAIT_MS = 2500;
const NET_TIMEOUT_MS = 8000;

const cachePath = () => L.inResults('update-state.json');

// Semua pekerjaan jaringan/git yang masih berjalan. Dipakai cancel() supaya
// menu bisa langsung keluar tanpa menunggu timeout.
const active = new Set();

function track(handle) {
  active.add(handle);
  return handle;
}

function untrack(handle) {
  active.delete(handle);
}

function intervalMs() {
  const v = parseInt(process.env.GASPOLL_UPDATE_INTERVAL_MS, 10);
  return Number.isFinite(v) && v >= 1000 ? v : DEFAULT_INTERVAL_MS;
}

function disabled() {
  return process.env.GASPOLL_UPDATE_OFF === '1';
}

// Pemeriksaan otomatis tidak dijalankan saat output dipipe (tes, skrip pack),
// supaya tidak ada panggilan jaringan yang tak diharapkan.
function autoEnabled() {
  return !disabled() && (Boolean(process.stdout.isTTY) || process.env.GASPOLL_UPDATE_CHECK === '1');
}

// ---------------------------------------------------------------- git dasar

let gitChecked = false;
let gitPresent = false;

function hasGit() {
  if (!gitChecked) {
    gitChecked = true;
    try {
      const r = cp.spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      gitPresent = r.status === 0;
    } catch {
      gitPresent = false;
    }
  }
  return gitPresent;
}

function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
}

// Perintah git lokal (cepat, aman diblokir).
function runGit(args, { cwd = ROOT, timeout = 6000 } = {}) {
  if (!hasGit()) return { ok: false, error: 'git tidak ditemukan' };
  try {
    const r = cp.spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: gitEnv(),
    });
    if (r.error) {
      return { ok: false, error: r.error.code === 'ENOENT' ? 'git tidak ditemukan' : r.error.message };
    }
    const out = String(r.stdout || '').trim();
    if (r.status !== 0) {
      const err = String(r.stderr || '').trim();
      return { ok: false, code: r.status, error: err || `git ${args[0]} gagal (kode ${r.status})` };
    }
    return { ok: true, out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Perintah git yang menyentuh jaringan (dijalankan asinkron agar prompt menu tidak tersendat).
function runGitAsync(args, { cwd = ROOT, timeout = NET_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!hasGit()) { resolve({ ok: false, error: 'git tidak ditemukan' }); return; }
    try {
      let child;
      child = cp.execFile('git', args, {
        cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        env: gitEnv(),
      }, (err, stdout, stderr) => {
        untrack(child);
        if (err) {
          const why = err.killed ? 'waktu habis' : (err.code === 'ENOENT' ? 'git tidak ditemukan' : String(stderr || err.message).trim());
          resolve({ ok: false, error: why });
          return;
        }
        resolve({ ok: true, out: String(stdout || '').trim() });
      });
      track(child);
      child.on('error', () => {});
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// ---------------------------------------------------------------- repo lokal

// "https://github.com/Owner/Repo.git", "git@github.com:Owner/Repo.git", atau "ssh://..."
function slugOf(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  let m = s.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/^ssh:\/\/git@[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  return '';
}

function localVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
}

function repoInfo() {
  if (!hasGit()) return { git: false, repo: false, error: 'git tidak ditemukan' };

  const top = runGit(['-C', ROOT, 'rev-parse', '--show-toplevel']);
  if (!top.ok) {
    return { git: true, repo: false, error: 'folder ini bukan repo git (mis. hasil unduh ZIP)' };
  }
  const dir = path.resolve(top.out);
  // Jangan memakai repo induk kalau folder ini hanya berada di dalam repo lain.
  if (dir !== path.resolve(ROOT)) {
    return { git: true, repo: false, dir, error: 'folder ini bukan akar repo git' };
  }

  const head = runGit(['-C', dir, 'rev-parse', 'HEAD']);
  const branchR = runGit(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const dateR = runGit(['-C', dir, 'log', '-1', '--format=%cI']);
  const remoteR = runGit(['-C', dir, 'remote', 'get-url', 'origin']);
  const dirtyR = runGit(['-C', dir, 'status', '--porcelain', '--untracked-files=no']);

  const branch = branchR.ok && branchR.out && branchR.out !== 'HEAD' ? branchR.out : DEFAULT_BRANCH;
  const remoteUrl = remoteR.ok ? remoteR.out : '';

  return {
    git: true,
    repo: true,
    dir,
    localHash: head.ok ? head.out : '',
    branch,
    localDate: dateR.ok ? dateR.out : '',
    remoteUrl,
    slug: slugOf(remoteUrl) || DEFAULT_SLUG,
    dirty: dirtyR.ok ? dirtyR.out.split(/\r?\n/).filter(Boolean).length : 0,
  };
}

// ---------------------------------------------------------------- jarak jauh

function ghHeaders(extra = {}) {
  const token = process.env.GASPOLL_GITHUB_TOKEN || '';
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gaspoll-update-check',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function githubCommit(slug, branch) {
  const ctrl = track(new AbortController());
  const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/commits/${encodeURIComponent(branch)}`, {
      headers: ghHeaders(),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || !body.sha) return null;
    return { sha: String(body.sha), date: body.commit && body.commit.committer ? body.commit.committer.date || '' : '' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    untrack(ctrl);
  }
}

async function remoteVersion(slug, branch) {
  const ctrl = track(new AbortController());
  const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS);
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${slug}/${encodeURIComponent(branch)}/package.json`, {
      headers: { 'User-Agent': 'gaspoll-update-check', 'Cache-Control': 'no-cache' },
      signal: ctrl.signal,
    });
    if (!res.ok) return '';
    const body = await res.json();
    return body && body.version ? String(body.version) : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
    untrack(ctrl);
  }
}

async function remoteHead(info) {
  if (info.git && info.remoteUrl) {
    const r = await runGitAsync(['-C', info.dir, 'ls-remote', 'origin', `refs/heads/${info.branch}`]);
    if (r.ok && r.out) {
      const m = r.out.match(/^([0-9a-f]{7,40})\s+/i);
      if (m) return { hash: m[1], date: '', via: 'git' };
    }
  }
  const api = await githubCommit(info.slug, info.branch);
  if (api) return { hash: api.sha, date: api.date, via: 'api' };
  return null;
}

// ---------------------------------------------------------------- cache

function readCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(state) {
  try {
    const file = cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* gagal menulis cache tidak boleh mengganggu menu */
  }
}

function isFresh(state) {
  return Boolean(state && state.checkedAt && Date.now() - state.checkedAt < intervalMs());
}

function baseState(extra) {
  return {
    state: 'unknown',
    checkedAt: 0,
    repoDir: '',
    slug: DEFAULT_SLUG,
    branch: DEFAULT_BRANCH,
    localHash: '',
    remoteHash: '',
    localDate: '',
    remoteDate: '',
    localVersion: localVersion(),
    remoteVersion: '',
    dirty: 0,
    via: '',
    error: '',
    ...extra,
  };
}

// ---------------------------------------------------------------- pemeriksaan

let inflight = null;

// Naik setiap cancel(). Hasil pemeriksaan yang dibatalkan tidak ditulis ke cache,
// supaya badge tidak berubah menjadi [?] gara-gara proses ditutup saat memeriksa.
let epoch = 0;

async function checkNow() {
  if (disabled()) {
    const cached = readCache();
    return { ...(cached || baseState()), error: 'pemeriksaan update dimatikan (GASPOLL_UPDATE_OFF=1)' };
  }

  const mine = epoch;
  let state;
  try {
    state = await doCheck();
  } catch (e) {
    state = baseState({ state: 'unknown', checkedAt: Date.now(), error: e.message });
  }
  if (mine === epoch) writeCache(state);
  return state;
}

async function doCheck() {
  const info = repoInfo();
  const now = Date.now();

  if (!info.git) {
    return baseState({ state: 'no-git', checkedAt: now, error: 'git tidak ditemukan. Perbarui manual dari GitHub.' });
  }
  if (!info.repo) {
    return baseState({ state: 'no-git', checkedAt: now, repoDir: info.dir || ROOT, error: info.error });
  }

  const base = baseState({
    checkedAt: now,
    repoDir: info.dir,
    slug: info.slug,
    branch: info.branch,
    localHash: info.localHash,
    localDate: info.localDate,
    localVersion: localVersion(),
    dirty: info.dirty,
  });

  const remote = await remoteHead(info);
  if (!remote || !remote.hash) {
    return { ...base, state: 'unknown', error: 'tidak bisa menghubungi GitHub (jaringan atau rate limit)' };
  }

  base.remoteHash = remote.hash;
  base.remoteDate = remote.date || '';
  base.via = remote.via;

  if (!base.localHash) {
    return { ...base, state: 'unknown', error: 'commit lokal tidak terbaca' };
  }

  if (remote.hash === base.localHash) {
    return { ...base, state: 'ok' };
  }

  // Hash berbeda: pastikan mana yang lebih baru. Tanggal commit lokal dibanding
  // tanggal commit GitHub; kalau tanggal tidak tersedia, anggap perlu update.
  let remoteDate = base.remoteDate;
  if (!remoteDate && base.slug) {
    const api = await githubCommit(base.slug, base.branch);
    if (api && api.sha === remote.hash) remoteDate = api.date;
  }
  if (remoteDate) base.remoteDate = remoteDate;

  if (remoteDate && base.localDate) {
    const rTime = new Date(remoteDate).getTime();
    const lTime = new Date(base.localDate).getTime();
    if (Number.isFinite(rTime) && Number.isFinite(lTime) && rTime <= lTime) {
      return { ...base, state: 'ahead' };
    }
  }

  const version = await remoteVersion(base.slug, base.branch);
  return { ...base, state: 'update', remoteVersion: version };
}

function startCheck() {
  if (inflight) return inflight;
  inflight = checkNow().finally(() => { inflight = null; });
  return inflight;
}

/**
 * Status update untuk menu. Tidak pernah menahan kecuali waitIfMissing=true.
 * Saat cache belum ada, tunggu sebentar (bawaan 2,5 detik) supaya badge langsung
 * benar. Saat cache sudah basi (lewat 60 menit), tunggu lebih singkat (1,2 detik)
 * supaya badge ikut segar ketika pengguna kembali ke menu setelah aksi panjang,
 * tanpa membuat menu terasa lambat ketika jaringan bermasalah.
 */
async function getStatus({ force = false, waitIfMissing = false } = {}) {
  const cached = readCache();
  if (!force && isFresh(cached)) return { ...cached, fresh: true };
  if (disabled()) return { ...(cached || baseState()), fresh: Boolean(cached) };

  const shouldWait = waitIfMissing && autoEnabled() && (!cached || !isFresh(cached));
  if (shouldWait) {
    const boot = parseInt(process.env.GASPOLL_UPDATE_BOOT_MS, 10);
    const budget = cached ? 1200 : (Number.isFinite(boot) && boot >= 0 ? boot : BOOT_WAIT_MS);
    const done = await Promise.race([startCheck(), L.sleep(budget).then(() => null)]);
    if (done) return { ...done, fresh: true };
  } else if (autoEnabled()) {
    startCheck(); // latar belakang; hasilnya muncul di render menu berikutnya
  }

  return { ...(cached || baseState({ state: cached ? cached.state : 'checking' })), fresh: false };
}

// ---------------------------------------------------------------- git pull

function spawnPull(dir, branch) {
  return new Promise((resolve) => {
    if (!hasGit()) { resolve({ ok: false, error: 'git tidak ditemukan' }); return; }
    try {
      const child = cp.spawn('git', ['-C', dir, 'pull', 'origin', branch], {
        stdio: 'inherit',
        windowsHide: true,
        env: gitEnv(),
      });
      child.on('error', (e) => resolve({ ok: false, error: e.code === 'ENOENT' ? 'git tidak ditemukan' : e.message }));
      child.on('close', (code) => resolve({ ok: code === 0, code: code === null ? 1 : code }));
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

/**
 * Jalankan "git pull origin <branch>" di folder gaspoll.
 * Keluaran git diteruskan langsung ke layar (stdio inherit).
 */
async function pullNow() {
  const info = repoInfo();
  if (!info.git) return { ok: false, error: 'git tidak ditemukan' };
  if (!info.repo) return { ok: false, error: info.error || 'folder ini bukan repo git' };

  const before = info.localHash;
  const res = await spawnPull(info.dir, info.branch);
  const afterR = runGit(['-C', info.dir, 'rev-parse', 'HEAD']);
  const after = afterR.ok ? afterR.out : '';
  const updated = Boolean(before && after && before !== after);

  let changed = [];
  if (updated) {
    const d = runGit(['-C', info.dir, 'diff', '--name-only', before, after]);
    if (d.ok) changed = d.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }

  return {
    ok: res.ok,
    code: res.code,
    error: res.error || '',
    branch: info.branch,
    before,
    after,
    updated,
    changed,
  };
}

// Hentikan pemeriksaan yang masih berjalan supaya proses bisa langsung keluar.
function cancel() {
  epoch++;
  inflight = null;
  for (const handle of active) {
    try {
      if (typeof handle.abort === 'function') handle.abort();
      else if (typeof handle.kill === 'function') handle.kill();
    } catch {
      /* abaikan */
    }
  }
  active.clear();
}

module.exports = {
  ROOT,
  DEFAULT_SLUG,
  DEFAULT_BRANCH,
  cachePath,
  intervalMs,
  disabled,
  autoEnabled,
  hasGit,
  slugOf,
  localVersion,
  repoInfo,
  readCache,
  writeCache,
  isFresh,
  checkNow,
  startCheck,
  getStatus,
  pullNow,
  cancel,
};

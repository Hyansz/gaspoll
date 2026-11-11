#!/usr/bin/env node
'use strict';
/**
 * guardian.js - Realtime bot guardian.
 *
 * Perantara OpenAI-compatible di depan 9Router:
 *
 *   klien (opencode) --> guardian :20130 --> 9Router :20128 --> provider
 *
 * Klien memilih model virtual "guardian". Untuk tiap request, guardian mencoba model sungguhan
 * satu per satu menurut urutan combo-auto-combo.json. Model yang kena limit / macet / kosong
 * dilewati dan ditandai cooldown; request yang sama langsung dicoba ke model berikutnya.
 * Combo di 9Router dan combo-auto-combo.json TIDAK diubah. Urutan efektif hanya ada di memori
 * dan di results/combo-state.json.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const L = require('./lib');
const UI = require('./ui');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 20130,
  virtualModel: 'guardian',
  firstByteMs: 30000,    // tunggu respons pertama dari model (stream)
  attemptMs: 90000,      // batas satu percobaan non-stream
  idleMs: 60000,         // stream macet setelah mulai
  totalMs: 150000,       // batas total satu request (semua percobaan)
  maxAttempts: 8,
  cooldownBaseMs: 20000,
  cooldownMaxMs: 300000,
  inactiveAfter: 5,
  recoverOk: 2,          // probe sukses beruntun sebelum kembali ke posisi asal
  inactiveProbeMs: 120000,
  holdChars: 40,         // tahan awal stream sampai sekian karakter untuk mendeteksi teks limit
  holdMs: 800,
  keepaliveMs: 8000,
  watchMs: 0,            // 0 = tidak ada probe berkala untuk model sehat
  probeTickMs: 2000,
  probeTimeoutMs: 20000,
  routerCheck: true,
  maxBodyBytes: 32 * 1024 * 1024,
};

const LIMIT_SRC = [
  'rate.?limit', 'too many requests', 'quota', 'usage limit', 'limit (has been )?(reached|exceeded)',
  '(reached|exceeded|hit) (your |the |its )?([a-z]+ )?limit', 'out of (credits|usage|tokens)',
  'insufficient (quota|credits|balance|funds)', 'credit balance', 'resource.?exhausted',
  'upgrade (your )?(plan|to)', 'payment required', 'billing', 'try again (later|in)',
].join('|');
const CONTEXT_RE = /context.{0,20}(length|window)|maximum context|prompt is too long|too long|reduce the length|token limit|max(imum)? (prompt )?tokens/i;

function buildPatterns(extra) {
  let src = LIMIT_SRC;
  if (extra) {
    try { new RegExp(extra, 'i'); src += '|' + extra; } catch { /* pola salah diabaikan */ }
  }
  return { limit: new RegExp(src, 'i') };
}

// ---------------------------------------------------------------- klasifikasi

function snip(s, n = 160) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

// Respons non-2xx dari 9Router. Hasil: { kind, reason, skip?, pass? }.
//   fail  : model bermasalah -> pindah + cooldown
//   skip  : bukan salah model (mis. konteks terlalu panjang) -> lewati hanya untuk request ini
//   pass  : salah klien (400 biasa, 401) -> teruskan apa adanya, jangan hukum model
function classifyHttp(status, text, pats) {
  const t = String(text || '').slice(0, 4000);
  const why = (label) => `HTTP ${status}${t ? ': ' + snip(t, 120) : ''}${label ? ' (' + label + ')' : ''}`;
  if (status === 401) return { kind: 'auth', pass: true, reason: why('api key') };
  if ((status === 400 || status === 413 || status === 422) && CONTEXT_RE.test(t) && !pats.limit.test(t)) {
    return { kind: 'context', skip: true, reason: why('konteks terlalu panjang') };
  }
  if (status === 429 || status === 402) return { kind: 'limit', reason: why('limit') };
  if (status === 408 || status === 504) return { kind: 'timeout', reason: why('timeout') };
  if (status === 404) return { kind: 'notfound', reason: why('model tidak ada') };
  if (status >= 500) {
    return { kind: pats.limit.test(t) ? 'limit' : 'provider', reason: why(pats.limit.test(t) ? 'limit' : 'provider') };
  }
  if (pats.limit.test(t)) return { kind: 'limit', reason: why('limit') };
  if (status === 403) return { kind: 'forbidden', reason: why('ditolak') };
  return { kind: 'client', pass: true, reason: why('request ditolak') };
}

// Isi jawaban yang sudah terkumpul. 200 OK pun dianggap gagal bila kosong atau berisi teks limit pendek.
function classifyContent(text, hasTool, pats) {
  const t = String(text || '');
  if (hasTool) return null;
  if (!t.trim()) return { kind: 'empty', reason: 'respons kosong' };
  if (t.length < 300 && pats.limit.test(t)) return { kind: 'limit', reason: `teks limit: "${snip(t, 100)}"` };
  return null;
}

function flatten(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  return '';
}

// ---------------------------------------------------------------- util

const pad2 = (n) => String(n).padStart(2, '0');
const clock = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

function raceTimeout(p, ms) {
  if (!Number.isFinite(ms)) return p;
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => { const e = new Error('timeout'); e.code = 'TIMEOUT'; rej(e); }, ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

// Pembaca stream yang tidak kehilangan data ketika batas waktu terlewati: satu read() tertunda dipakai ulang.
function makeReader(reader) {
  let pending = null;
  return {
    next(ms) {
      if (!pending) {
        const p = reader.read().then((r) => { pending = null; return r; }, (e) => { pending = null; throw e; });
        p.catch(() => {});
        pending = p;
      }
      return raceTimeout(pending, ms);
    },
    cancel() { try { reader.cancel().catch(() => {}); } catch { /* sudah ditutup */ } },
  };
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > cap) { const e = new Error('body terlalu besar'); e.code = 'TOOBIG'; req.destroy(); reject(e); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

// ---------------------------------------------------------------- guardian

function createGuardian(userOpts = {}) {
  const o = { ...DEFAULTS, ...userOpts };
  const cfg = o.cfg || L.loadConfig();
  const pats = buildPatterns(o.limitPattern || process.env.GASPOLL_GUARD_PATTERN || '');
  const upstream = String(cfg.baseUrl || 'http://localhost:20128').replace(/\/+$/, '');
  const stateFile = o.stateFile || L.inResults('combo-state.json');
  const failLog = o.failLog || L.inResults('guardian-failures.log');

  let models = Array.isArray(o.models) ? o.models.slice() : [];
  let comboMtime = 0;
  let watcher = null; // fs.watch handle untuk combo file
  const state = {};              // id -> { status, fails, cooldownUntil, nextProbeAt, probeOk, lastMs, lastAt, reason, uses }
  const active = new Map();      // id -> { id, model, started, stream, phase, attempts }
  const events = [];
  const metrics = { total: 0, switches: 0, failedAll: 0, interrupted: 0 };
  const probing = new Set();
  const router = { ok: null, reason: '' };
  let seq = 0; let saveTimer = null; let tickTimer = null; let routerTimer = null; let stopping = false;
  let boundPort = null;

  const secrets = () => [cfg.apiKey].filter(Boolean);
  function redact(s) {
    let out = String(s);
    secrets().forEach((k) => { out = out.split(k).join('[key]'); });
    return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[key]').replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [key]');
  }

  function ev(type, msg) {
    const e = { t: Date.now(), type, msg: redact(msg) };
    events.push(e);
    if (events.length > 200) events.shift();
    if (typeof o.onEvent === 'function') { try { o.onEvent(e); } catch { /* tampilan tidak boleh merusak proxy */ } }
  }

  function logFailure(entry) {
    try {
      fs.mkdirSync(path.dirname(failLog), { recursive: true });
      try { if (fs.statSync(failLog).size > 1024 * 1024) fs.renameSync(failLog, failLog + '.1'); } catch { /* belum ada */ }
      fs.appendFileSync(failLog, redact(JSON.stringify({ ts: new Date().toISOString(), ...entry })) + '\n', 'utf8');
    } catch { /* log opsional */ }
  }

  // ------------------------------------------------ daftar model & status

  function idOf(m) { return typeof m === 'string' ? m : (m && (m.id || m.model)) || ''; }

  function loadModels(force) {
    if (Array.isArray(o.models)) return;
    try {
      const p = L.inResults('combo-auto-combo.json');
      const st = fs.statSync(p);
      if (!force && st.mtimeMs === comboMtime) return;
      comboMtime = st.mtimeMs;
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      const list = (j.models || []).map(idOf).filter(Boolean);
      if (list.length) models = list;
    } catch { /* belum ada combo */ }
  }

  function st(id) {
    if (!state[id]) state[id] = { status: 'healthy', fails: 0, cooldownUntil: 0, nextProbeAt: 0, probeOk: 0, lastMs: 0, lastAt: 0, reason: '', uses: 0 };
    return state[id];
  }

  function loadState() {
    try {
      const j = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
      for (const [id, v] of Object.entries(j.models || {})) {
        if (!v || typeof v !== 'object') continue;
        const s = st(id);
        if (['healthy', 'degraded', 'inactive'].includes(v.status)) s.status = v.status;
        ['fails', 'cooldownUntil', 'nextProbeAt', 'lastMs', 'lastAt', 'uses'].forEach((k) => { if (Number.isFinite(v[k])) s[k] = v[k]; });
        if (typeof v.reason === 'string') s.reason = v.reason;
      }
    } catch { /* tanpa state */ }
  }

  function saveStateNow() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ models: state, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch { /* gagal tulis tidak boleh menjatuhkan proxy */ }
  }
  function dirty() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveStateNow(); }, 1000);
    if (saveTimer.unref) saveTimer.unref();
  }

  function markFail(id, kind, reason) {
    const s = st(id);
    s.fails += 1; s.probeOk = 0; s.reason = redact(reason); s.lastAt = Date.now();
    const backoff = Math.min(o.cooldownMaxMs, o.cooldownBaseMs * (2 ** (Math.min(s.fails, 10) - 1)));
    if (kind === 'notfound' || s.fails >= o.inactiveAfter) {
      s.status = 'inactive';
      s.cooldownUntil = Date.now() + o.inactiveProbeMs;
    } else {
      s.status = 'degraded';
      s.cooldownUntil = Date.now() + backoff;
    }
    s.nextProbeAt = s.cooldownUntil;
    dirty();
  }

  function markOk(id, ms) {
    const s = st(id);
    const was = s.status;
    s.status = 'healthy'; s.fails = 0; s.probeOk = 0; s.cooldownUntil = 0; s.reason = ''; s.lastMs = ms; s.lastAt = Date.now();
    dirty();
    return was;
  }

  function effectiveOrder() {
    loadModels(false);
    const rank = { healthy: 0, degraded: 1, inactive: 2 };
    return models.map((id, i) => ({ id, i, s: st(id) }))
      .sort((a, b) => (rank[a.s.status] - rank[b.s.status]) || (a.i - b.i));
  }

  // Calon berikutnya untuk satu request: yang sehat dulu; bila habis, yang cooldown (terdekat pulih), lalu nonaktif.
  function pickNext(tried) {
    const left = effectiveOrder().filter((m) => !tried.has(m.id));
    const healthy = left.find((m) => m.s.status === 'healthy');
    if (healthy) return healthy.id;
    const deg = left.filter((m) => m.s.status === 'degraded').sort((a, b) => a.s.cooldownUntil - b.s.cooldownUntil)[0];
    if (deg) return deg.id;
    const ina = left.find((m) => m.s.status === 'inactive');
    return ina ? ina.id : null;
  }

  // ------------------------------------------------ satu percobaan ke 9Router

  async function peekStream(rd, ac) {
    const dec = new TextDecoder();
    const held = [];
    let buf = ''; let text = ''; let hasTool = false; let hasReason = false;
    let firstContentAt = 0; let ended = false; let errText = null;

    const handle = (block) => {
      for (const ln of block.split(/\r?\n/)) {
        if (!ln.startsWith('data:')) continue;
        const data = ln.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j && j.error) { errText = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error)); continue; }
        const ch = j && j.choices && j.choices[0];
        if (!ch) continue;
        const d = ch.delta || ch.message || {};
        if (Array.isArray(d.tool_calls) && d.tool_calls.length) hasTool = true;
        if (d.reasoning_content || d.reasoning) hasReason = true;
        const c = flatten(d.content);
        if (c) { text += c; if (!firstContentAt) firstContentAt = Date.now(); }
      }
    };

    for (;;) {
      if (errText !== null) {
        ac.abort(); rd.cancel();
        const c = pats.limit.test(errText) ? 'limit' : 'provider';
        return { fail: { kind: c, reason: `error di stream: ${snip(errText, 120)}` } };
      }
      if (hasTool || (hasReason && !firstContentAt)) return { ok: true, held, rd };
      let wait = o.firstByteMs;
      if (!ended && firstContentAt) {
        const evalAt = firstContentAt + o.holdMs;
        if (text.length >= o.holdChars || Date.now() >= evalAt) {
          if (!pats.limit.test(text)) return { ok: true, held, rd };
          if (text.length >= 300 || Date.now() >= firstContentAt + 3000) return { ok: true, held, rd };
          wait = Math.max(30, firstContentAt + 3000 - Date.now());
        } else {
          wait = Math.max(30, evalAt - Date.now());
        }
      }
      if (ended) {
        const bad = classifyContent(text, hasTool, pats);
        if (bad) { ac.abort(); rd.cancel(); return { fail: bad }; }
        return { ok: true, held, rd, ended: true };
      }
      let r;
      try { r = await rd.next(wait); } catch (e) {
        if (e.code === 'TIMEOUT') {
          if (firstContentAt) continue;
          ac.abort(); rd.cancel();
          return { fail: { kind: 'timeout', reason: `tidak ada respons dalam ${Math.round(o.firstByteMs / 1000)} dtk` } };
        }
        return { fail: { kind: 'provider', reason: `stream terputus: ${e.message}` } };
      }
      if (r.done) { ended = true; if (buf.trim()) handle(buf); continue; }
      held.push(r.value);
      buf += dec.decode(r.value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop();
      parts.forEach(handle);
    }
  }

  // mode: 'live' (ikut stream klien) atau 'probe' (kecil, non-stream)
  async function attempt(modelId, parsed, auth, clientSignal, mode) {
    const wantStream = mode === 'live' && !!parsed.stream;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (clientSignal) clientSignal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { if (clientSignal) clientSignal.removeEventListener('abort', onAbort); };
    let timedOut = false;
    const limitMs = wantStream ? o.firstByteMs : (mode === 'probe' ? o.probeTimeoutMs : o.attemptMs);
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, limitMs);
    const t0 = Date.now();
    const body = JSON.stringify({ ...parsed, model: modelId });
    let resp;
    try {
      resp = await fetch(`${upstream}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
        body,
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer); cleanup();
      if (clientSignal && clientSignal.aborted) return { aborted: true };
      if (timedOut) return { fail: { kind: 'timeout', reason: `timeout > ${Math.round(limitMs / 1000)} dtk` } };
      return { net: { reason: (e.cause && (e.cause.code || e.cause.message)) || e.message } };
    }

    const ct = resp.headers.get('content-type') || '';
    try {
      if (!resp.ok) {
        let text = '';
        try { text = await raceTimeout(resp.text(), 10000); } catch { /* badan tidak terbaca */ }
        clearTimeout(timer); cleanup();
        const c = classifyHttp(resp.status, text, pats);
        if (c.pass) return { pass: { status: resp.status, ct, text }, cls: c };
        if (c.skip) return { skip: c };
        return { fail: { ...c, status: resp.status, raw: text } };
      }

      if (wantStream && /text\/event-stream/i.test(ct) && resp.body) {
        clearTimeout(timer);
        const rd = makeReader(resp.body.getReader());
        const pk = await peekStream(rd, ac);
        if (pk.fail) { cleanup(); return { fail: { ...pk.fail, raw: '' } }; }
        return { ok: true, kind: 'stream', held: pk.held, rd: pk.rd, ac, ms: Date.now() - t0, done: cleanup };
      }

      let text;
      try { text = await raceTimeout(resp.text(), limitMs); } catch (e) {
        clearTimeout(timer); cleanup();
        if (clientSignal && clientSignal.aborted) return { aborted: true };
        return { fail: { kind: 'timeout', reason: `timeout > ${Math.round(limitMs / 1000)} dtk` } };
      }
      clearTimeout(timer); cleanup();
      let j = null; try { j = JSON.parse(text); } catch { /* bukan JSON */ }
      if (j && j.error) {
        const msg = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error));
        return { fail: { kind: pats.limit.test(msg) ? 'limit' : 'provider', reason: `error: ${snip(msg, 120)}`, raw: text } };
      }
      const msg = (j && j.choices && j.choices[0] && (j.choices[0].message || {})) || {};
      const content = flatten(msg.content);
      const reasoning = flatten(msg.reasoning_content || msg.reasoning);
      const hasTool = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      const probeText = j ? (content || (reasoning ? '.' : '')) : text;
      const bad = classifyContent(probeText, hasTool, pats);
      if (bad) return { fail: { ...bad, raw: text } };
      return { ok: true, kind: 'json', status: resp.status, ct, text, ms: Date.now() - t0 };
    } catch (e) {
      clearTimeout(timer); cleanup();
      if (clientSignal && clientSignal.aborted) return { aborted: true };
      return { fail: { kind: 'provider', reason: e.message } };
    }
  }

  // ------------------------------------------------ request klien

  function sseHead(res, modelId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no',
      ...(modelId ? { 'X-Guardian-Model': modelId } : {}),
    });
  }

  async function handleChat(req, res, parsed) {
    const id = ++seq;
    const a = { id, model: '', started: Date.now(), stream: !!parsed.stream, phase: 'memilih model', attempts: 0 };
    active.set(id, a);
    metrics.total += 1;
    const auth = req.headers.authorization || (cfg.apiKey ? `Bearer ${cfg.apiKey}` : '');
    const ac = new AbortController();
    let finished = false;
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });

    let keepTimer = null; let keepIv = null; let keptAlive = false;
    if (a.stream) {
      keepTimer = setTimeout(() => {
        if (res.headersSent || res.writableEnded) return;
        keptAlive = true; sseHead(res, null);
        res.write(': guardian sedang mencari model yang sehat\n\n');
        keepIv = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ditutup */ } }, Math.max(50, Math.min(5000, o.keepaliveMs)));
      }, o.keepaliveMs);
    }
    const stopKeep = () => { clearTimeout(keepTimer); clearInterval(keepIv); };

    const tried = new Set(); const log = [];
    const deadline = Date.now() + o.totalMs;
    let prev = null;
    try {
      for (;;) {
        if (ac.signal.aborted) return;
        if (a.attempts >= o.maxAttempts || Date.now() > deadline) break;
        const cand = pickNext(tried);
        if (!cand) break;
        tried.add(cand); a.attempts += 1; a.model = cand; a.phase = 'menunggu respons';
        if (prev) { metrics.switches += 1; ev('switch', `pindah dari ${prev} ke ${cand}`); }

        const out = await attempt(cand, parsed, auth, ac.signal, 'live');
        if (out.aborted) return;
        if (out.net) {
          stopKeep();
          ev('fail', `9Router tidak terjangkau: ${out.net.reason}`);
          const body = { error: { message: `Guardian tidak bisa menghubungi 9Router di ${upstream}: ${out.net.reason}`, type: 'guardian_router_down' } };
          if (res.headersSent) { res.write(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`); res.end(); } else sendJson(res, 502, body);
          return;
        }
        if (out.pass) {
          stopKeep();
          ev('info', `${cand}: ${out.cls.reason}, diteruskan ke klien`);
          if (res.headersSent) { res.write(`data: ${JSON.stringify({ error: { message: out.cls.reason, type: 'guardian_client_error' } })}\n\ndata: [DONE]\n\n`); res.end(); return; }
          res.writeHead(out.pass.status, { 'Content-Type': out.pass.ct || 'application/json' });
          res.end(out.pass.text);
          return;
        }
        if (out.skip) {
          log.push({ model: cand, reason: out.skip.reason });
          ev('info', `${cand} dilewati untuk request ini: ${out.skip.reason}`);
          prev = cand;
          continue;
        }
        if (out.fail) {
          markFail(cand, out.fail.kind, out.fail.reason);
          log.push({ model: cand, reason: redact(out.fail.reason) });
          logFailure({ model: cand, kind: out.fail.kind, status: out.fail.status || null, reason: out.fail.reason, body: snip(out.fail.raw || '', 500) });
          ev('fail', `${cand} gagal: ${out.fail.reason}`);
          prev = cand;
          continue;
        }

        // sukses
        stopKeep();
        const s = st(cand);
        s.uses += 1;
        if (out.kind === 'json') {
          markOk(cand, out.ms);
          a.phase = 'selesai';
          res.writeHead(out.status, { 'Content-Type': out.ct || 'application/json', 'X-Guardian-Model': cand });
          res.end(out.text);
          ev('ok', `${cand} melayani (${out.ms} ms)`);
          finished = true;
          return;
        }
        markOk(cand, out.ms);
        a.phase = 'streaming';
        if (!res.headersSent) sseHead(res, cand);
        ev('ok', `${cand} melayani stream (respons pertama ${out.ms} ms)`);
        try {
          for (const c of out.held) res.write(c);
          for (;;) {
            const r = await out.rd.next(o.idleMs);
            if (r.done) break;
            res.write(r.value);
          }
          res.end();
          finished = true;
        } catch (e) {
          if (ac.signal.aborted) return;
          const why = e.code === 'TIMEOUT' ? `stream macet > ${Math.round(o.idleMs / 1000)} dtk` : e.message;
          metrics.interrupted += 1;
          markFail(cand, 'interrupted', `terputus di tengah jawaban: ${why}`);
          logFailure({ model: cand, kind: 'interrupted', reason: why });
          ev('fail', `${cand} terputus di tengah jawaban: ${why}`);
          try {
            res.write(`data: ${JSON.stringify({ error: { message: `guardian: model ${cand} terputus (${why}). Ulangi permintaan, model berikutnya akan dipakai.`, type: 'guardian_upstream_interrupted' } })}\n\n`);
            res.write('data: [DONE]\n\n'); res.end();
          } catch { /* klien sudah pergi */ }
          finished = true;
        } finally { out.ac.abort(); if (out.done) out.done(); }
        return;
      }

      // semua gagal
      stopKeep();
      metrics.failedAll += 1;
      ev('fail', `semua model gagal (${log.length} percobaan)`);
      const body = { error: { message: `Guardian: semua model gagal setelah ${log.length} percobaan.`, type: 'guardian_all_failed', attempts: log } };
      if (res.headersSent) { res.write(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`); res.end(); } else sendJson(res, 503, body);
    } catch (e) {
      stopKeep();
      ev('fail', `error internal: ${e.message}`);
      try {
        if (res.headersSent) res.end(); else sendJson(res, 500, { error: { message: `guardian: ${e.message}`, type: 'guardian_internal' } });
      } catch { /* abaikan */ }
    } finally {
      stopKeep();
      if (keptAlive && !finished && !res.writableEnded) { try { res.end(); } catch { /* abaikan */ } }
      active.delete(id);
    }
  }

  async function passthrough(req, res, bodyBuf) {
    const auth = req.headers.authorization || (cfg.apiKey ? `Bearer ${cfg.apiKey}` : '');
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let resp;
    try {
      resp = await fetch(upstream + req.url, {
        method: req.method,
        headers: { ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}), ...(auth ? { Authorization: auth } : {}) },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf,
        signal: ac.signal,
      });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 502, { error: { message: `Guardian tidak bisa menghubungi 9Router: ${(e.cause && e.cause.code) || e.message}`, type: 'guardian_router_down' } });
      return;
    }
    const ct = resp.headers.get('content-type') || 'application/octet-stream';
    if (req.method === 'GET' && req.url.split('?')[0] === '/v1/models' && /json/i.test(ct) && resp.ok) {
      const text = await resp.text();
      try {
        const j = JSON.parse(text);
        if (j && Array.isArray(j.data)) {
          j.data.unshift({ id: o.virtualModel, object: 'model', owned_by: 'guardian' });
          return sendJson(res, 200, j);
        }
      } catch { /* teruskan apa adanya */ }
      res.writeHead(resp.status, { 'Content-Type': ct }); res.end(text); return;
    }
    res.writeHead(resp.status, { 'Content-Type': ct });
    if (!resp.body) { res.end(); return; }
    const rd = makeReader(resp.body.getReader());
    try {
      for (;;) { const r = await rd.next(Infinity); if (r.done) break; res.write(r.value); }
    } catch { /* putus */ }
    res.end();
  }

  async function onRequest(req, res) {
    try {
      const url = req.url.split('?')[0];
      if (req.method === 'GET' && url === '/health') {
        const c = counts();
        return sendJson(res, 200, { ok: true, model: o.virtualModel, models: models.length, ...c, ...metrics });
      }
      let bodyBuf = Buffer.alloc(0);
      if (!['GET', 'HEAD'].includes(req.method)) bodyBuf = await readBody(req, o.maxBodyBytes);
      if (req.method === 'POST' && url === '/v1/chat/completions') {
        let parsed = null;
        try { parsed = JSON.parse(bodyBuf.toString('utf8')); } catch { /* JSON rusak */ }
        if (!parsed || typeof parsed !== 'object') return sendJson(res, 400, { error: { message: 'body bukan JSON yang valid', type: 'invalid_request' } });
        if (parsed.model === o.virtualModel) {
          loadModels(false);
          if (!models.length) return sendJson(res, 503, { error: { message: 'Belum ada combo. Jalankan menu [1] GASPOLL dulu (combo-auto-combo.json).', type: 'guardian_no_combo' } });
          return handleChat(req, res, parsed);
        }
      }
      return passthrough(req, res, bodyBuf);
    } catch (e) {
      try { if (!res.headersSent) sendJson(res, e.code === 'TOOBIG' ? 413 : 500, { error: { message: `guardian: ${e.message}`, type: 'guardian_internal' } }); else res.end(); } catch { /* abaikan */ }
    }
  }

  // ------------------------------------------------ probe berkala

  async function probe(id, force) {
    if (probing.has(id)) return;
    probing.add(id);
    try {
      const out = await attempt(id, { messages: [{ role: 'user', content: 'Jawab satu angka: 1+1=' }], max_tokens: 16, stream: false }, cfg.apiKey ? `Bearer ${cfg.apiKey}` : '', null, 'probe');
      const s = st(id);
      if (out.ok) {
        s.lastMs = out.ms; s.lastAt = Date.now();
        s.probeOk += 1;
        if (force || s.status === 'healthy' || s.probeOk >= o.recoverOk) {
          const was = markOk(id, out.ms);
          if (was !== 'healthy') {
            const pos = models.indexOf(id) + 1;
            ev('recover', `${id} pulih, kembali ke posisi ${pos}`);
          }
        } else {
          s.nextProbeAt = Date.now() + Math.min(5000, o.cooldownBaseMs);
          ev('info', `${id} probe ${s.probeOk}/${o.recoverOk} sukses`);
        }
      } else if (out.net) {
        ev('fail', `probe ${id}: 9Router tidak terjangkau`);
      } else if (out.fail) {
        markFail(id, out.fail.kind, out.fail.reason);
        ev('fail', `probe ${id} gagal: ${out.fail.reason}`);
      } else if (out.pass || out.skip) {
        s.lastAt = Date.now();
        ev('info', `probe ${id}: ${(out.cls || out.skip).reason}`);
      }
    } finally { probing.delete(id); }
  }

  function tick() {
    if (stopping) return;
    loadModels(false);
    const now = Date.now();
    let slots = 3 - probing.size;
    for (const id of models) {
      if (slots <= 0) break;
      const s = st(id);
      const due = (s.status !== 'healthy' && now >= s.nextProbeAt)
        || (o.watchMs > 0 && s.status === 'healthy' && now - s.lastAt >= o.watchMs);
      if (due && !probing.has(id)) { slots -= 1; probe(id, false).catch(() => {}); }
    }
  }

  async function probeAll() {
    loadModels(true);
    ev('info', `tes kesehatan ${models.length} model...`);
    const queue = models.slice();
    const worker = async () => { while (queue.length) { const id = queue.shift(); await probe(id, true); } };
    await Promise.all([worker(), worker(), worker(), worker()]);
    ev('info', 'tes kesehatan selesai');
  }

  function resetStates() {
    Object.keys(state).forEach((k) => delete state[k]);
    saveStateNow();
    ev('info', 'status model direset');
  }

  function counts() {
    let healthy = 0; let degraded = 0; let inactive = 0;
    for (const id of models) {
      const s = st(id).status;
      if (s === 'degraded') degraded++; else if (s === 'inactive') inactive++; else healthy++;
    }
    return { healthy, degraded, inactive };
  }

  // ------------------------------------------------ siklus hidup

  const server = http.createServer((req, res) => { onRequest(req, res); });

  function start() {
    return new Promise((resolve, reject) => {
      loadModels(true); loadState();
      
      // Setup file watcher untuk real-time combo reload (dengan debounce di Windows)
      let watchTimer = null;
      try {
        const comboPath = L.inResults('combo-auto-combo.json');
        watcher = fs.watch(comboPath, (eventType, filename) => {
          if (watchTimer) clearTimeout(watchTimer);
          // Debounce di Windows (multiple change events) dan throttle di Unix
          watchTimer = setTimeout(() => {
            loadModels(true);
            ev('info', `combo reloaded dari file watch (${models.length} model)`);
          }, 500);
        });
      } catch { /* file watcher opsional */ }
      
      server.once('error', reject);
      server.listen(o.port, o.host, () => {
        server.removeListener('error', reject);
        boundPort = server.address().port;
        tickTimer = setInterval(tick, o.probeTickMs);
        if (o.routerCheck) {
          const chk = async () => { const r = await L.checkRouter(cfg, 2500); router.ok = r.ok; router.reason = r.reason || ''; };
          chk().catch(() => {});
          routerTimer = setInterval(() => { chk().catch(() => {}); }, 5000);
        }
        resolve(boundPort);
      });
    });
  }

  async function stop() {
    stopping = true;
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
    clearInterval(tickTimer); clearInterval(routerTimer); clearTimeout(saveTimer); saveTimer = null;
    saveStateNow();
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
      setTimeout(resolve, 1500).unref();
    });
  }

  return {
    opts: o, cfg, server, state, events, metrics, router, upstream,
    start, stop, probeAll, resetStates, effectiveOrder, pickNext, counts, loadModels, saveStateNow,
    get port() { return boundPort; },
    get models() { return models; },
    snapshot() { return { order: effectiveOrder(), counts: counts(), active: [...active.values()], metrics: { ...metrics }, router: { ...router }, port: boundPort, host: o.host, upstream, virtualModel: o.virtualModel }; },
  };
}

// ---------------------------------------------------------------- tampilan live

// Merakit baris dari segmen [teks, fungsiWarna]; segmen terakhir dipotong supaya tidak melebihi max kolom.
function fit(segs, max) {
  let used = 0; let out = '';
  for (const [t, fn] of segs) {
    const room = max - used;
    if (room <= 0) break;
    const txt = UI.visualWidth(t) > room ? UI.truncate(t, room) : t;
    out += fn ? fn(txt) : txt;
    used += UI.visualWidth(txt);
  }
  return out;
}

function renderDashboard(g, opt = {}) {
  const width = Math.max(50, Math.min(opt.width || UI.getTermWidth(), 110));
  const rows = opt.rows || 30;
  const s = UI.sym();
  const c = UI.c;
  const snap = g.snapshot();
  const now = Date.now();
  const inner = width - 3;
  const dash = '  ' + c.border(s.dash.repeat(Math.max(10, width - 4)));
  const cut = (t, n) => UI.truncate(String(t), Math.max(4, n));
  const out = [];

  out.push('  ' + c.whiteBold('REALTIME BOT GUARDIAN (LIVE)'));
  out.push(dash);
  const W = width - 1;
  const green = L.col.green; const yellow = L.col.yellow; const red = L.col.red;
  out.push(fit([['  Guardian  : ', c.gray], [s.bullet + ' AKTIF', green], [`  http://${snap.host}:${snap.port}/v1`, c.white], [`  model "${snap.virtualModel}"`, c.gray]], W));
  const rtSeg = snap.router.ok === null ? [s.circle + ' memeriksa', c.gray] : snap.router.ok ? [s.bullet + ' ONLINE', green] : [s.circle + ' OFFLINE', red];
  out.push(fit([['  Router    : ', c.gray], rtSeg, ['  ' + snap.upstream, c.white]], W));
  const k = snap.counts;
  out.push(fit([['  Model     : ', c.gray], [`${snap.order.length} combo  `, c.white], [`${s.success} ${k.healthy} sehat`, green], [' | ', c.gray], [`${s.warn} ${k.degraded} cooldown`, yellow], [' | ', c.gray], [`${s.fail} ${k.inactive} nonaktif`, c.gray]], W));
  out.push(fit([['  Lalu lintas: ', c.gray], [`${snap.active.length} aktif`, c.white], [' | ', c.gray], [`total ${snap.metrics.total}`, c.white], [' | ', c.gray], [`pindah ${snap.metrics.switches}`, c.white], [' | ', c.gray], [`gagal total ${snap.metrics.failedAll}`, c.white]], W));
  out.push(dash);

  out.push('  ' + c.whiteBold('Sedang dipakai:'));
  if (!snap.active.length) out.push('  ' + c.gray('  (belum ada request yang berjalan)'));
  snap.active.slice(0, 4).forEach((a) => {
    const el = ((now - a.started) / 1000).toFixed(1) + 's';
    const left = `#${a.id} ${a.stream ? 'stream' : 'biasa '} `;
    const tail = `  ${a.phase}  x${a.attempts}  ${el}`;
    const idRoom = Math.max(8, W - 4 - left.length - tail.length);
    out.push(fit([['  ', null], [s.pointer + ' ', c.accent], [left, c.gray], [cut(a.model || '-', idRoom), c.white], [tail, c.gray]], W));
  });
  if (snap.active.length > 4) out.push('  ' + c.gray(`  ... +${snap.active.length - 4} request lain`));
  out.push(dash);

  out.push('  ' + c.whiteBold('Urutan efektif (fallback):'));
  const room = Math.max(5, Math.min(40, rows - 22));
  const activeModels = new Set(snap.active.map((a) => a.model));
  const idW = Math.max(16, Math.min(46, inner - 40));
  const order = snap.order;
  const bad = order.filter((m) => m.s.status !== 'healthy');
  const good = order.filter((m) => m.s.status === 'healthy');
  const showGood = good.slice(0, Math.max(3, room - Math.min(bad.length, 5)));
  const shown = [...showGood, ...bad.slice(0, Math.max(0, room - showGood.length))];
  shown.forEach((m) => {
    const pos = order.indexOf(m) + 1;
    const mark = activeModels.has(m.id) ? c.accent(s.pointer) : ' ';
    const st = m.s;
    let badge; let info;
    if (st.status === 'healthy') {
      badge = L.col.green('[OK ]');
      info = st.lastAt ? `${String(st.lastMs).padStart(5)}ms  ${clock(st.lastAt)}  ${st.uses}x` : '    -  belum dipakai';
    } else if (st.status === 'degraded') {
      badge = L.col.yellow('[LIM]');
      info = `cooldown ${Math.max(0, Math.ceil((st.cooldownUntil - now) / 1000))}s  ${st.reason}`;
    } else {
      badge = L.col.red('[OFF]');
      info = `nonaktif  ${st.reason}`;
    }
    out.push(` ${mark}${String(pos).padStart(2)}. ${badge} ${c.white(cut(m.id, idW).padEnd(idW))} ${c.gray(cut(info, inner - idW - 14))}`);
  });
  const hidden = order.length - shown.length;
  if (hidden > 0) out.push('  ' + c.gray(`  ... +${hidden} model lainnya (sehat)`));
  if (!order.length) out.push('  ' + c.gray('  (belum ada combo: jalankan menu [1] dulu)'));
  out.push(dash);

  out.push('  ' + c.whiteBold('Log aktivitas:'));
  const evs = g.events.slice(-6);
  if (!evs.length) out.push('  ' + c.gray('  (belum ada aktivitas)'));
  evs.forEach((e) => {
    const col = e.type === 'fail' ? L.col.red : e.type === 'recover' || e.type === 'ok' ? L.col.green : e.type === 'switch' ? L.col.yellow : c.gray;
    out.push('  ' + c.gray(`  ${clock(e.t)} `) + col(cut(e.msg, inner - 12)));
  });
  out.push(dash);
  out.push(fit([['  ', null], ['[r]', c.accent], [' tes semua model  ', c.gray], ['[1]', c.accent], [' reset status  ', c.gray], ['[q]', c.accent], [' kembali ke menu', c.gray]], W));
  return out.map((l) => l.replace(/\s+$/, ''));
}

// ---------------------------------------------------------------- CLI

const KNOWN = ['port', 'model-name', 'first-byte', 'timeout', 'cooldown', 'watch', 'no-ui', 'from-menu', 'limit-pattern', 'help', 'ascii', 'unicode'];

async function main() {
  const A = L.makeArgs();
  if (A.has('help')) {
    console.log([
      'GASPOLL guardian: perantara OpenAI-compatible dengan fallback otomatis antar model.',
      '',
      'Pakai:  node src/guardian.js [opsi]',
      '  --port N            port guardian (bawaan 20130, hanya 127.0.0.1)',
      '  --model-name NAMA   nama model virtual untuk klien (bawaan guardian)',
      '  --first-byte DETIK  batas tunggu respons pertama (bawaan 30)',
      '  --timeout DETIK     batas satu percobaan non-stream (bawaan 90)',
      '  --cooldown DETIK    cooldown awal model yang gagal (bawaan 20)',
      '  --watch DETIK       probe berkala model sehat (bawaan mati)',
      '  --limit-pattern RE  tambahan pola teks limit (regex)',
      '  --no-ui             tanpa dashboard, cetak log biasa',
      '',
      'Arahkan klien ke http://127.0.0.1:PORT/v1 dan pakai model "guardian".',
    ].join('\n'));
    return;
  }
  L.warnUnknown(A.argv, KNOWN);
  const opts = {
    port: A.num('port', DEFAULTS.port),
    virtualModel: A.opt('model-name', DEFAULTS.virtualModel),
    firstByteMs: A.num('first-byte', DEFAULTS.firstByteMs / 1000) * 1000,
    attemptMs: A.num('timeout', DEFAULTS.attemptMs / 1000) * 1000,
    cooldownBaseMs: A.num('cooldown', DEFAULTS.cooldownBaseMs / 1000) * 1000,
    watchMs: A.num('watch', 0) * 1000,
    limitPattern: A.opt('limit-pattern', ''),
  };
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') && !A.has('no-ui') && !process.env.CI;
  if (!interactive) {
    L.startLog('guardian', []);
    opts.onEvent = (e) => L.line(`  ${clock(e.t)} ${e.msg}`);
  }
  const g = createGuardian(opts);
  try {
    await g.start();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      L.line(L.col.red(`[!] Port ${opts.port} sudah dipakai (guardian lain sudah jalan?). Coba: node src/guardian.js --port ${opts.port + 1}`));
    } else {
      L.line(L.col.red(`[!] Guardian gagal start: ${e.message}`));
    }
    process.exitCode = 1;
    return;
  }

  let quitting = false;
  const restore = () => {
    if (interactive) { try { process.stdin.setRawMode(false); } catch { /* sudah */ } process.stdout.write('\x1b[?25h'); }
  };
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    clearInterval(drawTimer);
    restore();
    await g.stop();
    process.exit(0);
  };

  let drawTimer = null;
  if (!interactive) {
    L.line(`Guardian aktif di http://${g.opts.host}:${g.port}/v1 (model "${opts.virtualModel}"), ${g.models.length} model di urutan.`);
    L.line('Ctrl+C untuk berhenti.');
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
    return;
  }

  process.stdout.write('\x1b[2J\x1b[?25l');
  const draw = () => {
    const lines = renderDashboard(g, { width: process.stdout.columns || 80, rows: process.stdout.rows || 30 });
    process.stdout.write('\x1b[H' + lines.map((l) => l + '\x1b[K').join('\n') + '\n\x1b[J');
  };
  draw();
  drawTimer = setInterval(draw, 500);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', (ch, key) => {
    const k = (key && key.name) || ch;
    if ((key && key.ctrl && k === 'c') || k === 'q' || k === '0') quit();
    else if (k === 'r') g.probeAll().catch(() => {});
    else if (k === '1') g.resetStates();
  });
  process.on('SIGTERM', quit);
  process.on('exit', restore);
}

module.exports = { createGuardian, renderDashboard, classifyHttp, classifyContent, buildPatterns, DEFAULTS };

if (require.main === module) {
  main().catch((e) => { console.error(`[!] ${e.message}`); process.exit(1); });
}

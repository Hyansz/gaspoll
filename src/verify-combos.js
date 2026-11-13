#!/usr/bin/env node
'use strict';
/**
 * verify-combos.js
 * Verifikasi combo di router vs file hasil di results/.
 * Default: via API. Opsi --ui: via dashboard di Chrome yang terlihat.
 */

const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { col } = L;

const A = L.makeArgs();
const { has, opt, list, num } = A;
const KNOWN = ['only', 'ui', 'base-url', 'timeout', 'help'];

const cfg = L.loadConfig();
if (opt('base-url', '')) cfg.baseUrl = opt('base-url', '').replace(/\/+$/, '');
const ONLY = list(opt('only', ''));
const TIMEOUT_MS = Math.max(5, num('timeout', 30)) * 1000;

function readResults(name) {
  const f = L.inResults(name);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function expectedCombos() {
  const out = {};
  const a = readResults('combo-auto-combo.json');
  if (a && a.name && Array.isArray(a.models) && a.models.length) out[a.name] = a.models;
  const b = readResults('bench-results.json');
  if (b && b.tiers) {
    for (const [t, ids] of Object.entries(b.tiers)) {
      if (Array.isArray(ids) && ids.length) out[t] = ids;
    }
  }
  return out;
}

function compare(expected, actual) {
  const missing = expected.filter((x) => !(actual || []).includes(x));
  const extra = (actual || []).filter((x) => !(expected || []).includes(x));
  let status = 'PASS';
  if (missing.length || extra.length) status = 'FAIL';
  else if (expected.join('|') !== (actual || []).join('|')) status = 'WARN';
  return { status, missing, extra };
}

async function apiCheck() {
  L.heading('VERIFIKASI COMBO VIA API');
  const alive = await L.checkRouter(cfg, 5000);
  if (!alive.ok) {
    L.line(col.red(`[!] 9Router tidak online di ${cfg.baseUrl}: ${alive.reason}`));
    return false;
  }
  let cookie = '';
  if (cfg.password) {
    try {
      cookie = await L.dashboardCookie(cfg);
    } catch (e) {
      L.line(col.yellow(`[!] Login dashboard gagal: ${e.message}`));
    }
  }
  const h = { ...L.authHeaders(cfg), ...(cookie ? { Cookie: cookie } : {}) };
  let r;
  try {
    r = await L.fetchJson(`${cfg.baseUrl}/api/combos`, { headers: h }, TIMEOUT_MS);
  } catch (e) {
    L.line(col.red(`[!] Gagal GET /api/combos: ${e.message}`));
    return false;
  }
  if (!r.res.ok) {
    L.line(col.red(`[!] GET /api/combos gagal (HTTP ${r.res.status})`));
    return false;
  }
  const arr = Array.isArray(r.body) ? r.body : r.body?.combos || [];
  const map = {};
  arr.forEach((c) => { if (c.name && Array.isArray(c.models)) map[c.name] = c.models; });

  const expected = expectedCombos();
  let allPass = true;
  for (const [name, models] of Object.entries(expected)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    L.line('');
    L.line(col.bold(`Combo: ${name}`));
    if (!map[name]) {
      L.line(col.red(`  FAIL: combo "${name}" tidak ada di router`));
      allPass = false;
      continue;
    }
    const c = compare(models, map[name]);
    if (c.status === 'PASS') L.line(col.green(`  PASS: ${models.length} model, urutan sama`));
    else if (c.status === 'WARN') {
      L.line(col.yellow(`  WARN: isi sama tapi urutan beda (tidak cocok setelah --apply)`));
      L.line(`    Kurang : ${c.missing.length ? c.missing.join(', ') : '-'}`);
      L.line(`    Kelebihan: ${c.extra.length ? c.extra.join(', ') : '-'}`);
      allPass = false;
    } else {
      L.line(col.red(`  FAIL: isi berbeda`));
      L.line(`    Kurang : ${c.missing.join(', ') || '-'}`);
      L.line(`    Kelebihan: ${c.extra.join(', ') || '-'}`);
      allPass = false;
    }
  }
  return allPass;
}

async function uiCheck() {
  L.heading('VERIFIKASI COMBO VIA UI DASHBOARD (Chrome terlihat)');
  let pw;
  try {
    pw = require('playwright-core');
  } catch {
    L.line(col.red('[!] Playwright belum terpasang. Jalankan: npm install playwright-core'));
    return false;
  }

  const resultsDir = path.join(L.RESULTS, 'ui-check');
  fs.mkdirSync(resultsDir, { recursive: true });

  const browser = await pw.chromium.launch({
    channel: 'chrome',
    headless: false,
    slowMo: 300,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Login otomatis via POST /api/auth/login, ambil cookie, injeksi ke context
  let cookieStr = '';
  try {
    cookieStr = await L.dashboardCookie(cfg);
    L.line(col.dim(`[OK] Login otomatis berhasil, cookie siap dipakai di Chrome`));
  } catch (e) {
    L.line(col.yellow(`[!] Login otomatis gagal: ${e.message}`));
  }
  if (cookieStr) {
    const cookieParts = cookieStr.split('; ');
    for (const p of cookieParts) {
      const idx = p.indexOf('=');
      if (idx > 0) {
        await context.addCookies([{
          name: p.slice(0, idx),
          value: p.slice(idx + 1),
          domain: new URL(cfg.baseUrl).hostname,
          path: '/',
          httpOnly: true,
        }]);
      }
    }
  }

  await page.goto(`${cfg.baseUrl}/dashboard/combos`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // Screenshot halaman combos sebelum inspect
  await page.screenshot({ path: path.join(resultsDir, 'combos-before.png'), fullPage: true });

  const expected = expectedCombos();
  let allPass = true;
  for (const [name, models] of Object.entries(expected)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    L.line('');
    L.line(col.bold(`Combo: ${name}`));
    try {
      // Cari kartu combo berdasarkan nama persis
      let card = page.locator('div.flex.min-w-0.flex-col.gap-3').filter({ hasText: name }).first();
      if (await card.count() === 0) {
        card = page.locator(`text=${JSON.stringify(name)} >> xpath=ancestor::div[2]`).first();
      }
      // Klik tombol Edit di dalam card: cari tombol yang punya teks "Edit" atau ikon edit
      const editBtn = card.locator('button:has-text("Edit"), [title="Edit"], span:has-text("Edit")').first();
      if (await editBtn.count() === 0) {
        L.line(col.red(`  FAIL: tombol Edit tidak ditemukan di kartu "${name}"`));
        allPass = false;
        continue;
      }
      await editBtn.click();
      await page.waitForTimeout(1500);

      // Modal Edit Combo: baca daftar model dari modal yang terbuka
      await page.waitForSelector('text=Edit Combo', { timeout: TIMEOUT_MS });
      L.line(col.dim(`  [OK] Modal "Edit Combo" untuk "${name}" terbuka`));

      // Ekstrak model id dari modal: cari semua elemen di div.fixed yang memuat 'Edit Combo'
      let uiModels = await page.evaluate(() => {
        const modals = Array.from(document.querySelectorAll('div.fixed'));
        const target = modals.find((m) => m.textContent.includes('Edit Combo'));
        if (!target) return [];
        const allEls = Array.from(target.querySelectorAll('*'));
        const modelIds = [];
        const seen = new Set();
        for (const el of allEls) {
          const txt = el.textContent.trim();
          // Model id valid: mengandung slash, tanpa spasi, dan bukan teks UI
          if (txt.includes('/') && !txt.includes(' ') && !txt.includes('arrow') && !txt.includes('close')) {
            if (!seen.has(txt)) {
              seen.add(txt);
              modelIds.push(txt);
            }
          }
        }
        return modelIds;
      });

      const c = compare(models, uiModels);
      if (c.status === 'PASS') L.line(col.green(`  PASS: ${models.length} model, urutan sama`));
      else if (c.status === 'WARN') {
        L.line(col.yellow(`  WARN: urutan berbeda di dashboard`));
        L.line(`    Kurang : ${c.missing.length ? c.missing.join(', ') : '-'}`);
        L.line(`    Kelebihan: ${c.extra.length ? c.extra.join(', ') : '-'}`);
        allPass = false;
      } else {
        L.line(col.red(`  FAIL: isi berbeda`));
        L.line(`    Kurang : ${c.missing.join(', ') || '-'}`);
        L.line(`    Kelebihan: ${c.extra.join(', ') || '-'}`);
        allPass = false;
      }
      await page.screenshot({ path: path.join(resultsDir, `modal-${name}.png`), fullPage: true });
      // Tutup modal dengan tombol Cancel
      await page.locator('button:has-text("Cancel"), button:has-text("Batal")').first().click();
      await page.waitForTimeout(500);
    } catch (e) {
      L.line(col.red(`  FAIL: ${e.message}`));
      allPass = false;
    }
  }

  L.line('');
  L.line(col.dim('Tunggukan: Chrome tetap terbuka selama 10 detik untuk inspeksi manual...'));
  await page.waitForTimeout(10000);
  await browser.close();
  return allPass;
}

async function main() {
  L.installCrashHandlers();
  if (has('help')) {
    const src = fs.readFileSync(__filename, 'utf8');
    console.log(src.split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?\n?/, '').replace(/^ \* ?/gm, ''));
    return;
  }
  L.startLog(has('ui') ? 'verify-ui' : 'verify-api', [`args: ${A.argv.join(' ')}`, `router: ${cfg.baseUrl}`]);
  L.warnUnknown(A.argv, KNOWN);
  const ok = has('ui') ? await uiCheck() : await apiCheck();
  process.exitCode = ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((e) => {
    L.line(col.red(`\n[!] Error: ${e.message}`));
    if (L.lastLogPath()) L.line(col.dim(`Log lengkap: ${L.lastLogPath()}`));
    process.exitCode = 1;
  });
}

module.exports = { expectedCombos, compare, apiCheck, uiCheck };

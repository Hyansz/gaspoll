'use strict';
/**
 * Skenario pengujian mock router di port 20999 (bukan 20128).
 */

const test = require('node:test');
const assert = require('node:assert');
const mockRouter = require('./mock-router.js');
const L = require('../src/lib.js');

const MOCK_PORT = mockRouter.PORT;
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;

const cfg = {
  baseUrl: MOCK_BASE,
  apiKey: 'sk-mock-test-key-000',
  password: 'mock-password',
  source: 'mock-test',
};

test('mock: alur login, ambil key, buat combo, verify', async () => {
  await mockRouter.start();
  try {
    // 1. Login
    const loginRes = await L.fetchJson(`${MOCK_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: '123456' }),
    }, 5000);
    assert.strictEqual(loginRes.res.status, 200, 'login harus 200');
    const cookie = loginRes.res.headers.get('set-cookie')?.split(';')[0] || '';
    assert.ok(cookie.includes('mock_cookie'), 'cookie mock harus terkirim');

    // 2. Ambil API key
    const keysRes = await L.fetchJson(`${MOCK_BASE}/api/keys`, {
      headers: { Cookie: cookie, ...L.authHeaders(cfg) },
    }, 5000);
    assert.strictEqual(keysRes.res.status, 200);
    const activeKey = keysRes.body?.keys?.find((k) => k.isActive);
    assert.ok(activeKey, 'ada API key aktif');

    // 3. Buat combo auto-combo
    const comboModels = ['gemini/gemini-flash', 'gemini/gemini-flash-2'];
    const saveRes = await L.saveCombo(cfg, cookie, 'auto-combo', comboModels);
    assert.strictEqual(saveRes.ok, true, 'simpan auto-combo harus berhasil');

    // 4. Verify dengan GET /api/combos
    const combosRes = await L.fetchJson(`${MOCK_BASE}/api/combos`, {
      headers: { Cookie: cookie, ...L.authHeaders(cfg) },
    }, 5000);
    assert.strictEqual(combosRes.res.status, 200);
    const combos = Array.isArray(combosRes.body) ? combosRes.body : combosRes.body?.combos || [];
    const autoCombo = combos.find((c) => c.name === 'auto-combo');
    assert.ok(autoCombo, 'auto-combo harus ada di mock');
    assert.deepStrictEqual(autoCombo.models, comboModels, 'isi auto-combo harus sesuai');

    // 5. combo-coding (milik user) tidak boleh terhapus
    const comboCoding = combos.find((c) => c.name === 'combo-coding');
    assert.ok(comboCoding, 'combo-coding harus tetap ada');
    assert.strictEqual(comboCoding.models.length, 2, 'combo-coding punya 2 model');
  } finally {
    await mockRouter.stop();
  }
});

test('mock: provider 55 model tidak merusak combo, terpotong secara terkontrol', async () => {
  await mockRouter.start();
  try {
    const models = mockRouter.getModels();
    const largeModelCount = models.filter((m) => m.id.startsWith('cf/provider-large/')).length;
    assert.strictEqual(largeModelCount, 55, 'ada 55 model besar');

    // Test bahwa combo bisa dibuat dengan subset model
    const comboModels = models.filter((m) => m.id.startsWith('gemini/')).map((m) => m.id);
    const loginRes = await L.fetchJson(`${MOCK_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'mock-password' }),
    }, 5000);
    assert.strictEqual(loginRes.res.status, 200, 'login harus 200');
    const cookie = loginRes.res.headers.get('set-cookie')?.split(';')[0] || '';

    const saveRes = await L.saveCombo(cfg, cookie, 'test-large-combo', comboModels);
    assert.strictEqual(saveRes.ok, true, `simpan combo harus berhasil, got: ${JSON.stringify(saveRes)}`);

    // Verify combo yang tersimpan
    const combosRes = await L.fetchJson(`${MOCK_BASE}/api/combos`, {
      headers: { Cookie: cookie, ...L.authHeaders(cfg) },
    }, 5000);
    assert.strictEqual(combosRes.res.status, 200, 'GET /api/combos harus 200');
    const combos = Array.isArray(combosRes.body) ? combosRes.body : combosRes.body?.combos || [];
    const testCombo = combos.find((c) => c.name === 'test-large-combo');
    assert.ok(testCombo, 'test-large-combo harus ada di mock');
    assert.strictEqual(testCombo.models.length, comboModels.length, 'jumlah model harus sesuai');
  } finally {
    await mockRouter.stop();
  }
});

test('mock: skenario error 429/503/410 tidak mengganggu model lain', async () => {
  await mockRouter.start();
  try {
    // Set skenario error untuk model tertentu
    mockRouter.setScenario('gemini/gemini-flash', '429');
    mockRouter.setScenario('gemini/gemini-flash-2', '503');

    // Uji model pertama: harus dapat 429
    const r1 = await L.fetchJson(`${MOCK_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: L.authHeaders(cfg),
      body: JSON.stringify({ model: 'gemini/gemini-flash' }),
    }, 5000);
    assert.strictEqual(r1.res.status, 429, 'Model gemini/gemini-flash harus 429');

    // Uji model kedua: harus dapat 503
    const r2 = await L.fetchJson(`${MOCK_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: L.authHeaders(cfg),
      body: JSON.stringify({ model: 'gemini/gemini-flash-2' }),
    }, 5000);
    assert.strictEqual(r2.res.status, 503, 'Model gemini/gemini-flash-2 harus 503');

    // Uji model yang tidak set skenario: harus sukses
    const r3 = await L.fetchJson(`${MOCK_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: L.authHeaders(cfg),
      body: JSON.stringify({ model: 'cf/provider-large/model-0' }),
    }, 5000);
    assert.strictEqual(r3.res.status, 200, 'Model lain harus sukses');
    assert.strictEqual(r3.body?.choices?.[0]?.message?.content, '391');

    // Bersihkan skenario
    mockRouter.clearScenarios();
  } finally {
    await mockRouter.stop();
  }
});

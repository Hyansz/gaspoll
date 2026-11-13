'use strict';
/**
 * mock-router.js
 * Mock server 9Router untuk pengujian tanpa menyentuh kuota asli.
 * Port default 20999 (WAJIB bukan 20128, karena 20128 milik 9Router asli).
 */

// Bukan tes. Jangan dijalankan lewat node --test.
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.MOCK_PORT || 20999);

const state = {
  comboDb: [
    { id: 'c1', name: 'combo-coding', kind: null, models: ['mock/owned-model-1', 'mock/owned-model-2'] },
  ],
  modelList: [
    { id: 'gemini/gemini-flash', owned_by: 'gemini', type: 'model' },
    { id: 'gemini/gemini-flash-2', owned_by: 'gemini', type: 'model' },
    ...Array.from({ length: 55 }, (_, i) => ({
      id: `cf/provider-large/model-${i}`, owned_by: 'cf', type: 'model',
    })),
  ],
  errorMap: new Map(),
};

function getScenario(id) {
  return state.errorMap.get(id) || 'ok';
}

function dispatch(url, method, body, res) {
  if (url === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  if (url === '/v1/models' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: state.modelList }));
    return;
  }

  if (url === '/api/auth/login' && method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'mock_cookie=abc123; Path=/' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (url === '/api/keys' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      keys: [
        { id: 'k1', key: 'sk-mock-test-key-000', name: 'Default Key', isActive: true },
      ],
    }));
    return;
  }

  if (url === '/api/combos' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state.comboDb));
    return;
  }

  if (url === '/api/combos' && method === 'POST') {
    let combo;
    try { combo = JSON.parse(body); } catch { combo = null; }
    if (!combo || !combo.name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid combo' }));
      return;
    }
    const existing = state.comboDb.find((c) => c.name === combo.name);
    if (existing) {
      existing.models = combo.models || existing.models;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, updated: true, combo: existing }));
    } else {
      const newCombo = { id: crypto.randomUUID(), kind: null, ...combo };
      state.comboDb.push(newCombo);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, combo: newCombo }));
    }
    return;
  }

  if (url === '/v1/chat/completions' && method === 'POST') {
    let payload;
    try { payload = JSON.parse(body); } catch { payload = {}; }
    const modelId = payload.model;
    const scenario = getScenario(modelId);

    if (scenario === '429') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate limited' }));
      return;
    }

    if (scenario === '503') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'service unavailable' }));
      return;
    }

    if (scenario === '410') {
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'gone' }));
      return;
    }

    if (scenario === 'timeout') {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'gateway timeout' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '391' } }] }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

function handleRequest(req, res) {
  res.setHeader('Connection', 'close');
  const url = req.url.split('?')[0];
  const method = req.method;

  if (method === 'GET') {
    dispatch(url, method, '', res);
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    dispatch(url, method, body, res);
  });
}

const server = http.createServer(handleRequest);

module.exports = {
  PORT,
  server,
  state,
  start: () => new Promise((resolve) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Port masih dipakai (kemungkinan belum close selesai), tunggu sebentar
        setTimeout(() => {
          server.removeAllListeners('error');
          server.listen(PORT, resolve);
        }, 200);
      } else {
        resolve();
      }
    });
    server.listen(PORT, '127.0.0.1', () => {
      server.removeAllListeners('error');
      resolve();
    });
  }),
  stop: () => new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(resolve);
    // Pastikan closed selesai
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    server.on('close', done);
    // Fallback timeout
    setTimeout(done, 1000);
  }),
  setScenario: (modelId, scenario) => {
    state.errorMap.set(modelId, scenario);
  },
  clearScenarios: () => state.errorMap.clear(),
  addModel: (m) => state.modelList.push(m),
  getModels: () => state.modelList,
  getCombos: () => state.comboDb,
};

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Mock 9Router running on http://localhost:${PORT}`);
    console.log('Tekan Ctrl+C untuk berhenti.');
  });
}

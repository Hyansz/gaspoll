'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const resultsDir = path.join(__dirname, '..', 'results');

// Create temporary isolated results directory for the entire test suite
const tmpRoot = fs.mkdtempSync(require('os').tmpdir() + '\\gaspoll-test-res-');
process.env.GASPOLL_RESULTS = tmpRoot;

function getSnapshot() {
  const map = new Map();
  if (!fs.existsSync(resultsDir)) return map;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const stat = fs.statSync(full);
        map.set(path.relative(resultsDir, full), stat.mtimeMs);
      }
    }
  };
  walk(resultsDir);
  return map;
}

const before = getSnapshot();

const res = cp.spawnSync(process.execPath, ['--test', 'test/*.test.js'], {
  stdio: 'inherit',
  env: process.env
});

const after = getSnapshot();

let diff = false;
const allKeys = new Set([...before.keys(), ...after.keys()]);
const diffDetails = [];

for (const k of allKeys) {
  if (!before.has(k) || !after.has(k) || before.get(k) !== after.get(k)) {
    diff = true;
    diffDetails.push(k);
  }
}

if (diff || res.status !== 0) {
  if (diff) {
    console.error('\x1b[31m[!] GUARD ERROR: Test suite modified files in original results/ folder:\x1b[0m', diffDetails);
  }
  process.exit(res.status !== 0 ? res.status : 1);
}

process.exit(0);

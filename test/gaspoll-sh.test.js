const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('gaspoll sh script has correct shebang and exec', () => {
  const p = path.join(__dirname, '..', 'gaspoll.sh');
  const content = fs.readFileSync(p, 'utf8');
  const lines = content.split(/\r?\n/);
  assert.strictEqual(lines[0], '#!/usr/bin/env sh', 'Shebang line incorrect');
  const execLine = lines.find(l => l.includes('exec node src/cli.js'));
  assert.ok(execLine, 'exec line missing');
  const raw = fs.readFileSync(p);
  for (let i = 0; i < raw.length; i++) {
    assert.notStrictEqual(raw[i], 0x0d, 'CR character found in gaspoll.sh');
  }
});

const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'src');
const ui = require(path.join(root, 'ui.js'));
const lib = require(path.join(root, 'lib.js'));
const mods = { UI: ui, UI2: ui, L: lib, L2: lib };
let missing = [];
for (const f of fs.readdirSync(root).filter(x => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/);
  src.forEach((line, i) => {
    for (const m of line.matchAll(/\b(UI2?|L2?)\.([A-Za-z_$][\w$]*)/g)) {
      if (!(m[2] in mods[m[1]])) missing.push(f + ':' + (i + 1) + ' ' + m[1] + '.' + m[2]);
    }
  });
}
require('node:test').it('export scanner finds no missing exports', () => {
  const assert = require('node:assert');
  assert.strictEqual(missing.length, 0, 'Missing exports: ' + missing.join('\n'));
});

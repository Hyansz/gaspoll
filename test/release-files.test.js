const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('release files validation', () => {
  // README must contain image reference
  const readme = fs.readFileSync('README.md', 'utf8');
  assert.ok(readme.includes('![GASPOLL - menu utama](docs/gaspoll-menu.png)'), 'README missing menu image');
  // README must contain gaspoll.bat and gaspoll.sh commands
  assert.ok(readme.includes('gaspoll.bat'), 'README missing gaspoll.bat');
  assert.ok(readme.includes('gaspoll.sh'), 'README missing gaspoll.sh');
  // .gitattributes lines
  const gitat = fs.readFileSync('.gitattributes', 'utf8');
  assert.ok(gitat.includes('*.bat text eol=crlf'), '.gitattributes missing *.bat rule');
  assert.ok(gitat.includes('*.sh text eol=lf'), '.gitattributes missing *.sh rule');
  // ci.yml must contain the three OS names
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.ok(ci.includes('ubuntu-latest'), 'ci.yml missing ubuntu-latest');
  assert.ok(ci.includes('macos-latest'), 'ci.yml missing macos-latest');
  assert.ok(ci.includes('windows-latest'), 'ci.yml missing windows-latest');
  // pack script must contain gaspoll.sh and .gitattributes entries
  const pack = fs.readFileSync('scripts/pack-gaspoll.js', 'utf8');
  assert.ok(pack.includes('gaspoll.sh'), 'pack script missing gaspoll.sh');
  assert.ok(pack.includes('.gitattributes'), 'pack script missing .gitattributes');
});

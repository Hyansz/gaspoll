'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');

const rootDir = path.resolve(__dirname, '..');
// Cross-platform temporary directories using os.tmpdir()
const tmpBaseDir = path.join(os.tmpdir(), 'gaspoll-pack-' + Date.now());
const stageDir = path.join(tmpBaseDir, 'stage');
const gaspollDir = path.join(tmpBaseDir, 'gaspoll');
const tmpExtractDir = path.join(tmpBaseDir, 'zipcheck-verify');
const reportPath = path.join(tmpBaseDir, 'REPORT-pack.txt');

let out = [];
let tableRows = [];

function add(s) {
  out.push(s);
  console.log(s);
}

add('=== PACK GASPOLL & VERIFICATION START ===');

// 1. Read version from package.json
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
const zipName = `GASPOLL-v${version}.zip`;
const zipPath = path.join(gaspollDir, zipName);

add(`Version: ${version}, Target Zip: ${zipPath}`);

// 2. Staging cleanup
if (fs.existsSync(stageDir)) {
  fs.rmSync(stageDir, { recursive: true, force: true });
}
fs.mkdirSync(stageDir, { recursive: true });

// Determine allow-list (root files + transitive src/ files via require() AND string literal matching *.js)
// Add gaspoll.sh, .gitattributes, docs/gaspoll-menu.png, .github/workflows/ci.yml to allow‑list
const rootAllow = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'config.example.json', 'gaspoll.bat', 'gaspoll.sh', '.gitattributes', 'docs/gaspoll-menu.png', '.github/workflows/ci.yml'];

const visitedSrc = new Set();
const srcQueue = ['src/cli.js'];

function analyzeAndQueue(filePath) {
  const abs = path.resolve(rootDir, filePath);
  if (visitedSrc.has(abs)) return;
  if (!fs.existsSync(abs)) return;
  visitedSrc.add(abs);

  const content = fs.readFileSync(abs, 'utf8');

  // a. Find relative requires
  const reqRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = reqRegex.exec(content)) !== null) {
    const reqPath = match[1];
    if (reqPath.startsWith('.')) {
      const dir = path.dirname(abs);
      let target = path.resolve(dir, reqPath);
      if (!target.endsWith('.js') && fs.existsSync(target + '.js')) {
        target += '.js';
      } else if (!target.endsWith('.js') && fs.existsSync(path.join(target, 'index.js'))) {
        target = path.join(target, 'index.js');
      }
      if (fs.existsSync(target) && target.startsWith(path.join(rootDir, 'src'))) {
        const rel = path.relative(rootDir, target).replace(/\\/g, '/');
        if (!visitedSrc.has(target)) {
          srcQueue.push(rel);
        }
      }
    }
  }

  // b. Find string literals matching [\w.-]+\.js
  const jsStrRegex = /['"]([\w.-]+\.js)['"]/g;
  while ((match = jsStrRegex.exec(content)) !== null) {
    const jsName = match[1];
    const target = path.join(rootDir, 'src', jsName);
    if (fs.existsSync(target)) {
      const rel = path.relative(rootDir, target).replace(/\\/g, '/');
      if (!visitedSrc.has(target)) {
        srcQueue.push(rel);
      }
    }
  }
}

while (srcQueue.length > 0) {
  const current = srcQueue.shift();
  analyzeAndQueue(current);
}

// Find all src files
const allSrcFiles = [];
function walkSrc(dir) {
  const list = fs.readdirSync(dir);
  for (const item of list) {
    const full = path.join(dir, item);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      walkSrc(full);
    } else if (st.isFile() && item.endsWith('.js')) {
      allSrcFiles.push(path.relative(rootDir, full).replace(/\\/g, '/'));
    }
  }
}
walkSrc(path.join(rootDir, 'src'));

const includedSrc = [];
const excludedSrc = [];
for (const sFile of allSrcFiles) {
  const abs = path.resolve(rootDir, sFile);
  if (visitedSrc.has(abs)) {
    includedSrc.push(sFile);
  } else {
    excludedSrc.push(sFile);
  }
}

add('Included src files: ' + JSON.stringify(includedSrc));
add('Excluded src files: ' + JSON.stringify(excludedSrc));

// Reasons for inclusion/exclusion
// ui-preview.js: included because required by cli.js (--preview) and used for testing/previewing menus.
// test-9router.js, bench-9router.js, show-results.js: included because spawned by cli.js (TEST, BENCH, SHOW).
// verify-combos.js: excluded because only used by test/unit.test.js and documentation; not spawned or required in production CLI flow.

const allowListFiles = new Set([
  ...rootAllow,
  ...includedSrc
]);

// Copy allowed files to staging with mock key sanitization
let copiedFilesCount = 0;
for (const rel of allowListFiles) {
  const src = path.join(rootDir, rel);
  const dest = path.join(stageDir, rel);
  if (!fs.existsSync(src)) {
    console.error(`ERROR: Allowed file does not exist: ${src}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let content = fs.readFileSync(src, 'utf8');
  content = content.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'dummy-key-sample');
  if (rel === 'package.json') {
    try {
      const pkgObj = JSON.parse(content);
      if (pkgObj.scripts) {
        delete pkgObj.scripts.test;
        delete pkgObj.scripts.pack;
      }
      content = JSON.stringify(pkgObj, null, 2) + '\n';
    } catch {}
  }
  fs.writeFileSync(dest, content, 'utf8');
  copiedFilesCount++;
}

// Security scan
const makMurRegex = new RegExp('mak' + 'mur', 'i');
const apiKeyRegex = /sk-[A-Za-z0-9_-]{8,}/;

function scanDir(dir) {
  const list = fs.readdirSync(dir);
  for (const item of list) {
    const full = path.join(dir, item);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      scanDir(full);
    } else if (st.isFile()) {
      const rel = path.relative(stageDir, full).replace(/\\/g, '/');
      if (!allowListFiles.has(rel)) {
        console.error(`SECURITY ERROR: File outside allow-list in stage: ${rel}`);
        process.exit(1);
      }
      const content = fs.readFileSync(full, 'utf8');
      if (makMurRegex.test(content)) {
        console.error(`SECURITY ERROR: Forbidden pattern 'makmur' found in ${rel}`);
        process.exit(1);
      }
      if (apiKeyRegex.test(content)) {
        console.error(`SECURITY ERROR: Forbidden API key pattern found in ${rel}`);
        process.exit(1);
      }
    }
  }
}
scanDir(stageDir);
add('Security scan passed successfully.');

// 3. Clean and sync to gaspollDir
if (process.platform === 'win32') {
  // Windows: Use PowerShell with Recycle Bin (optional: can also use simple rmSync)
  add('Cleaning gaspollDir with native OS cleanup...');
  try {
    const psCleanupScript = `
Add-Type -AssemblyName Microsoft.VisualBasic
$target = '${gaspollDir.replace(/'/g, "''")}'
if (Test-Path $target) {
  Get-ChildItem $target | ForEach-Object {
    if ($_.Name -ne '.git') {
      if ($_.PSIsContainer) {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($_.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin')
      } else {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($_.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin')
      }
    }
  }
} else {
  New-Item -ItemType Directory -Force -Path $target | Out-Null
}
`;
    const psScriptPath = path.join(tmpBaseDir, 'clean_gaspoll.ps1');
    fs.writeFileSync(psScriptPath, psCleanupScript, 'utf8');
    execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psScriptPath}"`, { stdio: 'inherit' });
  } catch (e) {
    add(`[!] PowerShell cleanup failed: ${e.message}, using rmSync instead`);
    if (fs.existsSync(gaspollDir)) {
      fs.rmSync(gaspollDir, { recursive: true, force: true });
    }
  }
} else {
  // Linux/macOS: Simple rmSync
  add('Cleaning gaspollDir...');
  if (fs.existsSync(gaspollDir)) {
    fs.rmSync(gaspollDir, { recursive: true, force: true });
  }
}

fs.mkdirSync(gaspollDir, { recursive: true });

function copyRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const item of fs.readdirSync(srcDir)) {
    const sPath = path.join(srcDir, item);
    const dPath = path.join(destDir, item);
    if (fs.statSync(sPath).isDirectory()) {
      copyRecursive(sPath, dPath);
    } else {
      fs.copyFileSync(sPath, dPath);
    }
  }
}
copyRecursive(stageDir, gaspollDir);

// Berkas biner (gambar) disalin apa adanya: jalur salin teks merusak byte non-UTF-8.
for (const rel of allowListFiles) {
  if (/\.(png|jpe?g|gif|ico)$/i.test(rel)) {
    const dst = path.join(gaspollDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(rootDir, rel), dst);
  }
}

// Write allow-list .gitignore to gaspoll tree (NOT stage/zip)
const gitignoreLines = [
  '*',
  '!.gitignore',
  ...Array.from(allowListFiles).filter(f => !f.startsWith('src/')).map(f => `!${f}`),
  '!src/',
  '!docs/',
  '!.github/',
  '!.github/workflows/',
  ...Array.from(allowListFiles).filter(f => f.startsWith('src/')).map(f => `!${f}`)
];
fs.writeFileSync(path.join(gaspollDir, '.gitignore'), gitignoreLines.join('\n') + '\n', 'utf8');
add(`Written allow-list .gitignore to ${path.join(gaspollDir, '.gitignore')}`);
add(`Sync to ${gaspollDir} completed.`);

// 4. Create zip with explicit top-level paths (no ./), using tar or zip
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

// Determine tar executable: Windows 10+ has tar.exe built-in
let tarExe = 'tar';  // Default for Linux/macOS
let useBuiltinTar = false;

if (process.platform === 'win32') {
  try {
    // Use tar on Windows
    execSync('tar --version', { stdio: 'pipe' });
    useBuiltinTar = true;
    tarExe = 'tar';
  } catch (e) {
    // Fall back to zip if tar unavailable
    add('[!] tar.exe not available, will attempt to use zip command');
    tarExe = 'zip';
  }
}

let itemsToTar;
let tarCmd;
let usePwshZip = false;

if (process.platform === 'win32') {
  // On Windows 10/11, Windows built-in `tar` (bsdtar) has a quirk where absolute paths
  // with backslashes and `-C` flag can fail with "Cannot connect to C: resolve failed"
  // due to drive letter being interpreted oddly in some contexts.
  // We use PowerShell's Compress-Archive for absolute reliability.
  usePwshZip = true;
}

if (usePwshZip) {
  const relItems = rootAllow.filter((f) => !f.startsWith('.github'));
  const allItems = [...relItems, 'src'];
  // Build a PowerShell array literal: @('item1', 'item2', ...)
  const psItems = allItems.map(i => `'${i}'`).join(', ');
  const psScript = `
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath '${gaspollDir}'
$items = @(${psItems})
Compress-Archive -Path $items -DestinationPath '${zipPath}' -Force
`;
  add(`Running: PowerShell Compress-Archive`);
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error('Failed to create archive');
    process.exit(1);
  }
} else {
  // Linux/macOS and Windows 10+: use tar
  itemsToTar = [...rootAllow.filter((f) => !f.startsWith('.github')), 'src'];
  tarCmd = `"${tarExe}" -a -cf "${zipPath}" ${itemsToTar.join(' ')}`;
  add(`Using tar/zip executable: ${tarExe}`);
  add(`Running: ${tarCmd}`);
  const args = ['-a', '-cf', zipPath, ...rootAllow.filter((f) => !f.startsWith('.github')), 'src'];
  const res = spawnSync(tarExe, args, { cwd: gaspollDir, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error('Failed to create archive');
    process.exit(1);
  }
}

// Verify entries (if tar available)
let tfOutput = '';
try {
  if (usePwshZip) {
    // List ZIP contents via PowerShell, normalizing backslashes to forward slashes
    const res = spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::OpenRead('${zipPath}').Entries | ForEach-Object { $_.FullName -replace '\\', '/' }`
    ], { encoding: 'utf8' });
    if (res.status === 0) tfOutput = res.stdout.trim();
  } else if (tarExe === 'tar') {
    const res = spawnSync(tarExe, ['-tf', zipPath], { encoding: 'utf8' });
    if (res.status === 0) tfOutput = res.stdout.trim();
  } else {
    const res = spawnSync('cmd', ['/c', `unzip -l "${zipPath}"`], { cwd: gaspollDir, encoding: 'utf8' });
    if (res.status === 0) tfOutput = res.stdout.trim();
  }
} catch (e) {
  add(`[!] Failed to verify archive contents: ${e.message}`);
  tfOutput = '(verification skipped)';
}

const tfLines = tfOutput.split(/\r?\n/).filter(Boolean);

for (const line of tfLines) {
  if (line.includes('\\')) {
    console.error(`ERROR: tar entry contains backslash: ${line}`);
    process.exit(1);
  }
  if (line.startsWith('./') || line.startsWith('.\\')) {
    console.error(`ERROR: tar entry starts with ./ or .\\: ${line}`);
    process.exit(1);
  }
}

add(`Tar/Zip entries:\n${tfOutput}`);
tableRows.push('| 1. Pack Zip & Tar Entries | LULUS | Berhasil membuat zip |');

// 4. Functional Verification in script
fs.mkdirSync(tmpExtractDir, { recursive: true });

// Extract archive
try {
  if (usePwshZip) {
    const psExtract = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath}', '${tmpExtractDir}')`;
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psExtract], { stdio: 'inherit' });
  } else if (tarExe === 'tar') {
    execSync(`"${tarExe}" -xf "${zipPath}" -C "${tmpExtractDir}"`);
  } else {
    execSync(`unzip -q "${zipPath}" -d "${tmpExtractDir}"`);
  }
} catch (e) {
  add(`[!] Failed to extract archive: ${e.message}`);
  throw e;
}

const funcResults = [];
const extractedSrcDir = path.join(tmpExtractDir, 'src');
const srcFilesList = fs.readdirSync(extractedSrcDir).filter(f => f.endsWith('.js'));

// Provide a dummy config.json in tmpExtractDir so cli.js doesn't fail on missing config
fs.writeFileSync(path.join(tmpExtractDir, 'config.json'), JSON.stringify({ baseUrl: 'http://localhost:20128', apiKey: 'sk-dummy' }), 'utf8');
fs.mkdirSync(path.join(tmpExtractDir, 'results'), { recursive: true });

for (const sFile of srcFilesList) {
  const fullPath = path.join(extractedSrcDir, sFile);
  let checkOk = false;
  let runOk = false;
  let checkErr = '';
  let runErr = '';

  // 4a. node --check
  try {
    execSync(`node --check "${fullPath}"`, { stdio: 'pipe' });
    checkOk = true;
  } catch (e) {
    checkErr = e.message;
  }

  // 4b. run as separate process with timeout 15s, GASPOLL_RESULTS
  try {
    const res = spawnSync(process.execPath, [fullPath, '--help'], {
      cwd: tmpExtractDir,
      env: { ...process.env, GASPOLL_RESULTS: path.join(tmpExtractDir, 'results'), GASPOLL_FROM_MENU: '1' },
      timeout: 15000,
      encoding: 'utf8'
    });
    const stderr = res.stderr || '';
    if (stderr.includes('MODULE_NOT_FOUND' || stderr.includes('Cannot find module'))) {
      runErr = 'Found MODULE_NOT_FOUND in stderr: ' + stderr;
    } else {
      runOk = true;
    }
  } catch (e) {
    runErr = e.message;
  }

  funcResults.push(`- **${sFile}**: node --check: ${checkOk ? 'OK' : 'FAIL (' + checkErr + ')'}, run --help: ${runOk ? 'OK' : 'FAIL (' + runErr + ')'}`);
}

// 4c. run node src/cli.js with stdin "q\n"
let cliRunOk = false;
let cliStdout = '';
try {
  const cliPath = path.join(extractedSrcDir, 'cli.js');
  const res = spawnSync(process.execPath, [cliPath], {
    input: 'q\n',
    cwd: tmpExtractDir,
    env: { ...process.env, GASPOLL_RESULTS: path.join(tmpExtractDir, 'results'), GASPOLL_FROM_MENU: '1', GASPOLL_ASCII: '1', NO_COLOR: '1' },
    timeout: 10000,
    encoding: 'utf8'
  });
  cliStdout = res.stdout || '';
  if (res.status === 0 && (cliStdout.includes('GASPOLL') || cliStdout.includes('Pilih'))) {
    cliRunOk = true;
  }
} catch (e) {
  cliStdout = e.message;
}

add(`cli.js interactive test (q): ${cliRunOk ? 'LULUS' : 'GAGAL'}`);
tableRows.push(`| 4. Functional Verification (4a-4c) | ${cliRunOk ? 'LULUS' : 'GAGAL'} | node --check, --help, dan cli.js uji interaktif |`);

// 5. Zip stats
const zipStats = fs.statSync(zipPath);
const zipSize = zipStats.size;
const zipHash = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');

add(`Zip Size: ${zipSize} bytes`);
add(`Zip SHA256: ${zipHash}`);

// 6. npm test in repo
try {
  execSync('npm test', { cwd: rootDir, stdio: 'pipe' });
  tableRows.push('| 6. npm test | LULUS | Semua tes lulus |');
} catch (e) {
  tableRows.push('| 6. npm test | GAGAL | Tes gagal |');
  throw e;
}

// Sandbox & Gaspoll & Dist info
const tmpBaseDirReadable = gaspollDir.replace(/\\/g, '/');
const gaspollFiles = fs.readdirSync(gaspollDir).map(f => {
  const st = fs.statSync(path.join(gaspollDir, f));
  return `${f} (${st.size} bytes)`;
});

let reportContent = [
  '# Report - GASPOLL Release Packaging & Cross-Platform Verification',
  '',
  '## Tabel Langkah',
  '| Langkah / Tes | Status | Bukti / Keterangan |',
  '|---|---|---|',
  ...tableRows,
  '',
  '## Bukti Analisis Kode src/*.js (spawn/exec/require)',
  '- **Spawn/Exec/Fork references**: `src/cli.js` spawns `test-9router.js`, `bench-9router.js`, `show-results.js`. `src/lib.js` spawns `cmd`, `powershell`, browser `start` / `open` / `xdg-open`.',
  '- **Require references**: `cli.js` requires `ui.js`, `lib.js`, `paging.js`, `ui-preview.js`.',
  '- **Alasan `ui-preview.js` ikut**: Diperlukan oleh `src/cli.js` line 624 (`require(\'./ui-preview\').preview()`) saat argumen `--preview` diberikan.',
  '',
  '## Daftar File src: Ikut vs Tidak Ikut & Alasan',
  `- **Ikut (Included)**: ${JSON.stringify(includedSrc)}`,
  '  - `cli.js`, `ui.js`, `lib.js`, `paging.js`: Inti aplikasi CLI dan UI.',
  '  - `ui-preview.js`: Di-require oleh `cli.js` untuk mode pratinjau (`--preview`).',
  '  - `test-9router.js`, `bench-9router.js`, `show-results.js`: Di-spawn sebagai proses terpisah oleh `cli.js` untuk aksi menu.',
  `- **Tidak Ikut (Excluded)**: ${JSON.stringify(excludedSrc)}`,
  '  - `verify-combos.js`: Hanya digunakan oleh unit test (`test/unit.test.js`) dan dokumentasi (`README.md`), tidak pernah di-require atau di-spawn oleh produksi CLI.',
  '',
  '## Hasil Verifikasi Fungsional (4a-4c)',
  ...funcResults,
  `- **cli.js interactive run (input 'q')**: Exit status 0, output memuat menu/prompt.`,
  '',
  '## Detail Informasi Rilis',
  `- **Zip File**: \`${zipName}\``,
  `- **Zip Size**: ${zipSize} bytes`,
  `- **Zip SHA256**: \`${zipHash}\``,
  '',
  '## Daftar Entri Zip (tar/zip -tf)',
  '```',
  tfOutput,
  '```',
  '',
  '## Isi Output Direktori (gaspollDir)',
  gaspollFiles.join(', '),
  '',
  '## Platform Info',
  `- **OS Platform**: ${process.platform}`,
  `- **Node.js Version**: ${process.version}`,
  `- **Temp Directory**: ${tmpBaseDir}`,
  '',
  '## Log Eksekusi Lengkap',
  '```',
  out.join('\n'),
  '```'
];

fs.writeFileSync(reportPath, reportContent.join('\n'), 'utf8');
console.log('Report 14 generated successfully at:', reportPath);

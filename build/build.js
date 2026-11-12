'use strict';
// Builds a single self-contained executable (Node SEA) for the current OS:
//   dist/PhotonAIStudio(.exe)
// Steps: bundle src/*.js into one CommonJS file, embed public/* as SEA assets, inject into a copy of node.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const WORK = path.join(DIST, '.work');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// 1. tiny CommonJS bundler for our own modules (only relative requires of ./x)
const mods = {};
function collect(file) {
  const id = path.relative(path.join(ROOT, 'src'), file).replace(/\\/g, '/');
  if (mods[id]) return;
  let code = fs.readFileSync(file, 'utf8');
  mods[id] = null;
  code = code.replace(/require\('\.\/([\w-]+)'\)/g, (_, n) => { collect(path.join(ROOT, 'src', n + '.js')); return `__req('${n}.js')`; });
  mods[id] = code;
}
collect(path.join(ROOT, 'src', 'server.js'));
let bundle = `'use strict';\nconst __defs = {};\nconst __cache = {};\nfunction __req(id) { if (__cache[id]) return __cache[id].exports; const m = { exports: {} }; __cache[id] = m; __defs[id](m, m.exports); return m.exports; }\n`;
for (const [id, code] of Object.entries(mods)) {
  const body = code.replace(/^'use strict';/, '').replace(/require\.main === module/g, id === 'server.js' ? 'true' : 'false');
  bundle += `__defs['${id}'] = function (module, exports) {\nconst __dirname = process.cwd();\n${body}\n};\n`;
}
bundle += `__req('server.js');\n`;
const bundlePath = path.join(WORK, 'bundle.js');
fs.writeFileSync(bundlePath, bundle);

// 2. SEA config with embedded UI assets
const assets = {};
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) assets['public/' + f] = path.join(ROOT, 'public', f);
const seaCfg = { main: bundlePath, output: path.join(WORK, 'sea-prep.blob'), disableExperimentalSEAWarning: true, useCodeCache: false, assets };
fs.writeFileSync(path.join(WORK, 'sea-config.json'), JSON.stringify(seaCfg, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(WORK, 'sea-config.json')], { stdio: 'inherit' });

// 3. copy node binary and inject the blob
const exe = path.join(DIST, process.platform === 'win32' ? 'PhotonAIStudio.exe' : 'PhotonAIStudio');
fs.copyFileSync(process.execPath, exe);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', seaCfg.output, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });
execFileSync(npx, args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });
fs.rmSync(WORK, { recursive: true, force: true });
console.log('\nCreated: ' + exe);

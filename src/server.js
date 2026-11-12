'use strict';
// Photon AI Studio — local AI tools for Photon Studio (generative fill/expand, generate, remove background,
// super resolution, neural filters) powered by a self-installed ComfyUI engine.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const photon = require('./photon');
const { Comfy } = require('./comfy');
const { Engine, PACKS, defaultRoot } = require('./engine');
const hardware = require('./hardware');
const { Features, UserError, STYLES, LANDSCAPE, EXPRESSIONS } = require('./features');

const VERSION = '1.0.0';
const IS_WIN = process.platform === 'win32';

// ------------------------------------------------------------------ config
const CFG_DIR = process.env.PAS_CONFIG_DIR || path.join(os.homedir(), '.photon-ai-studio');
const CFG_FILE = path.join(CFG_DIR, 'config.json');
const DEFAULTS = {
  port: 7788,
  engineMode: 'managed',            // 'managed' = our own ComfyUI | 'external' = a ComfyUI you already run
  installDir: '',                    // '' = default per-OS folder
  enginePort: 8190,
  comfyUrl: 'http://127.0.0.1:8188', // used when engineMode = external
  extraModelDirs: [],                // other model folders to reuse (e.g. an existing ComfyUI/models)
  checkpoint: '',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: '',
  outputDir: path.join(os.homedir(), 'Pictures', 'Photon AI Studio'),
  photonPath: '',
  language: 'en',                    // UI language (only English ships for now)
  openWindow: true,
  stopEngineOnExit: true,
  setupDone: false,
};
function loadCfg() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }; } catch { return { ...DEFAULTS }; }
}
const cfg = loadCfg();
function saveCfg() { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); }
photon.setPath(cfg.photonPath);

// ------------------------------------------------------------------ context
const engine = new Engine(cfg);
const comfy = new Comfy(cfg.engineMode === 'external' ? cfg.comfyUrl : engine.url);
const ctx = { cfg, comfy, engine, hw: null };
const features = new Features(ctx);
const JOB_ROOT = path.join(os.tmpdir(), 'photon-ai-studio', 'jobs');

(function cleanupOldJobs() {
  try {
    for (const d of fs.readdirSync(JOB_ROOT)) {
      const p = path.join(JOB_ROOT, d);
      if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600e3) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch { /* none */ }
})();

async function hw() {
  if (!ctx.hw) ctx.hw = await hardware.check(engine.root);
  return ctx.hw;
}

async function ensureComfy() {
  if (cfg.engineMode === 'external') {
    comfy.setUrl(cfg.comfyUrl);
    if (!(await comfy.alive())) throw new UserError('err.comfyExternal', { url: cfg.comfyUrl });
    return;
  }
  comfy.setUrl(engine.url);
  if (await comfy.alive()) return;
  if (!engine.installed()) throw new UserError('err.notInstalled');
  const h = await hw();
  await engine.start({ lowVram: h.lowVram, cpu: h.cpuOnly });
  comfy._info = null;
}

// ------------------------------------------------------------------ i18n (server-side labels for layer names)
const LAYER_NAMES = {
  en: { 'layer.genfill': 'Generative Fill', 'layer.remove': 'Generative Remove', 'layer.expand': 'Generative Expand', 'layer.generate': 'Generated Image', 'layer.neural': 'Neural Filter',
    'nf.skin': 'Skin Smoothing', 'nf.portrait': 'Smart Portrait', 'nf.style': 'Style Transfer', 'nf.colorize': 'Colorize', 'nf.landscape': 'Landscape Mixer', 'nf.harmonize': 'Harmonization', 'nf.restore': 'Photo Restoration', 'nf.jpeg': 'JPEG Artifacts Removal', 'nf.superzoom': 'Super Zoom', 'nf.depthblur': 'Depth Blur' },
};
function lang() { return LAYER_NAMES[cfg.language] ? cfg.language : 'en'; }

// ------------------------------------------------------------------ jobs (one at a time: Photon revisions are sequential)
const jobs = new Map();
let chain = Promise.resolve();
const TOOLS = {
  genfill: (j, p) => features.genfill(j, p), expand: (j, p) => features.expand(j, p), generate: (j, p) => features.generate(j, p),
  removebg: (j, p) => features.removeBackground(j, p), select: (j, p) => features.select(j, p),
  superres: (j, p) => features.superResolution(j, p), neural: (j, p) => features.neural(j, p),
};
const NATIVE = new Set(['removebg', 'select']);

function createJob(tool, params, lng) {
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(JOB_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const t = k => LAYER_NAMES[lng][k] || k;
  const job = { id, tool, params, dir, t, status: 'queued', progress: 0, step: { key: 'job.queued' }, variants: [], error: null, createdAt: Date.now(), cancelled: false };
  jobs.set(id, job);
  chain = chain.then(async () => {
    if (job.cancelled) { job.status = 'cancelled'; return; }
    job.status = 'running';
    try {
      if (!NATIVE.has(tool)) { job.step = { key: 'job.engine' }; job.progress = 0.03; await ensureComfy(); }
      job.progress = Math.max(job.progress, 0.08);
      await TOOLS[tool](job, params);
      job.status = job.cancelled ? 'cancelled' : 'done'; job.progress = 1; job.step = { key: job.cancelled ? 'job.cancelled' : 'job.done' };
    } catch (e) {
      job.status = 'error';
      job.error = e instanceof UserError ? { key: e.key, vars: e.vars } : { message: e.message };
      console.error('[job ' + id + ']', e.message);
    }
  });
  // drop old jobs
  for (const [k, v] of jobs) if (Date.now() - v.createdAt > 3 * 3600e3) jobs.delete(k);
  return job;
}

function publicJob(j) {
  return { id: j.id, tool: j.tool, status: j.status, progress: j.progress, step: j.step, error: j.error,
    variants: j.variants.map((v, i) => ({ index: i, visible: v.visible, hasLayer: !!v.layerId, thumb: v.file ? `/api/jobs/${j.id}/variant/${i}` : null, path: v.path || null })) };
}

// ------------------------------------------------------------------ ollama (optional: prompt translate/improve)
async function ollamaModel() {
  try {
    const r = await fetch(cfg.ollamaUrl + '/api/tags', { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const names = ((await r.json()).models || []).map(m => m.name);
    if (cfg.ollamaModel && names.includes(cfg.ollamaModel)) return cfg.ollamaModel;
    return names.find(n => /qwen3|qwen2\.5|llama3|gemma|mistral/i.test(n) && !/embed|vl|vision/i.test(n)) || names[0] || null;
  } catch { return null; }
}
async function improvePrompt(text, mode) {
  const model = await ollamaModel();
  if (!model) throw new UserError('err.noOllama');
  const sys = mode === 'translate'
    ? 'Translate the user text to English for an image generation model. Output only the translation, nothing else.'
    : 'You write prompts for Stable Diffusion XL image generation. Rewrite the user idea (any language) as ONE concise English prompt: main subject first, then details, setting, lighting, style, quality tags; comma separated; max 60 words. Output only the prompt.';
  const r = await fetch(cfg.ollamaUrl + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(90000),
    body: JSON.stringify({ model, stream: false, think: false, options: { temperature: 0.4 }, messages: [{ role: 'system', content: sys }, { role: 'user', content: text }] }) });
  if (!r.ok) throw new Error('Ollama: ' + r.status);
  const j = await r.json();
  return String(j.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^"|"$/g, '');
}

// ------------------------------------------------------------------ static assets (works from disk and from a single executable)
let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch { sea = null; }
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function asset(rel) {
  if (sea) { try { return Buffer.from(sea.getAsset('public/' + rel)); } catch { return null; } }
  const p = path.join(PUBLIC, rel);
  if (!p.startsWith(PUBLIC)) return null;
  try { return fs.readFileSync(p); } catch { return null; }
}

// ------------------------------------------------------------------ http
function send(res, code, body, type = 'application/json') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(buf);
}
function readBody(req, limit = 40 * 1048576) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const errOut = e => (e instanceof UserError ? { error: { key: e.key, vars: e.vars } } : { error: { message: e.message, code: e.code } });

async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  const json = async () => { const b = await readBody(req); return b.length ? JSON.parse(b) : {}; };

  if (p === '/api/ping') return send(res, 200, { app: 'photon-ai-studio', version: VERSION });

  if (p === '/api/status' && m === 'GET') {
    const out = { version: VERSION, lang: lang(req), cfg: { ...cfg }, engine: { mode: cfg.engineMode, state: engine.state, installed: !!engine.installed(), task: engine.task, lastError: engine.lastError, root: engine.root, url: cfg.engineMode === 'external' ? cfg.comfyUrl : engine.url } };
    try { out.documents = await photon.listDocuments(); out.photon = { ok: true }; } catch (e) { out.photon = { ok: false, error: e.message, code: e.code }; out.documents = []; }
    out.comfy = { ok: !!(await comfy.alive(1500)) };
    out.ollama = { model: await ollamaModel() };
    out.hw = ctx.hw;
    return send(res, 200, out);
  }

  if (p === '/api/hardware') { if (url.searchParams.get('refresh')) ctx.hw = null; return send(res, 200, await hw()); }

  if (p === '/api/packs') {
    const st = engine.packStatus();
    return send(res, 200, { packs: st, engineInstalled: !!engine.installed(), root: engine.root, freeGB: hardware.freeDiskGB(engine.root) });
  }

  if (p === '/api/install' && m === 'POST') {
    const b = await json();
    if (b.installDir !== undefined && !engine.installed()) { cfg.installDir = b.installDir || ''; ctx.hw = null; }
    if (Array.isArray(b.extraModelDirs)) cfg.extraModelDirs = b.extraModelDirs.filter(Boolean);
    cfg.engineMode = 'managed'; saveCfg();
    const h = await hw();
    const packs = ['base', ...(b.packs || []).filter(x => x !== 'base' && PACKS[x])];
    const need = engine.estimateBytes(packs) / 1073741824;
    const free = hardware.freeDiskGB(engine.root);
    if (free != null && free < need + 2) return send(res, 400, { error: { key: 'err.disk', vars: { need: Math.ceil(need), free } } });
    engine.install({ packs, torch: b.torch || h.torch }).then(() => { cfg.setupDone = true; saveCfg(); }).catch(e => console.error('[install]', e.message));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/install/cancel' && m === 'POST') { engine.cancel(); return send(res, 200, { ok: true }); }
  if (p === '/api/install/log') return send(res, 200, { log: engine.logTail('install.log', 6000) });

  if (p === '/api/engine/start' && m === 'POST') { try { await ensureComfy(); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, errOut(e)); } }
  if (p === '/api/engine/stop' && m === 'POST') { await engine.stop(); return send(res, 200, { ok: true }); }
  if (p === '/api/engine/log') return send(res, 200, { log: engine.logTail('comfyui.log', 6000) });

  if (p === '/api/config' && m === 'POST') {
    const b = await json();
    for (const k of Object.keys(DEFAULTS)) if (k in b && k !== 'port') cfg[k] = b[k];
    photon.setPath(cfg.photonPath);
    comfy.setUrl(cfg.engineMode === 'external' ? cfg.comfyUrl : engine.url);
    saveCfg();
    return send(res, 200, { ok: true, cfg });
  }

  if (p === '/api/models') {
    try { await ensureComfy(); const mm = await features.models(); return send(res, 200, { ...mm, styles: Object.keys(STYLES), seasons: Object.keys(LANDSCAPE), expressions: Object.keys(EXPRESSIONS) }); }
    catch (e) { return send(res, 400, errOut(e)); }
  }

  if (p === '/api/prompt' && m === 'POST') {
    try { const b = await json(); return send(res, 200, { text: await improvePrompt(String(b.text || '').slice(0, 2000), b.mode) }); }
    catch (e) { return send(res, 400, errOut(e)); }
  }

  if (p === '/api/reference' && m === 'POST') { // raw image body -> temp file path id
    const buf = await readBody(req, 30 * 1048576);
    const id = crypto.randomUUID().slice(0, 8);
    const dir = path.join(JOB_ROOT, 'refs'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, id + '.png'); fs.writeFileSync(f, buf);
    return send(res, 200, { id });
  }

  if (p === '/api/run' && m === 'POST') {
    const b = await json();
    if (!TOOLS[b.tool]) return send(res, 400, { error: { message: 'unknown tool' } });
    const params = { ...(b.params || {}) };
    if (params.referenceId) { const f = path.join(JOB_ROOT, 'refs', String(params.referenceId).replace(/\W/g, '') + '.png'); if (fs.existsSync(f)) params.reference = f; }
    const job = createJob(b.tool, params, lang(req));
    return send(res, 200, publicJob(job));
  }

  let mm;
  if ((mm = p.match(/^\/api\/jobs\/(\w+)$/))) { const j = jobs.get(mm[1]); return j ? send(res, 200, publicJob(j)) : send(res, 404, { error: { message: 'job not found' } }); }
  if ((mm = p.match(/^\/api\/jobs\/(\w+)\/cancel$/)) && m === 'POST') {
    const j = jobs.get(mm[1]); if (j) { j.cancelled = true; if (j.status === 'running') await comfy.interrupt(); }
    return send(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/jobs\/(\w+)\/variant\/(\d+)$/))) {
    const j = jobs.get(mm[1]); const v = j?.variants[Number(mm[2])];
    if (!v?.file) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(v.file), 'image/png');
  }
  if ((mm = p.match(/^\/api\/jobs\/(\w+)\/(show|keep)\/(\d+)$/)) && m === 'POST') {
    const j = jobs.get(mm[1]); if (!j) return send(res, 404, { error: { message: 'job not found' } });
    try {
      const run = () => (mm[2] === 'show' ? features.showVariant(j.params.doc, j, Number(mm[3])) : features.keepVariant(j.params.doc, j, Number(mm[3])));
      chain = chain.then(run); await chain;
      return send(res, 200, publicJob(j));
    } catch (e) { return send(res, 400, errOut(e)); }
  }
  if (p === '/api/open-folder' && m === 'POST') {
    const b = await json();
    const target = b.which === 'output' ? cfg.outputDir : b.which === 'logs' ? engine.dirs.logs : engine.root;
    fs.mkdirSync(target, { recursive: true });
    openPath(target);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: { message: 'not found' } });
}

function openPath(p) {
  const cmd = IS_WIN ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [p], { detached: true, stdio: 'ignore' }).unref();
}

function allowed(req, port) {
  // Block other websites (DNS rebinding / CSRF): only our own origin may talk to the API.
  const host = String(req.headers.host || '');
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return false;
    if (req.headers['x-pas'] !== '1') return false;
  }
  return true;
}

function serve(port) {
  const server = http.createServer(async (req, res) => {
    try {
      if (!allowed(req, port)) return send(res, 403, { error: { message: 'forbidden' } });
      lastSeen = Date.now();
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      if (rel.includes('..')) return send(res, 400, 'bad path', 'text/plain');
      const b = asset(rel);
      if (!b) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, b, MIME[path.extname(rel)] || 'application/octet-stream');
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, errOut(e));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ------------------------------------------------------------------ window
function findBrowser() {
  const c = [];
  if (IS_WIN) {
    const pf = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const b of pf) c.push(path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(b, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium');
  }
  return c.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}
function openWindow(port) {
  const url = `http://127.0.0.1:${port}/`;
  const b = findBrowser();
  if (b) {
    const prof = path.join(CFG_DIR, 'window');
    spawn(b, [`--app=${url}`, `--user-data-dir=${prof}`, '--window-size=460,980', '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' }).unref();
  } else openPath(url);
}

// ------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const port = Number(args.find(a => a.startsWith('--port='))?.split('=')[1]) || cfg.port;
  const noWindow = args.includes('--no-window') || !cfg.openWindow;
  console.log(`Photon AI Studio ${VERSION}`);
  try {
    await serve(port);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      // Already running? Just show its window.
      try { const r = await fetch(`http://127.0.0.1:${port}/api/ping`); if ((await r.json()).app === 'photon-ai-studio') { console.log('Already running: opening its window.'); openWindow(port); return; } } catch { /* */ }
      console.error(`Port ${port} is used by another program.`); process.exit(1);
    }
    throw e;
  }
  console.log(`Panel: http://127.0.0.1:${port}/`);
  if (!noWindow) openWindow(port);
  hw().catch(() => {});
  const bye = async () => { if (cfg.stopEngineOnExit) await engine.stop(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  if (IS_WIN) process.on('SIGHUP', bye);
  // The panel polls every few seconds; once it has been closed for a while (and nothing is running), quit and free the GPU.
  if (!noWindow) {
    setInterval(() => {
      const busy = engine.state === 'installing' || [...jobs.values()].some(j => j.status === 'running' || j.status === 'queued');
      if (!busy && Date.now() - lastSeen > IDLE_EXIT_MS) { console.log('Panel closed: shutting down.'); bye(); }
    }, 30000).unref();
  }
}
let lastSeen = Date.now();
const IDLE_EXIT_MS = 10 * 60000;

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main };

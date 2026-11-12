'use strict';
// Self-contained AI engine: installs its own Python (via uv), PyTorch, ComfyUI, custom nodes and models
// into one folder, then starts/stops ComfyUI on a private port. Nothing else needs to be installed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const IS_WIN = process.platform === 'win32';

function defaultRoot() {
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'PhotonAIStudio');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'PhotonAIStudio');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'photon-ai-studio');
}

const UV_ASSET = {
  'win32-x64': 'uv-x86_64-pc-windows-msvc.zip', 'win32-arm64': 'uv-aarch64-pc-windows-msvc.zip',
  'darwin-arm64': 'uv-aarch64-apple-darwin.tar.gz', 'darwin-x64': 'uv-x86_64-apple-darwin.tar.gz',
  'linux-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz', 'linux-arm64': 'uv-aarch64-unknown-linux-gnu.tar.gz',
};

const CUSTOM_NODES = [
  { name: 'comfyui-inpaint-nodes', url: 'https://github.com/Acly/comfyui-inpaint-nodes/archive/refs/heads/main.zip' },
  { name: 'ComfyUI_IPAdapter_plus', url: 'https://github.com/cubiq/ComfyUI_IPAdapter_plus/archive/refs/heads/main.zip' },
];

const HF = 'https://huggingface.co/';
/** Model packs. `dir` is relative to ComfyUI/models. Sizes in bytes (checked on download). */
const PACKS = {
  base: {
    required: true,
    files: [
      { dir: 'checkpoints', name: 'RealVisXL_V5.0_fp16.safetensors', url: HF + 'SG161222/RealVisXL_V5.0/resolve/main/RealVisXL_V5.0_fp16.safetensors', size: 6938065488 },
      { dir: 'inpaint', name: 'fooocus_inpaint_head.pth', url: HF + 'lllyasviel/fooocus_inpaint/resolve/main/fooocus_inpaint_head.pth', size: 52602 },
      { dir: 'inpaint', name: 'inpaint_v26.fooocus.patch', url: HF + 'lllyasviel/fooocus_inpaint/resolve/main/inpaint_v26.fooocus.patch', size: 1323362033 },
      { dir: 'upscale_models', name: 'RealESRGAN_x2plus.pth', url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth', size: 67061725 },
      { dir: 'upscale_models', name: 'RealESRGAN_x4plus.pth', url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth', size: 67040989 },
    ],
  },
  style: {
    files: [
      { dir: 'ipadapter', name: 'ip-adapter-plus_sdxl_vit-h.safetensors', url: HF + 'h94/IP-Adapter/resolve/main/sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors', size: 847517512 },
      { dir: 'clip_vision', name: 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors', url: HF + 'h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors', size: 2528373448 },
    ],
  },
  anime: {
    files: [
      { dir: 'checkpoints', name: 'Illustrious-XL-v0.1.safetensors', url: HF + 'OnomaAIResearch/Illustrious-xl-early-release-v0/resolve/main/Illustrious-XL-v0.1.safetensors', size: 6938040760 },
    ],
  },
  zimage: {
    files: [
      { dir: 'diffusion_models', name: 'z_image_turbo_bf16.safetensors', url: HF + 'Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors', size: 12309866400 },
      { dir: 'text_encoders', name: 'qwen_3_4b.safetensors', url: HF + 'Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors', size: 8044982048 },
      { dir: 'vae', name: 'ae.safetensors', url: HF + 'Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors', size: 335304388 },
    ],
  },
};
const ENGINE_BYTES = 6.5e9; // python + torch (CUDA) + ComfyUI, roughly

class Engine {
  constructor(cfg, log) {
    this.cfg = cfg; this.log = log || (() => {});
    this.proc = null; this.state = 'idle'; this.task = null; this.lastError = null;
  }
  get root() { return this.cfg.installDir || defaultRoot(); }
  get dirs() {
    const e = path.join(this.root, 'engine');
    return {
      engine: e, uvDir: path.join(e, 'uv'), uv: path.join(e, 'uv', IS_WIN ? 'uv.exe' : 'uv'),
      pyInstall: path.join(e, 'python'), venv: path.join(e, 'venv'), comfy: path.join(e, 'ComfyUI'),
      models: path.join(e, 'ComfyUI', 'models'), downloads: path.join(this.root, 'downloads'), logs: path.join(this.root, 'logs'),
      marker: path.join(e, 'installed.json'),
    };
  }
  get python() { return IS_WIN ? path.join(this.dirs.venv, 'Scripts', 'python.exe') : path.join(this.dirs.venv, 'bin', 'python'); }
  installed() { try { return JSON.parse(fs.readFileSync(this.dirs.marker, 'utf8')); } catch { return null; } }
  get port() { return Number(this.cfg.enginePort) || 8190; }
  get url() { return `http://127.0.0.1:${this.port}`; }

  packStatus() {
    const out = {};
    const extra = (this.cfg.extraModelDirs || []).filter(Boolean);
    for (const [id, p] of Object.entries(PACKS)) {
      const files = p.files.map(f => {
        const local = path.join(this.dirs.models, f.dir, f.name);
        let have = false;
        try { have = fs.statSync(local).size >= f.size * 0.98; } catch { /* missing */ }
        if (!have) for (const d of extra) { try { if (fs.statSync(path.join(d, f.dir, f.name)).size >= f.size * 0.98) { have = true; break; } } catch { /* */ } }
        return { ...f, have };
      });
      const missing = files.filter(f => !f.have).reduce((a, f) => a + f.size, 0);
      out[id] = { required: !!p.required, installed: missing === 0, missingBytes: missing, totalBytes: p.files.reduce((a, f) => a + f.size, 0), files: files.map(f => ({ name: f.name, have: f.have, size: f.size })) };
    }
    return out;
  }

  estimateBytes(packs) {
    const st = this.packStatus();
    let b = this.installed() ? 0 : ENGINE_BYTES;
    for (const id of packs) if (st[id]) b += st[id].missingBytes;
    return b;
  }

  // ---------- helpers ----------
  progress(step, frac, detail) { this.task = { ...(this.task || {}), step, frac, detail, t: Date.now() }; }

  async download(url, dest, size, label) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (size) { try { if (fs.statSync(dest).size === size) return dest; } catch { /* */ } }
    const part = dest + '.part';
    let start = 0; try { start = fs.statSync(part).size; } catch { /* */ }
    if (size && start > size) { fs.rmSync(part); start = 0; }
    const headers = { 'user-agent': 'PhotonAIStudio/1.0' };
    if (start) headers.range = `bytes=${start}-`;
    const res = await fetch(url, { headers, redirect: 'follow' });
    if (res.status === 416 && size && start === size) { fs.renameSync(part, dest); return dest; }
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    if (start && res.status !== 206) start = 0; // server ignored Range
    const total = size || (Number(res.headers.get('content-length')) + start) || 0;
    let got = start, lastT = Date.now(), lastB = start, speed = 0;
    const self = this;
    const body = Readable.fromWeb(res.body);
    body.on('data', c => {
      got += c.length;
      const now = Date.now();
      if (now - lastT > 700) { speed = (got - lastB) / ((now - lastT) / 1000); lastT = now; lastB = got; }
      self.progress(self.task?.step, total ? got / total : 0, { label, got, total, speed });
      if (self.cancelled) body.destroy(new Error('Cancelled'));
    });
    await pipeline(body, fs.createWriteStream(part, { flags: start ? 'a' : 'w' }));
    if (size && fs.statSync(part).size !== size) throw new Error('Incomplete file: ' + label + ' (retry: the download resumes where it stopped)');
    fs.renameSync(part, dest);
    return dest;
  }

  exec(cmd, args, opts = {}, label) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(this.dirs.logs, { recursive: true });
      const logFile = fs.createWriteStream(path.join(this.dirs.logs, 'install.log'), { flags: 'a' });
      logFile.write(`\n$ ${cmd} ${args.join(' ')}\n`);
      const p = spawn(cmd, args, { windowsHide: true, ...opts, env: { ...process.env, ...(opts.env || {}) } });
      let tail = '';
      const onData = d => { const s = String(d); logFile.write(s); tail = (tail + s).slice(-3000); const last = s.trim().split(/\r?\n/).pop(); if (last) this.progress(this.task?.step, this.task?.frac ?? 0, { label, line: last.slice(0, 160) }); };
      p.stdout.on('data', onData); p.stderr.on('data', onData);
      p.on('error', e => { logFile.end(); reject(e); });
      p.on('close', code => { logFile.end(); code === 0 ? resolve(tail) : reject(new Error(`${label || cmd} failed (exit code ${code}): ${tail.slice(-600)}`)); });
    });
  }

  async extract(archive, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    // bsdtar (bundled with Windows 10+, macOS) handles both .zip and .tar.gz; GNU tar on Linux handles .tar.gz.
    if (archive.endsWith('.zip') && !IS_WIN && process.platform !== 'darwin') return this.exec('unzip', ['-oq', archive, '-d', destDir], {}, 'unzip');
    if (IS_WIN) {
      // Always use Windows' own bsdtar: a GNU tar from Git/MSYS earlier in PATH reads "C:" as a remote host.
      const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      if (fs.existsSync(sysTar)) return this.exec(sysTar, ['-xf', archive, '-C', destDir], {}, 'tar');
      if (archive.endsWith('.zip')) {
        return this.exec('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`], {}, 'Expand-Archive');
      }
    }
    return this.exec('tar', ['-xf', archive, '-C', destDir], {}, 'tar');
  }

  async extractSingleRoot(archive, target) {
    const tmp = target + '.tmp';
    fs.rmSync(tmp, { recursive: true, force: true });
    await this.extract(archive, tmp);
    const entries = fs.readdirSync(tmp);
    const src = entries.length === 1 && fs.statSync(path.join(tmp, entries[0])).isDirectory() ? path.join(tmp, entries[0]) : tmp;
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(src, target);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- install ----------
  async install({ packs = ['base'], torch = 'cu128' } = {}) {
    if (this.state === 'installing') throw new Error('Installation already running');
    this.state = 'installing'; this.cancelled = false; this.lastError = null; this.task = { step: 'start', frac: 0 };
    const d = this.dirs;
    try {
      await this.stop();
      fs.mkdirSync(d.engine, { recursive: true });
      const env = { UV_PYTHON_INSTALL_DIR: d.pyInstall, UV_CACHE_DIR: path.join(this.root, 'cache', 'uv'), UV_LINK_MODE: 'copy' };
      const mark = this.installed() || {};

      if (!mark.engine) {
        // 1. uv
        this.progress('uv', 0);
        const asset = UV_ASSET[`${process.platform}-${process.arch}`];
        if (!asset) throw new Error('Unsupported platform: ' + process.platform + '-' + process.arch);
        if (!fs.existsSync(d.uv)) {
          const a = await this.download('https://github.com/astral-sh/uv/releases/latest/download/' + asset, path.join(d.downloads, asset), 0, 'uv');
          await this.extract(a, d.uvDir);
          // archives may nest binaries in a folder
          if (!fs.existsSync(d.uv)) {
            for (const sub of fs.readdirSync(d.uvDir)) {
              const p = path.join(d.uvDir, sub);
              if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p)) fs.renameSync(path.join(p, f), path.join(d.uvDir, f));
            }
          }
          if (!IS_WIN) fs.chmodSync(d.uv, 0o755);
        }
        // 2. Python + venv
        this.progress('python', 0.1);
        await this.exec(d.uv, ['python', 'install', '3.12'], { env }, 'Python');
        if (!fs.existsSync(this.python)) await this.exec(d.uv, ['venv', d.venv, '--python', '3.12', '--seed'], { env }, 'venv');
        // 3. ComfyUI
        this.progress('comfy', 0);
        if (!fs.existsSync(path.join(d.comfy, 'main.py'))) {
          let tagUrl = 'https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.zip';
          try {
            const r = await fetch('https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest', { headers: { 'user-agent': 'PhotonAIStudio' }, signal: AbortSignal.timeout(10000) });
            if (r.ok) { const j = await r.json(); if (j.tag_name) tagUrl = `https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/${j.tag_name}.zip`; }
          } catch { /* fall back to master */ }
          const z = await this.download(tagUrl, path.join(d.downloads, 'ComfyUI.zip'), 0, 'ComfyUI');
          const keepModels = fs.existsSync(d.models) ? d.models + '.keep' : null;
          if (keepModels) fs.renameSync(d.models, keepModels);
          await this.extractSingleRoot(z, d.comfy);
          if (keepModels) { fs.rmSync(d.models, { recursive: true, force: true }); fs.renameSync(keepModels, d.models); }
        }
        // 4. PyTorch
        this.progress('torch', 0);
        const idx = { cu128: 'https://download.pytorch.org/whl/cu128', cpu: 'https://download.pytorch.org/whl/cpu', 'rocm6.3': 'https://download.pytorch.org/whl/rocm6.3' }[torch];
        const torchArgs = ['pip', 'install', '--python', this.python, 'torch', 'torchvision', 'torchaudio'];
        if (idx && torch !== 'mps') torchArgs.push('--index-url', idx);
        await this.exec(d.uv, torchArgs, { env }, 'PyTorch');
        // 5. ComfyUI requirements
        this.progress('deps', 0);
        await this.exec(d.uv, ['pip', 'install', '--python', this.python, '-r', path.join(d.comfy, 'requirements.txt')], { env }, 'ComfyUI requirements');
        // 6. custom nodes
        this.progress('nodes', 0);
        for (const n of CUSTOM_NODES) {
          const target = path.join(d.comfy, 'custom_nodes', n.name);
          if (!fs.existsSync(target)) {
            const z = await this.download(n.url, path.join(d.downloads, n.name + '.zip'), 0, n.name);
            await this.extractSingleRoot(z, target);
          }
          const req = path.join(target, 'requirements.txt');
          if (fs.existsSync(req)) await this.exec(d.uv, ['pip', 'install', '--python', this.python, '-r', req], { env }, n.name);
        }
        mark.engine = { at: new Date().toISOString(), torch };
        fs.writeFileSync(d.marker, JSON.stringify(mark, null, 2));
      }
      this.writeExtraPaths();

      // 7. models
      const todo = [];
      const st = this.packStatus();
      for (const id of packs) for (const f of PACKS[id]?.files || []) if (!st[id].files.find(x => x.name === f.name)?.have) todo.push(f);
      for (let i = 0; i < todo.length; i++) {
        const f = todo[i];
        this.progress('models', 0, { label: f.name, index: i + 1, count: todo.length });
        await this.download(f.url, path.join(d.models, f.dir, f.name), f.size, f.name);
      }
      this.state = 'idle'; this.task = { step: 'done', frac: 1 };
      return true;
    } catch (e) {
      this.state = 'idle'; this.lastError = e.message; this.task = { ...(this.task || {}), error: e.message };
      throw e;
    }
  }

  cancel() { this.cancelled = true; }

  /** Lets ComfyUI also read models from folders the user already has (e.g. another ComfyUI). */
  writeExtraPaths() {
    const dirs = (this.cfg.extraModelDirs || []).filter(p => p && fs.existsSync(p));
    const file = path.join(this.dirs.comfy, 'extra_model_paths.yaml');
    if (!fs.existsSync(this.dirs.comfy)) return;
    if (!dirs.length) { fs.rmSync(file, { force: true }); return; }
    const kinds = ['checkpoints', 'loras', 'vae', 'upscale_models', 'clip_vision', 'ipadapter', 'inpaint', 'diffusion_models', 'unet', 'text_encoders', 'clip', 'embeddings', 'controlnet'];
    let y = '# Written by Photon AI Studio\n';
    dirs.forEach((dir, i) => {
      y += `extra_${i}:\n    base_path: ${JSON.stringify(dir.replace(/\\/g, '/'))}\n`;
      for (const k of kinds) y += `    ${k}: ${k}\n`;
    });
    fs.writeFileSync(file, y);
  }

  // ---------- run ----------
  async alive() {
    try { const r = await fetch(this.url + '/system_stats', { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
  }

  async start({ lowVram = false, cpu = false } = {}) {
    if (await this.alive()) { this.state = 'running'; return; }
    if (!this.installed()) throw new Error('AI engine not installed');
    if (this.state === 'starting') return this._starting;
    this.state = 'starting';
    this._starting = (async () => {
      this.writeExtraPaths();
      fs.mkdirSync(this.dirs.logs, { recursive: true });
      const log = fs.openSync(path.join(this.dirs.logs, 'comfyui.log'), 'w');
      const args = ['main.py', '--listen', '127.0.0.1', '--port', String(this.port), '--preview-method', 'none',
        '--output-directory', path.join(this.root, 'comfy-output'), '--input-directory', path.join(this.root, 'comfy-input')];
      if (lowVram) args.push('--lowvram');
      if (cpu) args.push('--cpu');
      this.proc = spawn(this.python, args, { cwd: this.dirs.comfy, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
      this.proc.on('exit', () => { this.proc = null; if (this.state === 'running' || this.state === 'starting') this.state = 'stopped'; });
      for (let i = 0; i < 300; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (!this.proc) throw new Error('ComfyUI exited while starting. See ' + path.join(this.dirs.logs, 'comfyui.log'));
        if (await this.alive()) { this.state = 'running'; return; }
      }
      throw new Error('ComfyUI did not start within 5 minutes');
    })();
    try { await this._starting; } catch (e) { this.state = 'stopped'; this.lastError = e.message; throw e; }
  }

  async stop() {
    const p = this.proc; this.proc = null;
    if (!p) return;
    this.state = 'stopped';
    if (IS_WIN) await new Promise(r => execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => r()));
    else { try { p.kill('SIGTERM'); } catch { /* */ } }
  }

  logTail(name = 'comfyui.log', n = 4000) {
    try { const s = fs.readFileSync(path.join(this.dirs.logs, name), 'utf8'); return s.slice(-n); } catch { return ''; }
  }
}

module.exports = { Engine, PACKS, defaultRoot };

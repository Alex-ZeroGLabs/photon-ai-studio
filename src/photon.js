'use strict';
// Thin async wrapper around Photon Studio's official automation CLI (`photon`).
// Every command reads JSON params from stdin and prints one JSON object.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let customPath = '';
function setPath(p) { customPath = p || ''; }

function binary() {
  if (customPath && fs.existsSync(customPath)) return customPath;
  const exe = process.platform === 'win32' ? 'photon.exe' : 'photon';
  const home = path.join(os.homedir(), '.photon', 'bin', exe);
  if (fs.existsSync(home)) return home;
  return exe; // rely on PATH
}

class PhotonError extends Error {
  constructor(code, message, details) { super(message || code); this.code = code; this.details = details; }
}

function run(args, params, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary(), [...args, '--input', '-'], { windowsHide: true });
    } catch (e) { return reject(new PhotonError('PHOTON_NOT_FOUND', 'Photon CLI not found: ' + e.message)); }
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new PhotonError('TIMEOUT', 'Photon is not responding')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(new PhotonError('PHOTON_NOT_FOUND', 'Photon CLI not found (' + e.code + '). Open Photon > Settings > Agents and install the CLI.')); });
    child.on('close', () => {
      clearTimeout(timer);
      let j;
      try { j = JSON.parse(out); } catch { return reject(new PhotonError('BAD_OUTPUT', (err || out || 'Photon: invalid response').slice(0, 400))); }
      if (j.ok === false) return reject(new PhotonError(j.error?.code || 'ERROR', j.error?.message || 'Photon error', j.error?.details));
      resolve(j);
    });
    child.stdin.end(JSON.stringify(params ?? {}));
  });
}

async function doctor() { return run(['doctor'], {}, { timeoutMs: 20000 }); }

/** Live documents open in Photon's window. */
async function listDocuments() {
  const j = await run(['session', 'list'], {}, { timeoutMs: 20000 });
  const docs = [];
  for (const s of j.result || []) {
    if (s.mode && s.mode !== 'live') continue;
    for (const d of s.documents || []) docs.push({ key: s.id + ':' + d.id, sessionId: String(s.id), documentId: d.id, title: d.title, width: d.width, height: d.height, revision: d.revision, filePath: d.filePath || null });
  }
  return docs;
}

/** A handle on one document that tracks its revision for transactional calls. */
class Doc {
  constructor(sessionId, documentId) { this.sessionId = String(sessionId); this.documentId = documentId; this.revision = null; this.info = null; }
  base() { return ['--session', this.sessionId, '--document', this.documentId]; }
  async inspect() {
    const j = await run(['inspect', ...this.base()], {});
    this.info = j.result; this.revision = j.revision ?? j.result.revision; return this.info;
  }
  async exec(op, params, retry = true) {
    if (this.revision == null) await this.inspect();
    try {
      const j = await run(['execute', op, ...this.base(), '--revision', String(this.revision)], params);
      if (j.revision != null) this.revision = j.revision;
      return j.result;
    } catch (e) {
      if (retry && (e.code === 'REVISION_CONFLICT' || e.code === 'REVISION_REQUIRED')) { await this.inspect(); return this.exec(op, params, false); }
      throw e;
    }
  }
  async render(params) {
    const j = await run(['render', ...this.base()], { maxEdge: 8192, ...params });
    return j.result;
  }
  get selection() { return this.info?.selection || null; }
  get width() { return this.info?.width; }
  get height() { return this.info?.height; }
  activeLayer() {
    const id = this.info?.selectedLayerIds?.[0];
    return findLayer(this.info?.layers || [], id) || (this.info?.layers || [])[0] || null;
  }
}

function findLayer(layers, id) {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.children) { const f = findLayer(l.children, id); if (f) return f; }
    if (l.layers) { const f = findLayer(l.layers, id); if (f) return f; }
  }
  return null;
}

async function openFile(p) {
  const j = await run(['session', 'open', '--show'], { path: p, mode: 'live' });
  return j.result;
}

module.exports = { run, doctor, listDocuments, Doc, openFile, setPath, binary, PhotonError };

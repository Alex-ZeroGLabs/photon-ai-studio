'use strict';
// Minimal ComfyUI HTTP/WebSocket client (Node >= 22: global fetch, FormData, Blob, WebSocket).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class Comfy {
  constructor(url) { this.setUrl(url); this.clientId = crypto.randomUUID(); this._info = null; }
  setUrl(url) { this.url = String(url || 'http://127.0.0.1:8188').replace(/\/+$/, ''); this._info = null; }

  async alive(timeoutMs = 2500) {
    try { const r = await fetch(this.url + '/system_stats', { signal: AbortSignal.timeout(timeoutMs) }); return r.ok ? await r.json() : null; }
    catch { return null; }
  }

  async objectInfo(force = false) {
    if (this._info && !force) return this._info;
    const r = await fetch(this.url + '/object_info', { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('ComfyUI object_info ' + r.status);
    this._info = await r.json();
    return this._info;
  }

  async hasNode(name) { const o = await this.objectInfo(); return !!o[name]; }

  /** Choices of a COMBO input, e.g. options('CheckpointLoaderSimple','ckpt_name'). */
  async options(node, input) {
    const o = await this.objectInfo();
    const spec = o[node]?.input?.required?.[input] || o[node]?.input?.optional?.[input];
    if (!spec) return [];
    if (Array.isArray(spec[0])) return spec[0];
    if (spec[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options;
    return [];
  }

  async upload(filePath, name) {
    const fd = new FormData();
    const buf = fs.readFileSync(filePath);
    fd.append('image', new Blob([buf], { type: 'image/png' }), name || path.basename(filePath));
    fd.append('type', 'input');
    fd.append('overwrite', 'true');
    const r = await fetch(this.url + '/upload/image', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('ComfyUI upload failed: ' + r.status);
    const j = await r.json();
    return j.subfolder ? j.subfolder + '/' + j.name : j.name;
  }

  async queue(graph) {
    const r = await fetch(this.url + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: this.clientId }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const nodeErr = j.node_errors && Object.values(j.node_errors)[0];
      const detail = nodeErr?.errors?.[0] ? `${nodeErr.class_type}: ${nodeErr.errors[0].message} ${nodeErr.errors[0].details || ''}` : (j.error?.message || r.status);
      throw new Error('ComfyUI rejected the workflow: ' + detail);
    }
    return j.prompt_id;
  }

  async interrupt() { try { await fetch(this.url + '/interrupt', { method: 'POST' }); } catch { /* ignore */ } }

  /** Run a graph and wait. onProgress(fraction 0..1). Returns array of saved file paths in outDir. */
  async run(graph, outDir, onProgress, { timeoutMs = 30 * 60000 } = {}) {
    let ws = null;
    const nodes = Object.keys(graph).length;
    let done = 0;
    try {
      if (typeof WebSocket === 'function') {
        ws = new WebSocket(this.url.replace(/^http/, 'ws') + '/ws?clientId=' + this.clientId);
        ws.onerror = () => {};
      }
    } catch { ws = null; }
    const id = await this.queue(graph);
    if (ws) {
      ws.onmessage = ev => {
        if (typeof ev.data !== 'string') return;
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.data?.prompt_id && m.data.prompt_id !== id) return;
        if (m.type === 'progress' && m.data.max) onProgress?.(Math.min(0.98, (done + m.data.value / m.data.max) / nodes + 0.0));
        if (m.type === 'executing' && m.data.node) { done++; onProgress?.(Math.min(0.98, done / nodes)); }
        if (m.type === 'progress_state') { /* newer ComfyUI; ignore */ }
      };
    }
    const t0 = Date.now();
    try {
      for (;;) {
        await new Promise(r => setTimeout(r, 600));
        if (Date.now() - t0 > timeoutMs) throw new Error('Generation timed out');
        const r = await fetch(this.url + '/history/' + id).catch(() => null);
        if (!r || !r.ok) continue;
        const h = (await r.json())[id];
        if (!h) continue;
        if (h.status?.status_str === 'error') {
          const msg = (h.status.messages || []).find(x => x[0] === 'execution_error')?.[1];
          throw new Error('ComfyUI error: ' + (msg ? `${msg.node_type}: ${msg.exception_message}` : 'unknown'));
        }
        if (!h.status?.completed && !Object.keys(h.outputs || {}).length) continue;
        if (h.status && h.status.completed === false) continue;
        const files = [];
        for (const out of Object.values(h.outputs || {})) {
          for (const im of out.images || []) {
            if (im.type === 'temp') continue;
            const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || '', type: im.type || 'output' });
            const resp = await fetch(this.url + '/view?' + q);
            if (!resp.ok) continue;
            fs.mkdirSync(outDir, { recursive: true });
            const dest = path.join(outDir, crypto.randomUUID().slice(0, 8) + '_' + im.filename.replace(/[^\w.-]/g, '_'));
            fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
            files.push(dest);
          }
        }
        onProgress?.(1);
        return files;
      }
    } finally { try { ws?.close(); } catch { /* ignore */ } }
  }
}

module.exports = { Comfy };

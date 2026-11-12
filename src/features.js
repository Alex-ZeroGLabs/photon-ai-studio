'use strict';
// High-level AI tools: they read pixels from Photon, run a ComfyUI graph and place the result back
// as a new, non-destructive layer (masked by the selection when there is one).
const fs = require('node:fs');
const path = require('node:path');
const { Doc, openFile } = require('./photon');
const W = require('./workflows');
const PNG = require('./png');

/** Fix tone drift of the generated area against its surroundings; returns the (new) file path. */
function colorFix(file, mask, dilate, inner) {
  try {
    const img = PNG.decode(file);
    if (img.w * img.h !== mask.length) return file;
    if (!PNG.seamMatch(img, mask, { dilate, inner })) return file;
    const out = file.replace(/\.png$/i, '_cm.png');
    PNG.encode(out, img);
    return out;
  } catch { return file; }
}

class UserError extends Error { constructor(key, vars) { super(key); this.key = key; this.vars = vars; } }

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function clampRect(r, w, h) {
  const x = clamp(Math.floor(r.x), 0, w - 1), y = clamp(Math.floor(r.y), 0, h - 1);
  return { x, y, width: clamp(Math.ceil(r.x + r.width) - x, 1, w - x), height: clamp(Math.ceil(r.y + r.height) - y, 1, h - y) };
}
function padRect(b, pad) { return { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad }; }
const rand = () => Math.floor(Math.random() * 2 ** 31);

const NEURAL = {
  skin: { prompt: 'portrait photo, smooth clear skin, even skin tone, soft natural skin texture, flawless complexion', neg: 'blemishes, acne, spots, wrinkles, scars', d: [0.12, 0.35] },
  harmonize: { prompt: 'cohesive natural lighting, consistent color grading, realistic photo', neg: 'mismatched lighting', d: [0.1, 0.3] },
  colorize: { prompt: 'color photograph, natural vivid colors, realistic skin tones, detailed', neg: 'black and white, monochrome, grayscale, sepia', d: [0.4, 0.7], blend: 'color' },
  restore: { prompt: 'high quality restored photograph, sharp focus, clean details, natural', neg: 'scratches, dust, noise, damaged, torn, faded', d: [0.15, 0.4], preUpscale: true },
};
const STYLES = {
  oil: 'oil painting, thick brush strokes, impasto, fine art', watercolor: 'watercolor painting, soft washes, paper texture',
  sketch: 'pencil sketch, graphite drawing, cross hatching, monochrome', anime: 'anime style, cel shading, clean lineart, vibrant',
  comic: 'comic book art, bold ink outlines, halftone shading', pixar: '3d render, pixar style, soft lighting, stylized',
  vangogh: 'post-impressionist painting in the style of van gogh, swirling brush strokes', popart: 'pop art, bold flat colors, halftone dots',
  cyberpunk: 'cyberpunk, neon lights, futuristic, cinematic', vintage: 'vintage film photo, kodak portra, film grain, faded colors',
};
// [prompt, negative]: the season leads the prompt with extra weight, the negative pushes away its opposite.
const LANDSCAPE = {
  winter: ['(winter:1.3), (heavy snow covering the ground, trees and roofs:1.3), frozen, frost, cold blue light, overcast winter sky', 'summer, autumn, green grass, orange foliage, warm light'],
  autumn: ['(autumn:1.3), (orange, red and yellow foliage:1.2), fallen leaves, warm soft light', 'winter, snow, summer, spring blossoms'],
  spring: ['(spring:1.3), (blooming flowers, fresh light green leaves:1.2), cherry blossoms, soft daylight', 'winter, snow, autumn, dry grass'],
  summer: ['(summer:1.3), (lush vivid green vegetation:1.2), bright sunny day, clear blue sky', 'winter, snow, autumn, orange foliage, overcast'],
  sunset: ['(golden hour sunset:1.3), warm orange and pink sky, long shadows, glowing light', 'midday, flat light, overcast'],
  night: ['(night:1.3), (moonlight, dark blue sky, stars:1.2), warm lit windows, long exposure', 'daylight, sun, bright sky'],
  fog: ['(dense fog:1.3), misty atmosphere, soft diffused light, low visibility, muted colors', 'clear sky, harsh light, high contrast'],
  storm: ['(dramatic storm:1.3), dark thunder clouds, moody light, wind, rain', 'clear sky, sunny, calm'],
};
const EXPRESSIONS = { smile: 'smiling, happy expression', bigsmile: 'laughing, big smile, teeth', surprise: 'surprised expression, open mouth', angry: 'angry expression, frowning', sad: 'sad expression', neutral: 'neutral expression, relaxed face' };
const AGES = { '-2': 'child', '-1': 'young, youthful face', 0: '', 1: 'middle-aged, some wrinkles', 2: 'elderly, old, wrinkles, gray hair' };

class Features {
  constructor(ctx) { this.ctx = ctx; }
  get comfy() { return this.ctx.comfy; }

  async doc(docKey) {
    if (!docKey) throw new UserError('err.noDocument');
    const [s, d] = docKey.split(':');
    const doc = new Doc(s, d);
    try { await doc.inspect(); } catch (e) { if (/SESSION_NOT_FOUND|DOCUMENT/.test(e.code)) throw new UserError('err.noDocument'); throw e; }
    return doc;
  }

  async models() {
    const ck = await this.comfy.options('CheckpointLoaderSimple', 'ckpt_name');
    const unets = await this.comfy.options('UNETLoader', 'unet_name').catch(() => []);
    const ups = await this.comfy.options('UpscaleModelLoader', 'model_name').catch(() => []);
    const inp = await this.comfy.options('INPAINT_LoadFooocusInpaint', 'head').catch(() => []);
    const patches = await this.comfy.options('INPAINT_LoadFooocusInpaint', 'patch').catch(() => []);
    const ipa = await this.comfy.options('IPAdapterModelLoader', 'ipadapter_file').catch(() => []);
    const cv = await this.comfy.options('CLIPVisionLoader', 'clip_name').catch(() => []);
    const te = await this.comfy.options('CLIPLoader', 'clip_name').catch(() => []);
    return {
      checkpoints: ck,
      zimage: unets.includes('z_image_turbo_bf16.safetensors') && te.includes('qwen_3_4b.safetensors'),
      upscale: ups,
      fooocus: inp.includes('fooocus_inpaint_head.pth') && patches.includes('inpaint_v26.fooocus.patch') ? { head: 'fooocus_inpaint_head.pth', patch: 'inpaint_v26.fooocus.patch' } : null,
      ipadapter: ipa.find(x => /plus_sdxl_vit-h/i.test(x)) && cv.find(x => /vit-h|ViT-H/i.test(x)) ? { model: ipa.find(x => /plus_sdxl_vit-h/i.test(x)), clipVision: cv.find(x => /vit-h|ViT-H/i.test(x)) } : null,
    };
  }

  async pickCkpt(requested) {
    const m = await this.models();
    if (!m.checkpoints.length) throw new UserError('err.noCheckpoint');
    if (requested && m.checkpoints.includes(requested)) return { ckpt: requested, m };
    const pref = this.ctx.cfg.checkpoint;
    if (pref && m.checkpoints.includes(pref)) return { ckpt: pref, m };
    const auto = m.checkpoints.find(c => /realvis/i.test(c)) || m.checkpoints.find(c => /juggernaut|realistic|photo/i.test(c)) || m.checkpoints.find(c => !/refiner/i.test(c));
    return { ckpt: auto, m };
  }

  pixels() { return { great: 1.4e6, good: 1.1e6, limited: 0.8e6 }[this.ctx.hw?.level] || 1.0e6; }

  async render(doc, job, name, params) {
    const p = path.join(job.dir, name);
    await doc.render({ path: p, ...params });
    return p;
  }

  /** Placing with a mask consumes the selection, so keep a copy in a temporary alpha channel. */
  async saveSelection(doc) {
    const name = 'Photon AI ' + Date.now().toString(36);
    await doc.exec('select.saveSelection', { args: { name } });
    await doc.inspect();
    return (doc.info.channels || []).find(c => c.name === name)?.id || null;
  }
  async dropSelection(doc, id) {
    if (!id) return;
    try { await doc.exec('select.loadSelection', { args: { channelId: id } }); } catch { /* */ }
    try { await doc.exec('core.channels.deleteChannel', { id }); } catch { /* */ }
  }
  async withSelection(doc, fn) {
    const ch = doc.selection ? await this.saveSelection(doc) : null;
    try { return await fn(ch); } finally { await this.dropSelection(doc, ch); }
  }

  async placeVariants(doc, job, files, { rect, maskFromSelection, label, blend, selChannel, feather = 0 }) {
    for (let i = 0; i < files.length; i++) {
      if (maskFromSelection && selChannel) await doc.exec('select.loadSelection', { args: { channelId: selChannel } });
      const r = await doc.exec('image.place', { path: files[i], name: files.length > 1 ? `${label} (${i + 1})` : label, rect, maskFromSelection: !!maskFromSelection });
      const layerId = r.layerId;
      // Soft edge like Photoshop: outside the generated zone the layer holds the original pixels, so feathering is seamless.
      if (maskFromSelection && feather) await doc.exec('layer.mask.update', { layerId, properties: { feather } }).catch(() => {});
      if (blend) await doc.exec('layer.update', { layerId, properties: { blendMode: blend } });
      if (job.variants.length) await doc.exec('layer.visibility', { layerIds: [layerId], visible: false });
      job.variants.push({ file: files[i], layerId, visible: job.variants.length === 0 });
    }
  }

  /** Run N variants of a graph factory sequentially (models stay loaded in VRAM). */
  async runVariants(job, n, makeGraph, onEach) {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (job.cancelled) break;
      job.step = { key: 'job.generating', vars: { i: i + 1, n } };
      const files = await this.comfy.run(makeGraph(i), job.dir, f => { job.progress = 0.15 + 0.8 * ((i + f) / n); });
      if (!files.length) throw new Error('ComfyUI returned no images');
      out.push(files[0]);
      if (onEach) await onEach(files[0], i);
    }
    return out;
  }

  // ---------------------------------------------------------------- tools
  async genfill(job, p) {
    const doc = await this.doc(p.doc);
    const sel = doc.selection;
    if (!sel) throw new UserError('err.noSelection');
    const { ckpt, m } = await this.pickCkpt(p.model);
    const b = sel.bounds;
    const pad = Math.max(64, Math.round(Math.max(b.width, b.height) * 0.35));
    const rect = clampRect(padRect(b, pad), doc.width, doc.height);
    job.step = { key: 'job.reading' };
    const src = await this.render(doc, job, 'src.png', { rect });
    const mask = await this.render(doc, job, 'mask.png', { rect, selection: true });
    const srcName = await this.comfy.upload(src, `pas_${job.id}_src.png`);
    const maskName = await this.comfy.upload(mask, `pas_${job.id}_mask.png`);
    const remove = !String(p.prompt || '').trim();
    const opts = {
      ckpt, profile: W.profile(ckpt), fooocus: m.fooocus, fill: m.fooocus ? 'navier-stokes' : null, grow: 8, blur: 10, pixels: this.pixels(),
      positive: remove ? 'empty background, seamless continuation of the surroundings, nothing there' : p.prompt,
      negative: [p.negative, remove ? 'person, object, animal, text, logo, artifacts' : ''].filter(Boolean).join(', '),
    };
    const label = (remove ? job.t('layer.remove') : job.t('layer.genfill')) + (remove ? '' : ': ' + p.prompt.slice(0, 40));
    const seed = rand();
    let hard = null; try { hard = PNG.maskFromPng(mask).mask; } catch { /* no color fix */ }
    await this.withSelection(doc, selChannel => this.runVariants(job, clamp(Number(p.variations) || 1, 1, 4), i => W.inpaint(srcName, maskName, rect.width, rect.height, { ...opts, seed: seed + i * 7919 }),
      f => this.placeVariants(doc, job, [hard ? colorFix(f, hard, opts.grow + 6) : f], { rect, maskFromSelection: true, label, selChannel, feather: Math.round(clamp(Math.min(b.width, b.height) * 0.04, 3, 40)) })));
  }

  async expand(job, p) {
    const doc = await this.doc(p.doc);
    const { ckpt, m } = await this.pickCkpt(p.model);
    const w = doc.width, h = doc.height;
    let nw = w, nh = h;
    if (p.mode === 'ratio') {
      const [a, b] = String(p.ratio || '16:9').split(':').map(Number);
      const r = a / b;
      if (w / h < r) nw = Math.round(h * r); else nh = Math.round(w / r);
      if (nw === w && nh === h) { nw = Math.round(w * 1.25); nh = Math.round(h * 1.25); }
    } else {
      const pct = clamp(Number(p.percent) || 25, 5, 200) / 100;
      nw = Math.round(w * (1 + pct)); nh = Math.round(h * (1 + pct));
    }
    nw = Math.ceil(nw / 8) * 8; nh = Math.ceil(nh / 8) * 8;
    const anchor = p.anchor || 'center';
    const dx = nw - w, dy = nh - h;
    const left = /Left|^left$/.test(anchor) ? 0 : /Right|^right$/.test(anchor) ? dx : Math.floor(dx / 2);
    const top = /^top/.test(anchor) ? 0 : /^bottom/.test(anchor) ? dy : Math.floor(dy / 2);
    const pads = { left, top, right: dx - left, bottom: dy - top };
    job.step = { key: 'job.reading' };
    const src = await this.render(doc, job, 'src.png', { rect: { x: 0, y: 0, width: w, height: h } });
    const srcName = await this.comfy.upload(src, `pas_${job.id}_src.png`);
    const opts = { ckpt, profile: W.profile(ckpt), fooocus: m.fooocus, pixels: this.pixels(), blur: 12, positive: [p.prompt, 'seamless continuation of the scene, same style and lighting, high detail, full bleed'].filter(Boolean).join(', '),
      negative: [p.negative, 'frame, border, picture frame, window frame, panel, split screen, collage, vignette, bars, edge, letterbox, text'].filter(Boolean).join(', ') };
    const seed = rand();
    let files = await this.runVariants(job, clamp(Number(p.variations) || 1, 1, 3), i => W.outpaint(srcName, pads, w, h, { ...opts, seed: seed + i * 7919 }));
    if (job.cancelled || !files.length) return;
    // Color-match each new side separately against the original image (sides drift differently).
    // The outpaint feather regenerates a band inside the original edge too, so dilate by that much.
    const feather = W.outpaintFeather(w, h);
    const sides = [];
    if (pads.left) sides.push(x => x < left);
    if (pads.right) sides.push(x => x >= left + w);
    if (pads.top) sides.push((x, y) => y < top);
    if (pads.bottom) sides.push((x, y) => y >= top + h);
    const sideMasks = sides.map(fn => { const m = new Float32Array(nw * nh); for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) m[y * nw + x] = fn(x, y) ? 1 : 0; return m; });
    files = files.map(f => sideMasks.reduce((cur, m) => colorFix(cur, m, feather + 6, 1), f));
    job.step = { key: 'job.placing' };
    await doc.exec('document.operation', { operation: { kind: 'canvasSize', spec: { width: nw, height: nh, anchor, relative: false, extensionColor: null } } });
    await this.placeVariants(doc, job, files, { rect: { x: 0, y: 0, width: nw, height: nh }, label: job.t('layer.expand') });
  }

  async generate(job, p) {
    const doc = await this.doc(p.doc);
    if (!String(p.prompt || '').trim()) throw new UserError('err.noPrompt');
    const sel = doc.selection;
    const rect = sel ? clampRect(sel.bounds, doc.width, doc.height) : { x: 0, y: 0, width: doc.width, height: doc.height };
    const useZ = p.model === '__zimage__';
    const m = await this.models();
    if (useZ && !m.zimage) throw new UserError('err.noZimage');
    const ck = useZ ? null : (await this.pickCkpt(p.model)).ckpt;
    const { W: gw, H: gh } = W.workSize(rect.width, rect.height, this.pixels());
    const seed = rand();
    const label = job.t('layer.generate') + ': ' + p.prompt.slice(0, 40);
    await this.runVariants(job, clamp(Number(p.variations) || 1, 1, 4), i => useZ
      ? W.zimage(gw, gh, { positive: p.prompt, seed: seed + i * 7919, vramGB: this.ctx.hw?.system?.vramGB })
      : W.txt2img(gw, gh, { ckpt: ck, profile: W.profile(ck), positive: p.prompt, negative: p.negative, seed: seed + i * 7919 }),
    f => this.placeVariants(doc, job, [f], { rect, maskFromSelection: false, label }));
  }

  async removeBackground(job, p) {
    const doc = await this.doc(p.doc);
    const layer = doc.activeLayer();
    if (!layer) throw new UserError('err.noLayer');
    job.step = { key: 'job.native' };
    if (layer.kind === 'background') await doc.exec('layer.background.unlock', { layerId: layer.id }).catch(() => {});
    await doc.inspect();
    const id = doc.activeLayer()?.id || layer.id;
    await doc.exec('layer.removeBackground', { layerId: id });
  }

  async select(job, p) {
    const doc = await this.doc(p.doc);
    const layer = doc.activeLayer();
    if (!layer) throw new UserError('err.noLayer');
    job.step = { key: 'job.native' };
    await doc.exec(p.what === 'sky' ? 'selection.sky' : 'selection.subject', { layerId: layer.id });
  }

  async superResolution(job, p) {
    const doc = await this.doc(p.doc);
    const m = await this.models();
    const factor = Number(p.factor) === 4 ? 4 : 2;
    const model = (factor === 4 ? m.upscale.find(x => /x4/i.test(x)) : m.upscale.find(x => /x2/i.test(x))) || m.upscale[0];
    if (!model) throw new UserError('err.noUpscaler');
    const mf = /x4|4x/i.test(model) ? 4 : /x2|2x/i.test(model) ? 2 : 4;
    const sel = p.zoom && doc.selection ? clampRect(doc.selection.bounds, doc.width, doc.height) : null;
    const rect = sel || { x: 0, y: 0, width: doc.width, height: doc.height };
    job.step = { key: 'job.reading' };
    const src = await this.render(doc, job, 'src.png', { rect });
    const name = await this.comfy.upload(src, `pas_${job.id}_src.png`);
    job.step = { key: 'job.upscaling' };
    const files = await this.comfy.run(W.upscale(name, model, { factor, modelFactor: mf }), job.dir, f => { job.progress = 0.15 + 0.75 * f; });
    if (!files.length) throw new Error('No result');
    const outDir = this.ctx.cfg.outputDir;
    fs.mkdirSync(outDir, { recursive: true });
    const base = (doc.info.title || 'image').replace(/[^\w.-]+/g, '_');
    const dest = path.join(outDir, `${base}_${sel ? 'zoom' : 'superres'}_x${factor}_${Date.now().toString(36)}.png`);
    fs.copyFileSync(files[0], dest);
    job.step = { key: 'job.opening' };
    await openFile(dest);
    job.variants.push({ file: files[0], layerId: null, visible: true, path: dest });
  }

  async neural(job, p) {
    const doc = await this.doc(p.doc);
    const f = p.filter;
    const strength = clamp(Number(p.strength ?? 50), 0, 100) / 100;
    const layer = doc.activeLayer();
    if (!layer) throw new UserError('err.noLayer');

    if (f === 'depthblur') return this.depthBlur(job, doc, layer, strength);
    if (f === 'jpeg' || f === 'superzoom') {
      if (f === 'superzoom') return this.superResolution(job, { ...p, zoom: true, factor: p.factor || 2 });
    }

    const sel = doc.selection;
    const lb = layer.bounds || { x: 0, y: 0, width: doc.width, height: doc.height };
    const base = sel ? padRect(sel.bounds, Math.round(Math.max(sel.bounds.width, sel.bounds.height) * 0.15)) : lb;
    const rect = clampRect(base, doc.width, doc.height);
    job.step = { key: 'job.reading' };
    const src = await this.render(doc, job, 'src.png', { rect, layerId: layer.id });
    let srcName = await this.comfy.upload(src, `pas_${job.id}_src.png`);
    const maskName = sel ? await this.comfy.upload(await this.render(doc, job, 'mask.png', { rect, selection: true }), `pas_${job.id}_mask.png`) : null;
    const m = await this.models();
    const label = job.t('layer.neural') + ': ' + job.t('nf.' + f);

    if (f === 'jpeg') {
      const model = m.upscale.find(x => /x2/i.test(x)) || m.upscale[0];
      if (!model) throw new UserError('err.noUpscaler');
      job.step = { key: 'job.generating', vars: { i: 1, n: 1 } };
      const files = await this.comfy.run(W.upscale(srcName, model, { back: { w: rect.width, h: rect.height } }), job.dir, x => { job.progress = 0.15 + 0.8 * x; });
      return this.withSelection(doc, selChannel => this.placeVariants(doc, job, files, { rect, maskFromSelection: !!sel, label, selChannel }));
    }

    const { ckpt } = await this.pickCkpt(p.model);
    let prompt, neg = '', d0, d1, blend = null, ipadapter = null;
    const desc = String(p.description || '').trim();
    if (NEURAL[f]) { ({ prompt, neg } = NEURAL[f]); [d0, d1] = NEURAL[f].d; blend = NEURAL[f].blend || null; }
    if (f === 'colorize' && p.hint) prompt += ', ' + p.hint;
    if (f === 'style') {
      prompt = STYLES[p.style] || STYLES.oil; d0 = 0.3; d1 = 0.75;
      if (p.reference && m.ipadapter) {
        const refName = await this.comfy.upload(p.reference, `pas_${job.id}_ref.png`);
        ipadapter = { ...m.ipadapter, image: refName, weight: 0.5 + strength * 0.5, weightType: 'style transfer' };
        prompt = 'artwork';
      }
    }
    let effectFirst = false;
    if (f === 'landscape') { [prompt, neg] = LANDSCAPE[p.season] || LANDSCAPE.winter; d0 = 0.4; d1 = 0.8; effectFirst = true; }
    if (f === 'portrait') {
      prompt = ['portrait photo, detailed face', EXPRESSIONS[p.expression] || '', AGES[String(p.age ?? 0)] || '', p.gaze ? 'looking at the camera' : ''].filter(Boolean).join(', ');
      neg = 'deformed face, distorted eyes, bad teeth'; d0 = 0.3; d1 = 0.6;
    }
    if (!prompt) throw new UserError('err.unknownFilter');
    if (NEURAL[f]?.preUpscale && m.upscale.length) {
      job.step = { key: 'job.upscaling' };
      const model = m.upscale.find(x => /x2/i.test(x)) || m.upscale[0];
      const files = await this.comfy.run(W.upscale(srcName, model, { back: { w: rect.width, h: rect.height } }), job.dir, x => { job.progress = 0.1 + 0.2 * x; });
      if (files[0]) srcName = await this.comfy.upload(files[0], `pas_${job.id}_clean.png`);
    }
    const opts = {
      ckpt, profile: W.profile(ckpt), positive: (effectFirst ? [prompt, desc] : [desc, prompt]).filter(Boolean).join(', '), negative: neg, ipadapter,
      denoise: d0 + (d1 - d0) * strength, pixels: this.pixels(),
    };
    const seed = rand();
    await this.withSelection(doc, selChannel => this.runVariants(job, clamp(Number(p.variations) || 1, 1, 3), i => W.img2img(srcName, maskName, rect.width, rect.height, { ...opts, seed: seed + i * 7919 }),
      file => this.placeVariants(doc, job, [file], { rect, maskFromSelection: !!sel, label, blend, selChannel, feather: sel ? Math.round(clamp(Math.min(sel.bounds.width, sel.bounds.height) * 0.03, 2, 30)) : 0 })));
  }

  /** Photon-native "depth" blur: blur everything except the detected subject on a copy of the layer. */
  async depthBlur(job, doc, layer, strength) {
    job.step = { key: 'job.native' };
    const dup = await doc.exec('layer.duplicate', { layerIds: [layer.id] });
    const id = dup.layerIds?.[0] || dup.ids?.[0] || dup.duplicatedLayerIds?.[0] || (dup.layers && dup.layers[0]?.id) || Object.values(dup).flat().find(v => typeof v === 'string' && v.startsWith('layer'));
    if (!id) throw new Error('Could not duplicate the layer');
    await doc.exec('layer.rename', { layerId: id, name: job.t('layer.neural') + ': ' + job.t('nf.depthblur') });
    await doc.exec('selection.subject', { layerId: id });
    await doc.exec('select.modify.feather', { args: { radius: 4 } }).catch(() => {});
    await doc.exec('select.inverse', {});
    const radius = Math.max(2, Math.round((Math.max(doc.width, doc.height) / 1000) * (3 + strength * 22)));
    await doc.exec('filter.blur.gaussianBlur', { layerId: id, params: { radius } });
    await doc.exec('select.deselect', {});
    job.variants.push({ file: null, layerId: id, visible: true });
  }

  /** Show exactly one variant layer. */
  async showVariant(docKey, job, index) {
    const doc = await this.doc(docKey);
    const ids = job.variants.map(v => v.layerId).filter(Boolean);
    const others = ids.filter((_, i) => i !== index);
    if (others.length) await doc.exec('layer.visibility', { layerIds: others, visible: false });
    if (job.variants[index]?.layerId) await doc.exec('layer.visibility', { layerIds: [job.variants[index].layerId], visible: true });
    job.variants.forEach((v, i) => { v.visible = i === index; });
  }

  async keepVariant(docKey, job, index) {
    const doc = await this.doc(docKey);
    const del = job.variants.filter((v, i) => i !== index && v.layerId).map(v => v.layerId);
    if (del.length) await doc.exec('layer.delete', { layerIds: del });
    job.variants = [job.variants[index]];
    job.variants[0].visible = true;
  }
}

module.exports = { Features, UserError, STYLES, LANDSCAPE, EXPRESSIONS };

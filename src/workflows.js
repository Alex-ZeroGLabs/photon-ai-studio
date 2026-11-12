'use strict';
// ComfyUI API-format graph builders.

class Graph {
  constructor() { this.g = {}; this.n = 0; }
  add(type, inputs, id) { id = id || 'n' + (++this.n); this.g[id] = { class_type: type, inputs }; return id; }
}
const o = (id, i = 0) => [id, i];

const BASE_NEG = 'lowres, worst quality, low quality, blurry, jpeg artifacts, watermark, text, signature, logo, deformed, bad anatomy, extra fingers, mutated hands';

/** Sampling defaults guessed from the checkpoint name (SDXL family). */
function profile(ckpt) {
  const n = String(ckpt || '').toLowerCase();
  const pony = /pony|pdxl/.test(n);
  const anime = /illustri|noob|wai|anim|niji|cartoon|toon/.test(n);
  const fast = /dmd2|lightning|hyper|turbo|lcm/.test(n);
  return {
    clipSkip: pony || anime ? 2 : 1,
    steps: fast ? 8 : 28,
    cfg: fast ? 1.5 : anime ? 5.5 : 5.5,
    sampler: fast ? 'lcm' : 'dpmpp_2m_sde',
    scheduler: fast ? 'sgm_uniform' : 'karras',
    posPrefix: pony ? 'score_9, score_8_up, score_7_up, ' : anime ? 'masterpiece, best quality, ' : '',
    neg: (pony ? 'score_4, score_5, score_6, ' : '') + BASE_NEG,
  };
}

/** Working size: same aspect, ~`pixels` total, multiple of 8. */
function workSize(w, h, pixels = 1048576) {
  const s = Math.sqrt(pixels / (w * h));
  return { W: Math.max(256, Math.round((w * s) / 8) * 8), H: Math.max(256, Math.round((h * s) / 8) * 8) };
}

function sdxlBase(G, o_) {
  const p = o_.profile;
  const ck = G.add('CheckpointLoaderSimple', { ckpt_name: o_.ckpt });
  let clip = o(ck, 1);
  if (p.clipSkip > 1) clip = o(G.add('CLIPSetLastLayer', { clip, stop_at_clip_layer: -p.clipSkip }));
  let model = o(ck, 0);
  if (o_.ipadapter) {
    const ipm = G.add('IPAdapterModelLoader', { ipadapter_file: o_.ipadapter.model });
    const cv = G.add('CLIPVisionLoader', { clip_name: o_.ipadapter.clipVision });
    const ref = G.add('LoadImage', { image: o_.ipadapter.image });
    model = o(G.add('IPAdapterAdvanced', {
      model, ipadapter: o(ipm), image: o(ref), weight: o_.ipadapter.weight ?? 0.8, weight_type: o_.ipadapter.weightType || 'style transfer',
      combine_embeds: 'concat', start_at: 0, end_at: 1, embeds_scaling: 'V only', clip_vision: o(cv),
    }));
  }
  const pos = G.add('CLIPTextEncode', { text: p.posPrefix + (o_.positive || ''), clip });
  const neg = G.add('CLIPTextEncode', { text: [o_.negative, p.neg].filter(Boolean).join(', '), clip });
  return { model, vae: o(ck, 2), pos: o(pos), neg: o(neg) };
}

function sampler(G, model, b, latent, o_, denoise) {
  const p = o_.profile;
  return G.add('KSampler', {
    model, seed: o_.seed >>> 0, steps: o_.steps || p.steps, cfg: o_.cfg ?? p.cfg, sampler_name: p.sampler, scheduler: p.scheduler,
    positive: b.pos, negative: b.neg, latent_image: latent, denoise,
  });
}

/** Soft mask at original size for the final paste (grow + blur). */
function softMask(G, mask, grow, blur) {
  let m = mask;
  if (grow) m = o(G.add('GrowMask', { mask: m, expand: grow, tapered_corners: true }));
  if (blur > 0) {
    const im = G.add('MaskToImage', { mask: m });
    const bl = G.add('ImageBlur', { image: o(im), blur_radius: Math.min(31, Math.max(1, Math.round(blur))), sigma: Math.max(0.5, blur / 2) });
    m = o(G.add('ImageToMask', { image: o(bl), channel: 'red' }));
  }
  return m;
}

function scaleMask(G, mask, W, H) {
  const im = G.add('MaskToImage', { mask });
  const sc = G.add('ImageScale', { image: o(im), upscale_method: 'bilinear', width: W, height: H, crop: 'disabled' });
  return o(G.add('ImageToMask', { image: o(sc), channel: 'red' }));
}

/**
 * Inpaint / outpaint core. img & mask are node refs at original size (origW x origH).
 * o_: { ckpt, profile, positive, negative, seed, denoise, fooocus:{head,patch}|null, fill, grow, blur, pixels }
 */
function inpaintCore(G, img, mask, origW, origH, o_) {
  const { W, H } = workSize(origW, origH, o_.pixels);
  const b = sdxlBase(G, o_);
  const grown = o_.grow ? o(G.add('GrowMask', { mask, expand: o_.grow, tapered_corners: true })) : mask;
  const imgW = o(G.add('ImageScale', { image: img, upscale_method: 'lanczos', width: W, height: H, crop: 'disabled' }));
  const maskW = scaleMask(G, grown, W, H);
  let ks;
  if (o_.fooocus) {
    const filled = o_.fill ? o(G.add('INPAINT_MaskedFill', { image: imgW, mask: maskW, fill: o_.fill, falloff: 0 })) : imgW;
    const enc = G.add('INPAINT_VAEEncodeInpaintConditioning', { positive: b.pos, negative: b.neg, vae: b.vae, pixels: filled, mask: maskW });
    const head = G.add('INPAINT_LoadFooocusInpaint', { head: o_.fooocus.head, patch: o_.fooocus.patch });
    const model = o(G.add('INPAINT_ApplyFooocusInpaint', { model: b.model, patch: o(head), latent: o(enc, 2) }));
    ks = sampler(G, model, { pos: o(enc, 0), neg: o(enc, 1) }, o(enc, 3), o_, o_.denoise ?? 1);
  } else {
    const model = o(G.add('DifferentialDiffusion', { model: b.model }));
    const c = G.add('InpaintModelConditioning', { positive: b.pos, negative: b.neg, vae: b.vae, pixels: imgW, mask: maskW, noise_mask: true });
    ks = sampler(G, model, { pos: o(c, 0), neg: o(c, 1) }, o(c, 2), o_, o_.denoise ?? 1);
  }
  const dec = G.add('VAEDecode', { samples: o(ks), vae: b.vae });
  const up = G.add('ImageScale', { image: o(dec), upscale_method: 'lanczos', width: origW, height: origH, crop: 'disabled' });
  const comp = G.add('ImageCompositeMasked', { destination: img, source: o(up), x: 0, y: 0, resize_source: false, mask: softMask(G, grown, 0, o_.blur ?? 8) });
  G.add('SaveImage', { images: o(comp), filename_prefix: 'photon-ai/fill' });
  return G.g;
}

function inpaint(imageName, maskName, w, h, o_) {
  const G = new Graph();
  const img = o(G.add('LoadImage', { image: imageName }));
  const mask = o(G.add('LoadImageMask', { image: maskName, channel: 'red' }));
  return inpaintCore(G, img, mask, w, h, o_);
}

const outpaintFeather = (w, h) => Math.min(48, Math.round(Math.min(w, h) * 0.04));

function outpaint(imageName, pads, w, h, o_) {
  const G = new Graph();
  const img = G.add('LoadImage', { image: imageName });
  const feather = outpaintFeather(w, h);
  const pad = G.add('ImagePadForOutpaint', { image: o(img), left: pads.left, top: pads.top, right: pads.right, bottom: pads.bottom, feathering: feather });
  return inpaintCore(G, o(pad, 0), o(pad, 1), w + pads.left + pads.right, h + pads.top + pads.bottom, { ...o_, grow: 6, fill: o_.fooocus ? 'navier-stokes' : null });
}

/** img2img with optional mask (soft paste) and IPAdapter reference. */
function img2img(imageName, maskName, w, h, o_) {
  const G = new Graph();
  const { W, H } = workSize(w, h, o_.pixels);
  const b = sdxlBase(G, o_);
  const img = o(G.add('LoadImage', { image: imageName }));
  const imgW = o(G.add('ImageScale', { image: img, upscale_method: 'lanczos', width: W, height: H, crop: 'disabled' }));
  let lat = o(G.add('VAEEncode', { pixels: imgW, vae: b.vae }));
  let model = b.model, mask = null;
  if (maskName) {
    mask = o(G.add('LoadImageMask', { image: maskName, channel: 'red' }));
    lat = o(G.add('SetLatentNoiseMask', { samples: lat, mask: scaleMask(G, mask, W, H) }));
    model = o(G.add('DifferentialDiffusion', { model }));
  }
  const ks = sampler(G, model, b, lat, o_, o_.denoise);
  const dec = G.add('VAEDecode', { samples: o(ks), vae: b.vae });
  let out = o(G.add('ImageScale', { image: o(dec), upscale_method: 'lanczos', width: w, height: h, crop: 'disabled' }));
  if (mask) out = o(G.add('ImageCompositeMasked', { destination: img, source: out, x: 0, y: 0, resize_source: false, mask: softMask(G, mask, 0, 6) }));
  G.add('SaveImage', { images: out, filename_prefix: 'photon-ai/filter' });
  return G.g;
}

function txt2img(W, H, o_) {
  const G = new Graph();
  const b = sdxlBase(G, o_);
  const lat = G.add('EmptyLatentImage', { width: W, height: H, batch_size: 1 });
  const ks = sampler(G, b.model, b, o(lat), o_, 1);
  const dec = G.add('VAEDecode', { samples: o(ks), vae: b.vae });
  G.add('SaveImage', { images: o(dec), filename_prefix: 'photon-ai/gen' });
  return G.g;
}

function zimage(W, H, o_) {
  const G = new Graph();
  const unet = G.add('UNETLoader', { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: o_.vramGB && o_.vramGB < 20 ? 'fp8_e4m3fn' : 'default' });
  const clip = G.add('CLIPLoader', { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' });
  const vae = G.add('VAELoader', { vae_name: 'ae.safetensors' });
  const shift = G.add('ModelSamplingAuraFlow', { model: o(unet), shift: 3.0 });
  const pos = G.add('CLIPTextEncode', { text: o_.positive, clip: o(clip) });
  const neg = G.add('ConditioningZeroOut', { conditioning: o(pos) });
  const lat = G.add('EmptySD3LatentImage', { width: W, height: H, batch_size: 1 });
  const ks = G.add('KSampler', { model: o(shift), seed: o_.seed >>> 0, steps: 8, cfg: 1.0, sampler_name: 'res_multistep', scheduler: 'simple', positive: o(pos), negative: o(neg), latent_image: o(lat), denoise: 1 });
  const dec = G.add('VAEDecode', { samples: o(ks), vae: o(vae) });
  G.add('SaveImage', { images: o(dec), filename_prefix: 'photon-ai/gen' });
  return G.g;
}

/** AI upscale; `back` = scale the result back to the source size (artifact cleanup). */
function upscale(imageName, modelName, { factor = 2, modelFactor = 2, back = null } = {}) {
  const G = new Graph();
  const img = G.add('LoadImage', { image: imageName });
  const m = G.add('UpscaleModelLoader', { model_name: modelName });
  let out = o(G.add('ImageUpscaleWithModel', { upscale_model: o(m), image: o(img) }));
  if (back) out = o(G.add('ImageScale', { image: out, upscale_method: 'area', width: back.w, height: back.h, crop: 'disabled' }));
  else if (factor !== modelFactor) out = o(G.add('ImageScaleBy', { image: out, upscale_method: 'lanczos', scale_by: factor / modelFactor }));
  G.add('SaveImage', { images: out, filename_prefix: 'photon-ai/up' });
  return G.g;
}

module.exports = { profile, workSize, outpaintFeather, inpaint, outpaint, img2img, txt2img, zimage, upscale };

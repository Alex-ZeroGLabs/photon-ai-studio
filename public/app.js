/* Photon AI Studio — panel UI */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  let LANG = 'en';
  let status = null, models = null, hwInfo = null, currentJob = null, pollTimer = null, packsInfo = null;
  const state = { ratio: '16:9', anchor: 'center', srFactor: 2, view: null, wizardStep: 1 };

  // ---------------------------------------------------------------- i18n
  function t(k, v) {
    let s = (window.I18N[LANG] && window.I18N[LANG][k]) ?? window.I18N.en[k] ?? k;
    if (v) s = s.replace(/\{(\w+)\}/g, (_, n) => (v[n] ?? ''));
    return s;
  }
  function applyI18n(root = document) {
    $$('[data-i18n]', root).forEach(e => { e.textContent = t(e.dataset.i18n); });
    $$('[data-i18n-ph]', root).forEach(e => { e.placeholder = t(e.dataset.i18nPh); });
    $$('[data-i18n-title]', root).forEach(e => { e.title = t(e.dataset.i18nTitle); });
    document.documentElement.lang = LANG;
  }
  const errText = e => (e?.key ? t(e.key, e.vars) : (e?.message || String(e)));
  const fmtBytes = b => (b >= 1e9 ? t('gb', { n: (b / 1073741824).toFixed(1) }) : t('mb', { n: Math.max(1, Math.round(b / 1048576)) }));

  // ---------------------------------------------------------------- api
  async function api(path, { method = 'GET', body, raw } = {}) {
    const opt = { method, headers: { 'x-pas': '1' } };
    if (raw) { opt.body = raw; opt.headers['content-type'] = 'application/octet-stream'; }
    else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['content-type'] = 'application/json'; }
    const r = await fetch(path, opt);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw j.error || { message: 'HTTP ' + r.status };
    return j;
  }
  function toast(msg, bad) {
    const el = $('#toast'); el.textContent = msg; el.className = 'toast' + (bad ? ' bad' : ''); el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, bad ? 6000 : 2600);
  }

  // ---------------------------------------------------------------- views
  function show(view) {
    state.view = view;
    $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + view; });
  }

  // ---------------------------------------------------------------- status loop
  async function refreshStatus() {
    try { status = await api('/api/status'); }
    catch { $('#chip-engine').className = 'chip bad'; return; }
    if (!refreshStatus.langSet) { LANG = window.I18N[status.lang] ? status.lang : 'en'; applyI18n(); refreshStatus.langSet = true; buildFilters(); }
    $('#chip-photon').className = 'chip ' + (status.photon.ok ? 'ok' : 'bad');
    const eng = status.engine;
    $('#chip-engine').className = 'chip ' + (status.comfy.ok ? 'ok' : (eng.state === 'starting' || eng.state === 'installing') ? 'busy' : 'idle');
    $$('.ai-improve').forEach(b => { b.hidden = !status.ollama.model; });
    // documents
    const sel = $('#doc-select');
    const keep = sel.value || localStorage.getItem('pas.doc') || '';
    const docs = status.documents || [];
    const sig = docs.map(d => d.key + d.title).join('|');
    if (sel.dataset.sig !== sig) {
      sel.innerHTML = docs.map(d => `<option value="${d.key}">${esc(d.title)} — ${d.width}×${d.height}</option>`).join('');
      sel.dataset.sig = sig;
      if (docs.some(d => d.key === keep)) sel.value = keep;
      else if (docs.length) sel.value = docs[docs.length - 1].key;
    }
    const n = $('#notice');
    if (!status.photon.ok) { n.textContent = t('notice.noPhoton'); n.hidden = false; }
    else if (!docs.length) { n.textContent = t('notice.noDoc'); n.hidden = false; }
    else n.hidden = true;
    return status;
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function loadModels() {
    try { models = await api('/api/models'); } catch (e) { models = null; return; }
    const ms = $('#model-select');
    const pref = localStorage.getItem('pas.model') || status?.cfg?.checkpoint || '';
    ms.innerHTML = models.checkpoints.filter(c => !/refiner/i.test(c)).map(c => `<option value="${esc(c)}">${esc(c.replace(/\.(safetensors|ckpt)$/i, ''))}</option>`).join('');
    if (pref && models.checkpoints.includes(pref)) ms.value = pref;
    else { const r = models.checkpoints.find(c => /realvis/i.test(c)); if (r) ms.value = r; }
    $('#g-z-wrap').hidden = !models.zimage;
    buildFilters();
  }

  // ---------------------------------------------------------------- setup wizard
  function wizardStep(n) {
    state.wizardStep = n;
    $$('.wstep').forEach(s => { s.hidden = s.id !== 'ws-' + n; });
    $$('.wizard-steps span').forEach(s => { s.classList.toggle('on', Number(s.dataset.step) <= n); });
  }

  function renderHw(h, el, compact) {
    const lvl = `<div class="level ${h.level}"><b>${t('level.' + h.level)}</b>${compact ? '' : `<span>${t('level.' + h.level + '.d')}</span>`}</div>`;
    const notes = h.notes.map(n => `<li class="${n.t}">${esc(t(n.k, n.v))}</li>`).join('');
    const sys = `<div class="sys small muted">${esc(h.system.cpu.trim())} · ${h.system.cores} threads · ${esc(h.system.os)}</div>`;
    el.innerHTML = lvl + `<ul class="notes">${notes}</ul>` + sys;
  }

  async function startWizard() {
    show('setup'); wizardStep(1);
    hwInfo = await api('/api/hardware');
    renderHw(hwInfo, $('#hw-card'));
    $('#ws1-next').disabled = false;
    if (new URLSearchParams(location.hash.slice(1)).get('step') === '2') { wizardStep(2); await renderPacks(); }
  }

  const PACK_ORDER = ['base', 'style', 'anime', 'zimage'];
  async function renderPacks() {
    const prevChecked = $$('#packs input').length ? new Set($$('#packs input:checked').map(i => i.value)) : null;
    packsInfo = await api('/api/packs');
    if (status?.cfg?.extraModelDirs?.length && !$('#reuse-dir').value) $('#reuse-dir').value = status.cfg.extraModelDirs[0];
    const rec = hwInfo?.recommend || {};
    $('#install-dir').value = status?.cfg?.installDir || packsInfo.root;
    $('#install-dir').disabled = packsInfo.engineInstalled;
    $('#packs').innerHTML = (packsInfo.engineInstalled ? '' : `<div class="pack fixed"><b>⚙ ${t('setup.engineLine', { size: '6 GB' })}</b></div>`) +
      PACK_ORDER.map(id => {
        const p = packsInfo.packs[id];
        const badge = p.installed ? `<em class="ok">${t('pack.installed')}</em>` : rec[id] ? `<em class="rec">${t('pack.recommended')}</em>` : `<em class="warn">${t('pack.notRecommended')}</em>`;
        const checked = p.installed || id === 'base' || (prevChecked ? prevChecked.has(id) : rec[id]);
        return `<label class="pack ${p.installed ? 'done' : ''}"><input type="checkbox" value="${id}" ${checked ? 'checked' : ''} ${id === 'base' || p.installed ? 'disabled' : ''}>
          <div><b>${t('pack.' + id)}</b> ${badge}<span class="size">${fmtBytes(p.installed ? p.totalBytes : p.missingBytes)}</span><p class="small muted">${t('pack.' + id + '.d')}</p></div></label>`;
      }).join('');
    $$('#packs input').forEach(i => i.addEventListener('change', updateTotal));
    updateTotal();
  }
  function selectedPacks() { return ['base', ...$$('#packs input:checked').map(i => i.value).filter(v => v !== 'base')]; }
  function updateTotal() {
    if (!packsInfo) return;
    let b = packsInfo.engineInstalled ? 0 : 6.5e9;
    for (const id of selectedPacks()) b += packsInfo.packs[id]?.missingBytes || 0;
    const free = packsInfo.freeGB;
    $('#total-size').textContent = t('setup.total', { size: fmtBytes(b), free: free == null ? t('setup.freeUnknown') : t('gb', { n: free }) });
    $('#total-size').classList.toggle('bad', free != null && free < b / 1073741824 + 2);
  }

  const STEPS = ['uv', 'python', 'comfy', 'torch', 'deps', 'nodes', 'models'];
  async function runInstall() {
    const body = { packs: selectedPacks() };
    if (!packsInfo.engineInstalled) body.installDir = $('#install-dir').value.trim();
    const reuse = $('#reuse-dir').value.trim();
    if (reuse) body.extraModelDirs = [reuse];
    try { await api('/api/install', { method: 'POST', body }); }
    catch (e) { toast(errText(e), true); return; }
    show('setup'); wizardStep(3);
    $('#inst-err').hidden = true; $('#inst-retry').hidden = true; $('#inst-cancel').hidden = false;
    pollInstall();
  }
  async function pollInstall() {
    clearTimeout(pollInstall.t);
    let s; try { s = await refreshStatus(); } catch { /* */ }
    const task = s?.engine?.task || {};
    const engineDone = s?.engine?.installed;
    const cur = task.step;
    const idx = STEPS.indexOf(cur);
    if (cur !== pollInstall.step) { pollInstall.step = cur; pollInstall.since = Date.now(); }
    const el = Math.round((Date.now() - pollInstall.since) / 1000);
    const elapsed = el >= 5 ? ` <span class="muted small">· ${Math.floor(el / 60)}:${String(el % 60).padStart(2, '0')}</span>` : '';
    $('#inst-steps').innerHTML = STEPS.map((st, i) => {
      const done = cur === 'done' || (engineDone && i < 6) || (idx > i);
      const on = st === cur && cur !== 'done';
      return `<li class="${done ? 'done' : on ? 'on' : ''}">${t('step.' + st)}${on ? elapsed : ''}${on && task.detail?.line ? `<small>${esc(task.detail.line)}</small>` : ''}</li>`;
    }).join('');
    const dl = $('#inst-dl');
    if (task.detail?.total) {
      dl.hidden = false;
      const d = task.detail;
      $('.dl-name', dl).textContent = d.label + (d.count ? ` (${d.index}/${d.count})` : '');
      $('.bar i', dl).style.width = (100 * d.got / d.total).toFixed(1) + '%';
      const eta = d.speed ? Math.round((d.total - d.got) / d.speed) : 0;
      $('.dl-meta', dl).textContent = `${fmtBytes(d.got)} / ${fmtBytes(d.total)} · ${d.speed ? fmtBytes(d.speed) + '/s' : ''}${eta ? ' · ' + (eta > 90 ? Math.round(eta / 60) + ' min' : eta + ' s') : ''}`;
    } else dl.hidden = true;
    if (task.error) {
      $('#inst-err').textContent = task.error; $('#inst-err').hidden = false; $('#inst-retry').hidden = false; $('#inst-cancel').hidden = true;
      try { $('#inst-log').textContent = (await api('/api/install/log')).log; } catch { /* */ }
      return;
    }
    if (cur === 'done') { toast(t('step.done')); setTimeout(enterMain, 800); return; }
    if ($('details.alt[open] #inst-log')) { try { $('#inst-log').textContent = (await api('/api/install/log')).log; } catch { /* */ } }
    pollInstall.t = setTimeout(pollInstall, 1000);
  }

  // ---------------------------------------------------------------- main
  function selectTab(name) {
    if (!$(`.tabs button[data-tab="${name}"]`)) return;
    $$('.tabs button').forEach(x => x.classList.toggle('on', x.dataset.tab === name));
    $$('.tab').forEach(tb => { tb.hidden = tb.id !== 'tab-' + name; });
  }

  async function enterMain() {
    show('main');
    await refreshStatus();
    await loadModels();
    // Deep links: #tab=neural|tools, #open=<filter id> (used for docs screenshots too).
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('tab')) selectTab(h.get('tab'));
    if (h.get('open')) { const d = $(`#filters details[data-id="${h.get('open')}"]`); if (d) d.open = true; }
  }

  function docKey() { return $('#doc-select').value; }
  function model() { return $('#model-select').value; }

  async function run(tool, params) {
    if (currentJob && ['queued', 'running'].includes(currentJob.status)) { toast(t('job.queued')); }
    const doc = docKey();
    if (!doc) { toast(t('notice.noDoc'), true); return; }
    try {
      const j = await api('/api/run', { method: 'POST', body: { tool, params: { doc, model: model(), ...params } } });
      currentJob = j; renderJob(); pollJob();
    } catch (e) { toast(errText(e), true); }
  }

  async function pollJob() {
    clearTimeout(pollTimer);
    if (!currentJob) return;
    try { currentJob = await api('/api/jobs/' + currentJob.id); } catch { /* */ }
    renderJob();
    if (['queued', 'running'].includes(currentJob.status)) pollTimer = setTimeout(pollJob, 700);
    else if (currentJob.status === 'done' && !models) loadModels();
  }

  function renderJob() {
    const j = currentJob; const box = $('#job');
    if (!j) { box.hidden = true; return; }
    box.hidden = false;
    $('#job-step').textContent = j.status === 'error' ? '' : t(j.step.key, j.step.vars);
    $('#job-bar').style.width = Math.round((j.progress || 0) * 100) + '%';
    $('#job-bar').parentElement.classList.toggle('active', j.status === 'running');
    $('#job-cancel').hidden = !['queued', 'running'].includes(j.status);
    const err = $('#job-err');
    if (j.status === 'error') { err.textContent = errText(j.error); err.hidden = false; } else err.hidden = true;
    const withThumb = j.variants.filter(v => v.thumb);
    $('#variants').innerHTML = withThumb.length > 1 || (withThumb.length === 1 && j.variants.length > 1)
      ? j.variants.map(v => v.thumb ? `<button class="variant ${v.visible ? 'on' : ''}" data-i="${v.index}"><img src="${v.thumb}" alt=""></button>` : '').join('')
      : (withThumb.length === 1 ? `<div class="variant single"><img src="${withThumb[0].thumb}" alt=""></div>` : '');
    $('#variant-actions').hidden = !(j.status === 'done' && j.variants.filter(v => v.hasLayer).length > 1);
  }

  // ---------------------------------------------------------------- neural filters UI
  const FILTERS = [
    { id: 'skin', controls: ['strength'] },
    { id: 'portrait', controls: ['expression', 'age', 'gaze', 'strength'] },
    { id: 'style', controls: ['style', 'reference', 'strength'] },
    { id: 'colorize', controls: ['hint', 'strength'] },
    { id: 'landscape', controls: ['season', 'strength'] },
    { id: 'harmonize', controls: ['strength'] },
    { id: 'restore', controls: ['strength'] },
    { id: 'jpeg', controls: [] },
    { id: 'superzoom', controls: ['factor'] },
    { id: 'depthblur', controls: ['strength'] },
  ];
  const STYLES = ['oil', 'watercolor', 'sketch', 'anime', 'comic', 'pixar', 'vangogh', 'popart', 'cyberpunk', 'vintage'];
  const SEASONS = ['winter', 'autumn', 'spring', 'summer', 'sunset', 'night', 'fog', 'storm'];
  const EXPR = ['smile', 'bigsmile', 'surprise', 'angry', 'sad', 'neutral'];

  function control(fid, c) {
    const id = `nf-${fid}-${c}`;
    switch (c) {
      case 'strength': return `<label class="ctl"><span>${t('common.strength')}</span><input type="range" id="${id}" min="0" max="100" value="50"><output>50</output></label>`;
      case 'expression': return `<label class="ctl"><span>${t('nf.expression')}</span><select id="${id}">${EXPR.map(e => `<option value="${e}">${t('expr.' + e)}</option>`).join('')}</select></label>`;
      case 'age': return `<label class="ctl"><span>${t('nf.age')}</span><input type="range" id="${id}" min="-2" max="2" step="1" value="0"><output>${t('age.0')}</output></label>`;
      case 'gaze': return `<label class="ctl check"><input type="checkbox" id="${id}"> ${t('nf.gaze')}</label>`;
      case 'style': return `<label class="ctl"><span>${t('nf.styleSel')}</span><select id="${id}">${STYLES.map(s => `<option value="${s}">${t('style.' + s)}</option>`).join('')}</select></label>`;
      case 'reference': return `<label class="ctl"><span>${t('nf.ref')}</span><input type="file" id="${id}" accept="image/png,image/jpeg,image/webp" ${models && !models.ipadapter ? 'disabled' : ''}>${models && !models.ipadapter ? `<small class="muted">${t('nf.refNeedsPack')}</small>` : ''}</label>`;
      case 'season': return `<label class="ctl"><span>${t('nf.season')}</span><select id="${id}">${SEASONS.map(s => `<option value="${s}">${t('season.' + s)}</option>`).join('')}</select></label>`;
      case 'hint': return `<label class="ctl"><span>${t('nf.hint')}</span><input id="${id}" placeholder="${esc(t('nf.hintPh'))}"></label>`;
      case 'factor': return `<label class="ctl"><span>${t('nf.factor')}</span><select id="${id}"><option value="2">2×</option><option value="4">4×</option></select></label>`;
      default: return '';
    }
  }
  function buildFilters() {
    const open = $$('#filters details[open]').map(d => d.dataset.id);
    $('#filters').innerHTML = FILTERS.map(f => `
      <details class="filter" data-id="${f.id}" ${open.includes(f.id) ? 'open' : ''}>
        <summary><b>${t('nf.' + f.id)}</b><small class="muted">${t('nf.' + f.id + '.d')}</small></summary>
        <div class="ctls">${f.controls.map(c => control(f.id, c)).join('')}
          <div class="row end"><button class="btn primary" data-filter="${f.id}">${t('common.apply')}</button></div></div>
      </details>`).join('');
    $$('#filters input[type=range]').forEach(r => {
      const out = r.nextElementSibling;
      const upd = () => { out.textContent = r.id.endsWith('-age') ? t('age.' + r.value) : r.value; };
      r.addEventListener('input', upd); upd();
    });
  }
  async function applyFilter(fid) {
    const g = c => document.getElementById(`nf-${fid}-${c}`);
    const p = { filter: fid, description: $('#nf-desc').value.trim() };
    if (g('strength')) p.strength = Number(g('strength').value);
    if (g('expression')) p.expression = g('expression').value;
    if (g('age')) p.age = Number(g('age').value);
    if (g('gaze')) p.gaze = g('gaze').checked;
    if (g('style')) p.style = g('style').value;
    if (g('season')) p.season = g('season').value;
    if (g('hint')) p.hint = g('hint').value.trim();
    if (g('factor')) p.factor = Number(g('factor').value);
    const ref = g('reference');
    if (ref && ref.files && ref.files[0]) {
      try { const r = await api('/api/reference', { method: 'POST', raw: await ref.files[0].arrayBuffer() }); p.referenceId = r.id; }
      catch (e) { toast(errText(e), true); return; }
    }
    run('neural', p);
  }

  // ---------------------------------------------------------------- settings
  async function openSettings() {
    await refreshStatus();
    const c = status.cfg;
    $('#s-mode').value = c.engineMode; $('#s-url').value = c.comfyUrl; $('#s-url-wrap').hidden = c.engineMode !== 'external';
    $('#s-extra').value = (c.extraModelDirs || []).join('\n'); $('#s-out').value = c.outputDir; $('#s-ollama').value = c.ollamaUrl;
    $('#s-photon').value = c.photonPath || ''; $('#s-stopexit').checked = !!c.stopEngineOnExit;
    $('#about').textContent = `Photon AI Studio ${status.version} · ${status.engine.root}`;
    show('settings');
    try { const h = hwInfo || await api('/api/hardware'); hwInfo = h; renderHw(h, $('#s-hw'), true); } catch { /* */ }
  }
  async function saveSettings() {
    const body = {
      engineMode: $('#s-mode').value, comfyUrl: $('#s-url').value.trim(), extraModelDirs: $('#s-extra').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
      outputDir: $('#s-out').value.trim(), ollamaUrl: $('#s-ollama').value.trim(), photonPath: $('#s-photon').value.trim(), stopEngineOnExit: $('#s-stopexit').checked,
    };
    try {
      await api('/api/config', { method: 'POST', body });
      toast(t('settings.saved'));
      await refreshStatus(); applyI18n(); buildFilters();
      models = null; loadModels();
    } catch (e) { toast(errText(e), true); }
  }

  // ---------------------------------------------------------------- events
  function bind() {
    $('#ws1-next').onclick = async () => { wizardStep(2); await renderPacks(); };
    $('#ws2-back').onclick = () => wizardStep(1);
    $('#ws2-install').onclick = runInstall;
    // Reusing an existing models folder: save it and recompute what is still missing.
    let reuseTimer = null;
    const onReuse = () => {
      clearTimeout(reuseTimer);
      reuseTimer = setTimeout(async () => {
        const v = $('#reuse-dir').value.trim();
        try { await api('/api/config', { method: 'POST', body: { extraModelDirs: v ? [v] : [] } }); await refreshStatus(); await renderPacks(); } catch (err) { toast(errText(err), true); }
      }, 600);
    };
    $('#reuse-dir').addEventListener('input', onReuse);
    $('#reuse-dir').addEventListener('change', onReuse);
    $('#inst-cancel').onclick = async () => { await api('/api/install/cancel', { method: 'POST' }).catch(() => {}); };
    $('#inst-retry').onclick = runInstall;
    $('#ext-connect').onclick = async () => {
      const url = $('#ext-url').value.trim();
      try {
        await api('/api/config', { method: 'POST', body: { engineMode: 'external', comfyUrl: url, setupDone: true } });
        await api('/api/engine/start', { method: 'POST' });
        $('#ext-msg').textContent = t('setup.connected'); setTimeout(enterMain, 600);
      } catch (e) { $('#ext-msg').textContent = t('setup.notReachable') + ' — ' + errText(e); await api('/api/config', { method: 'POST', body: { engineMode: 'managed', setupDone: false } }).catch(() => {}); }
    };
    $$('.tabs button').forEach(b => b.onclick = () => selectTab(b.dataset.tab));
    $('#doc-select').onchange = e => localStorage.setItem('pas.doc', e.target.value);
    $('#model-select').onchange = e => localStorage.setItem('pas.model', e.target.value);
    $$('#ex-ratio button').forEach(b => b.onclick = () => {
      $$('#ex-ratio button').forEach(x => x.classList.toggle('on', x === b)); state.ratio = b.dataset.v; $('#ex-pct-row').hidden = state.ratio !== 'pct';
    });
    $('#ex-pct').oninput = e => { $('#ex-pct-v').textContent = e.target.value + '%'; };
    $$('#ex-anchor button').forEach(b => b.onclick = () => { $$('#ex-anchor button').forEach(x => x.classList.toggle('on', x === b)); state.anchor = b.dataset.v; });
    $$('#sr-factor button').forEach(b => b.onclick = () => { $$('#sr-factor button').forEach(x => x.classList.toggle('on', x === b)); state.srFactor = Number(b.dataset.v); });

    document.addEventListener('click', async e => {
      const r = e.target.closest('[data-run]');
      if (r) {
        const a = r.dataset.run;
        if (a === 'genfill') run('genfill', { prompt: $('#gf-prompt').value.trim(), variations: Number($('#gf-var').value) });
        if (a === 'genfill-remove') run('genfill', { prompt: '', variations: Number($('#gf-var').value) });
        if (a === 'expand') run('expand', { mode: state.ratio === 'pct' ? 'percent' : 'ratio', ratio: state.ratio, percent: Number($('#ex-pct').value), anchor: state.anchor, prompt: $('#ex-prompt').value.trim() });
        if (a === 'generate') run('generate', { prompt: $('#g-prompt').value.trim(), variations: Number($('#g-var').value), ...($('#g-z').checked ? { model: '__zimage__' } : {}) });
        if (a === 'removebg') run('removebg', {});
        if (a === 'select-subject') run('select', { what: 'subject' });
        if (a === 'select-sky') run('select', { what: 'sky' });
        if (a === 'superres') run('superres', { factor: state.srFactor });
        return;
      }
      const f = e.target.closest('[data-filter]');
      if (f) { applyFilter(f.dataset.filter); return; }
      const v = e.target.closest('.variant[data-i]');
      if (v && currentJob) {
        try { currentJob = await api(`/api/jobs/${currentJob.id}/show/${v.dataset.i}`, { method: 'POST' }); renderJob(); } catch (err) { toast(errText(err), true); }
        return;
      }
      const imp = e.target.closest('.ai-improve');
      if (imp) {
        const ta = document.getElementById(imp.dataset.for);
        if (!ta.value.trim()) return;
        imp.disabled = true; imp.classList.add('spin');
        try { ta.value = (await api('/api/prompt', { method: 'POST', body: { text: ta.value } })).text; } catch (err) { toast(errText(err), true); }
        imp.disabled = false; imp.classList.remove('spin');
        return;
      }
      const o = e.target.closest('[data-open]');
      if (o) api('/api/open-folder', { method: 'POST', body: { which: o.dataset.open } }).catch(err => toast(errText(err), true));
    });
    $('#keep-variant').onclick = async () => {
      const on = currentJob?.variants.find(v => v.visible);
      if (!on) return;
      try { currentJob = await api(`/api/jobs/${currentJob.id}/keep/${on.index}`, { method: 'POST' }); renderJob(); } catch (err) { toast(errText(err), true); }
    };
    $('#job-cancel').onclick = () => currentJob && api(`/api/jobs/${currentJob.id}/cancel`, { method: 'POST' }).catch(() => {});
    $('#btn-settings').onclick = () => (state.view === 'settings' ? enterMain() : openSettings());
    $('#settings-close').onclick = () => (status?.engine?.installed || status?.cfg?.engineMode === 'external' ? enterMain() : startWizard());
    $('#settings-save').onclick = saveSettings;
    $('#s-mode').onchange = e => { $('#s-url-wrap').hidden = e.target.value !== 'external'; };
    $('#s-start').onclick = async () => { toast(t('job.engine')); try { await api('/api/engine/start', { method: 'POST' }); toast('OK'); loadModels(); } catch (e) { toast(errText(e), true); } };
    $('#s-stop').onclick = async () => { await api('/api/engine/stop', { method: 'POST' }).catch(() => {}); refreshStatus(); };
    $('#s-packs').onclick = async () => { show('setup'); if (!hwInfo) hwInfo = await api('/api/hardware'); wizardStep(2); renderPacks(); };
    // Ctrl/Cmd+Enter in a prompt runs its tool
    $$('textarea').forEach(ta => ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { const btn = ta.closest('.tool')?.querySelector('.btn.primary'); btn?.click(); }
    }));
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    applyI18n(); bind();
    await refreshStatus();
    if (!status) { document.body.insertAdjacentHTML('beforeend', '<p class="center">Photon AI Studio server is not reachable.</p>'); return; }
    const e = status.engine;
    if (e.state === 'installing') { show('setup'); wizardStep(3); hwInfo = await api('/api/hardware').catch(() => null); pollInstall(); }
    else if (e.mode === 'external' || e.installed) enterMain();
    else startWizard();
    setInterval(() => { if (state.view === 'main') refreshStatus(); }, 3000);
  }
  boot();
})();

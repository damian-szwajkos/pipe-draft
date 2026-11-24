// PipeDraft UI wiring.

import { analyze, simulate, flattenView, fmtDur } from '../engine/engine.js';
import { presetContexts, normalizeContext, suggestContexts, newId, CAUSES } from '../engine/contexts.js';
import { makeJobResolver, chainRuns, chainTotal, runAt } from '../engine/jobs.js';
import { EXAMPLES } from '../examples.js';
import { createEditor } from './editor.js';
import { createSplit } from './split.js';
import { renderGraph, timedStatus } from './graph.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const STORE_KEY = 'pipedraft:v1';
const ST_COLOR = { success: 'var(--ok)', failure: 'var(--fail)', unstable: 'var(--warn)', skipped: 'var(--skip)', 'not-run': 'var(--skip)', aborted: 'var(--abort)' };
const MOCKED_WHY = {
  missing: 'no Jenkinsfile for this job in the workspace',
  rule: 'a mock rule of this context matches it',
  loop: 'it would start a build that is already running up the chain',
  limit: 'the simulation stops starting builds here',
  aborted: 'the build that starts it was aborted first',
  notfound: 'Jenkins finds no job with this name',
};
const RES_ICON = { SUCCESS: '✓', FAILURE: '✕', UNSTABLE: '!', ABORTED: '■', NOT_BUILT: '–' };

const state = {
  source: '',
  // standalone pipeline jobs a `build job:` step can start: [{ id, name, source }]
  jobs: [],
  exampleId: 'multibranch',
  pristine: '',
  pristineJobs: '[]',
  // the file open in the editor: 'main' or a job id
  file: 'main',
  contexts: [],
  activeCtx: null,
  tab: 'pipeline',
  // the build of the chain that details and the log show ('' is the build itself, '0' the first one it started)
  view: '',
  // the job of that build, so a context switch does not land on another job at the same path
  viewJob: null,
  selected: null,
  autorun: false,
};
// Live: re-analysed (syntax + structure checks) on every edit.
let analysis = null;
const jobAnalyses = new Map();
// The last run: results for every context, and the analyses they were computed from.
let ran = null;
// True when a Jenkinsfile or the contexts changed after the last run.
let dirty = true;
// Playback of the active context's run: { ctxId, t, total, wall, t0, raf, sig }.
let anim = null;
let celebrate = false;
let engineError = null;
let timer = null;

const query = new URLSearchParams(location.search);
const embed = query.has('embed');
const exampleParam = query.get('example');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (embed) document.body.classList.add('embed');

let jobSeq = 0;
const newJobId = () => `job-${Date.now().toString(36)}-${(jobSeq++).toString(36)}`;
const jobsSnapshot = () => JSON.stringify(state.jobs.map((j) => [j.name, j.source]));
const isEdited = () => state.source !== state.pristine || jobsSnapshot() !== state.pristineJobs;
const readJobs = (list) => (Array.isArray(list) ? list : []).filter((j) => j && typeof j.name === 'string').map((j) => ({ id: j.id || newJobId(), name: j.name, source: String(j.source ?? '') }));

// ------------------------------------------------------------------ persistence

function save() {
  if (embed) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      source: state.source, jobs: state.jobs, exampleId: state.exampleId, pristine: state.pristine, pristineJobs: state.pristineJobs,
      file: state.file, contexts: state.contexts, activeCtx: state.activeCtx, tab: state.tab, autorun: state.autorun,
    }));
  } catch { /* storage unavailable */ }
}

function loadStored() {
  if (embed) return null;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function compress(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decompress(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

// ------------------------------------------------------------------ files

const fileAnalysis = (file) => (file === 'main' ? analysis : jobAnalyses.get(file) || null);
const openAnalysis = () => fileAnalysis(state.file);
const openSource = () => (state.file === 'main' ? state.source : state.jobs.find((j) => j.id === state.file)?.source ?? '');
const fileName = (file) => (file === 'main' ? 'Jenkinsfile' : state.jobs.find((j) => j.id === file)?.name || 'job');

function setOpenSource(v) {
  if (state.file === 'main') state.source = v;
  else {
    const j = state.jobs.find((x) => x.id === state.file);
    if (j) j.source = v;
  }
}

/** Open another file in the editor. Flushes an edit still waiting in the debounce. */
function setFile(file) {
  if (file !== 'main' && !state.jobs.some((j) => j.id === file)) file = 'main';
  if (timer) { clearTimeout(timer); timer = null; save(); reanalyze(); markDirty(); }
  if (state.file === file) return;
  state.file = file;
  editor.setValue(openSource());
  save();
}

const JOB_TEMPLATE = `pipeline {
    agent any

    parameters {
        string(name: 'VERSION', defaultValue: '', description: 'Passed by the upstream build')
    }

    stages {
        stage('Run') {
            steps {
                echo "Started with VERSION=\${params.VERSION}"
            }
        }
    }
}
`;

function addJob(suggested) {
  const name = (suggested ?? prompt('Job name, as build job: refers to it (for example deploy-staging or tools/deploy):', 'deploy-staging'))?.trim().replace(/^\/+|\/+$/g, '');
  if (!name) return;
  if (state.jobs.some((j) => j.name === name)) { toast(`There is already a job "${name}"`); return; }
  const job = { id: newJobId(), name, source: JOB_TEMPLATE };
  state.jobs.push(job);
  setFile(job.id);
  reanalyze();
  save();
  markDirty();
  toast(`Added job "${name}". Run again to simulate it when it is started.`);
}

function renameJob(id) {
  const j = state.jobs.find((x) => x.id === id);
  if (!j) return;
  const name = prompt('Rename job:', j.name)?.trim().replace(/^\/+|\/+$/g, '');
  if (!name || name === j.name) return;
  if (state.jobs.some((x) => x.name === name)) { toast(`There is already a job "${name}"`); return; }
  j.name = name;
  save();
  markDirty();
}

function deleteJob(id) {
  const j = state.jobs.find((x) => x.id === id);
  if (!j || !confirm(`Delete the job "${j.name}" and its Jenkinsfile?`)) return;
  state.jobs = state.jobs.filter((x) => x.id !== id);
  jobAnalyses.delete(id);
  if (state.file === id) { state.file = 'main'; editor.setValue(state.source); }
  save();
  markDirty();
}

// ------------------------------------------------------------------ analysis & runs

/** Live syntax and structure checks. Does not run anything. */
function reanalyze() {
  engineError = null;
  try {
    analysis = analyze(state.source);
    const keep = new Set();
    for (const j of state.jobs) {
      keep.add(j.id);
      const prev = jobAnalyses.get(j.id);
      if (!prev || prev.text !== j.source) jobAnalyses.set(j.id, analyze(j.source));
    }
    for (const id of [...jobAnalyses.keys()]) if (!keep.has(id)) jobAnalyses.delete(id);
  } catch (e) {
    console.error(e);
    analysis = null;
    engineError = e;
  }
}

const valid = (an) => !!(an && an.ok && !an.diagnostics.some((d) => d.severity === 'error'));
/** The main Jenkinsfile is the one every context builds: it must be valid to run. */
const isValid = () => valid(analysis);

/** The source changed: re-check it now; run again only with Auto-run on. */
function sourceChanged() {
  reanalyze();
  markDirty();
}

/** The contexts changed: the last results no longer describe them. */
function contextsChanged() {
  save();
  if (!analysis) reanalyze();
  markDirty();
}

function markDirty() {
  stopAnim();
  dirty = true;
  if (state.autorun && isValid()) runAll({ animate: false });
  else render();
}

/** Simulate every context (and the builds they start), then play the active one back. */
function runAll({ animate = true } = {}) {
  stopAnim();
  if (timer) {
    // an edit is still inside the debounce window: check that text, not the previous one
    clearTimeout(timer);
    timer = null;
    save();
    reanalyze();
  }
  if (!analysis) reanalyze();
  if (!isValid()) {
    render();
    toast(analysis && !analysis.ok ? 'Fix the syntax error in the Jenkinsfile first: it does not compile' : 'Fix the errors in the Jenkinsfile first: Jenkins would reject it');
    return;
  }
  const jobs = state.jobs.map((j) => ({ id: j.id, name: j.name, analysis: jobAnalyses.get(j.id) }));
  const runs = new Map();
  for (const ctx of state.contexts) {
    try {
      const resolveJob = makeJobResolver({ project: normalizeContext(ctx).job, main: analysis, jobs });
      const r = simulate(analysis, ctx, { resolveJob });
      r.file = 'main';
      runs.set(ctx.id, r);
    } catch (e) {
      console.error(e);
      runs.set(ctx.id, { crash: e });
    }
  }
  ran = { analysis, analyses: new Map([['main', analysis], ...jobAnalyses]), runs };
  dirty = false;
  syncView();
  if (animate && !reducedMotion) startAnim();
  else render();
}

const activeCtx = () => state.contexts.find((c) => c.id === state.activeCtx) || state.contexts[0] || null;
/** Results that match the current Jenkinsfiles and contexts (null when stale). */
const results = () => (ran && !dirty ? ran.runs : null);
const activeRun = () => {
  const c = activeCtx();
  const r = c ? results()?.get(c.id) : null;
  return r && !r.crash ? r : null;
};
/** The last run of the active context, even when stale (for the log and the matrix). */
const lastRun = () => {
  const c = activeCtx();
  const r = c ? ran?.runs.get(c.id) : null;
  return r && !r.crash ? r : null;
};
const runFile = (run) => run?.file || 'main';
const runAnalysis = (run) => ran?.analyses.get(runFile(run)) || analysis;
/** The build of the chain in focus. */
const viewRun = () => runAt(activeRun(), state.view) || activeRun();

/** Drop a focus that no longer exists, e.g. after switching to a context that started fewer builds. */
function syncView() {
  const root = activeRun();
  if (!root || !state.view) return;
  const r = runAt(root, state.view);
  if (!r || (state.viewJob && r.job !== state.viewJob)) { state.view = ''; state.viewJob = null; state.selected = null; }
}

/** The run whose coverage the editor shows: the build in focus, or the first one of the open file. */
function covRun() {
  const root = activeRun();
  if (!root) return null;
  const vr = viewRun();
  if (runFile(vr) === state.file) return vr;
  return chainRuns(root).find((x) => runFile(x.run) === state.file)?.run || null;
}

/** Put a build of the chain in focus and open its Jenkinsfile. */
function focusRun(path, selected = null) {
  state.view = path;
  state.selected = selected;
  const r = runAt(activeRun(), path);
  state.viewJob = path && r ? r.job : null;
  if (r) setFile(runFile(r));
}

// ------------------------------------------------------------------ playback

function startAnim() {
  const r = activeRun();
  if (!r) { render(); return; }
  const chain = chainRuns(r);
  const stages = chain.reduce((n, { run }) => n + flattenView(runAnalysis(run).viewTree).length, 0);
  anim = {
    ctxId: activeCtx().id, t: 0, total: chainTotal(r),
    wall: Math.min(chain.length > 1 ? 9500 : 6500, Math.max(2600, 1500 + stages * 260)), t0: performance.now(), raf: 0, sig: '',
  };
  document.body.classList.add('running');
  render();
  const tick = (now) => {
    if (!anim) return;
    const p = Math.min(1, (now - anim.t0) / anim.wall);
    // ease-in-out so the first and last stages are easy to follow
    const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
    anim.t = e * anim.total;
    $('#run-progress i').style.width = `${(p * 100).toFixed(1)}%`;
    const sig = chain.map(({ run }) => {
      const t = anim.t - run.offset;
      const stubs = run.downstream.filter((d) => !d.run).map(stubStatus).join();
      return `${t < 0 ? 'q' : t < run.duration ? 'r' : 'd'}:${Object.values(run.stages).map((s) => timedStatus(s, t, run.duration)).join()}:${stubs}`;
    }).join('|');
    if (sig !== anim.sig) {
      anim.sig = sig;
      if (state.tab === 'pipeline') { renderPipeline(); followRunning(chain); }
    }
    renderSummary();
    if (state.tab === 'log') renderLog();
    if (p >= 1) { finishAnim(); return; }
    anim.raf = requestAnimationFrame(tick);
  };
  anim.raf = requestAnimationFrame(tick);
}

/** Keep the build that is running in view while the chain plays back. */
function followRunning(chain) {
  let last = null;
  for (const { run, path } of chain) {
    const t = anim.t - run.offset;
    if (t >= 0 && t < run.duration) last = path;
  }
  if (last == null || last === '') return;
  const block = $(`#graph .run-block[data-path="${CSS.escape(last)}"]`);
  const g = $('#graph');
  if (block && (block.offsetTop < g.scrollTop || block.offsetTop + 60 > g.scrollTop + g.clientHeight)) g.scrollTo({ top: block.offsetTop - 8, behavior: 'smooth' });
}

function finishAnim() {
  stopAnim();
  celebrate = true;
  render();
  celebrate = false;
}

function stopAnim() {
  if (anim) cancelAnimationFrame(anim.raf);
  anim = null;
  document.body.classList.remove('running');
  const bar = $('#run-progress i');
  if (bar) bar.style.width = '0';
}

function indexTree(tree) {
  const map = new Map();
  const walk = (t, parent, depth) => {
    if (!t) return;
    for (const it of t.items) {
      const list = it.kind === 'par' ? it.items : [it];
      for (const n of list) {
        map.set(n.id, { node: n, parent, depth, par: it.kind === 'par' ? it : null });
        walk(n.children, n, depth + 1);
      }
    }
  };
  walk(tree, null, 0);
  return map;
}

// ------------------------------------------------------------------ rendering

function render() {
  syncView();
  renderFiles();
  renderHeader();
  renderContexts();
  renderParams();
  renderTabs();
  renderSummary();
  renderProblems();
  renderEditorDeco();
  if (state.tab === 'pipeline') { renderPipeline(); renderDetails(); }
  if (state.tab === 'matrix') renderMatrix();
  if (state.tab === 'log') renderLog();
}

function renderFiles() {
  const el = $('#files');
  const tab = (id, label, sub, removable) => {
    const an = fileAnalysis(id);
    const bad = an && !valid(an);
    return `<span class="file-tab${state.file === id ? ' active' : ''}" role="tab" tabindex="0" aria-selected="${state.file === id}" data-file="${esc(id)}" title="${esc(sub)}">
      ${bad ? '<i class="file-bad" aria-label="has errors"></i>' : ''}<span class="fn">${esc(label)}</span>${removable ? `<button class="file-x" type="button" data-rm-job="${esc(id)}" aria-label="Delete ${esc(label)}" title="Delete this job">×</button>` : ''}</span>`;
  };
  const project = normalizeContext(activeCtx() || {}).job;
  el.innerHTML = tab('main', 'Jenkinsfile', `The pipeline every context builds: the multibranch project "${project}". build job: "${project}/<branch>" starts another branch of it.`, false)
    + state.jobs.map((j) => tab(j.id, j.name, `Pipeline job "${j.name}": started by build job: '${j.name}'. Double-click to rename.`, true)).join('')
    + '<button class="file-add" type="button" data-add-job title="Add a pipeline job that build job: can start">+ Job</button>';
}

function renderHeader() {
  const mode = $('#mode');
  const val = $('#validity');
  const A = openAnalysis();
  if (!A) {
    mode.textContent = '—';
    val.textContent = engineError ? 'Simulator error' : '';
    val.className = 'validity bad';
    return;
  }
  mode.textContent = A.mode ? `${A.mode} pipeline` : 'syntax error';
  const errs = A.diagnostics.filter((d) => d.severity === 'error').length;
  if (!A.ok) { val.textContent = 'Groovy syntax error: the file does not compile'; val.className = 'validity bad'; }
  else if (errs) { val.textContent = `${errs} error${errs === 1 ? '' : 's'}: Jenkins would reject this file`; val.className = 'validity bad'; }
  else { val.textContent = '✓ Valid: Jenkins would accept this file'; val.className = 'validity ok'; }
}

function renderContexts() {
  const el = $('#contexts');
  const runBtn = $('#run');
  runBtn.classList.toggle('pending', dirty && isValid() && !state.autorun);
  runBtn.classList.toggle('running', !!anim);
  runBtn.querySelector('.lbl').textContent = anim ? 'Running…' : ran && !dirty ? 'Run again' : 'Run';
  $('#autorun').checked = state.autorun;
  el.innerHTML = state.contexts.map((c) => {
    const r = results()?.get(c.id);
    const res = anim ? 'NONE' : !r ? (ran ? 'STALE' : 'NONE') : r.crash ? 'ERROR' : r.result;
    const active = c.id === activeCtx()?.id;
    const ds = r && !r.crash && !anim ? chainRuns(r).slice(1).map(({ run }) => `${run.display} → ${run.result}`) : [];
    const title = `${c.name}${r && !anim ? ` → ${res}` : res === 'STALE' ? ' (not run since your last change)' : ''}${ds.length ? `\nstarted: ${ds.join(', ')}` : ''}`;
    return `<span class="chip-btn${active ? ' active' : ''}" role="tab" tabindex="0" aria-selected="${active}" data-id="${esc(c.id)}" title="${esc(title)}">
      <span class="dot ${esc(res)}"></span><span class="nm">${esc(c.name)}</span>${ds.length ? `<span class="ds-count" aria-label="${ds.length} downstream">+${ds.length}</span>` : ''}
      <button class="edit" type="button" data-edit="${esc(c.id)}" title="Edit context" aria-label="Edit ${esc(c.name)}">✎</button></span>`;
  }).join('');
}

/** "Build with Parameters": the parameters of the main Jenkinsfile, for the active context. */
function renderParams() {
  const el = $('#params');
  const defs = analysis?.model?.params || [];
  const c = activeCtx();
  if (!defs.length || !c) { el.hidden = true; el.innerHTML = ''; return; }
  // do not rebuild while the user is typing in it
  const typing = el.contains(document.activeElement) && document.activeElement.matches('input[type="text"], input[type="password"]');
  if (typing && el.dataset.ctx === c.id && el.dataset.sig === sigOf(defs)) {
    for (const p of defs) el.querySelector(`[data-param="${CSS.escape(p.name)}"]`)?.classList.toggle('set', has(c.params, p.name) && String(c.params[p.name]) !== String(p.default));
    return;
  }
  el.hidden = false;
  el.dataset.ctx = c.id;
  el.dataset.sig = sigOf(defs);
  const field = (p) => {
    const set = has(c.params, p.name) && String(c.params[p.name]) !== String(p.default);
    const v = has(c.params, p.name) ? c.params[p.name] : p.default;
    const id = `param-${p.name}`;
    const title = `${p.description ? `${p.description}\n` : ''}${p.type}, default ${JSON.stringify(p.default)}`;
    let input;
    if (p.type === 'booleanParam') input = `<input type="checkbox" id="${esc(id)}" data-pv="${esc(p.name)}" ${v === true || v === 'true' ? 'checked' : ''}>`;
    else if (p.type === 'choice' && !p.dynamicChoices) input = `<select id="${esc(id)}" data-pv="${esc(p.name)}">${p.choices.map((ch) => `<option${String(v) === ch ? ' selected' : ''}>${esc(ch)}</option>`).join('')}</select>`;
    else if (['string', 'text', 'password', 'choice'].includes(p.type)) input = `<input type="${p.type === 'password' ? 'password' : 'text'}" id="${esc(id)}" data-pv="${esc(p.name)}" value="${esc(v)}" spellcheck="false" autocomplete="off">`;
    else input = `<span class="muted">${esc(p.type)}: not simulated</span>`;
    return `<div class="pf${set ? ' set' : ''}${p.type === 'booleanParam' ? ' bool' : ''}" data-param="${esc(p.name)}" title="${esc(title)}">
      <label for="${esc(id)}">${esc(p.name)}</label>${input}<button type="button" class="pf-reset" data-reset="${esc(p.name)}" title="Back to the default (${esc(JSON.stringify(p.default))})" aria-label="Reset ${esc(p.name)}">↺</button></div>`;
  };
  const manual = c.cause === 'user' || c.cause === 'upstream';
  el.innerHTML = `<span class="params-label" title="The parameters block of the Jenkinsfile. Values apply to the selected context.">Parameters</span>
    <div class="pfs">${defs.map(field).join('')}</div>
    ${manual ? '' : '<span class="params-note" title="Jenkins starts branch, PR and timer builds with the default values. Changing a value here turns this context into a manual build (Build with Parameters).">defaults · changing one makes this a manual build</span>'}`;
}
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const sigOf = (defs) => defs.map((p) => `${p.name}:${p.type}:${p.default}:${(p.choices || []).join(',')}`).join('|');

function setParam(name, value) {
  const c = activeCtx();
  const def = analysis?.model?.params.find((p) => p.name === name);
  if (!c || !def) return;
  const params = { ...c.params };
  if (value === null || String(value) === String(def.default)) delete params[name];
  else params[name] = value;
  c.params = params;
  if (has(params, name) && c.cause !== 'user' && c.cause !== 'upstream') {
    c.cause = 'user';
    toast(`“${c.name}” is now a manual build (Build with Parameters): Jenkins starts push, PR and timer builds with the defaults`);
  }
  contextsChanged();
}

function renderTabs() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${state.tab}`));
}

function renderSummary() {
  const el = $('#run-summary');
  const c = activeCtx();
  if (anim) {
    const clock = el.querySelector('[data-clock]');
    const text = `${fmtDur(anim.t)} / ${fmtDur(anim.total)}`;
    if (clock && el.dataset.anim === String(anim.t0)) { clock.textContent = text; return; }
    el.dataset.anim = String(anim.t0);
    el.innerHTML = `<span>Running “${esc(c?.name)}” · <span data-clock>${esc(text)}</span></span><button class="skip-anim" type="button" data-skip>Skip ⏭</button>`;
    el.querySelector('[data-skip]').onclick = finishAnim;
    return;
  }
  el.dataset.anim = '';
  if (isValid() && dirty) {
    el.innerHTML = `<span class="stale-note">${ran ? 'Changed since the last run' : 'Not run yet'}</span>`;
    return;
  }
  const r = c ? results()?.get(c.id) : null;
  if (!isValid() || !r) { el.innerHTML = ''; return; }
  if (r.crash) { el.innerHTML = `<span class="badge FAILURE">SIMULATOR ERROR</span>`; return; }
  const n = r.steps.length;
  const ds = chainRuns(r).length - 1;
  el.innerHTML = `<span>${esc(fmtDur(r.duration))} simulated · ${n} step${n === 1 ? '' : 's'}${ds ? ` · <span title="Builds started with build job:">+${ds} build${ds === 1 ? '' : 's'}</span>` : ''}</span><span class="badge ${r.result}">${r.result}</span>`;
}

function allProblems() {
  const A = openAnalysis();
  if (!A) return [];
  const list = A.diagnostics.map((d) => ({ ...d }));
  const root = activeRun();
  if (root) {
    const seen = new Set();
    for (const { run } of chainRuns(root)) {
      if (runFile(run) !== state.file) continue;
      for (const w of run.warnings) {
        const key = `${w.message}@${w.s}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ ...w, runtime: true, runName: run.display });
      }
    }
    const r = covRun();
    if (r?.firstError && r.firstError.s != null) {
      list.push({ severity: 'error', message: `${r.firstError.cls?.split('.').pop() || 'Error'}: ${r.firstError.message}`, s: r.firstError.s, e: r.firstError.e, hint: r.firstError.hint, runtime: true, failure: true, runName: r.display });
    }
  }
  const rank = { error: 0, warning: 1, info: 2 };
  return list.sort((a, b) => (a.runtime === b.runtime ? 0 : a.runtime ? 1 : -1) || rank[a.severity] - rank[b.severity] || a.s - b.s);
}

function renderProblems() {
  const el = $('#problems');
  const count = $('#problem-count');
  if (engineError) {
    el.innerHTML = `<li><span class="sev error">✕</span><span>Simulator error: ${esc(engineError.message)}</span></li>`;
    count.textContent = '';
    railBadge(1, 0);
    return;
  }
  const A = openAnalysis();
  const list = allProblems();
  const errs = list.filter((d) => d.severity === 'error').length;
  const warns = list.filter((d) => d.severity === 'warning').length;
  count.textContent = list.length ? `${errs} error${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}, ${list.length - errs - warns} info` : '';
  railBadge(errs, warns);
  if (!list.length) {
    el.innerHTML = '<li class="empty">No problems found.</li>';
    return;
  }
  el.innerHTML = list.map((d, i) => {
    const { line, col } = A.lines.lc(d.s);
    const icon = d.severity === 'error' ? '✕' : d.severity === 'warning' ? '!' : 'i';
    const rt = d.runtime ? `<span class="rt" title="Found while simulating ${esc(d.runName || 'the build')} for “${esc(activeCtx()?.name)}”">run</span>` : '';
    return `<li data-i="${i}" title="${esc(d.message)}"><span class="sev ${d.severity}">${icon}</span>
      <span>${rt}${esc(d.message)}${d.hint ? `<span class="hint">${esc(d.hint)}</span>` : ''}</span>
      <span class="where">${line}:${col}</span></li>`;
  }).join('');
  el.querySelectorAll('li[data-i]').forEach((li) => li.addEventListener('click', () => {
    const d = list[Number(li.dataset.i)];
    editor.reveal(d.s, d.e);
  }));
}

function renderEditorDeco() {
  const A = openAnalysis();
  if (!A) { editor.setDecorations({ diagnostics: [], lineInfo: new Map(), range: null }); return; }
  const diags = allProblems();
  const lineInfo = new Map();
  const get = (l) => { if (!lineInfo.has(l)) lineInfo.set(l, {}); return lineInfo.get(l); };
  const rankOf = { error: 3, warning: 2, info: 1 };
  for (const d of diags) {
    if (d.severity === 'info') continue;
    const l = A.lines.line(d.s);
    const info = get(l);
    if (!info.diag || rankOf[d.severity] > rankOf[info.diag]) { info.diag = d.severity; info.title = d.message; }
  }
  const r = anim ? null : covRun();
  if (r && A.model && !r.invalid) {
    const who = `${r.depth ? r.display : `“${activeCtx().name}”`}`;
    for (const s of A.model.codeStarts) {
      const l = A.lines.line(s);
      const info = get(l);
      const hit = r.hits.has(s);
      if (hit) { info.cov = 'hit'; info.covTitle = `Executed ${r.hits.get(s)}× in ${who}`; }
      else if (info.cov !== 'hit') { info.cov = 'miss'; info.covTitle = `Not executed in ${who}`; }
    }
    for (const { node } of flattenView(A.viewTree)) {
      if (node.cell || node.dynamic) continue;
      const sr = r.stages[node.id];
      if (!sr) continue;
      const l = A.lines.line(node.s);
      const info = get(l);
      info.stage = ST_COLOR[sr.status] || 'transparent';
      info.stageTitle = `${node.name}: ${sr.status}${sr.reason ? ` (${sr.reason})` : ''}`;
    }
  }
  let range = null;
  const vr = viewRun();
  if (state.selected && A.viewTree && (!vr || runFile(vr) === state.file)) {
    const idx = indexTree(A.viewTree).get(state.selected);
    if (idx && !idx.node.cell) range = { s: idx.node.s, e: idx.node.e };
  }
  editor.setDecorations({ diagnostics: diags, lineInfo, range });
}

function renderPipeline() {
  const el = $('#graph');
  if (engineError) { el.innerHTML = `<div class="graph-empty"><strong>Simulator error.</strong> ${esc(engineError.message)}</div>`; return; }
  if (!analysis) return;
  const stale = $('#stale');
  const showStale = isValid() && dirty;
  stale.hidden = !showStale;
  if (showStale) {
    stale.innerHTML = `<span>${ran ? 'A Jenkinsfile or the contexts changed since the last run.' : 'Nothing has run yet.'} The stages below are not simulated.</span>
      <button class="link-btn" type="button" data-run>Run now (⌘↵)</button>`;
    stale.querySelector('[data-run]').onclick = () => runAll();
  }
  const crash = results()?.get(activeCtx()?.id)?.crash;
  if (crash) { el.innerHTML = `<div class="graph-empty"><strong>The simulator crashed on this context.</strong> ${esc(crash.message)}</div>`; return; }
  const root = activeRun();
  el.classList.toggle('chain', !!root && root.downstream.length > 0);
  if (!root) {
    // not simulated: the stages of the file being edited
    const A = state.file === 'main' || !openAnalysis() ? analysis : openAnalysis();
    el.innerHTML = '<div class="run-graph"></div>';
    renderGraph(el.firstChild, A.viewTree, null, { selected: state.selected, onSelect: (id) => selectStage(id, state.view), contextName: activeCtx()?.name, invalid: !valid(A) });
    return;
  }
  const chain = chainRuns(root);
  const scroll = el.scrollTop;
  const blocks = [];
  for (const item of chain) {
    blocks.push({ kind: 'run', ...item });
    // builds that were mocked (no Jenkinsfile in the workspace) get a stub after their parent
    item.run.downstream.forEach((d, i) => {
      if (!d.run) blocks.push({ kind: 'stub', d, depth: item.depth + 1, path: item.path ? `${item.path}.${i}` : String(i), parent: item.run });
    });
  }
  // keep stubs right after the builds started before them: order by path
  blocks.sort((a, b) => cmpPath(a.path, b.path));
  el.innerHTML = blocks.map((b) => (b.kind === 'run' ? runBlockHead(b, chain.length > 1) : stubBlock(b))).join('');
  for (const b of blocks) {
    if (b.kind !== 'run') continue;
    const box = el.querySelector(`.run-block[data-path="${CSS.escape(b.path)}"] .run-graph`);
    const A = runAnalysis(b.run);
    const t = anim ? anim.t - b.run.offset : null;
    renderGraph(box, b.run.invalid ? null : A.viewTree, b.run, {
      selected: state.view === b.path ? state.selected : null,
      onSelect: (id) => selectStage(id, b.path),
      contextName: b.depth ? 'upstream' : activeCtx()?.name,
      invalid: !!b.run.invalid,
      post: b.run.postRuns?.length ? b.run.postRuns : null,
      time: anim ? Math.max(t, -0.001) : null,
      total: anim ? Math.max(b.run.duration, 1) : null,
      celebrate: celebrate && b.depth === 0,
    });
  }
  el.scrollTop = scroll;
  el.querySelectorAll('[data-focus]').forEach((x) => x.addEventListener('click', () => { stopAnim(); focusRun(x.dataset.focus); render(); }));
  el.querySelectorAll('[data-add-job]').forEach((x) => x.addEventListener('click', () => addJob(x.dataset.addJob)));
}

const cmpPath = (a, b) => {
  const pa = a ? a.split('.').map(Number) : [];
  const pb = b ? b.split('.').map(Number) : [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return pa.length - pb.length;
};

function stageName(run, id) {
  if (!id) return null;
  return run?.stages[id]?.name || id;
}

function runBlockHead({ run, path, depth, parent, via }, showHead) {
  const focus = state.view === path;
  let status = run.result;
  let when = '';
  if (anim) {
    const t = anim.t - run.offset;
    status = t < 0 ? 'QUEUED' : t < run.duration ? 'RUNNING' : run.result;
  }
  if (via) {
    const from = stageName(parent, via.stage);
    when = `started by ${from ? `stage “${esc(from)}” of ` : ''}${esc(parent.display)} #${parent.number}${via.wait ? '' : ' · <b>wait: false</b>'}${via.params.length ? ` · <span class="mono">${esc(via.params.join(', '))}</span>` : ''}`;
  }
  const head = showHead ? `<header class="run-head" style="--depth:${depth}">
      ${depth ? '<span class="ds-arrow" aria-hidden="true">↳</span>' : ''}
      <button class="run-title" type="button" data-focus="${esc(path)}" title="Show this build's steps, log and parameters">${esc(run.display)} <span class="muted">#${run.number}</span></button>
      <span class="badge ${esc(status)}">${esc(status)}</span>
      ${run.depth ? `<span class="run-file" title="Runs this Jenkinsfile">${esc(fileName(runFile(run)))}</span>` : ''}
      ${when ? `<span class="run-via">${when}</span>` : ''}</header>` : '';
  return `<section class="run-block${focus && showHead ? ' focus' : ''}${depth ? ' ds' : ''}" data-path="${esc(path)}" style="--depth:${depth}">${head}<div class="run-graph"></div></section>`;
}

function stubStatus(d) {
  if (!anim) return d.result;
  if (anim.t < d.offset) return 'QUEUED';
  return anim.t < d.offset + (d.duration || 0) ? 'RUNNING' : d.result;
}

function stubBlock({ d, depth, parent }) {
  const why = d.result === 'NOT_BUILT' ? `not started: ${esc(d.error || 'rejected')}` : `mocked: ${esc(MOCKED_WHY[d.mockedBy] || MOCKED_WHY.missing)}`;
  const canAdd = d.mockedBy === 'missing' && !/^\.\.?\/|\/\.\.?\//.test(d.job) && !state.jobs.some((j) => j.name === d.job.replace(/^\/+/, ''));
  const from = stageName(parent, d.stage);
  return `<section class="run-block stub" style="--depth:${depth}"><header class="run-head" style="--depth:${depth}">
      <span class="ds-arrow" aria-hidden="true">↳</span><span class="run-title static">${esc(d.display)}</span>
      <span class="badge ${esc(stubStatus(d))}">${esc(stubStatus(d))}</span>
      <span class="run-via">${from ? `from stage “${esc(from)}” · ` : ''}${why}</span>
      ${canAdd ? `<button class="btn small" type="button" data-add-job="${esc(d.job.replace(/^\/+/, ''))}">Add job “${esc(d.job.replace(/^\/+/, ''))}”</button>` : ''}
    </header></section>`;
}

function selectStage(id, path = '') {
  if (state.view !== path) focusRun(path, id);
  else {
    state.selected = state.selected === id ? null : id;
    // the graph shows the build's own Jenkinsfile: open it before revealing a stage in it
    const r = activeRun() ? runAt(activeRun(), path) || activeRun() : null;
    if (r) setFile(runFile(r));
  }
  render();
  if (state.selected) {
    const A = activeRun() ? runAnalysis(viewRun()) : openAnalysis();
    const idx = A?.viewTree ? indexTree(A.viewTree).get(state.selected) : null;
    if (idx && !idx.node.cell) editor.reveal(idx.node.s, idx.node.s, { select: false });
  }
}

function condTree(list) {
  return `<ul class="cond-tree">${list.map((n) => {
    const v = n.value === true ? '<span class="v t">✓</span>' : n.value === false ? '<span class="v f">✕</span>' : '<span class="v n">·</span>';
    return `<li>${v} <code>${esc(n.text)}</code>${n.detail ? ` <span class="d">${esc(n.detail)}</span>` : ''}${n.children?.length ? condTree(n.children) : ''}</li>`;
  }).join('')}</ul>`;
}

function stepsTable(steps, A, path) {
  if (!steps.length) return '<p class="muted">No steps ran.</p>';
  const stIcon = { ok: '✓', failed: '✕', warn: '!', 'not-run': '–' };
  return `<table class="steps">${steps.map((s) => {
    const line = A.lines.line(s.s);
    const out = s.output ? String(s.output).split('\n').slice(0, 4).join('\n') : '';
    const ds = s.ds != null && viewRun()?.downstream?.[s.ds];
    const open = ds && ds.run ? ` <button class="link-btn" data-focus="${esc(path ? `${path}.${s.ds}` : String(s.ds))}">open ${esc(ds.run.display)} #${ds.run.number} →</button>` : '';
    return `<tr class="${s.status}"><td class="sst ${s.status}">${stIcon[s.status] || ''}</td>
      <td class="sname"><button class="link-btn mono" data-reveal="${s.s}:${s.e}" title="Line ${line}">${esc(s.name)}</button></td>
      <td class="slabel">${esc(s.label)}${s.mockRule != null ? `<span class="mock" title="Result from mock rule #${s.mockRule + 1}">mock</span>` : ''}${open}${s.caught ? `<div class="out">caught: ${esc(s.caught)}</div>` : ''}${out ? `<div class="out">${esc(out)}</div>` : ''}</td>
      <td class="sdur">${s.dur ? esc(fmtDur(s.dur)) : ''}</td></tr>`;
  }).join('')}</table>`;
}

function renderDetails() {
  const el = $('#details');
  if (!analysis) { el.innerHTML = ''; return; }
  if (!isValid()) {
    el.innerHTML = `<h3>Fix the structure first</h3>
      <p class="reason">Jenkins validates the whole Jenkinsfile before any stage runs, so nothing is simulated while there are errors.
      ${state.file === 'main' ? 'Click a problem on the left to jump to it.' : 'Open the <b>Jenkinsfile</b> tab to see them.'}</p>`;
    return;
  }
  if (anim) {
    el.innerHTML = `<h3>Running “${esc(activeCtx()?.name)}”…</h3>
      <p class="reason">All ${state.contexts.length} contexts were simulated, with every build they start. This one is played back so you can follow it: stages light up as the simulated clock reaches them, and a started build begins when its <code>build</code> step runs.
      Press <b>Skip</b> or <kbd>Esc</kbd> to jump to the result.</p>`;
    return;
  }
  if (dirty) {
    el.innerHTML = `<h3>${ran ? 'Changed since the last run' : 'Ready to run'}</h3>
      <p class="reason">Syntax and structure are checked as you type. Press <b>Run</b> (<kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd>) to simulate every context, or switch on <b>Auto-run</b> to run after each change.</p>
      ${overview(null, analysis, '')}`;
    bindDetails(el, 'main');
    return;
  }
  const r = viewRun();
  const A = runAnalysis(r);
  const path = runAt(activeRun(), state.view) ? state.view : '';
  const idx = A?.viewTree && !r?.invalid ? indexTree(A.viewTree) : new Map();
  const entry = state.selected ? idx.get(state.selected) : null;
  if (!entry || !r) { el.innerHTML = overview(r, A, path); bindDetails(el, runFile(r)); return; }
  const n = entry.node;
  const sr = r.stages[n.id] || { status: 'pending', steps: [], post: [], phases: [] };
  // conditions on the path from the root
  const chain = [];
  for (let e = entry; e; e = e.parent ? idx.get(e.parent.id) : null) chain.unshift(e.node);
  let conds = '';
  if (A.mode === 'declarative') {
    const lines = chain.filter((c) => c.when).map((c) => `<li>${c === n ? '' : `parent <b>${esc(c.name)}</b>: `}<code>${esc(c.when)}</code></li>`);
    lines.push('<li>no earlier stage threw an error <span class="muted">(otherwise: “skipped due to earlier failure(s)”)</span></li>');
    if (entry.par?.failFast) lines.push('<li>no sibling branch failed first <span class="muted">(failFast)</span></li>');
    conds = `<ul class="help">${lines.join('')}</ul>`;
  } else {
    const all = chain.flatMap((c) => c.conds || []);
    conds = all.length
      ? `<ul class="help">${all.map((c) => `<li>${c.kind === 'if' ? `<code>if (${esc(c.src)})</code> is ${c.branch === 'then' ? 'true' : 'false'}` : c.kind === 'loop' ? `once per iteration of <code>${esc(c.src)}</code>` : c.kind === 'call' ? `when <code>${esc(c.src)}</code> is called` : esc(c.src)}</li>`).join('')}<li>no earlier error stopped the script</li></ul>`
      : '<ul class="help"><li>always, unless an earlier error stopped the script</li></ul>';
  }
  const phases = sr.phases?.length
    ? `<h4>Evaluation order</h4><div class="phases">${sr.phases.map((p) => `<span class="phase${p.ok === false ? ' bad' : ''}${p.name === 'when' ? ' when' : ''}" title="${esc(p.detail || '')}">${esc(p.name)}${p.detail && p.name !== 'when' ? `: ${esc(p.detail)}` : ''}</span>`).join('<span class="arrow">→</span>')}<span class="arrow">→</span><span class="phase">${sr.status === 'skipped' ? 'skip' : 'steps'}</span></div>`
    : '';
  const post = sr.post?.length
    ? `<h4>post</h4><ul class="post-list">${sr.post.map((p) => `<li>${p.ran ? '✓' : '·'} <code>${esc(p.cond)}</code> <span class="muted">${p.ran ? 'ran' : 'did not run'} — ${esc(p.why)}</span>${p.error ? ` <span style="color:var(--fail)">${esc(p.error)}</span>` : ''}</li>`).join('')}</ul>`
    : '';
  const names = sr.names && sr.names.length > 1 ? `<p class="muted">Ran ${sr.instances}×: ${sr.names.map((x) => `<code>${esc(x)}</code>`).join(', ')}</p>` : '';
  const where = r.depth ? `<p class="muted in-build">In ${esc(r.display)} #${r.number} · <button class="link-btn" data-focus="${esc(path)}">build overview</button></p>` : '';
  const ctxLabel = r.depth ? `${r.display} #${r.number}` : activeCtx().name;
  el.innerHTML = `
    <h3>${esc(n.name)} <span class="st-badge ${sr.status}">${esc(sr.status)}</span>
      ${n.cell ? '' : `<button class="link-btn" data-reveal="${n.s}:${n.head ? n.head.e : n.s + 5}">show in editor</button>`}</h3>
    ${where}
    ${sr.reason ? `<p class="reason ${sr.status === 'failure' ? 'failure' : ''}">${esc(sr.reason)}${sr.error?.s != null ? ` <button class="link-btn" data-reveal="${sr.error.s}:${sr.error.e}">line ${A.lines.line(sr.error.s)}</button>` : ''}</p>` : ''}
    ${names}
    <h4>Runs when</h4>${conds}
    ${sr.when ? `<h4>when, in “${esc(ctxLabel)}”</h4>${condTree(sr.when.tree)}` : ''}
    ${phases}
    ${sr.agent ? `<h4>Agent</h4><p class="mono">${esc(sr.agent)}</p>` : ''}
    <h4>Steps${sr.steps.length ? ` (${sr.steps.length})` : ''}</h4>${sr.status === 'skipped' || sr.status === 'not-run' ? '<p class="muted">Nothing ran in this stage.</p>' : stepsTable(sr.steps, A, path)}
    ${post}`;
  bindDetails(el, runFile(r));
}

function overview(r, A, path) {
  // a Jenkinsfile that does not compile has no model
  const m = A?.model || { params: [], triggers: [], pipeline: null };
  const ctx = activeCtx();
  const P = m.pipeline;
  const trig = m.triggers.map((t) => `<li><code>${esc(t.src || t.type)}</code>${t.dynamic ? ' <span class="muted">(schedule computed at runtime)</span>' : ''}</li>`).join('');
  const passed = r?.depth ? new Set(Object.keys(r.context.params || {})) : null;
  const params = m.params.map((p) => {
    const v = r?.params?.[p.name];
    const src = passed ? (passed.has(p.name) ? 'passed by the upstream build' : 'default') : r && has(ctx?.params, p.name) ? 'set for this context' : r ? 'default' : '';
    return `<li><code>${esc(p.name)}</code> <span class="muted">${esc(p.type)}, default ${esc(JSON.stringify(p.default))}</span>${r ? ` → <code>${esc(JSON.stringify(v))}</code> <span class="muted">${src}</span>` : ''}</li>`;
  }).join('');
  const post = r?.postRuns?.length ? `<h4>Pipeline post</h4><ul class="post-list">${r.postRuns.map((p) => `<li>${p.ran ? '✓' : '·'} <code>${esc(p.cond)}</code> <span class="muted">${p.ran ? 'ran' : 'did not run'} — ${esc(p.why)}</span></li>`).join('')}</ul>` : '';
  const ds = r?.downstream?.length ? `<h4>Builds it started</h4><ul class="help">${r.downstream.map((d, i) => {
    const p = path ? `${path}.${i}` : String(i);
    const name = d.run ? `<button class="link-btn" data-focus="${esc(p)}">${esc(d.display)} #${d.run.number}</button>` : `<code>${esc(d.display)}</code>`;
    const note = d.result === 'NOT_BUILT' ? ` — ${esc(d.error || 'not started')}` : d.mocked ? ` — mocked: ${esc(MOCKED_WHY[d.mockedBy] || MOCKED_WHY.missing)}` : d.resolved === 'branch' ? ' — this Jenkinsfile on that branch' : '';
    return `<li>${name} <span class="badge ${esc(d.result)}">${esc(d.result)}</span>${d.wait ? '' : ' <span class="muted">wait: false</span>'}${d.params.length ? ` <span class="muted mono">(${esc(d.params.join(', '))})</span>` : ''}<span class="muted">${note}</span></li>`;
  }).join('')}</ul>` : '';
  const env = r ? ['JOB_NAME', 'BRANCH_NAME', 'CHANGE_ID', 'CHANGE_TARGET', 'CHANGE_BRANCH', 'TAG_NAME', 'BUILD_NUMBER'].filter((k) => r.env[k] != null && (k !== 'JOB_NAME' || r.depth)) : [];
  const title = r?.depth ? `${r.display} #${r.number}` : ctx?.name || 'Run';
  const up = r?.depth ? `<p class="muted in-build">Started by ${esc(r.context.upstream?.job || 'upstream')} #${esc(r.context.upstream?.number)} · <button class="link-btn" data-focus="${esc(path.split('.').slice(0, -1).join('.'))}">← back to it</button></p>` : '';
  return `
    <h3>${esc(title)} ${r ? `<span class="badge ${r.result}">${r.result}</span>` : ''}</h3>
    ${up}
    <p class="reason">${r ? esc(r.causes.map((c) => c.text).join(', ')) : ''}${r?.firstError ? ` · <span style="color:var(--fail)">${esc(r.firstError.message)}</span>` : ''}</p>
    ${r?.invalid ? '<p class="reason failure">Its Jenkinsfile does not compile, so Jenkins fails the build before any stage. Open its tab above the editor to see the errors.</p>' : ''}
    ${r?.depth ? '' : `<h4>How to read this</h4>
    <ul class="help">
      <li>Click a stage to see <b>why</b> it ran or was skipped, the <code>when</code> conditions evaluated for this context, and the steps it ran.</li>
      <li>Switch contexts above, or open <b>Condition matrix</b> to compare every context at once. Set <b>Parameters</b> above for a manual build.</li>
      <li>A <code>build job:</code> step starts another pipeline: a branch of this one (<code>${esc(normalizeContext(ctx || {}).job)}/&lt;branch&gt;</code>) or a job you add with <b>+ Job</b>. It runs below this one.</li>
      <li>Every command is mocked and succeeds. Edit a context (✎) and add a mock rule to make a command fail or return output.</li>
    </ul>`}
    ${env.length ? `<h4>Environment for this run</h4><dl class="kv">${env.map((k) => `<dt>${k}</dt><dd>${esc(r.env[k])}</dd>`).join('')}</dl>` : ''}
    ${P?.agent ? `<h4>Agent</h4><p class="mono">${esc(P.agent.type)}</p>` : ''}
    ${trig ? `<h4>Triggers</h4><ul class="help">${trig}</ul>` : ''}
    ${params ? `<h4>Parameters</h4><ul class="help">${params}</ul>` : ''}
    ${post}${ds}`;
}

function bindDetails(el, file) {
  el.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', () => {
    const [s, e] = b.dataset.reveal.split(':').map(Number);
    if (state.file !== file) { setFile(file); render(); }
    editor.reveal(s, e);
  }));
  el.querySelectorAll('[data-focus]').forEach((b) => b.addEventListener('click', () => { focusRun(b.dataset.focus); render(); }));
}

function renderMatrix() {
  const el = $('#matrix');
  if (!ran) {
    el.innerHTML = `<p class="matrix-intro">${isValid() ? 'Press <b>Run</b> to simulate every context and compare them here.' : 'Fix the errors in the Jenkinsfile, then press Run to compare contexts.'}</p>`;
    return;
  }
  // Show the last run, even when it is stale, with a note.
  const A = ran.analysis;
  const runs = ran.runs;
  const rows = flattenView(A.viewTree);
  const ctxs = state.contexts.filter((c) => runs.has(c.id));
  const cellText = (sr) => {
    if (!sr) return { cls: 'not-run', i: '–', t: '' };
    switch (sr.status) {
      case 'success': return { cls: 'success', i: '✓', t: sr.instances > 1 ? `×${sr.instances}` : sr.end != null ? fmtDur(sr.end - sr.start) : '' };
      case 'failure': return { cls: 'failure', i: '✕', t: 'failed' };
      case 'unstable': return { cls: 'unstable', i: '!', t: 'unstable' };
      case 'aborted': return { cls: 'aborted', i: '■', t: 'aborted' };
      case 'skipped': return { cls: 'skipped', i: '–', t: sr.skip === 'when' ? 'when ✕' : sr.skip === 'failure' ? 'after failure' : sr.skip === 'parent' ? 'parent skipped' : 'skipped' };
      default: return { cls: 'not-run', i: '–', t: 'not reached' };
    }
  };
  // one row per job a context started, in the order they first appear
  const dsRows = [];
  for (const c of ctxs) {
    const r = runs.get(c.id);
    if (!r || r.crash) continue;
    for (const x of startedBuilds(r)) if (!dsRows.some((d) => d.display === x.display)) dsRows.push({ display: x.display, depth: x.depth });
  }
  const cur = activeCtx()?.id;
  el.innerHTML = `
    ${dirty ? '<p class="stale" style="border-radius:6px;margin:0 0 10px">These results are from the last run: a Jenkinsfile or the contexts changed since. Press Run to update them.</p>' : ''}
    <p class="matrix-intro">Each column is one simulated build. Hover a cell for the reason; click it to open that stage in that context.</p>
    <table class="cm">
      <thead><tr><th style="text-align:left">Stage</th>${ctxs.map((c) => {
        const r = runs.get(c.id);
        const res = !r ? '' : r.crash ? 'ERROR' : r.result;
        return `<th class="${c.id === cur ? 'sel' : ''}"><button data-ctx="${esc(c.id)}">${esc(c.name)}<span class="badge ${esc(res)}">${esc(res)}</span></button></th>`;
      }).join('')}</tr></thead>
      <tbody>
        ${rows.map(({ node, depth }) => `<tr><th style="padding-left:${10 + depth * 16}px">${esc(node.name)}${node.when ? `<span class="when" title="${esc(node.when)}">when ${esc(node.when)}</span>` : ''}</th>
          ${ctxs.map((c) => {
            const r = runs.get(c.id);
            const sr = r && !r.crash ? r.stages[node.id] : null;
            const t = cellText(sr);
            return `<td class="${c.id === cur ? 'sel-col' : ''}" data-ctx="${esc(c.id)}" data-stage="${esc(node.id)}" title="${esc(sr?.reason || sr?.status || '')}"><span class="cell ${t.cls}"><span class="i">${t.i}</span><span class="t">${esc(t.t)}</span></span></td>`;
          }).join('')}</tr>`).join('')}
        ${A.model.pipeline?.post ? `<tr><th>post</th>${ctxs.map((c) => {
          const r = runs.get(c.id);
          const ranPost = r && !r.crash ? r.postRuns.filter((p) => p.ran).map((p) => p.cond) : [];
          return `<td class="${c.id === cur ? 'sel-col' : ''}"><span class="cell"><span class="t" title="${esc(ranPost.join(', '))}">${esc(ranPost.join(', ') || '—')}</span></span></td>`;
        }).join('')}</tr>` : ''}
        ${dsRows.length ? `<tr class="cm-sep"><th colspan="${ctxs.length + 1}">Builds started with <code>build job:</code></th></tr>` : ''}
        ${dsRows.map((d) => `<tr class="cm-ds"><th style="padding-left:${10 + (d.depth - 1) * 16}px">↳ ${esc(d.display)}</th>${ctxs.map((c) => {
          const r = runs.get(c.id);
          const hit = r && !r.crash ? startedBuilds(r).find((x) => x.display === d.display) : null;
          if (!hit) return `<td class="${c.id === cur ? 'sel-col' : ''}" title="Not started in this context"><span class="cell not-run"><span class="i">–</span><span class="t">not started</span></span></td>`;
          const res = hit.result;
          const cls = { SUCCESS: 'success', FAILURE: 'failure', UNSTABLE: 'unstable', ABORTED: 'aborted' }[res] || 'not-run';
          const mocked = hit.run ? '' : ` · ${MOCKED_WHY[hit.entry.mockedBy] || 'mocked'}`;
          return `<td class="${c.id === cur ? 'sel-col' : ''}" data-ctx="${esc(c.id)}"${hit.run ? ` data-view="${esc(hit.path)}"` : ''} title="${esc(`${hit.display} #${hit.number}: ${res}${mocked}`)}"><span class="cell ${cls}"><span class="i">${RES_ICON[res] || '–'}</span><span class="t">${esc(res.toLowerCase())}${hit.run ? '' : ' (mock)'}</span></span></td>`;
        }).join('')}</tr>`).join('')}
      </tbody>
    </table>`;
  el.querySelectorAll('[data-ctx]').forEach((x) => x.addEventListener('click', () => {
    stopAnim();
    state.activeCtx = x.dataset.ctx;
    // stage ids and builds come from that run: only follow them while it is current
    if (!dirty && x.dataset.view != null) { state.tab = 'pipeline'; focusRun(x.dataset.view); }
    else if (x.dataset.stage && !dirty) { state.view = ''; state.selected = x.dataset.stage; state.tab = 'pipeline'; setFile('main'); }
    save();
    render();
  }));
}

/** Every build a run started, simulated or mocked, depth first: { display, depth, path, run, entry, result, number }. */
function startedBuilds(root) {
  const out = [];
  for (const item of chainRuns(root)) {
    item.run.downstream.forEach((d, i) => {
      out.push({ display: d.run ? d.run.display : d.display, depth: item.depth + 1, path: item.path ? `${item.path}.${i}` : String(i), run: d.run, entry: d, result: d.result, number: d.run ? d.run.number : d.number });
    });
  }
  return out;
}

function renderLog() {
  const el = $('#log');
  const bar = $('#log-chain');
  const root = lastRun();
  if (!root) {
    bar.hidden = true;
    el.textContent = !isValid() ? 'Nothing ran: Jenkins would reject this Jenkinsfile.' : 'Press Run to see the console log.';
    return;
  }
  const chain = chainRuns(root);
  const path = runAt(root, state.view) ? state.view : '';
  const r = runAt(root, path);
  bar.hidden = chain.length < 2;
  if (chain.length > 1) {
    const sig = chain.map((x) => `${x.path}:${x.run.display}:${anim ? '' : x.run.result}`).join('|') + `#${path}`;
    if (bar.dataset.sig !== sig) {
      bar.dataset.sig = sig;
      bar.innerHTML = `<span class="ctx-label">Build</span>${chain.map((x) => `<button type="button" class="chip-btn${x.path === path ? ' active' : ''}" data-log="${esc(x.path)}" style="margin-left:${x.depth ? 4 : 0}px">
        ${x.depth ? '<span class="muted">↳</span>' : ''}<span class="dot ${anim ? 'NONE' : esc(x.run.result)}"></span><span class="nm">${esc(x.run.display)} #${x.run.number}</span></button>`).join('')}`;
      bar.querySelectorAll('[data-log]').forEach((b) => b.addEventListener('click', () => { focusRun(b.dataset.log); render(); }));
    }
  }
  let inside = null;
  const A = runAnalysis(r);
  if (state.selected && A?.viewTree && !dirty) {
    const idx = indexTree(A.viewTree);
    const ids = new Set([state.selected]);
    for (const [id, e] of idx) {
      for (let p = e.parent; p; p = idx.get(p.id)?.parent) if (p.id === state.selected) ids.add(id);
    }
    inside = ids;
  }
  const upTo = anim && anim.ctxId === activeCtx()?.id ? anim.t - (r.offset || 0) : Infinity;
  const lines = upTo === Infinity ? r.log : r.log.filter((l) => l.t <= upTo && !/^Finished:/.test(l.text));
  const head = (dirty ? '<span class="warn">(from the last run: a Jenkinsfile or the contexts changed since)</span>\n' : '')
    + (upTo < 0 ? `<span class="info">Waiting: ${esc(r.display)} starts when the build step that triggers it runs.</span>` : '');
  el.innerHTML = head + lines.map((l) => {
    const cls = `${l.kind}${inside && l.stage && inside.has(l.stage) ? ' hl' : ''}`;
    return `<span class="${cls}">${esc(l.text)}</span>`;
  }).join('\n');
  if (upTo !== Infinity) el.scrollTop = el.scrollHeight;
}

// ------------------------------------------------------------------ context dialog

function openContextDialog(ctx, isNew) {
  const dlg = $('#ctx-dialog');
  const form = $('#ctx-form');
  const c = normalizeContext(ctx);
  const params = analysis?.model?.params || [];
  const opt = (v, cur, label = v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const paramField = (p) => {
    const v = has(c.params, p.name) ? c.params[p.name] : p.default;
    if (p.type === 'booleanParam') return `<label class="field"><span>${esc(p.name)}</span><span class="check"><input type="checkbox" name="param:${esc(p.name)}" ${v === true || v === 'true' ? 'checked' : ''}> true</span></label>`;
    if (p.type === 'choice') return `<label class="field"><span>${esc(p.name)}</span><select name="param:${esc(p.name)}">${p.choices.map((ch) => opt(ch, String(v))).join('')}</select></label>`;
    return `<label class="field"><span>${esc(p.name)}</span><input type="text" name="param:${esc(p.name)}" value="${esc(v)}"></label>`;
  };
  const mockRow = (m = {}) => `<div class="mock-row">
      <input name="m-match" placeholder="text or /regex/" value="${esc(m.match || '')}" aria-label="Command matches">
      <input name="m-exit" type="number" value="${esc(m.exitCode ?? 1)}" aria-label="Exit code">
      <input name="m-out" placeholder="stdout (optional)" value="${esc(m.stdout || '')}" aria-label="Output">
      <input name="m-times" type="number" min="0" placeholder="all" value="${esc(m.times || '')}" aria-label="Only the first N calls">
      <button type="button" class="x-btn" data-rm aria-label="Remove rule">×</button></div>`;
  const envText = Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join('\n');
  form.innerHTML = `
    <div class="dlg-head"><h2>${isNew ? 'New run context' : 'Edit run context'}</h2><button type="button" class="x-btn" data-cancel aria-label="Close">×</button></div>
    <div class="dlg-body">
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(c.name)}" required></label>
      <fieldset><legend>What is being built</legend>
        <div class="seg" role="radiogroup">
          <label><input type="radio" name="kind" value="branch" ${c.kind === 'branch' ? 'checked' : ''}>Branch</label>
          <label><input type="radio" name="kind" value="pr" ${c.kind === 'pr' ? 'checked' : ''}>Pull request</label>
          <label><input type="radio" name="kind" value="tag" ${c.kind === 'tag' ? 'checked' : ''}>Tag</label>
        </div>
        <div class="row" data-kind="branch"><label class="field"><span>Branch (BRANCH_NAME)</span><input type="text" name="branch" value="${esc(c.branch)}"></label></div>
        <div class="row" data-kind="pr">
          <label class="field"><span>PR number (CHANGE_ID)</span><input type="number" name="pr-id" value="${esc(c.pr.id)}"></label>
          <label class="field"><span>Source branch (CHANGE_BRANCH)</span><input type="text" name="pr-source" value="${esc(c.pr.source)}"></label>
          <label class="field"><span>Target branch (CHANGE_TARGET)</span><input type="text" name="pr-target" value="${esc(c.pr.target)}"></label>
          <label class="field"><span>Author</span><input type="text" name="pr-author" value="${esc(c.pr.author)}"></label>
          <label class="field"><span>Title</span><input type="text" name="pr-title" value="${esc(c.pr.title)}"></label>
        </div>
        <div class="row" data-kind="tag"><label class="field"><span>Tag (TAG_NAME)</span><input type="text" name="tag" value="${esc(c.tag)}"></label></div>
        <p class="note" data-kind="pr">Multibranch pull request builds have <code>BRANCH_NAME = PR-${esc(c.pr.id)}</code>, so <code>branch 'main'</code> is false here.</p>
      </fieldset>
      <fieldset><legend>Trigger</legend>
        <div class="row">
          <label class="field"><span>Build cause</span><select name="cause">${Object.entries(CAUSES).map(([k, v]) => opt(k, c.cause, v.label)).join('')}</select></label>
          <label class="field"><span>User (manual builds, input approver)</span><input type="text" name="user" value="${esc(c.user)}"></label>
          <label class="field"><span>Previous build result</span><select name="prev">${['SUCCESS', 'UNSTABLE', 'FAILURE', 'ABORTED', 'none'].map((v) => opt(v, c.previousResult, v === 'none' ? 'no previous build' : v)).join('')}</select></label>
          <label class="field"><span>input steps</span><select name="input">${opt('approve', c.input, 'Approve')}${opt('abort', c.input, 'Abort')}</select></label>
        </div>
        <div class="row">
          <label class="field"><span>Changed files (one per line)</span><textarea name="files" rows="3">${esc(c.changedFiles.join('\n'))}</textarea></label>
          <label class="field"><span>Commit messages (one per line)</span><textarea name="commits" rows="3">${esc(c.commits.join('\n'))}</textarea></label>
        </div>
      </fieldset>
      ${params.length ? `<fieldset><legend>Parameters</legend><div class="row">${params.map(paramField).join('')}</div></fieldset>` : ''}
      <fieldset><legend>Mock rules</legend>
        <p class="note">Every command succeeds by default, and git commands return plausible output. A rule matches the command text of <code>sh</code>/<code>bat</code>,
          or <code>junit …</code>, <code>build job</code>, <code>httpRequest GET url</code>, <code>readFile path</code>. In <code>junit</code> the exit code is the number of failed tests.
          Rules also apply to the builds this one starts; a <code>build job</code> rule replaces that build with a mock.</p>
        <div class="mocks">
          <div class="mock-row mock-head"><span>Command matches</span><span>Exit code</span><span>stdout</span><span>First N</span><span></span></div>
          <div data-mocks>${c.mocks.map(mockRow).join('')}</div>
          <div><button type="button" class="btn small" data-add-mock>+ Rule</button></div>
        </div>
      </fieldset>
      <fieldset><legend>Extra environment</legend>
        <label class="field"><span>KEY=value, one per line</span><textarea name="env" rows="2">${esc(envText)}</textarea></label>
      </fieldset>
    </div>
    <div class="dlg-foot">
      <div class="left">${isNew ? '' : '<button type="button" class="btn danger" data-delete>Delete</button><button type="button" class="btn" data-dup>Duplicate</button>'}</div>
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="submit" class="btn primary">${isNew ? 'Add context' : 'Save'}</button>
    </div>`;
  const syncKind = () => {
    const k = form.querySelector('input[name="kind"]:checked').value;
    form.querySelectorAll('[data-kind]').forEach((x) => { x.style.display = x.dataset.kind === k ? '' : 'none'; });
  };
  form.querySelectorAll('input[name="kind"]').forEach((x) => x.addEventListener('change', syncKind));
  syncKind();
  form.querySelector('[data-add-mock]').addEventListener('click', () => {
    form.querySelector('[data-mocks]').insertAdjacentHTML('beforeend', mockRow({ exitCode: 1 }));
  });
  form.onclick = (e) => {
    if (e.target.matches('[data-rm]')) e.target.closest('.mock-row').remove();
    if (e.target.matches('[data-cancel]')) dlg.close();
    if (e.target.matches('[data-delete]')) {
      if (state.contexts.length <= 1) { toast('Keep at least one context'); return; }
      state.contexts = state.contexts.filter((x) => x.id !== c.id);
      if (state.activeCtx === c.id) state.activeCtx = state.contexts[0].id;
      dlg.close();
      contextsChanged();
    }
    if (e.target.matches('[data-dup]')) {
      const copy = { ...readForm(form, c), id: newId(), name: `${form.elements.name.value} (copy)` };
      state.contexts.push(copy);
      state.activeCtx = copy.id;
      dlg.close();
      contextsChanged();
    }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const next = readForm(form, c);
    if (isNew) state.contexts.push(next);
    else state.contexts = state.contexts.map((x) => (x.id === c.id ? next : x));
    state.activeCtx = next.id;
    dlg.close();
    contextsChanged();
  };
  dlg.showModal();
}

function readForm(form, base) {
  const f = form.elements;
  const params = {};
  for (const p of analysis?.model?.params || []) {
    const el = f[`param:${p.name}`];
    if (!el) continue;
    const v = p.type === 'booleanParam' ? el.checked : el.value;
    // keep only values that differ from the default, as the Parameters bar does
    if (String(v) !== String(p.default)) params[p.name] = v;
  }
  const mocks = [...form.querySelectorAll('[data-mocks] .mock-row')].map((row) => ({
    match: row.querySelector('[name="m-match"]').value.trim(),
    exitCode: Number(row.querySelector('[name="m-exit"]').value) || 0,
    stdout: row.querySelector('[name="m-out"]').value || null,
    times: Number(row.querySelector('[name="m-times"]').value) || null,
  })).filter((m) => m.match);
  const env = {};
  for (const line of f.env.value.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return normalizeContext({
    id: base.id,
    name: f.name.value.trim() || 'Context',
    kind: form.querySelector('input[name="kind"]:checked').value,
    branch: f.branch.value.trim() || 'main',
    pr: { id: Number(f['pr-id'].value) || 1, source: f['pr-source'].value.trim(), target: f['pr-target'].value.trim(), author: f['pr-author'].value.trim(), title: f['pr-title'].value.trim() },
    tag: f.tag.value.trim() || 'v1.0.0',
    cause: f.cause.value,
    user: f.user.value.trim() || 'alice',
    previousResult: f.prev.value,
    input: f.input.value,
    changedFiles: f.files.value,
    commits: f.commits.value,
    params,
    mocks,
    env,
    buildNumber: base.buildNumber,
    job: base.job,
  });
}

// ------------------------------------------------------------------ setup

function loadExample(id, { keepContexts = false } = {}) {
  const ex = EXAMPLES.find((e) => e.id === id) || EXAMPLES[0];
  state.exampleId = ex.id;
  state.source = ex.source;
  state.pristine = ex.source;
  state.jobs = readJobs(ex.jobs);
  state.pristineJobs = jobsSnapshot();
  state.file = 'main';
  if (!keepContexts) {
    state.contexts = (ex.contexts || presetContexts()).map((c) => normalizeContext(c));
    state.activeCtx = state.contexts[0].id;
  }
  state.selected = null;
  state.view = '';
  editor.setValue(state.source);
  $('#example').value = ex.id;
  $('#graph').scrollTop = 0;
  $('#graph').scrollLeft = 0;
  save();
  reanalyze();
  ran = null;
  dirty = true;
  if (isValid()) runAll();
  else render();
}

const editor = createEditor($('#editor'), {
  onChange(v) {
    setOpenSource(v);
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; save(); sourceChanged(); }, 220);
  },
  onGutterClick(line) {
    const A = openAnalysis();
    const d = A && allProblems().find((p) => A.lines.line(p.s) === line);
    if (d) editor.reveal(d.s, d.e);
  },
});

// Drag the divider to resize the editor; « folds it into a rail, and the rail brings it back.
const split = createSplit({
  layout: $('.layout'), pane: $('#editor-pane'), splitter: $('#splitter'),
  collapseBtn: $('#editor-collapse'), expandBtn: $('#editor-expand'),
  persist: !embed,   // the landing-page demo always starts with the editor open
});
// an explicit jump ("show in editor", a line link) opens a folded editor first;
// selecting a stage in the graph (select: false) leaves it folded
const revealIn = editor.reveal.bind(editor);
editor.reveal = (s, e, opts = {}) => {
  if (opts.select !== false) split.expand();
  return revealIn(s, e, opts);
};

/** Error/warning count on the folded editor's rail. */
function railBadge(errs, warns) {
  const b = $('#rail-badge');
  if (!b) return;
  b.hidden = !errs && !warns;
  b.textContent = String(errs || warns);
  b.classList.toggle('warning', !errs);
  b.title = errs ? `${errs} error${errs === 1 ? '' : 's'}` : `${warns} warning${warns === 1 ? '' : 's'}`;
}

$('#example').innerHTML = EXAMPLES.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join('') + '<option value="__custom" hidden>Your Jenkinsfile</option>';
$('#example').addEventListener('change', (e) => {
  const id = e.target.value;
  if (isEdited() && !confirm('Replace your edits with this example?')) {
    e.target.value = state.exampleId;
    return;
  }
  loadExample(id);
});

$('#files').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm-job]');
  if (rm) { e.stopPropagation(); deleteJob(rm.dataset.rmJob); return; }
  if (e.target.closest('[data-add-job]')) { addJob(); return; }
  const tab = e.target.closest('[data-file]');
  if (tab && tab.dataset.file !== state.file) { setFile(tab.dataset.file); render(); }
});
$('#files').addEventListener('dblclick', (e) => {
  const tab = e.target.closest('[data-file]');
  if (tab && tab.dataset.file !== 'main') renameJob(tab.dataset.file);
});
$('#files').addEventListener('keydown', (e) => {
  if (e.target.closest('[data-rm-job], [data-add-job]')) return;
  const tab = e.target.closest('[data-file]');
  if (tab && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setFile(tab.dataset.file); render(); }
});

$('#params').addEventListener('change', (e) => {
  const name = e.target.dataset?.pv;
  if (!name) return;
  setParam(name, e.target.type === 'checkbox' ? e.target.checked : e.target.value);
});
$('#params').addEventListener('click', (e) => {
  const r = e.target.closest('[data-reset]');
  if (r) setParam(r.dataset.reset, null);
});

$('#contexts').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    const ctx = state.contexts.find((c) => c.id === edit.dataset.edit);
    if (ctx) openContextDialog(ctx, false);
    return;
  }
  const chip = e.target.closest('.chip-btn');
  if (chip) { stopAnim(); state.activeCtx = chip.dataset.id; save(); render(); }
});
$('#contexts').addEventListener('keydown', (e) => {
  const chip = e.target.closest('.chip-btn');
  if (chip && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); stopAnim(); state.activeCtx = chip.dataset.id; save(); render(); }
});
$('#ctx-add').addEventListener('click', () => {
  const base = activeCtx() || {};
  openContextDialog({ ...base, id: newId(), name: 'New context', mocks: [] }, true);
});
$('#ctx-suggest').addEventListener('click', () => {
  const sug = suggestContexts(analysis);
  const have = new Set(state.contexts.map((c) => c.name));
  const add = sug.filter((s) => !have.has(s.name));
  if (!add.length) { toast('No new contexts to suggest'); return; }
  state.contexts.push(...add);
  contextsChanged();
  toast(`Added ${add.length} context${add.length === 1 ? '' : 's'}: ${add.map((a) => a.name).join(', ')}`);
});
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { state.tab = t.dataset.tab; save(); render(); }));

$('#share').addEventListener('click', async () => {
  try {
    const data = await compress(JSON.stringify({ v: 1, source: state.source, jobs: state.jobs.map((j) => ({ name: j.name, source: j.source })), contexts: state.contexts }));
    const url = `${location.origin}${location.pathname}#p=${data}`;
    history.replaceState(null, '', `#p=${data}`);
    try { await navigator.clipboard.writeText(url); toast('Link copied: the Jenkinsfiles are stored in the URL itself'); } catch { toast('Link is in the address bar'); }
  } catch (e) {
    toast(`Could not create link: ${e.message}`);
  }
});

$('#run').addEventListener('click', () => {
  if (anim) { finishAnim(); return; }
  runAll();
});
$('#autorun').addEventListener('change', (e) => {
  state.autorun = e.target.checked;
  save();
  if (state.autorun && dirty && isValid()) runAll({ animate: false });
  else render();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !$('#ctx-dialog').open) {
    e.preventDefault();
    if (e.target.closest?.('#params')) e.target.dispatchEvent(new Event('change', { bubbles: true }));
    runAll();
  } else if (e.key === 'Escape' && anim) {
    finishAnim();
  }
});

/** First load: check the files and run once, so there is something to look at. */
function start() {
  reanalyze();
  dirty = true;
  if (isValid()) runAll();
  else render();
}

async function init() {
  if (location.hash.startsWith('#p=')) {
    try {
      const data = JSON.parse(await decompress(location.hash.slice(3)));
      state.source = data.source;
      state.pristine = data.source;
      state.jobs = readJobs(data.jobs);
      state.pristineJobs = jobsSnapshot();
      state.file = 'main';
      state.exampleId = '__custom';
      state.contexts = (data.contexts || presetContexts()).map((c) => normalizeContext(c));
      state.activeCtx = state.contexts[0].id;
      editor.setValue(state.source);
      $('#example').value = '__custom';
      start();
      return;
    } catch (e) {
      toast('Could not read the shared link');
    }
  }
  const stored = loadStored();
  if (stored) state.autorun = !!stored.autorun;
  if (exampleParam && EXAMPLES.some((e) => e.id === exampleParam)) {
    // A link from the landing page. Drop the parameter so a reload restores the saved work instead.
    if (!embed) history.replaceState(null, '', location.pathname);
    const storedJobs = JSON.stringify(readJobs(stored?.jobs).map((j) => [j.name, j.source]));
    const edited = stored && stored.source != null && (stored.source !== stored.pristine || (stored.pristineJobs != null && storedJobs !== stored.pristineJobs));
    if (!edited || confirm('Open this example? It replaces the Jenkinsfile you were editing.')) {
      loadExample(exampleParam);
      return;
    }
  }
  if (stored && stored.source != null && Array.isArray(stored.contexts) && stored.contexts.length) {
    Object.assign(state, { source: stored.source, exampleId: stored.exampleId, pristine: stored.pristine ?? stored.source, tab: stored.tab || 'pipeline' });
    state.jobs = readJobs(stored.jobs);
    state.pristineJobs = stored.pristineJobs ?? jobsSnapshot();
    state.file = state.jobs.some((j) => j.id === stored.file) ? stored.file : 'main';
    state.contexts = stored.contexts.map((c) => normalizeContext(c));
    state.activeCtx = state.contexts.some((c) => c.id === stored.activeCtx) ? stored.activeCtx : state.contexts[0].id;
    editor.setValue(openSource());
    $('#example').value = EXAMPLES.some((e) => e.id === state.exampleId) && !isEdited() ? state.exampleId : '__custom';
    start();
    return;
  }
  loadExample('multibranch');
}

init();

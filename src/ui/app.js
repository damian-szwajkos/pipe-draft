// PipeDraft UI wiring.

import { analyze, simulate, flattenView, fmtDur } from '../engine/engine.js';
import { presetContexts, normalizeContext, suggestContexts, newId, CAUSES } from '../engine/contexts.js';
import { EXAMPLES } from '../examples.js';
import { createEditor } from './editor.js';
import { renderGraph } from './graph.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const STORE_KEY = 'pipedraft:v1';
const ST_COLOR = { success: 'var(--ok)', failure: 'var(--fail)', unstable: 'var(--warn)', skipped: 'var(--skip)', 'not-run': 'var(--skip)', aborted: 'var(--abort)' };
const ICON = { success: '✓', failure: '✕', unstable: '!', skipped: '–', 'not-run': '–', aborted: '■', pending: '·' };

const state = {
  source: '',
  exampleId: 'multibranch',
  pristine: '',
  contexts: [],
  activeCtx: null,
  tab: 'pipeline',
  selected: null,
};
let analysis = null;
let runs = new Map();
let engineError = null;
let timer = null;

// ------------------------------------------------------------------ persistence

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      source: state.source, exampleId: state.exampleId, pristine: state.pristine, contexts: state.contexts, activeCtx: state.activeCtx, tab: state.tab,
    }));
  } catch { /* storage unavailable */ }
}

function loadStored() {
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
  toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ------------------------------------------------------------------ analysis & runs

function recompute() {
  engineError = null;
  runs = new Map();
  try {
    analysis = analyze(state.source);
  } catch (e) {
    console.error(e);
    analysis = null;
    engineError = e;
  }
  if (analysis && isValid()) {
    for (const ctx of state.contexts) {
      try {
        runs.set(ctx.id, simulate(analysis, ctx));
      } catch (e) {
        console.error(e);
        runs.set(ctx.id, { crash: e });
      }
    }
  }
  render();
}

function isValid() {
  return analysis && analysis.ok && !analysis.diagnostics.some((d) => d.severity === 'error');
}

const activeCtx = () => state.contexts.find((c) => c.id === state.activeCtx) || state.contexts[0] || null;
const activeRun = () => {
  const c = activeCtx();
  const r = c ? runs.get(c.id) : null;
  return r && !r.crash ? r : null;
};

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
  renderHeader();
  renderContexts();
  renderTabs();
  renderSummary();
  renderProblems();
  renderEditorDeco();
  if (state.tab === 'pipeline') { renderPipeline(); renderDetails(); }
  if (state.tab === 'matrix') renderMatrix();
  if (state.tab === 'log') renderLog();
}

function renderHeader() {
  const mode = $('#mode');
  const val = $('#validity');
  if (!analysis) {
    mode.textContent = '—';
    val.textContent = 'Simulator error';
    val.className = 'validity bad';
    return;
  }
  mode.textContent = analysis.mode ? `${analysis.mode} pipeline` : 'syntax error';
  const errs = analysis.diagnostics.filter((d) => d.severity === 'error').length;
  if (!analysis.ok) { val.textContent = 'Groovy syntax error: the file does not compile'; val.className = 'validity bad'; }
  else if (errs) { val.textContent = `${errs} error${errs === 1 ? '' : 's'}: Jenkins would reject this file`; val.className = 'validity bad'; }
  else { val.textContent = '✓ Valid: Jenkins would accept this file'; val.className = 'validity ok'; }
}

function renderContexts() {
  const el = $('#contexts');
  el.innerHTML = state.contexts.map((c) => {
    const r = runs.get(c.id);
    const res = !r ? 'NONE' : r.crash ? 'ERROR' : r.result;
    const active = c.id === activeCtx()?.id;
    return `<span class="chip-btn${active ? ' active' : ''}" role="tab" tabindex="0" aria-selected="${active}" data-id="${esc(c.id)}" title="${esc(`${c.name}${r ? ` → ${res}` : ''}`)}">
      <span class="dot ${esc(res)}"></span><span class="nm">${esc(c.name)}</span>
      <button class="edit" type="button" data-edit="${esc(c.id)}" title="Edit context" aria-label="Edit ${esc(c.name)}">✎</button></span>`;
  }).join('');
}

function renderTabs() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${state.tab}`));
}

function renderSummary() {
  const el = $('#run-summary');
  const c = activeCtx();
  const r = c ? runs.get(c.id) : null;
  if (!isValid() || !r) { el.innerHTML = ''; return; }
  if (r.crash) { el.innerHTML = `<span class="badge FAILURE">SIMULATOR ERROR</span>`; return; }
  const n = r.steps.length;
  el.innerHTML = `<span>${esc(fmtDur(r.duration))} simulated · ${n} step${n === 1 ? '' : 's'}</span><span class="badge ${r.result}">${r.result}</span>`;
}

function allProblems() {
  if (!analysis) return [];
  const list = analysis.diagnostics.map((d) => ({ ...d }));
  const r = activeRun();
  if (r) {
    for (const w of r.warnings) list.push({ ...w, runtime: true });
    if (r.firstError && r.firstError.s != null) {
      list.push({ severity: 'error', message: `${r.firstError.cls?.split('.').pop() || 'Error'}: ${r.firstError.message}`, s: r.firstError.s, e: r.firstError.e, hint: r.firstError.hint, runtime: true, failure: true });
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
    return;
  }
  const list = allProblems();
  const ctx = activeCtx();
  const errs = list.filter((d) => d.severity === 'error').length;
  const warns = list.filter((d) => d.severity === 'warning').length;
  count.textContent = list.length ? `${errs} error${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}, ${list.length - errs - warns} info` : '';
  if (!list.length) {
    el.innerHTML = '<li class="empty">No problems found.</li>';
    return;
  }
  el.innerHTML = list.map((d, i) => {
    const { line, col } = analysis.lines.lc(d.s);
    const icon = d.severity === 'error' ? '✕' : d.severity === 'warning' ? '!' : 'i';
    const rt = d.runtime ? `<span class="rt" title="Found while simulating “${esc(ctx?.name)}”">run</span>` : '';
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
  if (!analysis) { editor.setDecorations({ diagnostics: [], lineInfo: new Map(), range: null }); return; }
  const diags = allProblems();
  const lineInfo = new Map();
  const get = (l) => { if (!lineInfo.has(l)) lineInfo.set(l, {}); return lineInfo.get(l); };
  const rankOf = { error: 3, warning: 2, info: 1 };
  for (const d of diags) {
    if (d.severity === 'info') continue;
    const l = analysis.lines.line(d.s);
    const info = get(l);
    if (!info.diag || rankOf[d.severity] > rankOf[info.diag]) { info.diag = d.severity; info.title = d.message; }
  }
  const r = activeRun();
  if (r && analysis.model) {
    for (const s of analysis.model.codeStarts) {
      const l = analysis.lines.line(s);
      const info = get(l);
      const hit = r.hits.has(s);
      if (hit) { info.cov = 'hit'; info.covTitle = `Executed ${r.hits.get(s)}× in “${activeCtx().name}”`; }
      else if (info.cov !== 'hit') { info.cov = 'miss'; info.covTitle = `Not executed in “${activeCtx().name}”`; }
    }
    for (const { node } of flattenView(analysis.viewTree)) {
      if (node.cell || node.dynamic) continue;
      const sr = r.stages[node.id];
      if (!sr) continue;
      const l = analysis.lines.line(node.s);
      const info = get(l);
      info.stage = ST_COLOR[sr.status] || 'transparent';
      info.stageTitle = `${node.name}: ${sr.status}${sr.reason ? ` (${sr.reason})` : ''}`;
    }
  }
  let range = null;
  if (state.selected && analysis.viewTree) {
    const idx = indexTree(analysis.viewTree).get(state.selected);
    if (idx && !idx.node.cell) range = { s: idx.node.s, e: idx.node.e };
  }
  editor.setDecorations({ diagnostics: diags, lineInfo, range });
}

function renderPipeline() {
  const el = $('#graph');
  if (engineError) { el.innerHTML = `<div class="graph-empty"><strong>Simulator error.</strong> ${esc(engineError.message)}</div>`; return; }
  if (!analysis) return;
  const r = activeRun();
  const crash = runs.get(activeCtx()?.id)?.crash;
  if (crash) { el.innerHTML = `<div class="graph-empty"><strong>The simulator crashed on this context.</strong> ${esc(crash.message)}</div>`; return; }
  renderGraph(el, analysis.viewTree, r, {
    selected: state.selected,
    onSelect: selectStage,
    contextName: activeCtx()?.name,
    invalid: !isValid(),
    post: r?.postRuns?.length ? r.postRuns : null,
  });
}

function selectStage(id) {
  state.selected = state.selected === id ? null : id;
  renderPipeline();
  renderDetails();
  renderEditorDeco();
  if (state.selected) {
    const idx = indexTree(analysis.viewTree).get(state.selected);
    if (idx && !idx.node.cell) editor.reveal(idx.node.s, idx.node.s, { select: false });
  }
}

function condTree(list) {
  return `<ul class="cond-tree">${list.map((n) => {
    const v = n.value === true ? '<span class="v t">✓</span>' : n.value === false ? '<span class="v f">✕</span>' : '<span class="v n">·</span>';
    return `<li>${v} <code>${esc(n.text)}</code>${n.detail ? ` <span class="d">${esc(n.detail)}</span>` : ''}${n.children?.length ? condTree(n.children) : ''}</li>`;
  }).join('')}</ul>`;
}

function stepsTable(steps) {
  if (!steps.length) return '<p class="muted">No steps ran.</p>';
  const stIcon = { ok: '✓', failed: '✕', warn: '!', 'not-run': '–' };
  return `<table class="steps">${steps.map((s) => {
    const line = analysis.lines.line(s.s);
    const out = s.output ? String(s.output).split('\n').slice(0, 4).join('\n') : '';
    return `<tr class="${s.status}"><td class="sst ${s.status}">${stIcon[s.status] || ''}</td>
      <td class="sname"><button class="link-btn mono" data-reveal="${s.s}:${s.e}" title="Line ${line}">${esc(s.name)}</button></td>
      <td class="slabel">${esc(s.label)}${s.mockRule != null ? `<span class="mock" title="Result from mock rule #${s.mockRule + 1}">mock</span>` : ''}${s.caught ? `<div class="out">caught: ${esc(s.caught)}</div>` : ''}${out ? `<div class="out">${esc(out)}</div>` : ''}</td>
      <td class="sdur">${s.dur ? esc(fmtDur(s.dur)) : ''}</td></tr>`;
  }).join('')}</table>`;
}

function renderDetails() {
  const el = $('#details');
  if (!analysis) { el.innerHTML = ''; return; }
  if (!isValid()) {
    el.innerHTML = `<h3>Fix the structure first</h3>
      <p class="reason">Jenkins validates the whole Jenkinsfile before any stage runs, so nothing is simulated while there are errors.
      Click a problem on the left to jump to it.</p>`;
    return;
  }
  const r = activeRun();
  const idx = indexTree(analysis.viewTree);
  const entry = state.selected ? idx.get(state.selected) : null;
  if (!entry || !r) { el.innerHTML = overview(r); bindReveal(el); return; }
  const n = entry.node;
  const sr = r.stages[n.id] || { status: 'pending', steps: [], post: [], phases: [] };
  // conditions on the path from the root
  const chain = [];
  for (let e = entry; e; e = e.parent ? idx.get(e.parent.id) : null) chain.unshift(e.node);
  let conds = '';
  if (analysis.mode === 'declarative') {
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
  el.innerHTML = `
    <h3>${esc(n.name)} <span class="st-badge ${sr.status}">${esc(sr.status)}</span>
      ${n.cell ? '' : `<button class="link-btn" data-reveal="${n.s}:${n.head ? n.head.e : n.s + 5}">show in editor</button>`}</h3>
    ${sr.reason ? `<p class="reason ${sr.status === 'failure' ? 'failure' : ''}">${esc(sr.reason)}${sr.error?.s != null ? ` <button class="link-btn" data-reveal="${sr.error.s}:${sr.error.e}">line ${analysis.lines.line(sr.error.s)}</button>` : ''}</p>` : ''}
    ${names}
    <h4>Runs when</h4>${conds}
    ${sr.when ? `<h4>when, in “${esc(activeCtx().name)}”</h4>${condTree(sr.when.tree)}` : ''}
    ${phases}
    ${sr.agent ? `<h4>Agent</h4><p class="mono">${esc(sr.agent)}</p>` : ''}
    <h4>Steps${sr.steps.length ? ` (${sr.steps.length})` : ''}</h4>${sr.status === 'skipped' || sr.status === 'not-run' ? '<p class="muted">Nothing ran in this stage.</p>' : stepsTable(sr.steps)}
    ${post}`;
  bindReveal(el);
}

function overview(r) {
  const m = analysis.model;
  const ctx = activeCtx();
  const P = m.pipeline;
  const trig = m.triggers.map((t) => `<li><code>${esc(t.src || t.type)}</code>${t.dynamic ? ' <span class="muted">(schedule computed at runtime)</span>' : ''}</li>`).join('');
  const params = m.params.map((p) => `<li><code>${esc(p.name)}</code> <span class="muted">${esc(p.type)}, default ${esc(JSON.stringify(p.default))}</span> → <code>${esc(JSON.stringify(r?.params?.[p.name]))}</code></li>`).join('');
  const post = r?.postRuns?.length ? `<h4>Pipeline post</h4><ul class="post-list">${r.postRuns.map((p) => `<li>${p.ran ? '✓' : '·'} <code>${esc(p.cond)}</code> <span class="muted">${p.ran ? 'ran' : 'did not run'} — ${esc(p.why)}</span></li>`).join('')}</ul>` : '';
  const ds = r?.downstream?.length ? `<h4>Downstream builds</h4><ul class="help">${r.downstream.map((d) => `<li><code>${esc(d.job)}</code> ${esc(d.result)}${d.params.length ? ` <span class="muted">(${esc(d.params.join(', '))})</span>` : ''}</li>`).join('')}</ul>` : '';
  const env = r ? ['BRANCH_NAME', 'CHANGE_ID', 'CHANGE_TARGET', 'CHANGE_BRANCH', 'TAG_NAME', 'BUILD_NUMBER'].filter((k) => r.env[k] != null) : [];
  return `
    <h3>${esc(ctx?.name || 'Run')} ${r ? `<span class="badge ${r.result}">${r.result}</span>` : ''}</h3>
    <p class="reason">${r ? esc(r.causes.map((c) => c.text).join(', ')) : ''}${r?.firstError ? ` · <span style="color:var(--fail)">${esc(r.firstError.message)}</span>` : ''}</p>
    <h4>How to read this</h4>
    <ul class="help">
      <li>Click a stage to see <b>why</b> it ran or was skipped, the <code>when</code> conditions evaluated for this context, and the steps it ran.</li>
      <li>Switch contexts above, or open <b>Condition matrix</b> to compare every context at once.</li>
      <li>Every command is mocked and succeeds. Edit a context (✎) and add a mock rule to make a command fail or return output.</li>
      <li>The editor gutter shows which lines ran in this context (green) and which did not (grey).</li>
    </ul>
    ${env.length ? `<h4>Environment for this run</h4><dl class="kv">${env.map((k) => `<dt>${k}</dt><dd>${esc(r.env[k])}</dd>`).join('')}</dl>` : ''}
    ${P?.agent ? `<h4>Agent</h4><p class="mono">${esc(P.agent.type)}</p>` : ''}
    ${trig ? `<h4>Triggers</h4><ul class="help">${trig}</ul>` : ''}
    ${params ? `<h4>Parameters</h4><ul class="help">${params}</ul>` : ''}
    ${post}${ds}`;
}

function bindReveal(el) {
  el.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', () => {
    const [s, e] = b.dataset.reveal.split(':').map(Number);
    editor.reveal(s, e);
  }));
}

function renderMatrix() {
  const el = $('#matrix');
  if (!isValid()) { el.innerHTML = '<p class="matrix-intro">Fix the errors in the Jenkinsfile to compare contexts.</p>'; return; }
  const rows = flattenView(analysis.viewTree);
  const ctxs = state.contexts;
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
  const cur = activeCtx()?.id;
  el.innerHTML = `
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
        ${analysis.model.pipeline?.post ? `<tr><th>post</th>${ctxs.map((c) => {
          const r = runs.get(c.id);
          const ran = r && !r.crash ? r.postRuns.filter((p) => p.ran).map((p) => p.cond) : [];
          return `<td class="${c.id === cur ? 'sel-col' : ''}"><span class="cell"><span class="t" title="${esc(ran.join(', '))}">${esc(ran.join(', ') || '—')}</span></span></td>`;
        }).join('')}</tr>` : ''}
      </tbody>
    </table>`;
  el.querySelectorAll('[data-ctx]').forEach((x) => x.addEventListener('click', () => {
    state.activeCtx = x.dataset.ctx;
    if (x.dataset.stage) { state.selected = x.dataset.stage; state.tab = 'pipeline'; }
    save();
    render();
  }));
}

function renderLog() {
  const el = $('#log');
  const r = activeRun();
  if (!r) { el.textContent = isValid() ? '' : 'Nothing ran: Jenkins would reject this Jenkinsfile.'; return; }
  let inside = null;
  if (state.selected && analysis.viewTree) {
    const idx = indexTree(analysis.viewTree);
    const ids = new Set([state.selected]);
    for (const [id, e] of idx) {
      for (let p = e.parent; p; p = idx.get(p.id)?.parent) if (p.id === state.selected) ids.add(id);
    }
    inside = ids;
  }
  el.innerHTML = r.log.map((l) => {
    const cls = `${l.kind}${inside && l.stage && inside.has(l.stage) ? ' hl' : ''}`;
    return `<span class="${cls}">${esc(l.text)}</span>`;
  }).join('\n');
}

// ------------------------------------------------------------------ context dialog

function openContextDialog(ctx, isNew) {
  const dlg = $('#ctx-dialog');
  const form = $('#ctx-form');
  const c = normalizeContext(ctx);
  const params = analysis?.model?.params || [];
  const opt = (v, cur, label = v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const paramField = (p) => {
    const has = Object.prototype.hasOwnProperty.call(c.params, p.name);
    const v = has ? c.params[p.name] : p.default;
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
          or <code>junit …</code>, <code>build job</code>, <code>httpRequest GET url</code>, <code>readFile path</code>. In <code>junit</code> the exit code is the number of failed tests.</p>
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
  form.addEventListener('click', (e) => {
    if (e.target.matches('[data-rm]')) e.target.closest('.mock-row').remove();
    if (e.target.matches('[data-cancel]')) dlg.close();
    if (e.target.matches('[data-delete]')) {
      if (state.contexts.length <= 1) { toast('Keep at least one context'); return; }
      state.contexts = state.contexts.filter((x) => x.id !== c.id);
      if (state.activeCtx === c.id) state.activeCtx = state.contexts[0].id;
      dlg.close();
      save();
      recompute();
    }
    if (e.target.matches('[data-dup]')) {
      const copy = { ...readForm(form, c), id: newId(), name: `${form.elements.name.value} (copy)` };
      state.contexts.push(copy);
      state.activeCtx = copy.id;
      dlg.close();
      save();
      recompute();
    }
  });
  form.onsubmit = (e) => {
    e.preventDefault();
    const next = readForm(form, c);
    if (isNew) state.contexts.push(next);
    else state.contexts = state.contexts.map((x) => (x.id === c.id ? next : x));
    state.activeCtx = next.id;
    dlg.close();
    save();
    recompute();
  };
  dlg.showModal();
}

function readForm(form, base) {
  const f = form.elements;
  const params = {};
  for (const p of analysis?.model?.params || []) {
    const el = f[`param:${p.name}`];
    if (!el) continue;
    params[p.name] = p.type === 'booleanParam' ? el.checked : el.value;
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
  if (!keepContexts) {
    state.contexts = (ex.contexts || presetContexts()).map((c) => normalizeContext(c));
    state.activeCtx = state.contexts[0].id;
  }
  state.selected = null;
  editor.setValue(state.source);
  $('#example').value = ex.id;
  save();
  recompute();
}

const editor = createEditor($('#editor'), {
  onChange(v) {
    state.source = v;
    clearTimeout(timer);
    timer = setTimeout(() => { save(); recompute(); }, 220);
  },
  onGutterClick(line) {
    const d = allProblems().find((p) => analysis.lines.line(p.s) === line);
    if (d) editor.reveal(d.s, d.e);
  },
});

$('#example').innerHTML = EXAMPLES.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join('') + '<option value="__custom" hidden>Your Jenkinsfile</option>';
$('#example').addEventListener('change', (e) => {
  const id = e.target.value;
  if (state.source !== state.pristine && !confirm('Replace your edits with this example?')) {
    e.target.value = state.exampleId;
    return;
  }
  loadExample(id);
});

$('#contexts').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    const ctx = state.contexts.find((c) => c.id === edit.dataset.edit);
    if (ctx) openContextDialog(ctx, false);
    return;
  }
  const chip = e.target.closest('.chip-btn');
  if (chip) { state.activeCtx = chip.dataset.id; save(); render(); }
});
$('#contexts').addEventListener('keydown', (e) => {
  const chip = e.target.closest('.chip-btn');
  if (chip && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); state.activeCtx = chip.dataset.id; save(); render(); }
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
  save();
  recompute();
  toast(`Added ${add.length} context${add.length === 1 ? '' : 's'}: ${add.map((a) => a.name).join(', ')}`);
});
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { state.tab = t.dataset.tab; save(); render(); }));

$('#share').addEventListener('click', async () => {
  try {
    const data = await compress(JSON.stringify({ v: 1, source: state.source, contexts: state.contexts }));
    const url = `${location.origin}${location.pathname}#p=${data}`;
    history.replaceState(null, '', `#p=${data}`);
    try { await navigator.clipboard.writeText(url); toast('Link copied: the Jenkinsfile is stored in the URL itself'); } catch { toast('Link is in the address bar'); }
  } catch (e) {
    toast(`Could not create link: ${e.message}`);
  }
});

async function init() {
  if (location.hash.startsWith('#p=')) {
    try {
      const data = JSON.parse(await decompress(location.hash.slice(3)));
      state.source = data.source;
      state.pristine = data.source;
      state.exampleId = '__custom';
      state.contexts = (data.contexts || presetContexts()).map((c) => normalizeContext(c));
      state.activeCtx = state.contexts[0].id;
      editor.setValue(state.source);
      $('#example').value = '__custom';
      recompute();
      return;
    } catch (e) {
      toast('Could not read the shared link');
    }
  }
  const stored = loadStored();
  if (stored && stored.source != null && Array.isArray(stored.contexts) && stored.contexts.length) {
    Object.assign(state, { source: stored.source, exampleId: stored.exampleId, pristine: stored.pristine ?? stored.source, tab: stored.tab || 'pipeline' });
    state.contexts = stored.contexts.map((c) => normalizeContext(c));
    state.activeCtx = state.contexts.some((c) => c.id === stored.activeCtx) ? stored.activeCtx : state.contexts[0].id;
    editor.setValue(state.source);
    $('#example').value = EXAMPLES.some((e) => e.id === state.exampleId) && state.source === state.pristine ? state.exampleId : (state.source === state.pristine ? state.exampleId : '__custom');
    recompute();
    return;
  }
  loadExample('multibranch');
}

init();

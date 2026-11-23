// SVG stage graph: sequential stages left to right, parallel branches and
// matrix cells stacked vertically, nested stages drawn inside their parent.

import { fmtDur } from '../engine/engine.js';

const W = 196;
const H = 58;
const GX = 34;
const GY = 12;
const PAD = 12;
const HDR = 34;
const FORK = 18;
const TERM = 15;

const ICON = { success: '✓', failure: '✕', unstable: '!', skipped: '–', 'not-run': '–', aborted: '■', pending: '·', running: '…' };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const trunc = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/** Replace runtime-built parallel placeholders with the branches that actually ran. */
function expand(tree, run) {
  if (!tree || !run) return tree;
  const items = tree.items.map((it) => {
    if (it.kind === 'par') {
      let branches = it.items.map((b) => ({ ...b, children: expand(b.children, run) }));
      if (branches.some((b) => b.dynamic)) {
        const prefix = `${it.id}:`;
        const rt = Object.values(run.stages).filter((s) => s.id.startsWith(prefix));
        if (rt.length) branches = rt.map((s) => ({ kind: 'stage', id: s.id, name: s.name, conds: [], children: null, branch: true }));
      }
      return { ...it, items: branches };
    }
    return { ...it, children: expand(it.children, run) };
  });
  return { ...tree, items };
}

export function renderGraph(el, tree, run, opts) {
  const { selected, onSelect, contextName, invalid, post } = opts;
  if (!tree || !tree.items.length) {
    el.innerHTML = `<div class="graph-empty">${invalid ? '<strong>Jenkins would reject this file.</strong> Fix the problems on the left to see the stages.' : 'No stages found. Add <code>stages { stage(\'Build\') { steps { ... } } }</code>.'}</div>`;
    return;
  }
  tree = expand(tree, run);
  const sizes = new Map();
  const measure = (n) => {
    let s;
    if (n.kind === 'seq') {
      const ms = n.items.map(measure);
      s = { w: ms.reduce((a, m) => a + m.w, 0) + GX * Math.max(0, ms.length - 1), h: Math.max(H, ...ms.map((m) => m.h)) };
    } else if (n.kind === 'par') {
      const ms = n.items.map(measure);
      s = { w: Math.max(W, ...ms.map((m) => m.w)) + 2 * FORK, h: ms.reduce((a, m) => a + m.h, 0) + GY * Math.max(0, ms.length - 1) };
    } else if (n.children && n.children.items.length) {
      const inner = measure(n.children);
      s = { w: Math.max(W, inner.w + 2 * PAD), h: HDR + inner.h + PAD };
    } else s = { w: W, h: H };
    sizes.set(n, s);
    return s;
  };
  const total = measure(tree);
  const parts = [];
  const edges = [];
  const statusOf = (id) => (invalid ? 'pending' : run?.stages[id]?.status || 'pending');
  const ran = (st) => ['success', 'failure', 'unstable'].includes(st);

  const subtitle = (n, sr) => {
    if (invalid || !sr) return n.when ? `when ${n.when}` : n.input ? 'waits for input' : '';
    if (sr.status === 'skipped') {
      if (sr.skip === 'when') return `skipped · ${sr.reason.replace(/ → false.*/, '')}`;
      if (sr.skip === 'failure') return 'skipped · earlier failure';
      if (sr.skip === 'unstable') return 'skipped · build unstable';
      if (sr.skip === 'parent') return 'skipped with parent';
      return 'skipped';
    }
    if (sr.status === 'not-run') return sr.reason || 'not run';
    if (sr.status === 'aborted') return sr.reason || 'aborted';
    if (sr.status === 'failure') return sr.reason || 'failed';
    const nsteps = sr.steps.filter((s) => !['echo'].includes(s.name)).length;
    const dur = sr.end != null && sr.start != null ? fmtDur(sr.end - sr.start) : '';
    const inst = sr.instances > 1 ? `×${sr.instances} · ` : '';
    return `${inst}${dur}${nsteps ? ` · ${nsteps} step${nsteps === 1 ? '' : 's'}` : ''}${sr.status === 'unstable' ? ' · unstable' : ''}`;
  };

  const box = (n, x, y, w, h, container) => {
    const sr = invalid ? null : run?.stages[n.id];
    const st = statusOf(n.id);
    const sel = selected === n.id ? ' sel' : '';
    const name = sr && sr.names && sr.names.length > 1 ? `${n.name}` : n.name;
    let sub = subtitle(n, sr);
    if (container) {
      const par = n.children.items.find((it) => it.kind === 'par');
      if (par) {
        const kind = par.matrix ? `matrix · ${par.items.length} cells` : `parallel${par.failFast ? ' · failFast' : ''}`;
        sub = sr && ['success', 'unstable'].includes(sr.status) ? `${kind} · ${sub}` : sr && sub ? sub : kind;
      }
    }
    const title = [n.name, sr?.reason, n.when ? `when: ${n.when}` : null].filter(Boolean).join('\n');
    const maxName = Math.floor((w - 44) / 7.4);
    const maxSub = Math.floor((w - 44) / 5.9);
    parts.push(`<g class="g-node st-${st}${sel}${container ? ' container' : ''}" data-id="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(`${n.name}: ${st}`)}">
      <title>${esc(title)}</title>
      <rect class="box" x="${x}" y="${y}" width="${w}" height="${h}" rx="9"/>
      <circle class="badge-c" cx="${x + 18}" cy="${y + (container ? HDR / 2 : 20)}" r="9"/>
      <text class="ic" x="${x + 18}" y="${y + (container ? HDR / 2 : 20) + 4}" text-anchor="middle">${ICON[st] || '·'}</text>
      <text class="nm" x="${x + 34}" y="${y + (container ? HDR / 2 + 1 : 20) + 4}">${esc(trunc(name, maxName))}</text>
      ${!container && sub ? `<text class="sub" x="${x + 34}" y="${y + 40}">${esc(trunc(sub, maxSub))}</text>` : ''}
      ${container && sub ? `<text class="sub" x="${x + w - 10}" y="${y + HDR / 2 + 4}" text-anchor="end">${esc(trunc(sub, Math.max(6, Math.floor((w - 60 - name.length * 7.4) / 5.9))))}</text>` : ''}
    </g>`);
  };

  const draw = (n, x, y) => {
    const s = sizes.get(n);
    if (n.kind === 'seq') {
      let cx = x;
      let first = null;
      let prev = null;
      for (const it of n.items) {
        const is = sizes.get(it);
        const a = draw(it, cx, y + (s.h - is.h) / 2);
        if (!first) first = a;
        if (prev) edges.push({ d: `M${prev.ox} ${prev.oy} L${a.ix} ${a.iy}`, on: prev.on && a.on });
        prev = a;
        cx += is.w + GX;
      }
      return { ix: first.ix, iy: first.iy, ox: prev.ox, oy: prev.oy, on: first.on && prev.on, onIn: first.on };
    }
    if (n.kind === 'par') {
      const mid = y + s.h / 2;
      const fx = x;
      const jx = x + s.w;
      let cy = y;
      let anyOn = false;
      for (const it of n.items) {
        const is = sizes.get(it);
        const a = draw(it, x + FORK, cy);
        const c = FORK * 0.9;
        edges.push({ d: `M${fx} ${mid} C${fx + c} ${mid}, ${a.ix - c} ${a.iy}, ${a.ix} ${a.iy}`, on: a.on });
        edges.push({ d: `M${a.ox} ${a.oy} L${jx - FORK} ${a.oy} C${jx - FORK + c} ${a.oy}, ${jx - c} ${mid}, ${jx} ${mid}`, on: a.on });
        if (a.on) anyOn = true;
        cy += is.h + GY;
      }
      return { ix: fx, iy: mid, ox: jx, oy: mid, on: anyOn };
    }
    // stage
    const container = n.children && n.children.items.length;
    const st = statusOf(n.id);
    if (container) {
      box(n, x, y, s.w, s.h, true);
      const inner = sizes.get(n.children);
      draw(n.children, x + PAD + (s.w - 2 * PAD - inner.w) / 2, y + HDR);
    } else box(n, x, y, s.w, s.h, false);
    const cyMid = container ? y + HDR / 2 : y + H / 2;
    return { ix: x, iy: container ? cyMid : y + s.h / 2, ox: x + s.w, oy: container ? cyMid : y + s.h / 2, on: ran(st) };
  };

  const top = 26;
  const startX = 62;
  const mid = top + total.h / 2;
  const seqX = startX + TERM + GX;
  const a = draw(tree, seqX, top);
  let endX = seqX + total.w + GX;
  // pipeline post
  const postParts = [];
  if (post && post.length) {
    const ranPost = post.filter((p) => p.ran);
    const pw = 150;
    const ph = 46;
    const label = ranPost.length ? ranPost.map((p) => p.cond).join(', ') : 'none ran';
    postParts.push(`<g class="g-post"><title>${esc(post.map((p) => `${p.ran ? '✓' : '·'} ${p.cond}: ${p.why}`).join('\n'))}</title>
      <rect x="${endX}" y="${mid - ph / 2}" width="${pw}" height="${ph}" rx="8"/>
      <text class="g-label" x="${endX + 10}" y="${mid - 5}">post</text>
      <text class="sub" x="${endX + 10}" y="${mid + 12}" style="font-size:12px;fill:var(--text)">${esc(trunc(label, 22))}</text></g>`);
    edges.push({ d: `M${a.ox} ${a.oy} L${endX} ${mid}`, on: false });
    endX += pw + GX;
    edges.push({ d: `M${endX - GX} ${mid} L${endX - TERM} ${mid}`, on: false });
  } else {
    edges.push({ d: `M${a.ox} ${a.oy} L${endX - TERM} ${mid}`, on: a.on });
  }
  edges.push({ d: `M${startX + TERM} ${mid} L${a.ix} ${a.iy}`, on: a.onIn ?? a.on });
  const result = invalid ? '' : run?.result || '';
  const endIcon = { SUCCESS: '✓', FAILURE: '✕', UNSTABLE: '!', ABORTED: '■' }[result] || '';
  const width = endX + TERM + 24;
  const height = top + total.h + 34;
  el.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Stage graph">
    ${edges.map((e) => `<path class="g-edge${e.on ? ' on' : ''}" d="${e.d}"/>`).join('')}
    <g class="g-term start"><title>${esc(contextName || 'trigger')}</title><circle cx="${startX}" cy="${mid}" r="${TERM}"/><text class="ic" x="${startX}" y="${mid + 5}" text-anchor="middle">▶</text>
      <text x="${startX}" y="${mid + TERM + 14}" text-anchor="middle">${esc(trunc(contextName || 'start', 16))}</text></g>
    ${parts.join('')}
    ${postParts.join('')}
    <g class="g-term end ${esc(result)}"><circle cx="${endX}" cy="${mid}" r="${TERM}"/><text class="ic" x="${endX}" y="${mid + 5}" text-anchor="middle">${endIcon}</text>
      <text x="${endX}" y="${mid + TERM + 14}" text-anchor="middle">${esc(result.toLowerCase() || 'end')}</text></g>
  </svg>`;
  el.querySelectorAll('.g-node').forEach((g) => {
    g.addEventListener('click', () => onSelect(g.dataset.id));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(g.dataset.id); } });
  });
}

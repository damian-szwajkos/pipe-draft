// Lightweight code editor: a transparent textarea over a highlighted <pre>.

import { tokenize } from '../engine/lexer.js';
import { KNOWN_STEPS, PIPELINE_SECTIONS, STAGE_SECTIONS, WHEN_CONDITIONS, POST_CONDITIONS } from '../engine/catalog.js';

const DSL = new Set([...PIPELINE_SECTIONS, ...STAGE_SECTIONS, ...WHEN_CONDITIONS, ...POST_CONDITIONS,
  'pipeline', 'stage', 'node', 'axes', 'axis', 'excludes', 'exclude', 'values', 'name', 'label', 'docker', 'dockerfile', 'script']);
const CLASS = ['', 't-kw', 't-str', 't-num', 't-com', 't-dsl', 't-step', 't-err'];
const SEV = ['', 'd-info', 'd-warning', 'd-error'];
const SEV_RANK = { info: 1, warning: 2, error: 3 };

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function createEditor(root, { onChange, onGutterClick }) {
  root.innerHTML = '';
  const gutter = document.createElement('div');
  gutter.className = 'ed-gutter';
  const area = document.createElement('div');
  area.className = 'ed-area';
  const pre = document.createElement('pre');
  pre.className = 'ed-hl';
  pre.setAttribute('aria-hidden', 'true');
  const ta = document.createElement('textarea');
  ta.className = 'ed-input';
  ta.spellcheck = false;
  ta.setAttribute('wrap', 'off');
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('aria-label', 'Jenkinsfile source');
  area.append(pre, ta);
  root.append(gutter, area);

  let deco = { diagnostics: [], lineInfo: new Map(), range: null };

  const sync = () => {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    gutter.scrollTop = ta.scrollTop;
  };
  ta.addEventListener('scroll', sync);

  function renderHighlight() {
    const text = ta.value;
    const n = text.length;
    const cls = new Uint8Array(n);
    const sev = new Uint8Array(n);
    const hl = new Uint8Array(n);
    const toks = tokenize(text, { comments: true, tolerant: true });
    for (const t of toks) {
      let c = 0;
      if (t.t === 'kw') c = 1;
      else if (t.t === 'str' || t.t === 'gstr') c = 2;
      else if (t.t === 'num') c = 3;
      else if (t.t === 'com') c = 4;
      else if (t.t === 'id') c = DSL.has(t.v) ? 5 : KNOWN_STEPS.has(t.v) ? 6 : 0;
      else if (t.t === 'err') c = 7;
      if (c) cls.fill(c, t.s, Math.min(t.e, n));
      if (t.t === 'gstr') {
        for (const p of t.parts) if (typeof p !== 'string') cls.fill(0, p.s, Math.min(p.e, n));
      }
    }
    for (const d of deco.diagnostics) {
      const r = SEV_RANK[d.severity] || 1;
      const s = Math.max(0, Math.min(d.s, n));
      let e = Math.max(s + 1, Math.min(d.e, n));
      if (s >= n) continue;
      // don't underline across lines for long ranges: first line only
      const nl = text.indexOf('\n', s);
      if (nl >= 0 && nl < e) e = Math.max(nl, s + 1);
      for (let i = s; i < e; i++) if (sev[i] < r) sev[i] = r;
    }
    if (deco.range) hl.fill(1, Math.max(0, deco.range.s), Math.min(n, deco.range.e));
    let html = '';
    let i = 0;
    while (i < n) {
      const c = cls[i];
      const sv = sev[i];
      const h = hl[i];
      let j = i + 1;
      while (j < n && cls[j] === c && sev[j] === sv && hl[j] === h) j++;
      const chunk = escapeHtml(text.slice(i, j));
      const classes = [CLASS[c], SEV[sv], h ? 'hl-range' : ''].filter(Boolean).join(' ');
      html += classes ? `<span class="${classes}">${chunk}</span>` : chunk;
      i = j;
    }
    pre.innerHTML = html + '\n ';
  }

  function renderGutter() {
    const lines = ta.value.split('\n').length;
    const parts = [];
    for (let l = 1; l <= lines; l++) {
      const info = deco.lineInfo.get(l);
      const cl = ['ln'];
      let title = '';
      let style = '';
      if (info) {
        if (info.cov) cl.push(`cov-${info.cov}`);
        if (info.diag) { cl.push(`diag-${info.diag}`); title = info.title || ''; }
        if (info.stage) { cl.push('stage-line'); style = ` style="--st: ${info.stage}"`; title = title || info.stageTitle || ''; }
        if (!title && info.covTitle) title = info.covTitle;
      }
      parts.push(`<div class="${cl.join(' ')}" data-line="${l}"${title ? ` title="${escapeHtml(title).replace(/"/g, '&quot;')}"` : ''}${style}>${l}</div>`);
    }
    gutter.innerHTML = parts.join('') + '<div style="height:40px"></div>';
    sync();
  }

  gutter.addEventListener('click', (e) => {
    const ln = e.target.closest('.ln');
    if (ln && onGutterClick) onGutterClick(Number(ln.dataset.line));
  });

  ta.addEventListener('input', () => {
    renderHighlight();
    renderGutter();
    onChange?.(ta.value);
  });

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = ta;
      if (e.shiftKey) {
        const ls = value.lastIndexOf('\n', s - 1) + 1;
        const m = value.slice(ls).match(/^ {1,4}/);
        if (m) {
          ta.setRangeText('', ls, ls + m[0].length, 'preserve');
        }
      } else if (s !== en && value.slice(s, en).includes('\n')) {
        const ls = value.lastIndexOf('\n', s - 1) + 1;
        const block = value.slice(ls, en).replace(/^/gm, '    ');
        ta.setRangeText(block, ls, en, 'select');
      } else {
        ta.setRangeText('    ', s, en, 'end');
      }
      ta.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const { selectionStart: s, selectionEnd: en, value } = ta;
      const ls = value.lastIndexOf('\n', s - 1) + 1;
      const indent = value.slice(ls).match(/^[ \t]*/)[0];
      const before = value.slice(ls, s).trimEnd();
      const extra = before.endsWith('{') || before.endsWith('(') || before.endsWith('[') ? '    ' : '';
      e.preventDefault();
      const after = value.slice(en).match(/^\s*[}\])]/);
      if (extra && after) {
        ta.setRangeText(`\n${indent}${extra}\n${indent}`, s, en, 'start');
        ta.selectionStart = ta.selectionEnd = s + 1 + indent.length + extra.length;
      } else {
        ta.setRangeText(`\n${indent}${extra}`, s, en, 'end');
      }
      ta.dispatchEvent(new Event('input'));
    } else if (e.key === '}' && !e.metaKey && !e.ctrlKey) {
      const { selectionStart: s, value } = ta;
      const ls = value.lastIndexOf('\n', s - 1) + 1;
      const lineBefore = value.slice(ls, s);
      if (/^ {4,}$/.test(lineBefore)) {
        e.preventDefault();
        ta.setRangeText('}', s - 4, s, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    }
  });

  function lineOf(pos) {
    let l = 1;
    const v = ta.value;
    for (let i = 0; i < pos && i < v.length; i++) if (v.charCodeAt(i) === 10) l++;
    return l;
  }

  return {
    getValue: () => ta.value,
    setValue(v) {
      ta.value = v;
      ta.scrollTop = 0;
      renderHighlight();
      renderGutter();
    },
    setDecorations(d) {
      deco = { ...deco, ...d };
      renderHighlight();
      renderGutter();
    },
    reveal(s, e, { select = true, focus = true } = {}) {
      const line = lineOf(s);
      const lineH = 20;
      const top = (line - 1) * lineH;
      if (top < ta.scrollTop + 20 || top > ta.scrollTop + ta.clientHeight - 60) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
      if (select) {
        if (focus) ta.focus({ preventScroll: true });
        ta.setSelectionRange(s, Math.max(s, e));
      }
      sync();
    },
    focus: () => ta.focus(),
  };
}

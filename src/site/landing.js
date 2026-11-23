// Landing page (index.html): nav, scroll reveal, embedded playground, structure-check demo, example cards.
import { EXAMPLES } from '../examples.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- nav + reveal
function initChrome() {
  const nav = document.querySelector('.nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 4);
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
}

let io = null;
function observeReveal(root) {
  const els = root.querySelectorAll('[data-reveal]:not(.in)');
  if (!('IntersectionObserver' in window)) { els.forEach((el) => el.classList.add('in')); return; }
  io = io || new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  els.forEach((el) => io.observe(el));
}

// ---------------------------------------------------------------- embedded playground
// The real app renders at a desktop size and is scaled down to the window width.
const APP_W = 1360;
function initStage() {
  const stage = document.getElementById('stage');
  const tpl = document.getElementById('stageFrame');
  const cover = document.getElementById('stageCover');
  if (!stage || !tpl) return;
  const wide = matchMedia('(min-width: 761px)');
  let frame = null;
  const fit = () => { if (frame) frame.style.setProperty('--s', String(stage.clientWidth / APP_W)); };
  const ro = 'ResizeObserver' in window ? new ResizeObserver(fit) : null;

  function mount() {
    if (frame || !wide.matches) return;
    frame = tpl.content.firstElementChild.cloneNode(true);
    frame.addEventListener('load', () => frame.classList.add('loaded'), { once: true });
    stage.insertBefore(frame, cover);
    fit();
    if (ro) ro.observe(stage); else addEventListener('resize', fit);
  }
  mount();
  wide.addEventListener?.('change', mount);

  // Until clicked, a cover keeps page scrolling from being captured by the embedded editor.
  cover?.addEventListener('click', () => {
    if (!frame) return;
    stage.classList.add('live');
    frame.removeAttribute('tabindex');
    frame.focus();
  });
}

// ---------------------------------------------------------------- feature (a): structure check with a fix
function initFixDemo() {
  const root = document.getElementById('fixDemo');
  if (!root) return;
  const field = root.querySelector('[data-field]');
  const line = root.querySelector('[data-line]');
  const card = root.querySelector('.problem');
  const msg = root.querySelector('[data-msg]');
  const meta = root.querySelector('[data-meta]');
  const dot = root.querySelector('[data-dot]');
  const btn = root.querySelector('[data-fix]');
  const orig = { msg: msg.innerHTML, meta: meta.textContent, dot: dot.innerHTML, btn: btn.innerHTML };
  msg.setAttribute('aria-live', 'polite');

  let fixed = false;
  btn.addEventListener('click', () => {
    fixed = !fixed;
    root.classList.toggle('fixed', fixed);
    card.classList.toggle('done', fixed);
    line.classList.toggle('err', !fixed);
    line.classList.toggle('ok', fixed);
    field.textContent = fixed ? 'branch' : 'branches';
    if (fixed) {
      msg.innerHTML = 'Valid: Jenkins would accept this file';
      meta.textContent = '0 problems';
      dot.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
      btn.className = 'undo';
      btn.textContent = 'Undo';
    } else {
      msg.innerHTML = orig.msg;
      meta.textContent = orig.meta;
      dot.innerHTML = orig.dot;
      btn.className = 'fix-btn';
      btn.innerHTML = orig.btn;
    }
  });
}

// ---------------------------------------------------------------- example cards
const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="4.5" cy="12" r="2.2"/><circle cx="19.5" cy="6.5" r="2.2"/><circle cx="19.5" cy="17.5" r="2.2"/><path d="M6.7 12h4.3M11 12c2.4 0 2.6-5.5 6.3-5.5M11 12c2.4 0 2.6 5.5 6.3 5.5"/></svg>';
const ARROW = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

function initExamples() {
  const grid = document.getElementById('examplesGrid');
  if (!grid) return;
  grid.innerHTML = EXAMPLES.map((ex, i) => {
    const n = ex.contexts ? ex.contexts.length : 6;
    const stages = (ex.source.match(/\bstage\s*\(/g) || []).length;
    return `<a class="sc" href="play.html?example=${encodeURIComponent(ex.id)}" data-reveal style="--d:${(i % 3) * 60}ms" aria-labelledby="t-${ex.id}" aria-describedby="d-${ex.id}">
      <div class="sc-top"><span class="tile" style="--hue:${esc(ex.hue || '#7c93ff')}">${ICON}</span></div>
      <div class="sc-ind">${esc(ex.tag || 'Example')}</div>
      <h3 id="t-${ex.id}">${esc(ex.title)}</h3>
      <p>${esc(ex.blurb || '')}</p>
      <div class="sc-foot" id="d-${ex.id}">
        <span class="meta">${stages} stage${stages === 1 ? '' : 's'}</span>
        <span class="meta">${n} context${n === 1 ? '' : 's'}</span>
        <span class="go" aria-hidden="true">${ARROW}</span>
      </div>
    </a>`;
  }).join('');
}

initChrome();
initStage();
initFixDemo();
initExamples();
observeReveal(document);

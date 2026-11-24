// The divider between the editor and the run pane: drag it to resize the
// editor, fold the editor away with the « button (or by dragging it nearly
// shut), and bring it back with the rail that takes its place.

const KEY = 'pipedraft:layout';
const MIN = 280;        // narrowest open editor
const MIN_RUN = 480;    // keep at least ~440px for the run pane (layout padding + divider included)
const SNAP = 180;       // dragging narrower than this folds the editor
const STEP = 24;        // arrow-key step

export function createSplit({ layout, pane, splitter, collapseBtn, expandBtn, persist = true, onChange = () => {} }) {
  let width = null;     // px; null = the stylesheet default (44%)
  let collapsed = false;
  if (persist) try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (Number.isFinite(s.width)) width = s.width;
    collapsed = !!s.collapsed;
  } catch { /* storage unavailable */ }

  const store = () => {
    if (persist) try { localStorage.setItem(KEY, JSON.stringify({ width, collapsed })); } catch { /* ignore */ }
  };
  const maxWidth = () => Math.max(MIN, layout.clientWidth - MIN_RUN);
  const clamp = (w) => Math.min(maxWidth(), Math.max(MIN, w));

  function apply() {
    layout.classList.toggle('collapsed', collapsed);
    if (width == null) layout.style.removeProperty('--editor-w');
    else layout.style.setProperty('--editor-w', `${Math.round(clamp(width))}px`);
    splitter.setAttribute('aria-expanded', String(!collapsed));
    splitter.setAttribute('aria-valuenow', String(Math.round(collapsed ? 0 : pane.getBoundingClientRect().width)));
    splitter.title = collapsed ? 'Show the editor' : 'Drag to resize · double-click to reset';
  }

  function setCollapsed(v, { focus = false } = {}) {
    if (collapsed === v) return;
    collapsed = v;
    apply();
    store();
    onChange({ collapsed });
    if (focus) (collapsed ? expandBtn : collapseBtn).focus();
  }

  // ---- dragging
  let drag = null;
  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    const left = layout.getBoundingClientRect().left + parseFloat(getComputedStyle(layout).paddingLeft);
    drag = { left, startX: e.clientX, moved: false, startWidth: width, wasCollapsed: collapsed };
    layout.classList.add('resizing');
  });
  splitter.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.startX) < 3) return;
    drag.moved = true;
    const w = e.clientX - drag.left;
    if (w < SNAP) {
      layout.classList.add('snap');   // preview: let go here and it folds
      return;
    }
    layout.classList.remove('snap');
    width = clamp(w);
    if (collapsed) { collapsed = false; onChange({ collapsed }); }
    apply();
  });
  const end = () => {
    if (!drag) return;
    const folded = layout.classList.contains('snap');
    const clicked = !drag.moved;
    const d = drag;
    drag = null;
    layout.classList.remove('resizing', 'snap');
    if (folded) {
      // fold, and reopen later at the width it had before this drag
      if (!d.wasCollapsed) width = d.startWidth;
      if (collapsed) store(); else setCollapsed(true);
    }
    else if (clicked && collapsed) setCollapsed(false);
    else store();
  };
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);
  splitter.addEventListener('lostpointercapture', end);

  splitter.addEventListener('dblclick', (e) => {
    if (collapsed || e.target.closest('button')) return;
    width = null;
    apply();
    store();
  });

  splitter.addEventListener('keydown', (e) => {
    const cur = pane.getBoundingClientRect().width;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (collapsed) { if (e.key === 'ArrowRight') setCollapsed(false); return; }
      const next = cur + (e.key === 'ArrowRight' ? STEP : -STEP);
      if (next < MIN) { setCollapsed(true); return; }
      width = clamp(next);
      apply();
      store();
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (e.target !== splitter) return;
      e.preventDefault();
      setCollapsed(!collapsed);
    }
  });

  collapseBtn.addEventListener('click', () => setCollapsed(true, { focus: true }));
  expandBtn.addEventListener('click', () => setCollapsed(false, { focus: true }));

  // keep a stored width valid when the window shrinks
  window.addEventListener('resize', () => { if (width != null && !collapsed) apply(); });

  apply();
  return {
    get collapsed() { return collapsed; },
    expand: () => setCollapsed(false),
    collapse: () => setCollapsed(true),
  };
}

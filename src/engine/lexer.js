// Groovy-subset lexer. Produces tokens with absolute start/end offsets and a
// `nl` flag that tells whether a line break precedes the token (Groovy uses
// newlines as statement terminators).

export class PipelineSyntaxError extends Error {
  constructor(message, range, hint) {
    super(message);
    this.range = range; // { s, e } absolute offsets
    this.hint = hint || null;
  }
}

export const KEYWORDS = new Set([
  'def', 'if', 'else', 'for', 'while', 'do', 'in', 'return', 'try', 'catch', 'finally',
  'throw', 'new', 'true', 'false', 'null', 'break', 'continue', 'instanceof', 'as',
  'switch', 'case', 'default', 'import',
]);

const OPS3 = ['..<', '==~', '<=>', '===', '!=='];
const OPS2 = ['?.', '*.', '?:', '==', '!=', '<=', '>=', '&&', '||', '=~', '++', '--', '+=', '-=',
  '*=', '/=', '%=', '->', '<<', '>>', '..', '**'];
const OPS1 = '+-*/%=<>!?:.,;(){}[]&|^~@';

// After these tokens a '/' starts a slashy string (regex), not a division.
const REGEX_PREV_OPS = new Set(['=~', '==~', '(', ',', '=', ':', '[', '!', '&&', '||', '?', '{', ';',
  '~', '==', '!=', '->', '+']);

const isIdStart = (c) => /[A-Za-z_$]/.test(c);
const isId = (c) => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c) => c >= '0' && c <= '9';

/**
 * @param {string} text
 * @param {{start?:number,end?:number,comments?:boolean,tolerant?:boolean}} opts
 */
export function tokenize(text, opts = {}) {
  const start = opts.start ?? 0;
  const end = opts.end ?? text.length;
  const toks = [];
  let i = start;
  let nl = start === 0;

  const err = (msg, s, e, hint) => {
    if (opts.tolerant) {
      toks.push({ t: 'err', s, e: end, nl });
      i = end;
      return true;
    }
    throw new PipelineSyntaxError(msg, { s, e: Math.max(e, s + 1) }, hint);
  };

  const prevSignificant = () => {
    for (let k = toks.length - 1; k >= 0; k--) if (toks[k].t !== 'com') return toks[k];
    return null;
  };

  while (i < end) {
    const c = text[i];
    // whitespace
    if (c === '\n') { nl = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
    // line continuation
    if (c === '\\' && text[i + 1] === '\n') { i += 2; continue; }
    // shebang
    if (i === 0 && c === '#' && text[1] === '!') {
      const j = text.indexOf('\n', i);
      i = j < 0 ? end : j;
      continue;
    }
    // comments
    if (c === '/' && text[i + 1] === '/') {
      let j = text.indexOf('\n', i);
      if (j < 0 || j > end) j = end;
      if (opts.comments) toks.push({ t: 'com', s: i, e: j, nl });
      i = j;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      let j = text.indexOf('*/', i + 2);
      if (j < 0 || j + 2 > end) {
        if (err('Unterminated comment: "/*" is never closed with "*/"', i, i + 2)) break;
      }
      const body = text.slice(i, j + 2);
      if (opts.comments) toks.push({ t: 'com', s: i, e: j + 2, nl });
      if (body.includes('\n')) nl = true;
      i = j + 2;
      continue;
    }

    const s = i;
    // strings
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      i += q.length;
      const gstring = c === '"';
      const parts = [];
      let buf = '';
      let closed = false;
      while (i < end) {
        if (text.startsWith(q, i)) { i += q.length; closed = true; break; }
        const ch = text[i];
        if (ch === '\n' && !triple) break;
        if (ch === '\\') {
          const n = text[i + 1];
          const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '\\': '\\', "'": "'", '"': '"', $: '$' };
          if (n === '\n') { i += 2; continue; }
          if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
            buf += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          buf += n in map ? map[n] : n;
          i += 2;
          continue;
        }
        if (gstring && ch === '$' && text[i + 1] === '{') {
          // find matching brace
          let depth = 1;
          let j = i + 2;
          while (j < end && depth > 0) {
            const cj = text[j];
            if (cj === '{') depth++;
            else if (cj === '}') depth--;
            else if (cj === "'" || cj === '"') {
              const qq = cj;
              j++;
              while (j < end && text[j] !== qq && text[j] !== '\n') { if (text[j] === '\\') j++; j++; }
            }
            if (depth > 0) j++;
          }
          if (depth > 0) {
            if (err('Unclosed "${" inside a string', i, i + 2, 'Every ${ must be closed with }')) break;
          }
          if (buf) { parts.push(buf); buf = ''; }
          parts.push({ expr: true, s: i + 2, e: j });
          i = j + 1;
          continue;
        }
        if (gstring && ch === '$' && isIdStart(text[i + 1]) && text[i + 1] !== '$') {
          let j = i + 1;
          while (j < end && isId(text[j]) && text[j] !== '$') j++;
          while (text[j] === '.' && isIdStart(text[j + 1])) {
            j++;
            while (j < end && isId(text[j]) && text[j] !== '$') j++;
          }
          if (buf) { parts.push(buf); buf = ''; }
          parts.push({ expr: true, s: i + 1, e: j });
          i = j;
          continue;
        }
        buf += ch;
        i++;
      }
      if (!closed) {
        if (err(`Unterminated string: the ${q} opened here is never closed`, s, s + q.length,
          triple ? `Close it with ${q}` : 'Strings in single or double quotes cannot span lines. Use triple quotes (\'\'\' or """) for multi-line text.')) break;
      }
      if (buf || parts.length === 0) parts.push(buf);
      const hasExpr = parts.some((p) => typeof p !== 'string');
      if (hasExpr) toks.push({ t: 'gstr', parts, s, e: i, nl, quote: q });
      else toks.push({ t: 'str', v: parts.join(''), s, e: i, nl, quote: q });
      nl = false;
      continue;
    }
    // slashy string (regex)
    if (c === '/') {
      const p = prevSignificant();
      const regexOk = !p || (p.t === 'op' && REGEX_PREV_OPS.has(p.v)) || (p.t === 'kw' && (p.v === 'return' || p.v === 'in'));
      if (regexOk && text[i + 1] !== '=' && text[i + 1] !== ' ') {
        let j = i + 1;
        let buf = '';
        let closed = false;
        while (j < end && text[j] !== '\n') {
          if (text[j] === '\\' && text[j + 1] === '/') { buf += '/'; j += 2; continue; }
          if (text[j] === '/') { closed = true; break; }
          buf += text[j];
          j++;
        }
        if (closed) {
          toks.push({ t: 'str', v: buf, s, e: j + 1, nl, regex: true, quote: '/' });
          i = j + 1;
          nl = false;
          continue;
        }
      }
    }
    // numbers
    if (isDigit(c)) {
      let j = i;
      while (isDigit(text[j]) || text[j] === '_') j++;
      if (text[j] === '.' && isDigit(text[j + 1])) {
        j++;
        while (isDigit(text[j])) j++;
      }
      if ((text[j] === 'e' || text[j] === 'E') && /[0-9+-]/.test(text[j + 1])) {
        j += 2;
        while (isDigit(text[j])) j++;
      }
      const raw = text.slice(i, j).replace(/_/g, '');
      if (/[lLgGdDfFiI]/.test(text[j] || '')) j++;
      toks.push({ t: 'num', v: Number(raw), s, e: j, nl });
      i = j;
      nl = false;
      continue;
    }
    // identifiers / keywords
    if (isIdStart(c)) {
      let j = i;
      while (j < end && isId(text[j])) j++;
      const w = text.slice(i, j);
      toks.push({ t: KEYWORDS.has(w) ? 'kw' : 'id', v: w, s, e: j, nl });
      i = j;
      nl = false;
      continue;
    }
    // operators
    let op = null;
    for (const o of OPS3) if (text.startsWith(o, i)) { op = o; break; }
    if (!op) for (const o of OPS2) if (text.startsWith(o, i)) { op = o; break; }
    if (!op && OPS1.includes(c)) op = c;
    if (op) {
      toks.push({ t: 'op', v: op, s, e: i + op.length, nl });
      i += op.length;
      nl = false;
      continue;
    }
    if (err(`Unexpected character '${c}'`, i, i + 1)) break;
  }
  toks.push({ t: 'eof', s: end, e: end, nl: true });
  return toks;
}

/** Build a helper that turns absolute offsets into 1-based line/column. */
export function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lc = (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: pos - starts[lo] + 1 };
  };
  return { starts, lc, line: (pos) => lc(pos).line };
}

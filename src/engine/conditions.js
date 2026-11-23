// `when` conditions: a static, human-readable description and a runtime
// evaluation that explains every sub-condition.

const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** Ant-style simple glob (used by branch / tag): `*` matches anything, `?` one character. */
export function simpleGlob(pattern, caseSensitive = true) {
  const re = '^' + [...pattern].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : esc(c))).join('') + '$';
  return new RegExp(re, caseSensitive ? '' : 'i');
}

/** Ant path glob (used by changeset): `**` crosses directories, `*` stays inside one. */
export function pathGlob(pattern, caseSensitive = false) {
  let re = '';
  const p = pattern.replace(/\\/g, '/');
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += esc(c);
  }
  return new RegExp('^' + re + '$', caseSensitive ? '' : 'i');
}

function compare(actual, pattern, comparator = 'GLOB', caseSensitive = true, path = false) {
  if (actual == null) return false;
  const a = String(actual);
  const p = String(pattern);
  switch (String(comparator).toUpperCase()) {
    case 'EQUALS': return caseSensitive ? a === p : a.toLowerCase() === p.toLowerCase();
    case 'REGEXP': {
      try { return new RegExp('^(?:' + p + ')$', caseSensitive ? '' : 'i').test(a); } catch { return false; }
    }
    default: return (path ? pathGlob(p, caseSensitive) : simpleGlob(p, caseSensitive)).test(a);
  }
}

const q = (v) => (v == null ? 'null' : `'${v}'`);

/** Static description of a condition (used in the graph and stage details). */
export function describeCond(c, src) {
  const arg = (k) => {
    const n = c.pos[0] || c.named[k];
    if (!n) return '?';
    if (n.type === 'Literal') return n.value;
    return src(n);
  };
  const named = (k) => (c.named[k] ? (c.named[k].type === 'Literal' ? c.named[k].value : src(c.named[k])) : null);
  switch (c.type) {
    case 'branch': return `branch ${named('comparator') === 'REGEXP' ? 'matches regex' : 'is'} ${q(arg('pattern'))}`;
    case 'buildingTag': return 'building a tag';
    case 'tag': return c.pos[0] || c.named.pattern ? `tag is ${q(arg('pattern'))}` : 'building a tag';
    case 'changeRequest': {
      const attrs = Object.keys(c.named).filter((k) => k !== 'comparator').map((k) => `${k} ${q(named(k))}`);
      return attrs.length ? `pull request with ${attrs.join(', ')}` : 'a pull request';
    }
    case 'changeset': return `changed files match ${q(arg('pattern'))}`;
    case 'changelog': return `a commit message matches /${arg('pattern')}/`;
    case 'environment': return `env.${named('name')} == ${q(named('value'))}`;
    case 'equals': return `${named('actual')} == ${named('expected')}`;
    case 'expression': {
      const body = c.closure ? c.closure.body : [];
      const text = body.length ? src({ s: body[0].s, e: body[body.length - 1].e }) : '';
      return `expression { ${text.replace(/^return\s+/, '')} }`;
    }
    case 'triggeredBy': return `triggered by ${arg('cause')}`;
    case 'isRestartedRun': return 'restarted from a stage';
    case 'not': return `NOT (${c.children.map((x) => describeCond(x, src)).join(' AND ')})`;
    case 'allOf': return c.children.map((x) => wrap(x, src)).join(' AND ');
    case 'anyOf': return c.children.map((x) => wrap(x, src)).join(' OR ');
    default: return c.type;
  }
}

function wrap(c, src) {
  const d = describeCond(c, src);
  return c.type === 'allOf' || c.type === 'anyOf' ? `(${d})` : d;
}

export function describeWhen(when, src) {
  if (!when || !when.conds.length) return null;
  return when.conds.map((c) => wrap(c, src)).join(' AND ');
}

/**
 * Evaluate a when block.
 * @param host { env(name), evalNode(node), callClosure(closure), causes, changedFiles, commitMessages }
 * @returns {{value:boolean, tree:Array}}
 */
export function evaluateWhen(when, host, src) {
  const tree = [];
  let value = true;
  for (const c of when.conds) {
    if (!value) { tree.push(notEvaluated(c, src)); continue; }
    const r = evalCond(c, host, src);
    tree.push(r);
    if (!r.value) value = false;
  }
  return { value, tree };
}

function notEvaluated(c, src) {
  return { text: describeCond(c, src), value: null, detail: 'not evaluated (an earlier condition was false)', children: [], s: c.s, e: c.e };
}

function evalCond(c, host, src) {
  const text = describeCond(c, src);
  const val = (node) => (node ? host.evalNode(node) : null);
  const arg = (k) => val(c.pos[0] || c.named[k]);
  const named = (k) => val(c.named[k]);
  const out = (value, detail, children = []) => ({ text, value: !!value, detail, children, s: c.s, e: c.e });
  const cs = named('caseSensitive');
  switch (c.type) {
    case 'branch': {
      const b = host.env('BRANCH_NAME');
      const ok = compare(b, arg('pattern'), named('comparator') || 'GLOB', true);
      let detail = `BRANCH_NAME = ${q(b)}`;
      if (!ok && host.env('CHANGE_ID')) detail += ` (pull request builds use PR-${host.env('CHANGE_ID')}; use changeRequest target: '…' to match the target branch)`;
      if (!ok && host.env('TAG_NAME')) detail += ' (tag builds use the tag name as BRANCH_NAME)';
      return out(ok, detail);
    }
    case 'buildingTag': {
      const t = host.env('TAG_NAME');
      return out(!!t, t ? `TAG_NAME = ${q(t)}` : 'TAG_NAME is not set: this build is not for a tag');
    }
    case 'tag': {
      const t = host.env('TAG_NAME');
      const p = c.pos[0] || c.named.pattern ? arg('pattern') : null;
      if (!t) return out(false, 'TAG_NAME is not set: this build is not for a tag');
      if (p == null) return out(true, `TAG_NAME = ${q(t)}`);
      return out(compare(t, p, named('comparator') || 'GLOB'), `TAG_NAME = ${q(t)}`);
    }
    case 'changeRequest': {
      const id = host.env('CHANGE_ID');
      if (!id) return out(false, 'CHANGE_ID is not set: this build is not for a pull request');
      const map = { id: 'CHANGE_ID', target: 'CHANGE_TARGET', branch: 'CHANGE_BRANCH', fork: 'CHANGE_FORK', url: 'CHANGE_URL', title: 'CHANGE_TITLE',
        author: 'CHANGE_AUTHOR', authorDisplayName: 'CHANGE_AUTHOR_DISPLAY_NAME', authorEmail: 'CHANGE_AUTHOR_EMAIL' };
      const cmp = named('comparator') || 'EQUALS';
      const parts = [];
      let ok = true;
      for (const k of Object.keys(c.named)) {
        if (!map[k]) continue;
        const actual = host.env(map[k]);
        const m = compare(actual, named(k), cmp);
        parts.push(`${map[k]} = ${q(actual)}`);
        if (!m) ok = false;
      }
      return out(ok, parts.length ? parts.join(', ') : `CHANGE_ID = ${q(id)}`);
    }
    case 'changeset': {
      const files = host.changedFiles();
      const p = arg('pattern');
      const hit = files.filter((f) => compare(f, p, named('comparator') || 'GLOB', cs === true, true));
      if (!files.length) return out(false, 'no changed files in this build (first build of a branch has no changeset)');
      return out(hit.length > 0, hit.length ? `matched: ${hit.slice(0, 4).join(', ')}${hit.length > 4 ? '…' : ''}` : `changed: ${files.slice(0, 4).join(', ')}${files.length > 4 ? '…' : ''}`);
    }
    case 'changelog': {
      const msgs = host.commitMessages();
      let re;
      try { re = new RegExp(arg('pattern'), 's'); } catch (e) { return out(false, `invalid regex: ${e.message}`); }
      const hit = msgs.find((m) => re.test(m));
      return out(!!hit, hit ? `matched commit: "${hit.split('\n')[0]}"` : `no commit message matches (${msgs.length} commit${msgs.length === 1 ? '' : 's'})`);
    }
    case 'environment': {
      const name = named('name');
      const actual = host.env(name);
      const ok = compare(actual, named('value'), named('comparator') || 'EQUALS', named('ignoreCase') !== true);
      return out(ok, `${name} = ${q(actual)}`);
    }
    case 'equals': {
      const a = named('actual');
      const e = named('expected');
      return out(host.equals(a, e), `actual = ${host.str(a)}, expected = ${host.str(e)}`);
    }
    case 'expression': {
      const r = host.callClosure(c.closure);
      return out(host.truthy(r), `returned ${host.str(r)}`);
    }
    case 'triggeredBy': {
      const cause = arg('cause');
      const detailWanted = named('detail');
      const causes = host.causes();
      const hit = causes.find((x) => x.cls.includes(cause) && (detailWanted == null || x.detail === detailWanted));
      return out(!!hit, `build causes: ${causes.map((x) => x.cls.split('.').pop()).join(', ') || 'none'}`);
    }
    case 'isRestartedRun': return out(false, 'not a restarted run');
    case 'not': {
      const ch = c.children.map((x) => evalCond(x, host, src));
      const v = ch.length ? !ch[0].value : true;
      return out(v, null, ch);
    }
    case 'allOf': {
      const ch = [];
      let v = true;
      for (const x of c.children) {
        if (!v) { ch.push(notEvaluated(x, src)); continue; }
        const r = evalCond(x, host, src);
        ch.push(r);
        if (!r.value) v = false;
      }
      return out(v, null, ch);
    }
    case 'anyOf': {
      const ch = [];
      let v = false;
      for (const x of c.children) {
        if (v) { ch.push({ ...notEvaluated(x, src), detail: 'not evaluated (an earlier condition was true)' }); continue; }
        const r = evalCond(x, host, src);
        ch.push(r);
        if (r.value) v = true;
      }
      return out(v, null, ch);
    }
    default: return out(false, 'unknown condition');
  }
}

/** First false leaf of an evaluation tree: the short reason a stage was skipped. */
export function failingLeaf(tree) {
  for (const n of tree) {
    if (n.value === false) {
      if (n.children.length && n.text.startsWith('NOT')) return n;
      if (n.children.length) {
        const inner = failingLeaf(n.children);
        if (inner && !n.text.includes(' OR ')) return inner;
        return n;
      }
      return n;
    }
  }
  return null;
}

// A small Groovy interpreter: enough of the language for Jenkinsfiles
// (closures, GStrings, collections, control flow, exceptions). Jenkins steps
// are delegated to a host.

export class GClosure {
  constructor(node, scope, interp) { this.node = node; this.scope = scope; this.interp = interp; }
  call(...args) { return this.interp.invokeClosure(this, args); }
}

/** A Groovy-visible exception value. */
export class GError extends Error {
  constructor(cls, message, extra = {}) {
    super(message);
    this.cls = cls;
    Object.assign(this, extra);
  }
}

/** Thrown when a pipeline step fails (error step, non-zero sh exit, rejected input...). */
export class StepFailure extends GError {
  constructor(message, result = 'FAILURE', cls = 'hudson.AbortException', extra = {}) {
    super(cls, message, extra);
    this.result = result;
  }
}

class ReturnSig { constructor(v) { this.v = v; } }
class BreakSig {}
class ContinueSig {}

export class Scope {
  constructor(parent = null) { this.vars = new Map(); this.parent = parent; }
  lookup(name) {
    for (let s = this; s; s = s.parent) if (s.vars.has(name)) return { found: true, value: s.vars.get(name), scope: s };
    return { found: false };
  }
  declare(name, v) { this.vars.set(name, v); }
  root() { let s = this; while (s.parent) s = s.parent; return s; }
  assign(name, v) {
    const r = this.lookup(name);
    if (r.found) r.scope.vars.set(name, v);
    else this.root().vars.set(name, v); // undeclared → script binding
  }
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof GClosure) &&
  !(v instanceof Error) && !v.__special && !(v instanceof Matcher);

class Matcher {
  constructor(str, re) {
    this.matches = [...String(str).matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
  }
}

export function toStr(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(toStr).join(', ') + ']';
  if (v instanceof GClosure) return 'Closure';
  if (v instanceof GError) return `${v.cls}: ${v.message}`;
  if (v instanceof Matcher) return 'java.util.regex.Matcher';
  if (v.__special) return v.__str ? v.__str() : v.__special;
  if (isMap(v)) {
    const keys = Object.keys(v);
    return keys.length ? '[' + keys.map((k) => `${k}:${toStr(v[k])}`).join(', ') + ']' : '[:]';
  }
  return String(v);
}

export function truthy(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Matcher) return v.matches.length > 0;
  if (isMap(v)) return Object.keys(v).length > 0;
  return true;
}

export function gEquals(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => gEquals(x, b[i]));
  if (isMap(a) && isMap(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => gEquals(a[k], b[k]));
  }
  return false;
}

function typeName(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return 'java.lang.String';
  if (typeof v === 'number') return Number.isInteger(v) ? 'java.lang.Integer' : 'java.math.BigDecimal';
  if (typeof v === 'boolean') return 'java.lang.Boolean';
  if (Array.isArray(v)) return 'java.util.ArrayList';
  if (v instanceof GClosure) return 'groovy.lang.Closure';
  if (v instanceof GError) return v.cls;
  if (v.__special) return v.__special;
  return 'java.util.LinkedHashMap';
}

function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function toRegex(p) {
  if (p instanceof RegExp) return p;
  try { return new RegExp(String(p)); } catch (e) {
    throw new GError('java.util.regex.PatternSyntaxException', `${e.message} near pattern ${p}`);
  }
}

export class Interp {
  /**
   * @param host {{ callStep(name,pos,named,node,scope):any, global(name):{found,value}, hit(node):void,
   *               branch(node,taken):void, budget:number }}
   */
  constructor(program, text, host) {
    this.program = program;
    this.text = text;
    this.host = host;
    this.methods = new Map(program.methods.map((m) => [m.name, m]));
    this.binding = new Scope(null);
    this.script = new Scope(this.binding);
    this.ops = 0;
    this.depth = 0;
  }

  src(n) { return this.text.slice(n.s, n.e); }

  tick(node) {
    if (++this.ops > this.host.budget) {
      throw new GError('org.jenkinsci.plugins.scriptsecurity.TimeoutException', 'Execution limit reached: possible infinite loop', { node });
    }
  }

  // ---------------- statements
  execBlock(stmts, scope) {
    let last = null;
    for (const st of stmts) last = this.exec(st, scope);
    return last;
  }

  exec(st, scope) {
    this.tick(st);
    this.host.hit(st);
    switch (st.type) {
      case 'ExprStmt': return this.eval(st.expr, scope);
      case 'VarDecl': scope.declare(st.name, st.init ? this.eval(st.init, scope) : null); return null;
      case 'MultiDecl': {
        const v = st.init ? this.eval(st.init, scope) : [];
        st.names.forEach((n, i) => scope.declare(n, Array.isArray(v) ? v[i] ?? null : null));
        return null;
      }
      case 'Block': return this.execBlock(st.body, new Scope(scope));
      case 'If': {
        const v = truthy(this.eval(st.test, scope));
        this.host.branch(st, v);
        if (v) return this.execBody(st.then, scope);
        if (st.alt) return this.execBody(st.alt, scope);
        return null;
      }
      case 'ForIn': {
        const it = this.iterable(this.eval(st.iter, scope), st.iter);
        for (const v of it) {
          const s = new Scope(scope);
          s.declare(st.name, v);
          try { this.execBody(st.body, s); } catch (e) {
            if (e instanceof BreakSig) break;
            if (e instanceof ContinueSig) continue;
            throw e;
          }
        }
        return null;
      }
      case 'ForC': {
        const s = new Scope(scope);
        if (st.init) this.exec(st.init, s);
        while (!st.test || truthy(this.eval(st.test, s))) {
          this.tick(st);
          try { this.execBody(st.body, new Scope(s)); } catch (e) {
            if (e instanceof BreakSig) break;
            if (!(e instanceof ContinueSig)) throw e;
          }
          if (st.update) this.eval(st.update, s);
        }
        return null;
      }
      case 'While': {
        while (truthy(this.eval(st.test, scope))) {
          this.tick(st);
          try { this.execBody(st.body, new Scope(scope)); } catch (e) {
            if (e instanceof BreakSig) break;
            if (!(e instanceof ContinueSig)) throw e;
          }
        }
        return null;
      }
      case 'Try': {
        try {
          this.execBlock(st.block.body, new Scope(scope));
        } catch (e) {
          if (e instanceof ReturnSig || e instanceof BreakSig || e instanceof ContinueSig) throw e;
          const err = this.asGroovyError(e, st);
          const handler = st.catches.find((c) => this.catchMatches(c, err));
          if (!handler) throw err;
          this.host.caught?.(handler, err);
          const s = new Scope(scope);
          s.declare(handler.name, err);
          this.execBlock(handler.body.body, s);
        } finally {
          if (st.fin) this.execBlock(st.fin.body, new Scope(scope));
        }
        return null;
      }
      case 'Switch': {
        const v = this.eval(st.disc, scope);
        let matched = false;
        try {
          for (const c of st.cases) {
            if (!matched) {
              if (c.isDefault) matched = true;
              else matched = c.tests.some((t) => this.caseMatch(v, this.eval(t, scope)));
            }
            if (matched) this.execBlock(c.body, scope);
          }
        } catch (e) { if (!(e instanceof BreakSig)) throw e; }
        return null;
      }
      case 'Return': throw new ReturnSig(st.arg ? this.eval(st.arg, scope) : null);
      case 'Throw': {
        const v = this.eval(st.arg, scope);
        if (v instanceof Error) throw v;
        throw new GError('java.lang.Exception', toStr(v));
      }
      case 'Break': throw new BreakSig();
      case 'Continue': throw new ContinueSig();
      case 'MethodDecl': case 'Import': case 'Annotation': return null;
      default: throw new GError('groovy.lang.GroovyRuntimeException', `Unsupported statement ${st.type}`, { node: st });
    }
  }

  execBody(b, scope) {
    if (b.type === 'Block') return this.execBlock(b.body, new Scope(scope));
    return this.exec(b, new Scope(scope));
  }

  caseMatch(v, t) {
    if (Array.isArray(t)) return t.some((x) => gEquals(x, v));
    if (t instanceof GClosure) return truthy(this.invokeClosure(t, [v]));
    return gEquals(v, t);
  }

  catchMatches(c, err) {
    if (!c.types.length) return !(err.cls || '').includes('FlowInterruptedException') || true;
    return c.types.some((t) => {
      const short = t.split('.').pop();
      if (['Exception', 'Throwable', 'Error', 'RuntimeException'].includes(short)) return true;
      return (err.cls || '').split('.').pop() === short || (err.cls || '').endsWith(short);
    });
  }

  asGroovyError(e, node) {
    if (e instanceof GError) return e;
    // internal JS error: surface it as a Groovy runtime error
    return new GError('groovy.lang.GroovyRuntimeException', e && e.message ? e.message : String(e), { node });
  }

  iterable(v, node) {
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return [...v];
    if (isMap(v)) return Object.entries(v).map(([key, value]) => ({ key, value, __entry: true }));
    if (typeof v === 'number') return Array.from({ length: v }, (_, i) => i);
    throw new GError('groovy.lang.MissingMethodException', `Cannot iterate over ${typeName(v)}`, { node });
  }

  // ---------------- closures & methods
  invokeClosure(cl, args) {
    if (++this.depth > 200) { this.depth = 0; throw new GError('java.lang.StackOverflowError', 'Closure recursion too deep'); }
    try {
      const s = new Scope(cl.scope);
      const params = cl.node.params;
      if (params === null) s.declare('it', args.length ? args[0] : null);
      else if (params.length === 2 && args.length === 1 && args[0] && args[0].__entry) {
        s.declare(params[0], args[0].key);
        s.declare(params[1], args[0].value);
      } else params.forEach((p, i) => s.declare(p, i < args.length ? args[i] : null));
      try {
        return this.execBlock(cl.node.body, s);
      } catch (e) {
        if (e instanceof ReturnSig) return e.v;
        throw e;
      }
    } finally { this.depth--; }
  }

  invokeMethod(m, args, node) {
    if (++this.depth > 200) { this.depth = 0; throw new GError('java.lang.StackOverflowError', `Recursion too deep in ${m.name}()`, { node }); }
    try {
      const s = new Scope(this.binding); // methods do not see script-local `def` variables
      m.params.forEach((p, i) => s.declare(p.name, i < args.length ? args[i] : (p.def ? this.eval(p.def, s) : null)));
      if (args.length > m.params.length && !m.params.length) {
        throw new GError('groovy.lang.MissingMethodException', `No signature of method: WorkflowScript.${m.name}() is applicable for argument types: (${args.map(typeName).join(', ')})`, { node });
      }
      try { return this.execBlock(m.body, s); } catch (e) {
        if (e instanceof ReturnSig) return e.v;
        throw e;
      }
    } finally { this.depth--; }
  }

  // ---------------- expressions
  eval(n, scope) {
    this.tick(n);
    switch (n.type) {
      case 'Literal': return n.value;
      case 'GString': return n.parts.map((p) => (typeof p === 'string' ? p : toStr(this.eval(p, scope)))).join('');
      case 'Ident': return this.resolve(n.name, scope, n);
      case 'Paren': return this.eval(n.expr, scope);
      case 'ListLit': return n.items.map((x) => this.eval(x, scope));
      case 'MapLit': {
        const o = {};
        for (const en of n.entries) o[en.key !== undefined ? en.key : toStr(this.eval(en.keyExpr, scope))] = this.eval(en.value, scope);
        return o;
      }
      case 'Closure': return new GClosure(n, scope, this);
      case 'Member': {
        const obj = this.eval(n.object, scope);
        if (obj == null && n.safe) return null;
        if (n.spread) return (obj || []).map((x) => this.getProp(x, n.prop, n));
        return this.getProp(obj, n.prop, n);
      }
      case 'Index': {
        const obj = this.eval(n.object, scope);
        const idx = this.eval(n.index, scope);
        return this.getIndex(obj, idx, n);
      }
      case 'Call': return this.evalCall(n, scope);
      case 'Unary': {
        const v = this.eval(n.arg, scope);
        if (n.op === '!') return !truthy(v);
        if (n.op === '-') return -this.num(v, n);
        if (n.op === '+') return this.num(v, n);
        if (n.op === '~') return toRegex(v);
        return null;
      }
      case 'Update': {
        const old = this.num(this.eval(n.arg, scope), n);
        const nv = n.op === '++' ? old + 1 : old - 1;
        this.assignTo(n.arg, nv, scope);
        return n.prefix ? nv : old;
      }
      case 'Binary': return this.binary(n, scope);
      case 'Ternary': return truthy(this.eval(n.test, scope)) ? this.eval(n.cons, scope) : this.eval(n.alt, scope);
      case 'Elvis': {
        const l = this.eval(n.left, scope);
        return truthy(l) ? l : this.eval(n.right, scope);
      }
      case 'Assign': {
        let v = this.eval(n.value, scope);
        if (n.op !== '=') {
          const cur = this.eval(n.target, scope);
          v = this.arith(n.op[0], cur, v, n);
        }
        this.assignTo(n.target, v, scope);
        return v;
      }
      case 'Range': {
        const a = this.eval(n.from, scope);
        const b = this.eval(n.to, scope);
        const out = [];
        const end = n.exclusive ? b - 1 : b;
        if (a <= end) for (let i = a; i <= end && out.length < 10000; i++) out.push(i);
        else for (let i = a; i >= end && out.length < 10000; i--) out.push(i);
        return out;
      }
      case 'Cast': {
        const v = this.eval(n.expr, scope);
        const t = n.to.split('.').pop();
        if (['int', 'Integer', 'long', 'Long'].includes(t)) return parseInt(v, 10);
        if (['String'].includes(t)) return toStr(v);
        if (['boolean', 'Boolean'].includes(t)) return truthy(v);
        if (['List', 'ArrayList'].includes(t)) return Array.isArray(v) ? v : [v];
        return v;
      }
      case 'InstanceOf': {
        const v = this.eval(n.expr, scope);
        const t = n.cls.split('.').pop();
        const tn = typeName(v).split('.').pop();
        if (t === 'String') return typeof v === 'string';
        if (t === 'List' || t === 'Collection') return Array.isArray(v);
        if (t === 'Map') return isMap(v);
        if (t === 'Exception' || t === 'Throwable') return v instanceof Error;
        return tn === t;
      }
      case 'New': return this.construct(n, scope);
      default:
        throw new GError('groovy.lang.GroovyRuntimeException', `Unsupported expression ${n.type}`, { node: n });
    }
  }

  num(v, n) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
      throw new GError('groovy.lang.MissingMethodException', `No signature of method: java.lang.String.negative() is applicable (did you forget .toInteger()?)`, { node: n });
    }
    throw new GError('java.lang.NullPointerException', `Cannot do arithmetic on ${typeName(v)}`, { node: n });
  }

  construct(n, scope) {
    const args = n.args.map((a) => this.eval(a, scope));
    const cls = n.cls.split('.').pop();
    if (/Exception$|Error$|^Throwable$/.test(cls)) {
      const msg = args.length ? toStr(args[0]) : null;
      return new GError(n.cls.includes('.') ? n.cls : (cls === 'AbortException' ? 'hudson.AbortException' : `java.lang.${cls}`), msg);
    }
    if (cls === 'Date') return { __special: 'java.util.Date', __str: () => '2026-11-23T10:00:00Z', format: (f) => '2026-11-23' };
    if (cls === 'JsonSlurper' || cls === 'JsonSlurperClassic') {
      return { __special: 'groovy.json.JsonSlurper', parseText: (t) => { try { return JSON.parse(t); } catch { throw new GError('groovy.json.JsonException', 'Unable to parse JSON'); } } };
    }
    if (cls === 'ArrayList' || cls === 'LinkedList') return [];
    if (cls === 'HashMap' || cls === 'LinkedHashMap') return {};
    if (cls === 'StringBuilder' || cls === 'StringBuffer') {
      const sb = { __special: 'java.lang.StringBuilder', buf: args.length ? toStr(args[0]) : '' };
      sb.append = (x) => { sb.buf += toStr(x); return sb; };
      sb.__str = () => sb.buf;
      sb.toString = () => sb.buf;
      return sb;
    }
    throw new GError('org.codehaus.groovy.control.MultipleCompilationErrorsException', `unable to resolve class ${n.cls}`, { node: n });
  }

  resolve(name, scope, n) {
    const r = scope.lookup(name);
    if (r.found) return r.value;
    const g = this.host.global(name);
    if (g.found) return g.value;
    if (this.methods.has(name)) return new GClosure({ params: this.methods.get(name).params.map((p) => p.name), body: this.methods.get(name).body }, this.binding, this);
    throw new GError('groovy.lang.MissingPropertyException', `No such property: ${name} for class: groovy.lang.Binding`, { node: n });
  }

  assignTo(target, v, scope) {
    if (target.type === 'Ident') { scope.assign(target.name, v); return; }
    if (target.type === 'Member') {
      const obj = this.eval(target.object, scope);
      this.setProp(obj, target.prop, v, target);
      return;
    }
    if (target.type === 'Index') {
      const obj = this.eval(target.object, scope);
      const idx = this.eval(target.index, scope);
      if (Array.isArray(obj)) obj[idx < 0 ? obj.length + idx : idx] = v;
      else if (obj && obj.__setProp) obj.__setProp(toStr(idx), v);
      else if (isMap(obj)) obj[toStr(idx)] = v;
      else throw new GError('java.lang.NullPointerException', 'Cannot set index on null object', { node: target });
    }
  }

  binary(n, scope) {
    const op = n.op;
    if (op === '&&') return truthy(this.eval(n.left, scope)) && truthy(this.eval(n.right, scope));
    if (op === '||') return truthy(this.eval(n.left, scope)) || truthy(this.eval(n.right, scope));
    const a = this.eval(n.left, scope);
    const b = this.eval(n.right, scope);
    switch (op) {
      case '==': case '===': return gEquals(a, b);
      case '!=': case '!==': return !gEquals(a, b);
      case '<': return compareValues(a, b) < 0;
      case '>': return compareValues(a, b) > 0;
      case '<=': return compareValues(a, b) <= 0;
      case '>=': return compareValues(a, b) >= 0;
      case '<=>': return Math.sign(compareValues(a, b));
      case '=~': return new Matcher(toStr(a), toRegex(b));
      case '==~': return new RegExp('^(?:' + toRegex(b).source + ')$').test(toStr(a));
      case 'in':
        if (Array.isArray(b)) return b.some((x) => gEquals(x, a));
        if (isMap(b)) return Object.prototype.hasOwnProperty.call(b, toStr(a));
        if (typeof b === 'string') return b.includes(toStr(a));
        return false;
      case '<<':
        if (Array.isArray(a)) { a.push(b); return a; }
        if (a && a.append) return a.append(b);
        return a << b;
      case '&': return a & b;
      case '|': return a | b;
      case '^': return a ^ b;
      default: return this.arith(op, a, b, n);
    }
  }

  arith(op, a, b, n) {
    switch (op) {
      case '+':
        if (typeof a === 'string' || (a && a.__special === 'java.lang.StringBuilder')) return toStr(a) + toStr(b);
        if (Array.isArray(a)) return Array.isArray(b) ? [...a, ...b] : [...a, b];
        if (isMap(a) && isMap(b)) return { ...a, ...b };
        if (a == null) throw new GError('java.lang.NullPointerException', 'Cannot invoke method plus() on null object', { node: n });
        if (typeof a === 'number' && typeof b === 'string') {
          throw new GError('groovy.lang.MissingMethodException', `No signature of method: java.lang.Integer.plus() is applicable for argument types: (java.lang.String)`, { node: n });
        }
        return a + b;
      case '-':
        if (Array.isArray(a)) return a.filter((x) => !(Array.isArray(b) ? b : [b]).some((y) => gEquals(x, y)));
        if (typeof a === 'string') return a.replace(toStr(b), '');
        return this.num(a, n) - this.num(b, n);
      case '*':
        if (typeof a === 'string') return a.repeat(b);
        return this.num(a, n) * this.num(b, n);
      case '/': return this.num(a, n) / this.num(b, n);
      case '%': return this.num(a, n) % this.num(b, n);
      case '**': return this.num(a, n) ** this.num(b, n);
      default: throw new GError('groovy.lang.GroovyRuntimeException', `Unsupported operator ${op}`, { node: n });
    }
  }

  getIndex(obj, idx, n) {
    if (obj == null) throw new GError('java.lang.NullPointerException', 'Cannot get index on null object', { node: n });
    if (Array.isArray(obj) || typeof obj === 'string') {
      if (Array.isArray(idx)) return idx.map((i) => obj[i < 0 ? obj.length + i : i]);
      const i = idx < 0 ? obj.length + idx : idx;
      return obj[i] ?? null;
    }
    if (obj instanceof Matcher) {
      const m = obj.matches[idx];
      if (!m) throw new GError('java.lang.IndexOutOfBoundsException', `index is out of range 0..${obj.matches.length - 1} (index = ${idx})`, { node: n });
      return m.length > 1 ? [...m] : m[0];
    }
    return this.getProp(obj, toStr(idx), n);
  }

  getProp(obj, name, n) {
    if (obj == null) throw new GError('java.lang.NullPointerException', `Cannot get property '${name}' on null object`, { node: n });
    if (obj.__getProp) return obj.__getProp(name, n);
    if (obj instanceof GError) {
      if (name === 'message' || name === 'localizedMessage') return obj.message ?? null;
      if (name === 'class') return { __special: 'java.lang.Class', name: obj.cls, simpleName: obj.cls.split('.').pop(), __str: () => `class ${obj.cls}` };
      if (name === 'cause') return null;
      return obj[name] ?? null;
    }
    if (obj && obj.__entry) return name === 'key' ? obj.key : name === 'value' ? obj.value : null;
    if (Array.isArray(obj)) {
      if (name === 'size') return obj.length;
      return obj.map((x) => this.getProp(x, name, n));
    }
    if (typeof obj === 'string') {
      if (name === 'empty') return obj.length === 0;
      if (name === 'length') throw new GError('groovy.lang.MissingPropertyException', `No such property: length for class: java.lang.String (use .length())`, { node: n });
    }
    if (obj.__special && name in obj) return obj[name];
    if (isMap(obj)) return Object.prototype.hasOwnProperty.call(obj, name) ? obj[name] : null;
    if (name === 'class') return { __special: 'java.lang.Class', name: typeName(obj), simpleName: typeName(obj).split('.').pop() };
    throw new GError('groovy.lang.MissingPropertyException', `No such property: ${name} for class: ${typeName(obj)}`, { node: n });
  }

  setProp(obj, name, v, n) {
    if (obj == null) throw new GError('java.lang.NullPointerException', `Cannot set property '${name}' on null object`, { node: n });
    if (obj.__setProp) { obj.__setProp(name, v, n); return; }
    if (isMap(obj)) { obj[name] = v; return; }
    throw new GError('groovy.lang.ReadOnlyPropertyException', `Cannot set property ${name} of ${typeName(obj)}`, { node: n });
  }

  evalCall(n, scope) {
    const pos = n.args.map((a) => this.eval(a, scope));
    let named = null;
    if (n.named.length) {
      named = {};
      for (const en of n.named) named[en.key] = this.eval(en.value, scope);
    }
    const callee = n.callee;
    if (callee.type === 'Ident') {
      const name = callee.name;
      const local = scope.lookup(name);
      if (local.found && local.value instanceof GClosure) return this.invokeClosure(local.value, named ? [named, ...pos] : pos);
      if (this.methods.has(name)) return this.invokeMethod(this.methods.get(name), named ? [named, ...pos] : pos, n);
      return this.host.callStep(name, pos, named || {}, n, scope);
    }
    if (callee.type === 'Member') {
      const obj = this.eval(callee.object, scope);
      if (obj == null && callee.safe) return null;
      const args = named ? [named, ...pos] : pos;
      if (callee.spread) return (obj || []).map((x) => this.callMethod(x, callee.prop, args, n));
      return this.callMethod(obj, callee.prop, args, n);
    }
    const f = this.eval(callee, scope);
    if (f instanceof GClosure) return this.invokeClosure(f, named ? [named, ...pos] : pos);
    throw new GError('groovy.lang.MissingMethodException', `Cannot call ${typeName(f)} as a method`, { node: n });
  }

  callMethod(obj, name, args, n) {
    if (obj == null) {
      if (name === 'toString') return 'null';
      throw new GError('java.lang.NullPointerException', `Cannot invoke method ${name}() on null object`, { node: n });
    }
    if (obj instanceof GClosure) {
      if (name === 'call') return this.invokeClosure(obj, args);
    }
    if (obj.__call) {
      const r = obj.__call(name, args, n);
      if (r !== undefined) return r;
    }
    if (obj.__special && typeof obj[name] === 'function') return obj[name](...args);
    if (obj.__special && obj.__getProp && /^get[A-Z]/.test(name) && args.length === 0) {
      return obj.__getProp(name[3].toLowerCase() + name.slice(4), n);
    }
    if (obj.__special && obj.__setProp && /^set[A-Z]/.test(name) && args.length === 1) {
      obj.__setProp(name[3].toLowerCase() + name.slice(4), args[0], n);
      return null;
    }
    const cl = (i = 0) => {
      const c = args[i];
      if (!(c instanceof GClosure)) throw new GError('groovy.lang.MissingMethodException', `${name}() expects a closure`, { node: n });
      return (...a) => this.invokeClosure(c, a);
    };
    const generic = this.commonMethod(obj, name, args, n);
    if (generic !== undefined) return generic;
    if (typeof obj === 'string') {
      const r = stringMethod(obj, name, args, cl);
      if (r !== undefined) return r;
    } else if (Array.isArray(obj)) {
      const r = listMethod(obj, name, args, cl, this);
      if (r !== undefined) return r;
    } else if (typeof obj === 'number') {
      const r = numberMethod(obj, name, args, cl);
      if (r !== undefined) return r;
    } else if (obj instanceof GError) {
      if (name === 'getMessage' || name === 'getLocalizedMessage') return obj.message ?? null;
      if (name === 'printStackTrace') return null;
      if (name === 'getClass') return this.getProp(obj, 'class', n);
    } else if (obj instanceof Matcher) {
      if (name === 'find' || name === 'matches') return obj.matches.length > 0;
      if (name === 'getCount' || name === 'size') return obj.matches.length;
    } else if (isMap(obj)) {
      if (Object.prototype.hasOwnProperty.call(obj, name) && obj[name] instanceof GClosure) return this.invokeClosure(obj[name], args);
      const r = mapMethod(obj, name, args, cl, this);
      if (r !== undefined) return r;
    }
    const argTypes = args.map(typeName).join(', ');
    throw new GError('groovy.lang.MissingMethodException',
      `No signature of method: ${typeName(obj)}.${name}() is applicable for argument types: (${argTypes})`, { node: n });
  }

  commonMethod(obj, name, args) {
    switch (name) {
      case 'toString': return toStr(obj);
      case 'equals': return gEquals(obj, args[0]);
      case 'hashCode': return 0;
      case 'getClass': return { __special: 'java.lang.Class', name: typeName(obj), simpleName: typeName(obj).split('.').pop() };
      case 'asBoolean': return truthy(obj);
      case 'is': return obj === args[0];
      case 'with': return args[0] instanceof GClosure ? this.invokeClosure(args[0], [obj]) : undefined;
      default: return undefined;
    }
  }
}

function stringMethod(s, name, a, cl) {
  switch (name) {
    case 'trim': return s.trim();
    case 'strip': return s.trim();
    case 'toUpperCase': return s.toUpperCase();
    case 'toLowerCase': return s.toLowerCase();
    case 'capitalize': return s.charAt(0).toUpperCase() + s.slice(1);
    case 'startsWith': return s.startsWith(toStr(a[0]));
    case 'endsWith': return s.endsWith(toStr(a[0]));
    case 'contains': return s.includes(toStr(a[0]));
    case 'length': case 'size': return s.length;
    case 'isEmpty': return s.length === 0;
    case 'equalsIgnoreCase': return a[0] != null && s.toLowerCase() === toStr(a[0]).toLowerCase();
    case 'split': return a.length ? s.split(toRegex(a[0])).filter((x, i, arr) => !(x === '' && i === arr.length - 1)) : s.split(/\s+/).filter(Boolean);
    case 'tokenize': {
      const delims = a.length ? toStr(a[0]) : ' \t\n\r\f';
      const re = new RegExp('[' + delims.replace(/[\]\\^-]/g, '\\$&') + ']+');
      return s.split(re).filter(Boolean);
    }
    case 'replace': return s.split(toStr(a[0])).join(toStr(a[1]));
    case 'replaceAll': return s.replace(new RegExp(toRegex(a[0]).source, 'g'), toStr(a[1]).replace(/\$(\d)/g, '$$$1'));
    case 'replaceFirst': return s.replace(toRegex(a[0]), toStr(a[1]));
    case 'substring': return a.length > 1 ? s.substring(a[0], a[1]) : s.substring(a[0]);
    case 'indexOf': return s.indexOf(toStr(a[0]));
    case 'lastIndexOf': return s.lastIndexOf(toStr(a[0]));
    case 'charAt': return s.charAt(a[0]);
    case 'matches': return new RegExp('^(?:' + toRegex(a[0]).source + ')$').test(s);
    case 'find': { const m = s.match(toRegex(a[0])); return m ? m[0] : null; }
    case 'findAll': return [...s.matchAll(new RegExp(toRegex(a[0]).source, 'g'))].map((m) => m[0]);
    case 'toInteger': case 'asInteger': case 'toLong': case 'parseInt': {
      const v = parseInt(s, 10);
      if (isNaN(v)) throw new GError('java.lang.NumberFormatException', `For input string: "${s}"`);
      return v;
    }
    case 'toDouble': case 'toBigDecimal': case 'toFloat': return parseFloat(s);
    case 'toBoolean': return ['true', 'y', '1'].includes(s.trim().toLowerCase());
    case 'isNumber': case 'isInteger': case 'isBigDecimal': return s.trim() !== '' && !isNaN(Number(s));
    case 'take': return s.slice(0, a[0]);
    case 'drop': return s.slice(a[0]);
    case 'reverse': return [...s].reverse().join('');
    case 'readLines': return s.split(/\r?\n/).filter((x, i, arr) => !(x === '' && i === arr.length - 1));
    case 'padLeft': return s.padStart(a[0], a[1] != null ? toStr(a[1]) : ' ');
    case 'padRight': return s.padEnd(a[0], a[1] != null ? toStr(a[1]) : ' ');
    case 'count': return s.split(toStr(a[0])).length - 1;
    case 'stripIndent': case 'stripMargin': return s.replace(/^\s*\|?/gm, '');
    case 'concat': return s + toStr(a[0]);
    case 'center': return s;
    case 'getAt': return s[a[0]];
    case 'each': { for (const ch of s) cl()(ch); return s; }
    case 'format': return s;
    case 'execute': throw new GError('org.jenkinsci.plugins.scriptsecurity.sandbox.RejectedAccessException', 'Scripts not permitted to use method java.lang.String execute');
    default: return undefined;
  }
}

function listMethod(l, name, a, cl, interp) {
  switch (name) {
    case 'size': return l.length;
    case 'isEmpty': return l.length === 0;
    case 'contains': return l.some((x) => gEquals(x, a[0]));
    case 'each': { const f = cl(); l.forEach((x) => f(x)); return l; }
    case 'eachWithIndex': { const f = cl(); l.forEach((x, i) => f(x, i)); return l; }
    case 'collect': { if (!a.length) return [...l]; const f = cl(); return l.map((x) => f(x)); }
    case 'collectEntries': {
      const f = cl();
      const o = {};
      for (const x of l) {
        const r = f(x);
        if (Array.isArray(r)) o[toStr(r[0])] = r[1];
        else if (isMap(r)) Object.assign(o, r);
      }
      return o;
    }
    case 'findAll': { if (!a.length) return l.filter(truthy); const f = cl(); return l.filter((x) => truthy(f(x))); }
    case 'find': { const f = cl(); return l.find((x) => truthy(f(x))) ?? null; }
    case 'findIndexOf': { const f = cl(); return l.findIndex((x) => truthy(f(x))); }
    case 'any': { if (!a.length) return l.some(truthy); const f = cl(); return l.some((x) => truthy(f(x))); }
    case 'every': { const f = cl(); return l.every((x) => truthy(f(x))); }
    case 'count': { if (a[0] instanceof GClosure) { const f = cl(); return l.filter((x) => truthy(f(x))).length; } return l.filter((x) => gEquals(x, a[0])).length; }
    case 'join': return l.map(toStr).join(a.length ? toStr(a[0]) : '');
    case 'first': case 'head':
      if (!l.length) throw new GError('java.util.NoSuchElementException', 'Cannot access first() element from an empty List');
      return l[0];
    case 'last':
      if (!l.length) throw new GError('java.util.NoSuchElementException', 'Cannot access last() element from an empty List');
      return l[l.length - 1];
    case 'tail': return l.slice(1);
    case 'get': case 'getAt': return l[a[0]] ?? null;
    case 'add': case 'push': case 'leftShift': if (a.length === 2) l.splice(a[0], 0, a[1]); else l.push(a[0]); return true;
    case 'addAll': l.push(...(a[0] || [])); return true;
    case 'remove': {
      if (typeof a[0] === 'number') return l.splice(a[0], 1)[0] ?? null;
      const i = l.findIndex((x) => gEquals(x, a[0]));
      if (i >= 0) l.splice(i, 1);
      return i >= 0;
    }
    case 'removeAll': { const f = a[0] instanceof GClosure ? cl() : null; for (let i = l.length - 1; i >= 0; i--) if (f ? truthy(f(l[i])) : (a[0] || []).some((y) => gEquals(l[i], y))) l.splice(i, 1); return true; }
    case 'plus': return Array.isArray(a[0]) ? [...l, ...a[0]] : [...l, a[0]];
    case 'minus': return l.filter((x) => !(Array.isArray(a[0]) ? a[0] : [a[0]]).some((y) => gEquals(x, y)));
    case 'sort': {
      if (a[0] instanceof GClosure) {
        const f = cl();
        const two = a[0].node.params && a[0].node.params.length === 2;
        return l.sort((x, y) => (two ? f(x, y) : compareValues(f(x), f(y))));
      }
      return l.sort(compareValues);
    }
    case 'unique': { const out = []; for (const x of l) if (!out.some((y) => gEquals(x, y))) out.push(x); l.splice(0, l.length, ...out); return l; }
    case 'reverse': return [...l].reverse();
    case 'flatten': return l.flat(Infinity);
    case 'sum': return l.reduce((s, x) => (s === null ? x : interp.arith('+', s, x)), a.length ? a[0] : null) ?? 0;
    case 'max': return l.reduce((m, x) => (m === null || compareValues(x, m) > 0 ? x : m), null);
    case 'min': return l.reduce((m, x) => (m === null || compareValues(x, m) < 0 ? x : m), null);
    case 'indexOf': return l.findIndex((x) => gEquals(x, a[0]));
    case 'take': return l.slice(0, a[0]);
    case 'drop': return l.slice(a[0]);
    case 'subList': return l.slice(a[0], a[1]);
    case 'inject': { const f = cl(1); return l.reduce((acc, x) => f(acc, x), a[0]); }
    case 'groupBy': {
      const f = cl();
      const o = {};
      for (const x of l) { const k = toStr(f(x)); (o[k] = o[k] || []).push(x); }
      return o;
    }
    case 'toList': case 'asList': return [...l];
    case 'toSet': return [...new Set(l)];
    case 'withIndex': return l.map((x, i) => [x, i]);
    case 'intersect': return l.filter((x) => (a[0] || []).some((y) => gEquals(x, y)));
    default: return undefined;
  }
}

function mapMethod(m, name, a, cl) {
  const entries = () => Object.entries(m).map(([key, value]) => ({ key, value, __entry: true }));
  const call2 = (f, e, c) => (c.node.params && c.node.params.length === 2 ? f(e.key, e.value) : f(e));
  switch (name) {
    case 'get': return Object.prototype.hasOwnProperty.call(m, toStr(a[0])) ? m[toStr(a[0])] : (a.length > 1 ? a[1] : null);
    case 'getOrDefault': return Object.prototype.hasOwnProperty.call(m, toStr(a[0])) ? m[toStr(a[0])] : a[1];
    case 'put': { const old = m[toStr(a[0])] ?? null; m[toStr(a[0])] = a[1]; return old; }
    case 'putAll': Object.assign(m, a[0]); return null;
    case 'remove': { const old = m[toStr(a[0])] ?? null; delete m[toStr(a[0])]; return old; }
    case 'containsKey': return Object.prototype.hasOwnProperty.call(m, toStr(a[0]));
    case 'containsValue': return Object.values(m).some((v) => gEquals(v, a[0]));
    case 'keySet': return Object.keys(m);
    case 'values': return Object.values(m);
    case 'entrySet': return entries();
    case 'size': return Object.keys(m).length;
    case 'isEmpty': return Object.keys(m).length === 0;
    case 'each': { const f = cl(); for (const e of entries()) call2(f, e, a[0]); return m; }
    case 'collect': { const f = cl(); return entries().map((e) => call2(f, e, a[0])); }
    case 'findAll': {
      const f = cl();
      const o = {};
      for (const e of entries()) if (truthy(call2(f, e, a[0]))) o[e.key] = e.value;
      return o;
    }
    case 'find': { const f = cl(); return entries().find((e) => truthy(call2(f, e, a[0]))) ?? null; }
    case 'any': { const f = cl(); return entries().some((e) => truthy(call2(f, e, a[0]))); }
    case 'every': { const f = cl(); return entries().every((e) => truthy(call2(f, e, a[0]))); }
    case 'collectEntries': {
      const f = cl();
      const o = {};
      for (const e of entries()) {
        const r = call2(f, e, a[0]);
        if (Array.isArray(r)) o[toStr(r[0])] = r[1];
        else if (isMap(r)) Object.assign(o, r);
      }
      return o;
    }
    case 'plus': return { ...m, ...a[0] };
    case 'getAt': return m[toStr(a[0])] ?? null;
    default: return undefined;
  }
}

function numberMethod(n, name, a, cl) {
  switch (name) {
    case 'intValue': case 'toInteger': case 'longValue': return Math.trunc(n);
    case 'abs': return Math.abs(n);
    case 'times': { const f = cl(); for (let i = 0; i < n; i++) f(i); return null; }
    case 'plus': return n + a[0];
    case 'minus': return n - a[0];
    case 'multiply': return n * a[0];
    case 'compareTo': return Math.sign(n - a[0]);
    case 'round': return Math.round(n);
    default: return undefined;
  }
}

export { Matcher, isMap, typeName };

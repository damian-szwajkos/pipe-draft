// Recursive-descent parser for the Groovy subset used in Jenkinsfiles.
// Every node carries absolute offsets `s` / `e` into the source text.

import { tokenize, PipelineSyntaxError, lineIndex } from './lexer.js';

// Words after which a `{` on the next line still attaches as a closure argument
// (Allman-style Jenkinsfiles).
const DSL_WORDS = new Set(['pipeline', 'stages', 'steps', 'post', 'always', 'success', 'failure', 'unstable',
  'aborted', 'changed', 'fixed', 'regression', 'unsuccessful', 'cleanup', 'notBuilt', 'environment', 'options',
  'parameters', 'triggers', 'tools', 'when', 'script', 'agent', 'parallel', 'matrix', 'axes', 'axis', 'excludes',
  'exclude', 'input', 'node', 'not', 'allOf', 'anyOf', 'expression', 'docker', 'dockerfile', 'kubernetes', 'libraries']);

const TYPE_WORDS = new Set(['int', 'long', 'boolean', 'double', 'float', 'char', 'byte', 'short', 'void', 'var']);
const MODIFIERS = new Set(['final', 'static', 'private', 'public', 'protected']);

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
const BIN_LEVELS = [
  ['||'], ['&&'], ['|'], ['^'], ['&'],
  ['==', '!=', '=~', '==~', '<=>', '===', '!=='],
  ['<', '>', '<=', '>=', 'in', 'instanceof'],
  ['..', '..<'], ['<<', '>>'], ['+', '-'], ['*', '/', '%'], ['**'],
];
// Operators that may continue an expression from the previous line.
const NL_CONTINUE = new Set(['&&', '||', '?', ':', '?:', '.', '?.', '*.']);

export function parse(text) {
  return new Parser(text).parseProgram();
}

function describe(t) {
  if (!t) return 'end of file';
  switch (t.t) {
    case 'eof': return 'end of file';
    case 'id': return `'${t.v}'`;
    case 'kw': return `keyword '${t.v}'`;
    case 'num': return `number ${t.v}`;
    case 'str': return 'a string';
    case 'gstr': return 'a string';
    case 'op': return `'${t.v}'`;
    default: return 'an unexpected token';
  }
}

class Parser {
  constructor(text, tokens) {
    this.text = text;
    this.toks = tokens || tokenize(text);
    this.i = 0;
    this.depth = 0; // ( and [ nesting: newlines are insignificant inside
    this.lines = null;
  }

  // ---- token helpers ----
  peek(k = 0) { return this.toks[Math.min(this.i + k, this.toks.length - 1)]; }
  get last() { return this.toks[Math.max(0, this.i - 1)]; }
  next() { const t = this.toks[this.i]; if (this.i < this.toks.length - 1) this.i++; return t; }
  is(v, k = 0) { const t = this.peek(k); return (t.t === 'op' || t.t === 'kw') && t.v === v; }
  isId(k = 0) { return this.peek(k).t === 'id'; }
  eat(v) { return this.is(v) ? this.next() : null; }
  where(pos) {
    if (!this.lines) this.lines = lineIndex(this.text);
    const { line, col } = this.lines.lc(pos);
    return `line ${line}, col ${col}`;
  }
  fail(msg, tok, hint) {
    tok = tok || this.peek();
    throw new PipelineSyntaxError(msg, { s: tok.s, e: Math.max(tok.e, tok.s + 1) }, hint);
  }
  expect(v, ctx) {
    if (this.is(v)) return this.next();
    const t = this.peek();
    this.fail(`Expected '${v}'${ctx ? ' ' + ctx : ''} but found ${describe(t)}`, t);
  }
  closeWith(v, open, what) {
    if (this.is(v)) return this.next();
    const t = this.peek();
    if (t.t === 'eof' || (v !== '}' && this.is('}'))) {
      this.fail(`Missing '${v}': the '${open.v}' at ${this.where(open.s)} is never closed`, open,
        what ? `Close the ${what} with '${v}'` : null);
    }
    this.fail(`Expected '${v}' to close the '${open.v}' at ${this.where(open.s)} but found ${describe(t)}`, t);
  }
  node(type, startTok, props) {
    return { type, s: startTok.s, e: this.last.e, ...props };
  }

  // ---- program & statements ----
  parseProgram() {
    const body = [];
    const methods = [];
    const annotations = [];
    while (this.peek().t !== 'eof') {
      if (this.eat(';')) continue;
      if (this.is('}')) {
        this.fail("Unexpected '}': there is no open block to close here", this.peek(),
          'Check for an extra closing brace, or a block that was closed too early above.');
      }
      const st = this.parseStatement(true);
      if (!st) continue;
      if (st.type === 'MethodDecl') methods.push(st);
      else if (st.type === 'Annotation') annotations.push(st);
      else body.push(st);
    }
    return { type: 'Program', body, methods, annotations, s: 0, e: this.text.length };
  }

  endStatement() {
    const t = this.peek();
    if (t.t === 'eof' || t.nl || this.is('}') || this.is(';') || this.is('else')) {
      this.eat(';');
      return;
    }
    this.fail(`Unexpected ${describe(t)}: a statement must end here`, t,
      'Put each statement on its own line, or separate statements on one line with ";".');
  }

  parseBlock() {
    const open = this.expect('{');
    const body = this.parseStatementsUntilClose(open, 'block');
    return { type: 'Block', body, s: open.s, e: this.last.e };
  }

  parseStatementsUntilClose(open, what) {
    const body = [];
    const savedDepth = this.depth;
    this.depth = 0;
    while (!this.is('}')) {
      if (this.peek().t === 'eof') this.closeWith('}', open, what);
      if (this.eat(';')) continue;
      const st = this.parseStatement(false);
      if (st) body.push(st);
    }
    this.next();
    this.depth = savedDepth;
    return body;
  }

  parseBody() {
    if (this.is('{')) return this.parseBlock();
    const st = this.parseStatement(false);
    return st;
  }

  isTypeWord(t) {
    return t.t === 'id' && (TYPE_WORDS.has(t.v) || /^[A-Z]/.test(t.v));
  }

  parseStatement(top) {
    const t = this.peek();
    if (this.is('@')) return this.parseAnnotation();
    if (this.is('import')) {
      const start = this.next();
      while (!this.peek().nl && this.peek().t !== 'eof' && !this.is(';')) this.next();
      this.eat(';');
      return { type: 'Import', s: start.s, e: this.last.e };
    }
    // modifiers
    while (this.isId() && MODIFIERS.has(this.peek().v) && (this.isId(1) || this.is('def', 1))) this.next();

    if (this.is('def') || (this.isTypeWord(t) && this.isId(1) && !this.peek(1).nl)) {
      const after = this.peek(2);
      const isDecl = after.t === 'eof' || after.nl || (after.t === 'op' && ['=', ';', '(', '}', ','].includes(after.v));
      if (this.is('def') || isDecl) {
        // skip generic type args like List<String>
        const start = this.next();
        if (this.is('(') && start.v === 'def') {
          return this.parseMultiDecl(start);
        }
        if (this.isTypeWord(this.peek()) && this.isId(1) && !this.peek(1).nl) this.next(); // def String x
        const nameTok = this.peek();
        if (nameTok.t !== 'id') this.fail(`Expected a variable or method name after '${start.v}' but found ${describe(nameTok)}`, nameTok);
        this.next();
        if (this.is('(') && !this.peek().nl) return this.parseMethodDecl(start, nameTok, top);
        let init = null;
        if (this.eat('=')) init = this.parseExpr();
        const decl = this.node('VarDecl', start, { name: nameTok.v, init, nameS: nameTok.s, nameE: nameTok.e });
        this.endStatement();
        return decl;
      }
    }
    if (t.t === 'kw') {
      switch (t.v) {
        case 'if': return this.parseIf();
        case 'for': return this.parseFor();
        case 'while': return this.parseWhile();
        case 'try': return this.parseTry();
        case 'switch': return this.parseSwitch();
        case 'return': {
          this.next();
          let arg = null;
          const n = this.peek();
          if (!(n.t === 'eof' || n.nl || this.is('}') || this.is(';'))) arg = this.parseExpr();
          const st = this.node('Return', t, { arg });
          this.endStatement();
          return st;
        }
        case 'throw': {
          this.next();
          const arg = this.parseExpr();
          const st = this.node('Throw', t, { arg });
          this.endStatement();
          return st;
        }
        case 'break':
        case 'continue': {
          this.next();
          const st = this.node(t.v === 'break' ? 'Break' : 'Continue', t, {});
          this.endStatement();
          return st;
        }
        case 'else':
          this.fail("'else' without a matching 'if'", t);
          break;
        case 'catch':
        case 'finally':
          this.fail(`'${t.v}' without a matching 'try'`, t);
          break;
        default: break;
      }
    }
    if (this.is('{')) return this.parseBlock();
    const expr = this.isCommandStart() ? this.parseCommand() : this.parseExpr();
    const st = { type: 'ExprStmt', expr, s: expr.s, e: expr.e };
    this.endStatement();
    return st;
  }

  parseMultiDecl(start) {
    this.expect('(');
    const names = [];
    while (!this.is(')')) {
      if (this.isTypeWord(this.peek()) && this.isId(1)) this.next();
      const n = this.next();
      if (n.t !== 'id') this.fail('Expected a variable name', n);
      names.push(n.v);
      if (!this.eat(',')) break;
    }
    this.expect(')');
    let init = null;
    if (this.eat('=')) init = this.parseExpr();
    const st = this.node('MultiDecl', start, { names, init });
    this.endStatement();
    return st;
  }

  parseAnnotation() {
    const at = this.next();
    const name = this.next();
    if (name.t !== 'id') this.fail('Expected an annotation name after @', name);
    let full = name.v;
    while (this.is('.') && this.isId(1)) { this.next(); full += '.' + this.next().v; }
    let args = [];
    let named = [];
    if (this.is('(') && !this.peek().nl) {
      const r = this.parseParenArgs();
      args = r.args;
      named = r.named;
    }
    // `@Library('x') _`
    if (this.isId() && this.peek().v === '_') this.next();
    return this.node('Annotation', at, { name: full, args, named });
  }

  parseMethodDecl(start, nameTok, top) {
    const open = this.expect('(');
    const params = [];
    this.depth++;
    while (!this.is(')')) {
      while (this.isId() && MODIFIERS.has(this.peek().v)) this.next();
      if ((this.isTypeWord(this.peek()) || this.is('def')) && (this.isId(1))) this.next();
      const p = this.next();
      if (p.t !== 'id') this.fail(`Expected a parameter name but found ${describe(p)}`, p);
      let def = null;
      if (this.eat('=')) def = this.parseExpr();
      params.push({ name: p.v, def });
      if (!this.eat(',')) break;
    }
    this.closeWith(')', open, 'parameter list');
    this.depth--;
    const bodyOpen = this.peek();
    if (!this.is('{')) this.fail(`Expected '{' to start the body of method '${nameTok.v}'`, bodyOpen);
    this.next();
    const body = this.parseStatementsUntilClose(bodyOpen, `method '${nameTok.v}'`);
    const m = this.node('MethodDecl', start, { name: nameTok.v, params, body, nameS: nameTok.s, nameE: nameTok.e });
    if (!top) m.nested = true;
    return m;
  }

  parseCond() {
    const open = this.expect('(');
    this.depth++;
    const e = this.parseExpr();
    this.closeWith(')', open, 'condition');
    this.depth--;
    return e;
  }

  parseIf() {
    const start = this.next();
    const test = this.parseCond();
    const then = this.parseBody();
    let alt = null;
    if (this.is('else')) {
      this.next();
      alt = this.is('if') ? this.parseIf() : this.parseBody();
    }
    return this.node('If', start, { test, then, alt });
  }

  parseFor() {
    const start = this.next();
    const open = this.expect('(');
    this.depth++;
    // for (x in list) / for (def x in list) / for (String x : list)
    let k = 0;
    if (this.is('def') || (this.isTypeWord(this.peek()) && this.isId(1))) k = 1;
    if (this.peek(k).t === 'id' && (this.is('in', k + 1) || this.is(':', k + 1))) {
      for (let j = 0; j < k; j++) this.next();
      const v = this.next().v;
      this.next();
      const iter = this.parseExpr();
      this.closeWith(')', open, 'for loop header');
      this.depth--;
      const body = this.parseBody();
      return this.node('ForIn', start, { name: v, iter, body });
    }
    let init = null;
    if (!this.is(';')) {
      if (this.is('def') || (this.isTypeWord(this.peek()) && this.isId(1))) {
        const d = this.next();
        const n = this.next();
        let initE = null;
        if (this.eat('=')) initE = this.parseExpr();
        init = { type: 'VarDecl', name: n.v, init: initE, s: d.s, e: this.last.e };
      } else {
        const ex = this.parseExpr();
        init = { type: 'ExprStmt', expr: ex, s: ex.s, e: ex.e };
      }
    }
    this.expect(';', 'in for loop');
    const test = this.is(';') ? null : this.parseExpr();
    this.expect(';', 'in for loop');
    const update = this.is(')') ? null : this.parseExpr();
    this.closeWith(')', open, 'for loop header');
    this.depth--;
    const body = this.parseBody();
    return this.node('ForC', start, { init, test, update, body });
  }

  parseWhile() {
    const start = this.next();
    const test = this.parseCond();
    const body = this.parseBody();
    return this.node('While', start, { test, body });
  }

  parseTry() {
    const start = this.next();
    if (!this.is('{')) this.fail("Expected '{' after 'try'");
    const block = this.parseBlock();
    const catches = [];
    let fin = null;
    while (this.is('catch')) {
      const c = this.next();
      const open = this.expect('(');
      const types = [];
      let name = null;
      while (!this.is(')')) {
        const t = this.next();
        if (t.t !== 'id' && !(t.t === 'kw' && t.v === 'def')) this.fail(`Unexpected ${describe(t)} in catch clause`, t);
        if (this.is(')')) { name = t.v; break; }
        if (this.is('|')) { types.push(t.v); this.next(); continue; }
        if (this.is('.')) { // qualified type name
          let full = t.v;
          while (this.eat('.')) full += '.' + this.next().v;
          types.push(full);
          continue;
        }
        types.push(t.v);
      }
      this.closeWith(')', open, 'catch clause');
      if (!name) this.fail('Expected an exception variable name in catch clause', c);
      const body = this.parseBlock();
      catches.push({ types, name, body, s: c.s, e: this.last.e });
    }
    if (this.is('finally')) {
      this.next();
      fin = this.parseBlock();
    }
    if (!catches.length && !fin) this.fail("'try' must be followed by 'catch' or 'finally'", start);
    return this.node('Try', start, { block, catches, fin });
  }

  parseSwitch() {
    const start = this.next();
    const disc = this.parseCond();
    const open = this.expect('{');
    const cases = [];
    let cur = null;
    while (!this.is('}')) {
      if (this.peek().t === 'eof') this.closeWith('}', open, 'switch');
      if (this.is('case')) {
        const ct = this.next();
        const test = this.parseTernary();
        this.expect(':', 'after case value');
        if (cur && cur.body.length === 0 && !cur.isDefault) cur.tests.push(test);
        else { cur = { tests: [test], body: [], s: ct.s }; cases.push(cur); }
        continue;
      }
      if (this.is('default')) {
        this.next();
        this.expect(':', "after 'default'");
        cur = { tests: [], body: [], isDefault: true };
        cases.push(cur);
        continue;
      }
      if (this.eat(';')) continue;
      if (!cur) this.fail("Expected 'case' or 'default' inside switch");
      cur.body.push(this.parseStatement(false));
    }
    this.next();
    return this.node('Switch', start, { disc, cases });
  }

  // ---- command expressions: `sh 'make'`, `agent any`, `sh script: 'x', returnStdout: true`
  isCommandStart() {
    const t0 = this.peek();
    const t1 = this.peek(1);
    if (t0.t !== 'id' || t1.nl) return false;
    if (t1.t === 'str' || t1.t === 'gstr' || t1.t === 'num') return true;
    if (t1.t === 'id') return true;
    if (t1.t === 'kw' && ['true', 'false', 'null', 'new'].includes(t1.v)) return true;
    return false;
  }

  parseCommand() {
    const nameTok = this.next();
    const callee = { type: 'Ident', name: nameTok.v, s: nameTok.s, e: nameTok.e };
    const args = [];
    const named = [];
    for (;;) {
      this.parseArgInto(args, named);
      if (!this.eat(',')) break;
    }
    return this.node('Call', nameTok, { callee, args, named, command: true });
  }

  parseArgInto(args, named) {
    const t = this.peek();
    const t1 = this.peek(1);
    if ((t.t === 'id' || t.t === 'str' || t.t === 'kw') && t1.t === 'op' && t1.v === ':') {
      this.next();
      this.next();
      const value = this.parseExpr();
      named.push({ key: t.t === 'str' ? t.v : t.v, value, s: t.s, e: value.e });
      return;
    }
    args.push(this.parseExpr());
  }

  parseParenArgs() {
    const open = this.expect('(');
    this.depth++;
    const args = [];
    const named = [];
    while (!this.is(')')) {
      if (this.peek().t === 'eof' || this.is('}')) this.closeWith(')', open, 'argument list');
      this.parseArgInto(args, named);
      if (!this.eat(',')) break;
    }
    this.closeWith(')', open, 'argument list');
    this.depth--;
    return { args, named };
  }

  // ---- expressions ----
  parseExpr() { return this.parseAssign(); }

  parseAssign() {
    const left = this.parseTernary();
    const t = this.peek();
    if (t.t === 'op' && ASSIGN_OPS.has(t.v) && !(t.nl && this.depth === 0)) {
      if (!['Ident', 'Member', 'Index'].includes(left.type)) {
        this.fail('Invalid assignment target: only variables, properties and indexes can be assigned', t);
      }
      this.next();
      const value = this.parseAssign();
      return { type: 'Assign', op: t.v, target: left, value, s: left.s, e: value.e };
    }
    return left;
  }

  canContinue(t) {
    if (!t.nl || this.depth > 0) return true;
    return t.t === 'op' && NL_CONTINUE.has(t.v);
  }

  parseTernary() {
    const test = this.parseBin(0);
    const t = this.peek();
    if (this.is('?:') && this.canContinue(t)) {
      this.next();
      const alt = this.parseTernary();
      return { type: 'Elvis', left: test, right: alt, s: test.s, e: alt.e };
    }
    if (this.is('?') && this.canContinue(t)) {
      this.next();
      const cons = this.parseTernary();
      if (!this.is(':')) this.fail(`Expected ':' in ternary expression but found ${describe(this.peek())}`);
      this.next();
      const alt = this.parseTernary();
      return { type: 'Ternary', test, cons, alt, s: test.s, e: alt.e };
    }
    return test;
  }

  parseBin(level) {
    if (level >= BIN_LEVELS.length) return this.parseUnary();
    let left = this.parseBin(level + 1);
    const ops = BIN_LEVELS[level];
    for (;;) {
      const t = this.peek();
      if (!((t.t === 'op' || t.t === 'kw') && ops.includes(t.v))) break;
      if (!this.canContinue(t)) break;
      this.next();
      if (t.v === 'instanceof') {
        let name = this.next().v;
        while (this.is('.') && this.isId(1)) { this.next(); name += '.' + this.next().v; }
        left = { type: 'InstanceOf', expr: left, cls: name, s: left.s, e: this.last.e };
        continue;
      }
      const right = this.parseBin(level + 1);
      if (t.v === '..' || t.v === '..<') {
        left = { type: 'Range', from: left, to: right, exclusive: t.v === '..<', s: left.s, e: right.e };
      } else {
        left = { type: 'Binary', op: t.v, left, right, s: left.s, e: right.e };
      }
    }
    return left;
  }

  parseUnary() {
    const t = this.peek();
    if (t.t === 'op' && ['!', '-', '+', '~'].includes(t.v)) {
      this.next();
      const arg = this.parseUnary();
      return { type: 'Unary', op: t.v, arg, s: t.s, e: arg.e };
    }
    if (t.t === 'op' && (t.v === '++' || t.v === '--')) {
      this.next();
      const arg = this.parseUnary();
      return { type: 'Update', op: t.v, prefix: true, arg, s: t.s, e: arg.e };
    }
    let e = this.parsePostfix();
    while (this.is('as') && !this.peek().nl) {
      this.next();
      let name = this.next().v;
      while (this.is('.') && this.isId(1)) { this.next(); name += '.' + this.next().v; }
      e = { type: 'Cast', expr: e, to: name, s: e.s, e: this.last.e };
    }
    return e;
  }

  attachClosure(expr, allowNl) {
    const t = this.peek();
    if (!this.is('{')) return null;
    if (t.nl && !allowNl) return null;
    const cl = this.parseClosure();
    if (expr.type === 'Call' && !expr.hasTrailing) {
      expr.args.push(cl);
      expr.hasTrailing = true;
      expr.e = cl.e;
      return expr;
    }
    return { type: 'Call', callee: expr, args: [cl], named: [], hasTrailing: true, s: expr.s, e: cl.e };
  }

  parsePostfix() {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if ((this.is('.') || this.is('?.') || this.is('*.')) && this.canContinue(t)) {
        this.next();
        const nt = this.next();
        let prop;
        if (nt.t === 'id' || nt.t === 'kw') prop = nt.v;
        else if (nt.t === 'str') prop = nt.v;
        else this.fail(`Expected a property or method name after '${t.v}' but found ${describe(nt)}`, nt);
        e = { type: 'Member', object: e, prop, safe: t.v === '?.', spread: t.v === '*.', s: e.s, e: nt.e, propS: nt.s };
        if (this.is('(') && !this.peek().nl) {
          const { args, named } = this.parseParenArgs();
          e = { type: 'Call', callee: e, args, named, s: e.s, e: this.last.e };
        }
        const withCl = this.attachClosure(e, false);
        if (withCl) e = withCl;
        continue;
      }
      if (this.is('(') && !t.nl) {
        const { args, named } = this.parseParenArgs();
        e = { type: 'Call', callee: e, args, named, paren: true, s: e.s, e: this.last.e };
        const allowNl = e.callee.type === 'Ident';
        const withCl = this.attachClosure(e, allowNl && this.depth === 0);
        if (withCl) e = withCl;
        continue;
      }
      if (this.is('{') && (e.type === 'Ident' || e.type === 'Call')) {
        const allowNl = e.type === 'Ident' && DSL_WORDS.has(e.name) && this.depth === 0;
        if (!t.nl || allowNl) {
          if (e.type === 'Call' && e.hasTrailing) break;
          e = this.attachClosure(e, true);
          continue;
        }
      }
      if (this.is('[') && !t.nl) {
        const open = this.next();
        this.depth++;
        const index = this.parseExpr();
        this.closeWith(']', open, 'index');
        this.depth--;
        e = { type: 'Index', object: e, index, s: e.s, e: this.last.e };
        continue;
      }
      if ((this.is('++') || this.is('--')) && !t.nl) {
        this.next();
        e = { type: 'Update', op: t.v, prefix: false, arg: e, s: e.s, e: t.e };
        continue;
      }
      break;
    }
    return e;
  }

  parseGString(t) {
    const parts = t.parts.map((p) => {
      if (typeof p === 'string') return p;
      const toks = tokenize(this.text, { start: p.s, end: p.e });
      const sub = new Parser(this.text, toks);
      sub.depth = 1;
      if (sub.peek().t === 'eof') {
        throw new PipelineSyntaxError('Empty ${} inside a string', { s: p.s - 2, e: p.e + 1 });
      }
      const ex = sub.parseExpr();
      if (sub.peek().t !== 'eof') sub.fail(`Unexpected ${describe(sub.peek())} inside \${...}`);
      return ex;
    });
    return { type: 'GString', parts, s: t.s, e: t.e };
  }

  parsePrimary() {
    const t = this.peek();
    switch (t.t) {
      case 'num': this.next(); return { type: 'Literal', value: t.v, s: t.s, e: t.e };
      case 'str': this.next(); return { type: 'Literal', value: t.v, regex: !!t.regex, s: t.s, e: t.e };
      case 'gstr': this.next(); return this.parseGString(t);
      case 'id': this.next(); return { type: 'Ident', name: t.v, s: t.s, e: t.e };
      case 'kw':
        if (t.v === 'true' || t.v === 'false') { this.next(); return { type: 'Literal', value: t.v === 'true', s: t.s, e: t.e }; }
        if (t.v === 'null') { this.next(); return { type: 'Literal', value: null, s: t.s, e: t.e }; }
        if (t.v === 'new') return this.parseNew();
        break;
      case 'op':
        if (t.v === '(') {
          const open = this.next();
          this.depth++;
          const e = this.parseExpr();
          this.closeWith(')', open, 'parenthesis');
          this.depth--;
          return { type: 'Paren', expr: e, s: open.s, e: this.last.e };
        }
        if (t.v === '[') return this.parseListOrMap();
        if (t.v === '{') return this.parseClosure();
        break;
      case 'err':
        this.fail('Syntax error', t);
        break;
      default: break;
    }
    if (t.t === 'eof') this.fail('Unexpected end of file: an expression is missing here', t);
    if (this.is('}')) this.fail("Unexpected '}': an expression is missing before it", t);
    this.fail(`Unexpected ${describe(t)}`, t);
    return null;
  }

  parseNew() {
    const start = this.next();
    let name = this.next();
    if (name.t !== 'id') this.fail("Expected a class name after 'new'", name);
    let cls = name.v;
    while (this.is('.') && this.isId(1)) { this.next(); cls += '.' + this.next().v; }
    if (this.is('<')) { // generics
      let d = 0;
      do { if (this.is('<')) d++; else if (this.is('>')) d--; this.next(); } while (d > 0 && this.peek().t !== 'eof');
    }
    let args = [];
    let named = [];
    if (this.is('(')) {
      const r = this.parseParenArgs();
      args = r.args;
      named = r.named;
    }
    return this.node('New', start, { cls, args, named });
  }

  parseListOrMap() {
    const open = this.next();
    this.depth++;
    if (this.is(':') && this.is(']', 1)) {
      this.next();
      this.next();
      this.depth--;
      return { type: 'MapLit', entries: [], s: open.s, e: this.last.e };
    }
    const items = [];
    const entries = [];
    let isMap = null;
    while (!this.is(']')) {
      if (this.peek().t === 'eof' || this.is('}')) this.closeWith(']', open, 'list');
      const t = this.peek();
      const t1 = this.peek(1);
      if ((t.t === 'id' || t.t === 'str' || t.t === 'num' || t.t === 'kw') && t1.t === 'op' && t1.v === ':') {
        if (isMap === false) this.fail('Cannot mix list items and map entries in one literal', t);
        isMap = true;
        this.next();
        this.next();
        const value = this.parseExpr();
        entries.push({ key: String(t.v), value });
      } else {
        const e = this.parseExpr();
        if (this.is(':')) {
          if (isMap === false) this.fail('Cannot mix list items and map entries in one literal', this.peek());
          isMap = true;
          this.next();
          const value = this.parseExpr();
          entries.push({ keyExpr: e, value });
        } else {
          if (isMap === true) this.fail('Expected a map entry (key: value)', t);
          isMap = false;
          items.push(e);
        }
      }
      if (!this.eat(',')) break;
    }
    this.closeWith(']', open, 'list');
    this.depth--;
    if (isMap) return { type: 'MapLit', entries, s: open.s, e: this.last.e };
    return { type: 'ListLit', items, s: open.s, e: this.last.e };
  }

  parseClosure() {
    const open = this.next();
    let params = null;
    // detect `a, b ->` or `String a ->` or `->`
    if (this.is('->')) {
      this.next();
      params = [];
    } else {
      let k = 0;
      const names = [];
      let ok = false;
      for (;;) {
        const a = this.peek(k);
        const b = this.peek(k + 1);
        if (a.t !== 'id') break;
        if (b.t === 'id') { // typed
          const c = this.peek(k + 2);
          names.push(b.v);
          k += 2;
          if (c.t === 'op' && c.v === ',') { k++; continue; }
          if (c.t === 'op' && c.v === '->') { ok = true; k++; }
          break;
        }
        names.push(a.v);
        k++;
        if (b.t === 'op' && b.v === ',') { k++; continue; }
        if (b.t === 'op' && b.v === '->') { ok = true; k++; }
        break;
      }
      if (ok) {
        this.i += k;
        params = names;
      }
    }
    const body = this.parseStatementsUntilClose(open, 'closure');
    return { type: 'Closure', params, body, s: open.s, e: this.last.e };
  }
}

/** Visit every node of an AST (depth-first). */
export function walk(node, fn, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, fn, parent); return; }
  if (!node.type) {
    for (const k of Object.keys(node)) if (node[k] && typeof node[k] === 'object') walk(node[k], fn, parent);
    return;
  }
  if (fn(node, parent) === false) return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') walk(v, fn, node);
  }
}

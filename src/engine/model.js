// Builds a pipeline model from the AST and runs the structure checks that
// Jenkins' declarative validator (and the Groovy compiler) would run.

import {
  PIPELINE_SECTIONS, STAGE_SECTIONS, AGENT_TYPES, WHEN_CONDITIONS, WHEN_FLAGS, POST_CONDITIONS,
  PARAMETER_TYPES, TRIGGER_TYPES, OPTIONS, KNOWN_STEPS, NOT_A_STEP,
} from './catalog.js';

const STMT_TYPES = new Set(['ExprStmt', 'VarDecl', 'MultiDecl', 'If', 'ForIn', 'ForC', 'While', 'Try', 'Return',
  'Throw', 'Switch', 'Break', 'Continue']);
const MATRIX_SECTIONS = ['agent', 'axes', 'environment', 'excludes', 'input', 'options', 'post', 'stages', 'tools', 'when'];
const CRON_ALIASES = new Set(['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']);

/** Split a call into name / positional args / named args / trailing closure. */
export function callInfo(stmt) {
  const expr = stmt && stmt.type === 'ExprStmt' ? stmt.expr : stmt;
  if (!expr) return null;
  if (expr.type === 'Ident') return { name: expr.name, pos: [], named: {}, namedList: [], closure: null, node: expr, head: expr };
  if (expr.type !== 'Call' || expr.callee.type !== 'Ident') return null;
  let args = expr.args;
  let closure = null;
  if (args.length && args[args.length - 1].type === 'Closure') {
    closure = args[args.length - 1];
    args = args.slice(0, -1);
  }
  const named = {};
  for (const n of expr.named) named[n.key] = n.value;
  const headEnd = args.length ? args[args.length - 1].e : (expr.named.length ? expr.named[expr.named.length - 1].e : expr.callee.e);
  return {
    name: expr.callee.name, pos: args, named, namedList: expr.named, closure, node: expr,
    head: { s: expr.s, e: Math.min(headEnd + (expr.paren ? 1 : 0), closure ? closure.s : Infinity) },
  };
}

/** Static value of a literal node, or undefined when it is dynamic. */
export function literal(node) {
  if (!node) return undefined;
  switch (node.type) {
    case 'Literal': return node.value;
    case 'ListLit': {
      const out = [];
      for (const it of node.items) {
        const v = literal(it);
        if (v === undefined) return undefined;
        out.push(v);
      }
      return out;
    }
    case 'Unary':
      if (node.op === '-' && node.arg.type === 'Literal' && typeof node.arg.value === 'number') return -node.arg.value;
      return undefined;
    case 'Paren': return literal(node.expr);
    default: return undefined;
  }
}

export function buildModel(program, text) {
  const b = new ModelBuilder(program, text);
  return b.build();
}

class ModelBuilder {
  constructor(program, text) {
    this.program = program;
    this.text = text;
    this.diags = [];
    this.nextId = 1;
    this.codeStarts = new Set();
    this.methods = new Set(program.methods.map((m) => m.name));
    this.stageNames = new Map();
  }

  src(node, max = 60) {
    const s = this.text.slice(node.s, node.e).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  diag(severity, message, range, hint, code) {
    this.diags.push({ severity, message, s: range.s, e: Math.max(range.e, range.s + 1), hint: hint || null, code: code || null });
  }
  err(m, r, h, c) { this.diag('error', m, r, h, c); }
  warn(m, r, h, c) { this.diag('warning', m, r, h, c); }
  info(m, r, h, c) { this.diag('info', m, r, h, c); }

  collectCode(stmts) {
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (STMT_TYPES.has(n.type)) this.codeStarts.add(n.s);
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (v && typeof v === 'object') visit(v);
      }
    };
    visit(stmts);
  }

  build() {
    const prog = this.program;
    for (const a of prog.annotations) {
      if (a.name === 'Library' || a.name === 'Grab') {
        const lib = literal(a.args[0]);
        this.info(`Shared library ${Array.isArray(lib) ? lib.join(', ') : `'${lib ?? '?'}'`} is not loaded in the simulator`, a,
          'Custom steps from the library are mocked: they log a call and succeed.', 'library');
      }
    }
    for (const m of prog.methods) this.collectCode(m.body);

    const pipeStmts = prog.body.filter((st) => callInfo(st)?.name === 'pipeline' && callInfo(st).closure);
    let pipeline = null;
    let mode = 'scripted';
    if (pipeStmts.length) {
      mode = 'declarative';
      if (pipeStmts.length > 1) this.err('Only one pipeline { ... } block is allowed per Jenkinsfile', callInfo(pipeStmts[1]).head);
      pipeline = this.buildPipeline(callInfo(pipeStmts[0]));
      for (const st of prog.body) if (!pipeStmts.includes(st)) this.collectCode([st]);
    } else {
      const bare = prog.body.find((st) => callInfo(st)?.name === 'pipeline');
      if (bare) this.err('pipeline needs a block: pipeline { ... }', callInfo(bare).head);
      this.collectCode(prog.body);
    }

    const scripted = mode === 'scripted' ? this.scanScripted() : null;
    const params = mode === 'declarative' ? pipeline.parameters : this.scanScriptedParams();
    const triggers = mode === 'declarative' ? pipeline.triggers : this.scanScriptedTriggers();
    if (mode === 'scripted') {
      const hasNode = JSON.stringify(prog.body, (k, v) => (k === 's' || k === 'e' ? undefined : v)).includes('"name":"node"');
      if (!scripted.items.length && !hasNode && prog.body.length) {
        this.info('No pipeline { } block and no stage() calls: treating this as a scripted pipeline', { s: 0, e: 1 });
      }
    }
    return {
      mode,
      pipeline,
      scripted,
      params,
      triggers,
      methods: prog.methods,
      diagnostics: this.diags,
      codeStarts: this.codeStarts,
    };
  }

  // ------------------------------------------------------------ declarative
  buildPipeline(ci) {
    const P = {
      agent: null, environment: [], options: [], parameters: [], triggers: [], tools: [], stages: [], post: null,
      s: ci.node.s, e: ci.node.e, head: ci.head,
    };
    const seen = new Set();
    for (const st of ci.closure.body) {
      const c = callInfo(st);
      if (!c) {
        this.err(`Not a valid section definition: "${this.src(st)}". Some extra configuration is required.`, st,
          'Only sections like agent, environment, options, parameters, triggers, stages and post may appear directly inside pipeline { }.');
        continue;
      }
      if (!PIPELINE_SECTIONS.includes(c.name)) {
        if (STAGE_SECTIONS.includes(c.name) || KNOWN_STEPS.has(c.name)) {
          this.err(`Undefined section "${c.name}"`, c.head,
            `"${c.name}" belongs inside a stage. Valid pipeline sections: ${PIPELINE_SECTIONS.join(', ')}.`);
        } else {
          this.err(`Undefined section "${c.name}"`, c.head, `Valid pipeline sections: ${PIPELINE_SECTIONS.join(', ')}.`);
        }
        continue;
      }
      if (seen.has(c.name)) { this.err(`Multiple occurrences of the ${c.name} section`, c.head); continue; }
      seen.add(c.name);
      switch (c.name) {
        case 'agent': P.agent = this.parseAgent(c); break;
        case 'stages': P.stages = this.parseStages(c, { inParallel: false, depth: 0 }); break;
        case 'environment': P.environment = this.parseEnv(c); break;
        case 'options': P.options = this.parseOptions(c); break;
        case 'parameters': P.parameters = this.parseParameters(c); break;
        case 'triggers': P.triggers = this.parseTriggers(c); break;
        case 'post': P.post = this.parsePost(c, 'pipeline'); break;
        case 'tools': P.tools = this.parseTools(c); break;
        case 'libraries': break;
        default: break;
      }
    }
    if (!seen.has('agent')) this.err('Missing required section "agent"', ci.head, 'Add "agent any", or "agent none" and an agent per stage.');
    if (!seen.has('stages')) this.err('Missing required section "stages"', ci.head, 'Add stages { stage(\'Build\') { steps { ... } } }.');
    if (seen.has('agent') && !P.options.some((o) => o.name === 'timeout')) {
      this.info('No global timeout: a hung build keeps its executor forever', P.agent || ci.head,
        "Add options { timeout(time: 1, unit: 'HOURS') }.", 'no-timeout');
    }
    // lints that need the whole tree
    const topAgentNone = P.agent?.type === 'none';
    const visit = (stages, agentHeld) => {
      for (const s of stages) {
        const holds = s.agent ? s.agent.type !== 'none' : agentHeld;
        if (s.when && s.agent && s.agent.type !== 'none' && !s.when.beforeAgent) {
          this.info(`Stage "${s.name}" allocates its agent before evaluating "when"`, s.when.head,
            'Add "beforeAgent true" inside when, so a skipped stage does not wait for an executor first.', 'before-agent');
        }
        if (s.steps && holds) this.lintInputStep(s.steps.stmts, s.name);
        if (s.stages) visit(s.stages, holds);
        if (s.parallel) visit(s.parallel, holds);
        if (s.matrix) visit(s.matrix.stages, s.matrix.agent ? s.matrix.agent.type !== 'none' : holds);
      }
    };
    visit(P.stages, !topAgentNone && !!P.agent);
    return P;
  }

  lintInputStep(stmts, stageName) {
    for (const st of stmts) {
      const c = callInfo(st);
      if (c?.name === 'input') {
        this.warn(`input step in stage "${stageName}" holds an executor while it waits for approval`, c.head,
          'Use the stage-level input directive instead (it runs before the agent is allocated), or use agent none for this stage.', 'input-holds-agent');
      }
      if (c?.closure) this.lintInputStep(c.closure.body, stageName);
    }
  }

  parseAgent(c) {
    const a = { type: null, label: null, image: null, s: c.node.s, e: c.node.e, head: c.head };
    if (c.pos.length) {
      const p = c.pos[0];
      if (p.type === 'Ident' && (p.name === 'any' || p.name === 'none')) a.type = p.name;
      else if (p.type === 'Ident') this.err(`Invalid agent type "${p.name}" specified. Must be one of [${AGENT_TYPES.join(', ')}]`, p);
      else this.err('Invalid agent definition: use "agent any", "agent none" or agent { label \'x\' }', p);
      return a;
    }
    if (!c.closure) {
      this.err('Invalid agent definition: use "agent any", "agent none" or agent { label \'x\' }', c.head);
      return a;
    }
    const inner = c.closure.body.map(callInfo).filter(Boolean);
    if (!inner.length) {
      this.err('Empty agent block: add a type such as label \'linux\' or docker \'image\'', c.head);
      return a;
    }
    const t = inner[0];
    if (!AGENT_TYPES.includes(t.name) || t.name === 'any' || t.name === 'none') {
      this.err(`Invalid agent type "${t.name}" specified. Must be one of [${AGENT_TYPES.join(', ')}]`, t.head);
      return a;
    }
    a.type = t.name;
    const sub = t.closure ? t.closure.body.map(callInfo).filter(Boolean) : [];
    const subVal = (n) => sub.find((x) => x.name === n)?.pos[0] || t.named[n] || null;
    if (t.name === 'label') a.label = t.pos[0] || t.named.label || null;
    if (t.name === 'node') a.label = subVal('label');
    if (t.name === 'docker') { a.image = t.pos[0] || subVal('image'); a.label = subVal('label'); }
    if (t.name === 'dockerfile') a.image = { type: 'Literal', value: 'Dockerfile', s: t.node.s, e: t.node.e };
    if (t.name === 'kubernetes') a.label = subVal('label') || subVal('inheritFrom');
    if (t.name === 'docker' && !a.image) this.err('docker agent needs an image: docker { image \'maven:3\' }', t.head);
    return a;
  }

  parseStages(c, ctx) {
    const list = [];
    if (!c.closure) { this.err('Expected a block: stages { ... }', c.head); return list; }
    for (const st of c.closure.body) {
      const sc = callInfo(st);
      if (!sc || sc.name !== 'stage') {
        this.err('Expected a stage', sc ? sc.head : st,
          "Only stage('Name') { ... } blocks are allowed inside stages { }.");
        continue;
      }
      const stage = this.parseStage(sc, ctx);
      if (stage) list.push(stage);
    }
    if (!list.length && !c.closure.body.length) this.err('No stages specified', c.head);
    return list;
  }

  parseStage(c, ctx) {
    const nameNode = c.pos[0] || c.named.name;
    let name;
    if (!nameNode) {
      this.err("Expected a stage name but didn't find any", c.head, "stage('Build') { ... }");
      name = '(unnamed)';
    } else if (nameNode.type === 'Literal' && typeof nameNode.value === 'string') {
      name = nameNode.value;
    } else if (nameNode.type === 'GString') {
      name = this.src(nameNode).slice(1, -1);
    } else {
      this.err('Stage name must be a string', nameNode);
      name = this.src(nameNode);
    }
    const S = {
      id: `s${this.nextId++}`, name, s: c.node.s, e: c.node.e, head: c.head, depth: ctx.depth,
      agent: null, environment: [], when: null, options: [], input: null, steps: null, stages: null,
      parallel: null, matrix: null, post: null, failFast: false, tools: [],
    };
    if (!ctx.inMatrix && nameNode) {
      if (this.stageNames.has(name)) this.err(`Duplicate stage name: "${name}"`, nameNode, 'Stage names must be unique across the pipeline.');
      else this.stageNames.set(name, S);
    }
    if (!c.closure) {
      this.err(`Expected a block for stage "${name}"`, c.head, `stage('${name}') { steps { ... } }`);
      return S;
    }
    const seen = new Set();
    for (const st of c.closure.body) {
      const sc = callInfo(st);
      if (!sc) {
        this.err(`Not a valid stage section definition: "${this.src(st)}". Some extra configuration is required.`, st,
          'Groovy code goes inside steps { script { ... } }.');
        continue;
      }
      if (!STAGE_SECTIONS.includes(sc.name)) {
        this.err(`Unknown stage section "${sc.name}". Starting with version 0.5, steps in a stage must be in a ‘steps’ block.`, sc.head,
          KNOWN_STEPS.has(sc.name) ? `Wrap it: steps { ${this.src(sc.node, 40)} }` : `Valid stage sections: ${STAGE_SECTIONS.join(', ')}.`, 'steps-block');
        continue;
      }
      if (seen.has(sc.name)) { this.err(`Multiple occurrences of the ${sc.name} section`, sc.head); continue; }
      seen.add(sc.name);
      switch (sc.name) {
        case 'steps': S.steps = this.parseSteps(sc, name); break;
        case 'stages': S.stages = this.parseStages(sc, { ...ctx, depth: ctx.depth + 1 }); break;
        case 'parallel': S.parallel = this.parseParallel(sc, ctx); break;
        case 'matrix': S.matrix = this.parseMatrix(sc, ctx, S); break;
        case 'when': S.when = this.parseWhen(sc); break;
        case 'agent': S.agent = this.parseAgent(sc); break;
        case 'environment': S.environment = this.parseEnv(sc); break;
        case 'options': S.options = this.parseOptions(sc); break;
        case 'input': S.input = this.parseInput(sc); break;
        case 'post': S.post = this.parsePost(sc, name); break;
        case 'tools': S.tools = this.parseTools(sc); break;
        case 'failFast': {
          const v = literal(sc.pos[0]);
          if (typeof v !== 'boolean') this.err('failFast takes true or false', sc.head);
          S.failFast = v === true;
          break;
        }
        default: break;
      }
    }
    const exec = ['steps', 'stages', 'parallel', 'matrix'].filter((k) => seen.has(k));
    if (exec.length === 0) {
      this.err(`No "steps", "stages", "parallel", or "matrix" to execute within stage "${name}"`, c.head,
        'Add steps { ... } with at least one step.');
    } else if (exec.length > 1) {
      this.err(`Only one of "matrix", "parallel", "stages", or "steps" allowed for stage "${name}"`, c.head);
    }
    if (ctx.inParallel && (S.parallel || S.matrix)) {
      this.err(`Stage "${name}" is a parallel branch and cannot contain "parallel" or "matrix" itself`, c.head,
        'Parallel blocks cannot be nested directly; move the inner parallel into its own top-level stage.');
    }
    return S;
  }

  parseParallel(c, ctx) {
    const list = [];
    if (!c.closure) { this.err('Expected a block: parallel { stage(...) { ... } }', c.head); return list; }
    for (const st of c.closure.body) {
      const sc = callInfo(st);
      if (!sc || sc.name !== 'stage') {
        this.err('Expected a stage', sc ? sc.head : st, 'Declarative parallel { } takes stage blocks; each stage is one branch.');
        continue;
      }
      list.push(this.parseStage(sc, { ...ctx, inParallel: true, depth: ctx.depth + 1 }));
    }
    if (!list.length) this.err('No stages specified inside parallel', c.head);
    return list;
  }

  parseMatrix(c, ctx, owner) {
    const M = { axes: [], excludes: [], agent: null, when: null, environment: [], stages: [], post: null, options: [], cells: [], head: c.head };
    if (!c.closure) { this.err('Expected a block: matrix { axes { ... } stages { ... } }', c.head); return M; }
    const seen = new Set();
    for (const st of c.closure.body) {
      const sc = callInfo(st);
      if (!sc || !MATRIX_SECTIONS.includes(sc.name)) {
        this.err(`Unknown matrix section "${sc ? sc.name : this.src(st)}"`, sc ? sc.head : st, `Valid matrix sections: ${MATRIX_SECTIONS.join(', ')}.`);
        continue;
      }
      seen.add(sc.name);
      switch (sc.name) {
        case 'axes': M.axes = this.parseAxes(sc); break;
        case 'excludes':
          for (const ex of (sc.closure?.body || [])) {
            const ec = callInfo(ex);
            if (ec?.name !== 'exclude') { this.err('Expected an exclude block', ex); continue; }
            M.excludes.push(this.parseAxes(ec, true));
          }
          break;
        case 'stages': M.stages = this.parseStages(sc, { ...ctx, inParallel: true, inMatrix: true, depth: ctx.depth + 1 }); break;
        case 'agent': M.agent = this.parseAgent(sc); break;
        case 'when': M.when = this.parseWhen(sc); break;
        case 'environment': M.environment = this.parseEnv(sc); break;
        case 'post': M.post = this.parsePost(sc, owner.name); break;
        case 'options': M.options = this.parseOptions(sc); break;
        default: break;
      }
    }
    if (!seen.has('axes')) this.err('Missing required section "axes" in matrix', c.head);
    if (!seen.has('stages')) this.err('Missing required section "stages" in matrix', c.head);
    // expand cells
    let cells = [{}];
    for (const ax of M.axes) {
      const nextCells = [];
      for (const cell of cells) for (const v of ax.values) nextCells.push({ ...cell, [ax.name]: v });
      cells = nextCells;
    }
    if (!M.axes.length) cells = [];
    M.cells = cells.filter((cell) => !M.excludes.some((ex) => ex.every((ax) => {
      const v = cell[ax.name];
      if (ax.notValues) return !ax.notValues.includes(v);
      return ax.values.includes(v);
    }))).map((values) => ({ values, label: Object.entries(values).map(([k, v]) => `${k}=${v}`).join(', ') }));
    if (M.axes.length && !M.cells.length) this.warn('Every matrix cell is excluded: nothing will run', c.head);
    return M;
  }

  parseAxes(c, isExclude = false) {
    const axes = [];
    for (const st of (c.closure?.body || [])) {
      const ac = callInfo(st);
      if (ac?.name !== 'axis') { this.err('Expected an axis', ac ? ac.head : st); continue; }
      const inner = (ac.closure?.body || []).map(callInfo).filter(Boolean);
      const nameC = inner.find((x) => x.name === 'name');
      const valC = inner.find((x) => x.name === 'values');
      const notC = inner.find((x) => x.name === 'notValues');
      const name = literal(nameC?.pos[0]);
      if (typeof name !== 'string') { this.err('axis needs a name: name \'PLATFORM\'', ac.head); continue; }
      const vals = (valC || notC)?.pos.map(literal) || [];
      if (!vals.length) { this.err(`axis "${name}" needs values: values 'a', 'b'`, ac.head); continue; }
      if (vals.some((v) => typeof v !== 'string')) this.err(`axis "${name}" values must be strings`, (valC || notC).head);
      if (notC && !isExclude) this.err('notValues is only allowed inside exclude', notC.head);
      axes.push(notC ? { name, notValues: vals.map(String) } : { name, values: vals.map(String) });
    }
    if (!isExclude && !axes.length) this.err('axes needs at least one axis', c.head);
    return axes;
  }

  checkStepStmts(stmts, where, inScript) {
    for (const st of stmts) {
      if (inScript) continue;
      if (NOT_A_STEP.has(st.type)) {
        this.err('Expected a step', st,
          `Declarative "steps" blocks only take steps. Wrap Groovy code (def, if, for, try...) in script { ... }.`, 'expected-step');
        continue;
      }
      if (st.type === 'ExprStmt' && st.expr.type === 'Assign') {
        this.err('Expected a step', st, 'Assignments are Groovy code: wrap them in script { ... }.', 'expected-step');
        continue;
      }
      if (st.type === 'ExprStmt' && st.expr.type === 'Call' && st.expr.callee.type === 'Member') {
        this.err('Method calls on objects not allowed outside "script" blocks.', st, 'Wrap the call in script { ... }.', 'expected-step');
        continue;
      }
      const c = callInfo(st);
      if (!c) { this.err('Expected a step', st, null, 'expected-step'); continue; }
      if (!KNOWN_STEPS.has(c.name) && !this.methods.has(c.name)) {
        this.warn(`Unknown step "${c.name}": no plugin for it is known to the simulator`, c.head,
          'It will be mocked as a successful no-op (its block, if any, still runs).', 'unknown-step');
      }
      if (c.name === 'script') continue;
      if (c.closure) this.checkStepStmts(c.closure.body, where, false);
    }
  }

  parseSteps(c, stageName) {
    if (!c.closure) { this.err('Expected a block: steps { ... }', c.head); return { stmts: [], s: c.node.s, e: c.node.e }; }
    const stmts = c.closure.body;
    if (!stmts.length) this.err(`Steps block of stage "${stageName}" is empty: there must be at least one step`, c.head);
    this.checkStepStmts(stmts, stageName, false);
    this.collectCode(stmts);
    return { stmts, s: c.node.s, e: c.node.e };
  }

  parseWhen(c) {
    const W = { conds: [], beforeAgent: false, beforeInput: false, beforeOptions: false, s: c.node.s, e: c.node.e, head: c.head };
    if (!c.closure) { this.err('Expected a block: when { branch \'main\' }', c.head); return W; }
    for (const st of c.closure.body) {
      const wc = callInfo(st);
      if (wc && WHEN_FLAGS.includes(wc.name)) {
        const v = literal(wc.pos[0]);
        if (typeof v !== 'boolean') this.err(`${wc.name} takes true or false`, wc.head);
        W[wc.name] = v === true;
        continue;
      }
      const cond = this.parseCondition(st);
      if (cond) W.conds.push(cond);
    }
    if (!c.closure.body.length) this.err('Empty when closure, remove the property or add some content.', c.head);
    return W;
  }

  parseCondition(st) {
    const c = callInfo(st);
    if (!c) {
      this.err(`Expected a when condition but found "${this.src(st)}"`, st,
        'Wrap Groovy logic in expression { ... }, e.g. expression { return params.DEPLOY }.');
      return null;
    }
    if (!WHEN_CONDITIONS.includes(c.name)) {
      const near = c.name === 'branches' ? 'branch' : c.name === 'tags' ? 'tag' : null;
      this.err(`Unknown conditional ${c.name}. Valid conditionals are: ${WHEN_CONDITIONS.join(', ')}`, c.head,
        near ? `Did you mean "${near}"?` : null, 'unknown-condition');
      return null;
    }
    const cond = { type: c.name, pos: c.pos, named: c.named, closure: c.closure, children: [], s: c.node.s, e: c.node.e, head: c.head, src: this.src(c.node, 200) };
    const posOr = (k) => c.pos[0] || c.named[k];
    switch (c.name) {
      case 'not':
      case 'allOf':
      case 'anyOf': {
        for (const inner of (c.closure?.body || [])) {
          const ch = this.parseCondition(inner);
          if (ch) cond.children.push(ch);
        }
        if (!c.closure || !(c.closure.body.length)) this.err(`Empty ${c.name} condition`, c.head);
        else if (c.name === 'not' && c.closure.body.length > 1) {
          this.err('not takes exactly one condition', c.head, 'Combine several with not { anyOf { ... } }.');
        }
        break;
      }
      case 'expression':
        if (!c.closure) this.err('expression needs a block: expression { return params.DEPLOY }', c.head);
        else this.collectCode(c.closure.body);
        break;
      case 'branch':
      case 'changeset':
      case 'changelog':
        if (!posOr('pattern')) this.err(`${c.name} needs a pattern, e.g. ${c.name} '${c.name === 'changelog' ? '.*\\[ci deploy\\].*' : c.name === 'changeset' ? 'src/**' : 'main'}'`, c.head);
        break;
      case 'environment':
        if (!c.named.name) this.err('Missing required parameter: "name"', c.head, "environment name: 'DEPLOY_TO', value: 'production'");
        if (!c.named.value) this.err('Missing required parameter: "value"', c.head);
        break;
      case 'equals':
        if (!c.named.expected) this.err('Missing required parameter: "expected"', c.head);
        if (!c.named.actual) this.err('Missing required parameter: "actual"', c.head);
        break;
      case 'triggeredBy':
        if (!posOr('cause')) this.err("triggeredBy needs a cause, e.g. triggeredBy 'TimerTrigger'", c.head);
        break;
      default: break;
    }
    return cond;
  }

  parseEnv(c) {
    const list = [];
    if (!c.closure) { this.err('Expected a block: environment { NAME = \'value\' }', c.head); return list; }
    for (const st of c.closure.body) {
      const a = st.type === 'ExprStmt' && st.expr.type === 'Assign' ? st.expr : null;
      if (!a || a.op !== '=' || a.target.type !== 'Ident') {
        this.err('Expected name=value pairs', st, "environment { DEPLOY_TO = 'staging' }");
        continue;
      }
      const v = a.value;
      const okType = (v.type === 'Literal' && (typeof v.value === 'string' || v.value === null)) || v.type === 'GString' || v.type === 'Call';
      if (!okType) {
        this.err('Environment variable values must either be single quoted, double quoted, or function calls.', v,
          `Quote it: ${a.target.name} = '${this.src(v)}'`);
      }
      const ci = callInfo(v);
      list.push({ name: a.target.name, value: v, cred: ci?.name === 'credentials', s: st.s, e: st.e });
    }
    return list;
  }

  parseOptions(c) {
    const list = [];
    if (!c.closure) { this.err('Expected a block: options { ... }', c.head); return list; }
    for (const st of c.closure.body) {
      const oc = callInfo(st);
      if (!oc) { this.err(`Expected an option but found "${this.src(st)}"`, st); continue; }
      if (!OPTIONS.includes(oc.name)) {
        this.warn(`Invalid option type "${oc.name}"`, oc.head, `Known options: ${OPTIONS.slice(0, 16).join(', ')}…`);
      }
      list.push({ name: oc.name, pos: oc.pos, named: oc.named, s: oc.node.s, e: oc.node.e, head: oc.head });
    }
    return list;
  }

  parseTools(c) {
    return (c.closure?.body || []).map(callInfo).filter(Boolean).map((t) => ({ name: t.name, value: literal(t.pos[0]) }));
  }

  parseParameters(c) {
    const list = [];
    if (!c.closure) { this.err('Expected a block: parameters { ... }', c.head); return list; }
    for (const st of c.closure.body) {
      const pc = callInfo(st);
      if (!pc) { this.err(`Expected a parameter but found "${this.src(st)}"`, st); continue; }
      const p = this.paramFromCall(pc);
      if (p) list.push(p);
    }
    return list;
  }

  paramFromCall(pc, quiet = false) {
    if (!PARAMETER_TYPES.includes(pc.name)) {
      if (!quiet) this.err(`Invalid parameter type "${pc.name}". Valid parameter types: [${PARAMETER_TYPES.join(', ')}]`, pc.head);
      return null;
    }
    const name = literal(pc.named.name);
    if (typeof name !== 'string') {
      if (!quiet) this.err('Missing required parameter: "name"', pc.head);
      return null;
    }
    const p = { type: pc.name, name, description: literal(pc.named.description) || '', s: pc.node.s, e: pc.node.e };
    if (pc.name === 'booleanParam') {
      const d = literal(pc.named.defaultValue);
      p.default = d === true;
      if (d !== undefined && typeof d !== 'boolean' && !quiet) this.err('booleanParam defaultValue must be true or false', pc.named.defaultValue);
    } else if (pc.name === 'choice') {
      let ch = literal(pc.named.choices);
      if (typeof ch === 'string') ch = ch.split('\n');
      if (!Array.isArray(ch) || !ch.length) {
        if (!quiet) this.err("choice needs choices: choices: ['a', 'b']", pc.head);
        ch = [''];
        // computed at runtime (a variable, .join('\n') ...): the allowed values are unknown here
        p.dynamicChoices = true;
      }
      p.choices = ch.map(String);
      p.default = p.choices[0];
    } else {
      const d = literal(pc.named.defaultValue);
      p.default = d == null ? '' : String(d);
    }
    return p;
  }

  parseTriggers(c) {
    const list = [];
    if (!c.closure) { this.err('Expected a block: triggers { cron(\'H 2 * * *\') }', c.head); return list; }
    for (const st of c.closure.body) {
      const tc = callInfo(st);
      if (!tc) { this.err(`Expected a trigger but found "${this.src(st)}"`, st); continue; }
      list.push(this.triggerFromCall(tc));
    }
    return list;
  }

  triggerFromCall(tc, quiet = false) {
    if (!TRIGGER_TYPES.includes(tc.name) && !quiet) {
      this.warn(`Unknown trigger "${tc.name}"`, tc.head, `Known triggers: ${TRIGGER_TYPES.join(', ')}.`);
    }
    const t = { type: tc.name, spec: null, dynamic: false, s: tc.node.s, e: tc.node.e, src: this.src(tc.node, 80) };
    if (tc.name === 'cron' || tc.name === 'pollSCM') {
      const arg = tc.pos[0] || tc.named.spec;
      const v = literal(arg);
      if (typeof v === 'string') {
        t.spec = v;
        if (!quiet) this.checkCron(v, arg, tc.name);
      } else if (arg) t.dynamic = true;
      else if (!quiet) this.err(`${tc.name} needs a schedule, e.g. ${tc.name}('H 2 * * *')`, tc.head);
    }
    if (tc.name === 'upstream') {
      t.spec = literal(tc.named.upstreamProjects) || literal(tc.pos[0]) || null;
    }
    return t;
  }

  checkCron(spec, node, kind) {
    for (const raw of spec.split('\n')) {
      const line = raw.replace(/#.*/, '').trim();
      if (!line) continue;
      if (line.startsWith('@')) {
        if (!CRON_ALIASES.has(line)) this.err(`Invalid ${kind} spec "${line}": unknown alias`, node, `Use one of ${[...CRON_ALIASES].join(', ')}.`);
        continue;
      }
      const fields = line.split(/\s+/);
      if (fields.length !== 5) {
        this.err(`Invalid ${kind} spec "${line}": expected 5 fields (minute hour day-of-month month day-of-week), found ${fields.length}`, node);
        continue;
      }
      const bad = fields.find((f) => !/^[0-9H*/,\-()A-Za-z]+$/.test(f));
      if (bad) this.err(`Invalid ${kind} spec "${line}": "${bad}" is not a valid field`, node);
      if (fields[0] !== 'H' && !fields[0].startsWith('H') && fields[0] !== '*' && /^\d+$/.test(fields[0]) && fields[1] === '*') {
        // fine
      }
      if (/^\d+$/.test(fields[0]) && /^\d+$/.test(fields[1])) {
        this.info(`${kind} "${line}" uses a fixed minute: every job with this schedule starts at the same second`, node,
          `Use H to spread the load, e.g. 'H ${fields[1]} ${fields.slice(2).join(' ')}'.`, 'cron-hash');
      }
    }
  }

  parseInput(c) {
    const I = { message: null, ok: null, submitter: null, id: null, parameters: [], s: c.node.s, e: c.node.e, head: c.head };
    if (!c.closure) { this.err("Expected a block: input { message 'Deploy?' }", c.head); return I; }
    for (const st of c.closure.body) {
      const ic = callInfo(st);
      if (!ic) { this.err(`Unexpected "${this.src(st)}" in input`, st); continue; }
      if (ic.name === 'parameters') {
        for (const p of (ic.closure?.body || [])) {
          const pc = callInfo(p);
          const param = pc && this.paramFromCall(pc);
          if (param) I.parameters.push(param);
        }
      } else if (['message', 'ok', 'submitter', 'id', 'submitterParameter'].includes(ic.name)) {
        I[ic.name] = ic.pos[0] || null;
      } else this.err(`Unknown input option "${ic.name}"`, ic.head, 'Valid: message, ok, submitter, submitterParameter, id, parameters.');
    }
    if (!I.message) this.err('Missing required parameter: "message"', c.head, "input { message 'Deploy to production?' }");
    return I;
  }

  parsePost(c, owner) {
    const P = { blocks: [], s: c.node.s, e: c.node.e, head: c.head };
    if (!c.closure) { this.err('Expected a block: post { always { ... } }', c.head); return P; }
    for (const st of c.closure.body) {
      const pc = callInfo(st);
      if (!pc || !POST_CONDITIONS.includes(pc.name)) {
        const name = pc ? pc.name : this.src(st);
        const near = { failed: 'failure', fail: 'failure', succeeded: 'success', finally: 'cleanup', error: 'failure' }[name];
        this.err(`Invalid condition "${name}" - valid conditions are [${POST_CONDITIONS.join(', ')}]`, pc ? pc.head : st,
          near ? `Did you mean "${near}"?` : null, 'post-condition');
        continue;
      }
      if (!pc.closure) { this.err(`post condition "${pc.name}" needs a block`, pc.head); continue; }
      this.checkStepStmts(pc.closure.body, owner, false);
      this.collectCode(pc.closure.body);
      P.blocks.push({ cond: pc.name, stmts: pc.closure.body, s: pc.node.s, e: pc.node.e, head: pc.head });
    }
    return P;
  }

  // ------------------------------------------------------------ scripted
  scanScriptedParams() {
    const out = [];
    const seen = new Set();
    this.walkCalls(this.program.body, (c) => {
      // `string(name: 'X', value: 'y')` passes a value to `build job:`; definitions use defaultValue
      if (['booleanParam', 'string', 'choice', 'text', 'password'].includes(c.name) && c.named.name && !c.named.variable && !c.named.value) {
        const p = this.paramFromCall(c, true);
        if (p && !seen.has(p.name)) { seen.add(p.name); out.push(p); }
      }
    });
    return out;
  }

  scanScriptedTriggers() {
    const out = [];
    this.walkCalls(this.program.body, (c) => {
      if (['cron', 'pollSCM', 'upstream', 'githubPush'].includes(c.name)) out.push(this.triggerFromCall(c, true));
    });
    return out;
  }

  walkCalls(node, fn) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => this.walkCalls(n, fn)); return; }
    if (node.type === 'Call' && node.callee.type === 'Ident') fn(callInfo(node));
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') this.walkCalls(v, fn);
    }
  }

  /** Static stage tree of a scripted pipeline: every stage() call site, with the if/loop context around it. */
  scanScripted() {
    const methods = new Map(this.program.methods.map((m) => [m.name, m]));
    const inMethod = new Set();
    const seq = () => ({ kind: 'seq', items: [] });

    const scanStmts = (stmts, conds, out) => { for (const st of stmts) scanNode(st, conds, out); };
    const scanBody = (b, conds, out) => {
      if (!b) return;
      if (b.type === 'Block') scanStmts(b.body, conds, out);
      else scanNode(b, conds, out);
    };
    const scanNode = (n, conds, out) => {
      if (!n || typeof n !== 'object') return;
      switch (n.type) {
        case 'If':
          scanExpr(n.test, conds, out);
          scanBody(n.then, [...conds, { kind: 'if', src: this.src(n.test, 80), branch: 'then', s: n.s }], out);
          if (n.alt) scanBody(n.alt, [...conds, { kind: 'if', src: this.src(n.test, 80), branch: 'else', s: n.s }], out);
          return;
        case 'ForIn': case 'ForC': case 'While':
          scanBody(n.body, [...conds, { kind: 'loop', src: this.src({ s: n.s, e: (n.body?.s ?? n.e) }, 60), s: n.s }], out);
          return;
        case 'Try':
          scanStmts(n.block.body, conds, out);
          for (const c of n.catches) scanStmts(c.body.body, [...conds, { kind: 'catch', src: `catch (${c.name})`, s: c.s }], out);
          if (n.fin) scanStmts(n.fin.body, conds, out);
          return;
        case 'Switch':
          scanExpr(n.disc, conds, out);
          for (const c of n.cases) {
            scanStmts(c.body, [...conds, { kind: 'if', src: c.isDefault ? `switch default` : `case ${c.tests.map((t) => this.src(t, 30)).join(', ')}`, branch: 'then', s: c.s ?? n.s }], out);
          }
          return;
        case 'Block': scanStmts(n.body, conds, out); return;
        case 'ExprStmt': scanExpr(n.expr, conds, out); return;
        case 'VarDecl': case 'Return': case 'Throw': scanExpr(n.init || n.arg, conds, out); return;
        default: scanExpr(n, conds, out);
      }
    };
    const scanExpr = (e, conds, out) => {
      if (!e || typeof e !== 'object') return;
      if (Array.isArray(e)) { e.forEach((x) => scanExpr(x, conds, out)); return; }
      if (e.type === 'Closure') { scanStmts(e.body, conds, out); return; }
      if (e.type === 'Call') {
        const c = e.callee.type === 'Ident' ? callInfo(e) : null;
        if (c && c.name === 'stage') {
          const nameNode = c.pos[0] || c.named.name;
          const name = !nameNode ? '(unnamed)' : nameNode.type === 'Literal' ? String(nameNode.value) : this.src(nameNode).replace(/^"|"$/g, '');
          const node = { kind: 'stage', id: `site:${e.s}`, name, conds, s: e.s, e: e.e, head: c.head, children: null, dynamicName: nameNode?.type !== 'Literal' };
          if (c.closure) {
            const inner = seq();
            scanStmts(c.closure.body, [], inner);
            if (inner.items.length) node.children = inner;
          }
          out.items.push(node);
          return;
        }
        if (c && c.name === 'parallel') {
          const branches = c.namedList.filter((n) => n.value.type === 'Closure');
          const par = { kind: 'par', id: `par:${e.s}`, items: [], s: e.s, conds };
          for (const br of branches) {
            const inner = seq();
            scanStmts(br.value.body, [], inner);
            par.items.push({ kind: 'stage', id: `par:${e.s}:${br.key}`, name: br.key, branch: true, conds: [], s: br.s, e: br.e, children: inner.items.length ? inner : null });
          }
          if (!branches.length) {
            par.items.push({ kind: 'stage', id: `par:${e.s}:*`, name: 'parallel branches (built at runtime)', dynamic: true, conds: [], s: e.s, e: e.e, children: null });
          }
          out.items.push(par);
          return;
        }
        if (c && methods.has(c.name) && !inMethod.has(c.name)) {
          scanExpr(e.args, conds, out);
          inMethod.add(c.name);
          scanStmts(methods.get(c.name).body, [...conds, { kind: 'call', src: `${c.name}()`, s: e.s }], out);
          inMethod.delete(c.name);
          return;
        }
        const loopish = e.callee.type === 'Member' && ['each', 'eachWithIndex', 'collect', 'times', 'findAll'].includes(e.callee.prop);
        scanExpr(e.callee, conds, out);
        const c2 = loopish ? [...conds, { kind: 'loop', src: `.${e.callee.prop} { }`, s: e.s }] : conds;
        scanExpr(e.args, c2, out);
        for (const n of e.named) scanExpr(n.value, conds, out);
        return;
      }
      for (const k of Object.keys(e)) {
        const v = e[k];
        if (v && typeof v === 'object' && k !== 'parts') scanExpr(v, conds, out);
        if (k === 'parts') scanExpr(v.filter((p) => typeof p !== 'string'), conds, out);
      }
    };
    const root = seq();
    scanStmts(this.program.body, [], root);
    return root;
  }
}

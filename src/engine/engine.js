// Dry-run engine: analyses a Jenkinsfile and simulates one build for a given
// run context. Every external command is mocked: it succeeds and returns
// plausible output unless a mock rule in the context says otherwise.

import { parse } from './parser.js';
import { PipelineSyntaxError, lineIndex } from './lexer.js';
import { buildModel, literal } from './model.js';
import { Interp, GClosure, GError, StepFailure, toStr, truthy, gEquals, isMap } from './interp.js';
import { evaluateWhen, describeWhen, failingLeaf } from './conditions.js';
import { POST_CONDITIONS, NEEDS_NODE } from './catalog.js';
import { normalizeContext, contextEnv, contextCauses, jobFullName, jobDisplayName } from './contexts.js';
import { decode } from './jobs.js';

const ORDER = ['SUCCESS', 'UNSTABLE', 'FAILURE', 'NOT_BUILT', 'ABORTED'];
const worse = (a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a);
const STATUS = { SUCCESS: 'success', UNSTABLE: 'unstable', FAILURE: 'failure', ABORTED: 'aborted', NOT_BUILT: 'not-run' };
const SECRET_RE = /([^]*)/g;
// Downstream builds deeper than this are mocked instead of simulated.
const MAX_CHAIN = 5;
// ...and a context simulates at most this many builds in all (a fan-out that starts itself grows fast).
const MAX_BUILDS = 40;
const UNIT = { SECONDS: 1, MINUTES: 60, HOURS: 3600, DAYS: 86400, MILLISECONDS: 0.001, NANOSECONDS: 1e-9, MICROSECONDS: 1e-6 };

const validAnalysis = (an) => !!(an && an.ok && an.model && !an.diagnostics.some((d) => d.severity === 'error'));

/**
 * Stop a downstream build at simulated time `cutAbs` (from the start of the root build):
 * Jenkins aborts the build a `build` step waits for when that step is interrupted.
 */
function abortRun(run, cutAbs, why) {
  const cut = Math.max(0, cutAbs - (run.offset || 0));
  if (cut >= run.duration) return false;
  run.result = 'ABORTED';
  run.duration = cut;
  for (const s of Object.values(run.stages)) {
    if (s.start == null) continue;
    if (s.start >= cut) {
      s.status = 'not-run';
      s.reason = 'not reached: the build was aborted first';
      s.start = null;
      s.end = null;
      s.spans = undefined;
    } else if (s.end == null || s.end > cut) {
      s.status = 'aborted';
      s.reason = `aborted: ${why}`;
      s.end = cut;
      if (s.spans) s.spans = s.spans.filter(([a]) => a < cut).map(([a, b]) => [a, Math.min(b, cut)]);
    }
  }
  run.log = run.log.filter((l) => l.t <= cut && !/^Finished:/.test(l.text));
  run.log.push({ text: `Aborted by upstream: ${why}`, kind: 'error', stage: null, t: cut }, { text: 'Finished: ABORTED', kind: 'error', stage: null, t: cut });
  for (const st of run.steps) if (st.t >= cut) st.status = 'not-run';
  for (const d of run.downstream) {
    if (d.offset >= cutAbs) {
      d.result = 'NOT_BUILT';
      d.error = 'not started: the build that starts it was aborted first';
      d.run = null;
      d.mocked = true;
      d.mockedBy = 'aborted';
    } else if (d.run && d.wait && abortRun(d.run, cutAbs, why)) d.result = 'ABORTED';
  }
  run.firstError = run.firstError || { message: 'Aborted by upstream', cls: 'org.jenkinsci.plugins.workflow.steps.FlowInterruptedException' };
  return true;
}

class SkipSignal { constructor(reason, tree) { this.reason = reason; this.tree = tree; } }

// ------------------------------------------------------------------ analysis

export function analyze(text) {
  const lines = lineIndex(text);
  let program;
  try {
    program = parse(text);
  } catch (e) {
    if (e instanceof PipelineSyntaxError) {
      return {
        ok: false, text, lines, program: null, model: null, mode: null, viewTree: null,
        diagnostics: [{ severity: 'error', message: e.message, s: e.range.s, e: e.range.e, hint: e.hint, code: 'syntax', syntax: true }],
      };
    }
    throw e;
  }
  const model = buildModel(program, text);
  const src = (n) => text.slice(n.s, n.e).replace(/\s+/g, ' ').trim();
  const viewTree = model.mode === 'declarative' ? declView(model.pipeline.stages, '', src) : model.scripted;
  return { ok: true, text, lines, program, model, mode: model.mode, viewTree, diagnostics: model.diagnostics, src };
}

function declView(stages, suffix, src) {
  return { kind: 'seq', items: stages.map((st) => stageView(st, suffix, src)) };
}

function stageView(st, suffix, src) {
  const node = {
    kind: 'stage', id: st.id + suffix, modelId: st.id, name: st.name, s: st.s, e: st.e, head: st.head,
    when: describeWhen(st.when, src), input: !!st.input, children: null,
  };
  if (st.stages) node.children = declView(st.stages, suffix, src);
  if (st.parallel) node.children = { kind: 'seq', items: [{ kind: 'par', id: `${node.id}:par`, failFast: st.failFast, items: st.parallel.map((p) => stageView(p, suffix, src)) }] };
  if (st.matrix) {
    const cells = st.matrix.cells.map((cell, i) => ({
      kind: 'stage', id: `${st.id}#${i}${suffix}`, name: cell.label, cell: true, s: st.s, e: st.e, head: st.head,
      when: describeWhen(st.matrix.when, src), children: declView(st.matrix.stages, `${suffix}@${i}`, src),
    }));
    node.children = { kind: 'seq', items: [{ kind: 'par', id: `${node.id}:matrix`, matrix: true, items: cells }] };
  }
  return node;
}

/** Flatten a view tree into stage nodes (depth-first), with depth. */
export function flattenView(tree, depth = 0, out = []) {
  if (!tree) return out;
  for (const it of tree.items) {
    if (it.kind === 'par') {
      for (const b of it.items) {
        out.push({ node: b, depth });
        flattenView(b.children, depth + 1, out);
      }
    } else {
      out.push({ node: it, depth });
      flattenView(it.children, depth + 1, out);
    }
  }
  return out;
}

/**
 * Simulate one build. `opts.resolveJob(name, ctx)` finds the Jenkinsfile a
 * `build job: name` step starts (see makeJobResolver); without it, downstream
 * builds are mocked.
 */
export function simulate(analysis, context, opts = {}) {
  const run = new Run(analysis, context, opts);
  return run.execute();
}

// ------------------------------------------------------------------ helpers

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function estimate(cmd) {
  const c = cmd.toLowerCase();
  if (/^\s*git\b/.test(c)) return 1;
  if (/\be2e\b|cypress|playwright|selenium/.test(c)) return 300;
  if (/integration|\bit\b|verify/.test(c)) return 120;
  if (/test|check|spec|jest|pytest/.test(c)) return 60;
  if (/terraform (apply|plan)/.test(c)) return 90;
  if (/gradle|mvn|mvnw|npm run build|yarn build|make|cargo build|go build|dotnet build/.test(c)) return 45;
  if (/docker build|buildx/.test(c)) return 60;
  if (/npm (ci|install)|yarn install|pip install/.test(c)) return 30;
  if (/docker push|helm|kubectl|deploy|aws |gcloud|az /.test(c)) return 20;
  if (/sleep (\d+)/.test(c)) return Number(c.match(/sleep (\d+)/)[1]);
  return 3;
}

function fmtDur(sec) {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
export { fmtDur };

class Env {
  constructor(base) { this.layers = [base]; }
  get(name) {
    for (let i = this.layers.length - 1; i >= 0; i--) if (Object.prototype.hasOwnProperty.call(this.layers[i], name)) return this.layers[i][name];
    return undefined;
  }
  has(name) { return this.get(name) !== undefined; }
  setGlobal(name, v) { this.layers[0][name] = v; }
  push(layer = {}) { this.layers.push(layer); return layer; }
  pop() { this.layers.pop(); }
  all() { return Object.assign({}, ...this.layers); }
}

// ------------------------------------------------------------------ the run

class Run {
  constructor(an, context, opts = {}) {
    this.an = an;
    this.model = an.model;
    this.text = an.text;
    this.ctx = normalizeContext(context);
    this.opts = opts;
    this.depth = opts.depth || 0;
    // Jobs on the way to this run (upstream first), to stop a chain that triggers itself.
    this.chain = [...(opts.chain || []), jobFullName(this.ctx)];
    // shared by every build of the chain: build numbers per job, and how many builds were simulated
    this.numbers = opts.numbers || new Map([[jobFullName(this.ctx), this.ctx.buildNumber]]);
    this.budget = opts.budget || { builds: 0 };
    this.branchLabel = this.ctx.kind === 'pr' ? `PR-${this.ctx.pr.id}` : this.ctx.branchName ?? this.ctx.branch;
    this.wsName = this.ctx.standalone ? this.ctx.job.replace(/\//g, '_') : `${this.ctx.job}_${this.ctx.branchName}`;
    this.result = 'SUCCESS';
    this.resultSet = false;
    this.log = [];
    this.steps = [];
    this.hits = new Map();
    this.branches = new Map();
    this.stages = new Map();
    this.clock = 0;
    this.warnings = [];
    this.downstream = [];
    this.postRuns = [];
    this.firstError = null;
    this.stack = [];
    this.nodeDepth = 0;
    this.prefix = '';
    this.mockUse = new Map();
    this.unknownWarned = new Set();
    this.causes = contextCauses(this.ctx);
    const baseEnv = contextEnv(this.ctx);
    this.params = {};
    for (const p of this.model.params) {
      const v = Object.prototype.hasOwnProperty.call(this.ctx.params, p.name) ? this.ctx.params[p.name] : p.default;
      this.params[p.name] = p.type === 'booleanParam' ? v === true || v === 'true' : v == null ? '' : String(v);
      baseEnv[p.name] = String(this.params[p.name]);
    }
    Object.assign(baseEnv, this.ctx.env);
    this.env = new Env(baseEnv);
    this.globals = this.makeGlobals();
    this.interp = new Interp(an.program, an.text, {
      budget: 300000,
      callStep: (name, pos, named, node, scope) => this.step(name, pos, named, node, scope),
      global: (name) => this.global(name),
      hit: (node) => this.hits.set(node.s, (this.hits.get(node.s) || 0) + 1),
      branch: (node, taken) => {
        const b = this.branches.get(node.s) || { then: 0, else: 0 };
        b[taken ? 'then' : 'else']++;
        this.branches.set(node.s, b);
      },
    });
  }

  // ---------------- logging & records
  out(text, kind = 'out') {
    const masked = String(text).replace(SECRET_RE, '****');
    for (const line of masked.split('\n')) this.log.push({ text: this.prefix + line, kind, stage: this.cur?.id || null, t: this.clock });
  }
  pl(text) { this.out(`[Pipeline] ${text}`, 'pipeline'); }
  get cur() { return this.stack[this.stack.length - 1] || null; }

  record(name, node, label, extra = {}) {
    const rec = { name, label: String(label).replace(SECRET_RE, '****'), s: node.s, e: node.e, stage: this.cur?.id || null, t: this.clock, dur: 0, status: 'ok', output: null, ...extra };
    this.steps.push(rec);
    if (this.cur) this.cur.steps.push(rec);
    return rec;
  }

  setResult(r) {
    if (!ORDER.includes(r)) return;
    this.result = worse(this.result, r);
  }
  setStageResult(r, sr = this.cur) {
    if (sr) sr.result = worse(sr.result, r);
  }

  warnOnce(key, message, node, hint) {
    if (this.unknownWarned.has(key)) return;
    this.unknownWarned.add(key);
    this.warnings.push({ severity: 'warning', message, s: node.s, e: node.e, hint, runtime: true });
  }

  secret(name) { return `${name}`; }

  // ---------------- mocks
  mockFor(command) {
    const rules = this.ctx.mocks || [];
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (!r || !r.match) continue;
      let hit = false;
      const m = String(r.match);
      if (m.length > 2 && m.startsWith('/') && m.endsWith('/')) {
        try { hit = new RegExp(m.slice(1, -1)).test(command); } catch { hit = false; }
      } else hit = command.includes(m);
      if (!hit) continue;
      const used = this.mockUse.get(i) || 0;
      if (r.times && used >= Number(r.times)) continue;
      this.mockUse.set(i, used + 1);
      return { exitCode: Number(r.exitCode) || 0, stdout: r.stdout ?? null, rule: i, duration: r.duration != null && r.duration !== '' ? Number(r.duration) : null };
    }
    return { exitCode: 0, stdout: null, rule: null, duration: null };
  }

  sha() { return (hashStr(this.branchLabel + this.ctx.buildNumber) + hashStr(this.branchLabel) + hashStr(String(this.ctx.buildNumber)) + hashStr('x' + this.branchLabel) + hashStr('y')).slice(0, 40); }

  defaultStdout(cmd) {
    const c = cmd.trim();
    const ctx = this.ctx;
    const sha = this.sha();
    if (/git\s+rev-parse\s+--short(=\d+)?\s+HEAD/.test(c)) return sha.slice(0, 7);
    if (/git\s+rev-parse\s+(--verify\s+)?HEAD/.test(c)) return sha;
    if (/git\s+rev-parse\s+--abbrev-ref\s+HEAD|git\s+branch\s+--show-current|git\s+symbolic-ref/.test(c)) return ctx.kind === 'pr' ? ctx.pr.source : ctx.kind === 'tag' ? 'HEAD' : ctx.branch;
    if (/git\s+describe/.test(c)) return ctx.tag || `v1.4.1-3-g${sha.slice(0, 7)}`;
    if (/git\s+(log|show)\b.*(%an|%ae|%aN|%cn)/.test(c)) return ctx.pr?.author || ctx.user || 'alice';
    if (/git\s+(log|show)\b/.test(c)) return ctx.commits[0] || '';
    if (/git\s+diff(-tree)?\b.*--name-(only|status)/.test(c)) return ctx.changedFiles.join('\n');
    if (/git\s+tag\b/.test(c)) return ctx.tag || '';
    if (/git\s+rev-list\s+--count/.test(c)) return '128';
    if (/git\s+config\s+--get\s+remote\.origin\.url|git\s+remote\s+get-url/.test(c)) return `https://github.com/acme/${ctx.job}.git`;
    const echo = c.match(/^echo\s+(-n\s+)?(['"]?)([^|;&>]*)\2\s*$/);
    if (echo) return echo[3].replace(SECRET_RE, '****');
    if (/^whoami\b/.test(c)) return 'jenkins';
    if (/^hostname\b/.test(c)) return this.env.get('NODE_NAME') || 'agent-1';
    if (/^uname\b/.test(c)) return 'Linux';
    if (/\bdate\b/.test(c)) return '2026-11-23';
    if (/help:evaluate.*project\.version|properties.*version|gradlew?\s+.*-q\s+printVersion/.test(c)) return '1.4.0-SNAPSHOT';
    if (/npm\s+pkg\s+get\s+version|node\s+-p.*version/.test(c)) return '"1.4.0"';
    if (/^(cat|head|tail)\s+.*version/i.test(c)) return '1.4.0';
    return '';
  }

  // ---------------- globals
  global(name) {
    if (Object.prototype.hasOwnProperty.call(this.globals, name)) return { found: true, value: this.globals[name] };
    const v = this.env.get(name);
    if (v !== undefined) return { found: true, value: v };
    return { found: false };
  }

  makeGlobals() {
    const run = this;
    const ctx = this.ctx;
    const envObj = {
      __special: 'org.jenkinsci.plugins.workflow.cps.EnvActionImpl',
      __str: () => 'org.jenkinsci.plugins.workflow.cps.EnvActionImpl@1',
      __getProp: (n) => { const v = run.env.get(n); return v === undefined ? null : v; },
      __setProp: (n, v) => run.env.setGlobal(n, v == null ? null : toStr(v)),
      __call: (name, args) => {
        if (name === 'getEnvironment' || name === 'getOverriddenEnvironment') return run.env.all();
        if (name === 'getProperty') { const v = run.env.get(toStr(args[0])); return v === undefined ? null : v; }
        if (name === 'setProperty') { run.env.setGlobal(toStr(args[0]), toStr(args[1])); return null; }
        return undefined;
      },
    };
    const paramsObj = {
      __special: 'java.util.Collections$UnmodifiableMap',
      __str: () => toStr(run.params),
      __getProp: (n) => (Object.prototype.hasOwnProperty.call(run.params, n) ? run.params[n] : null),
      __setProp: () => { throw new GError('java.lang.UnsupportedOperationException', 'params is read-only: use env.X = ... or a variable instead'); },
      __call: (name, args) => {
        if (name === 'get') return run.params[toStr(args[0])] ?? null;
        if (name === 'containsKey') return Object.prototype.hasOwnProperty.call(run.params, toStr(args[0]));
        if (name === 'keySet') return Object.keys(run.params);
        if (name === 'each') { for (const [k, v] of Object.entries(run.params)) args[0].call({ key: k, value: v, __entry: true }); return null; }
        return undefined;
      },
    };
    const prev = ctx.previousResult && ctx.previousResult !== 'none' ? ctx.previousResult : null;
    const wrapper = (result, number) => ({
      __special: 'org.jenkinsci.plugins.workflow.support.steps.build.RunWrapper',
      __str: () => `#${number}`,
      __getProp: (n) => ({ result, currentResult: result, number, id: String(number), displayName: `#${number}`, previousBuild: null }[n] ?? null),
      __call: () => undefined,
    });
    const currentBuild = {
      __special: 'org.jenkinsci.plugins.workflow.support.steps.build.RunWrapper',
      __str: () => `#${ctx.buildNumber}`,
      __getProp: (n) => {
        switch (n) {
          case 'result': return run.resultSet || run.result !== 'SUCCESS' ? run.result : null;
          case 'currentResult': return run.result;
          case 'number': return ctx.buildNumber;
          case 'id': return String(ctx.buildNumber);
          case 'displayName': return run.displayName ?? `#${ctx.buildNumber}`;
          case 'fullDisplayName': return `${jobDisplayName(ctx)} #${ctx.buildNumber}`;
          case 'projectName': return ctx.standalone ? ctx.job.split('/').pop() : ctx.branchName;
          case 'fullProjectName': return jobFullName(ctx);
          case 'description': return run.description ?? null;
          case 'previousBuild': return prev ? wrapper(prev, ctx.buildNumber - 1) : null;
          case 'previousCompletedBuild': return prev ? wrapper(prev, ctx.buildNumber - 1) : null;
          case 'previousSuccessfulBuild': return wrapper('SUCCESS', ctx.buildNumber - (prev === 'SUCCESS' ? 1 : 2));
          case 'durationString': return `${fmtDur(run.clock)} and counting`;
          case 'duration': return Math.round(run.clock * 1000);
          case 'startTimeInMillis': case 'timeInMillis': return 1795000000000;
          case 'absoluteUrl': return run.env.get('BUILD_URL');
          case 'buildCauses': return run.causes.map((c) => ({ _class: c.cls, shortDescription: c.text, userId: c.detail ?? null }));
          case 'changeSets': return ctx.commits.length ? [{ items: ctx.commits.map((m) => ({ msg: m, comment: m, author: { fullName: ctx.pr?.author || ctx.user || 'alice' }, affectedPaths: ctx.changedFiles })) }] : [];
          case 'keepLog': return false;
          case 'rawBuild': throw new GError('org.jenkinsci.plugins.scriptsecurity.sandbox.RejectedAccessException',
            'Scripts not permitted to use method org.jenkinsci.plugins.workflow.support.steps.build.RunWrapper getRawBuild');
          default: throw new GError('groovy.lang.MissingPropertyException', `No such property: ${n} for class: org.jenkinsci.plugins.workflow.support.steps.build.RunWrapper`);
        }
      },
      __setProp: (n, v) => {
        if (n === 'result') {
          const r = toStr(v).toUpperCase();
          if (!ORDER.includes(r)) throw new GError('java.lang.IllegalArgumentException', `Unknown result: ${v}`);
          run.resultSet = true;
          run.setResult(r);
          if (run.cur) run.setStageResult(r);
          return;
        }
        if (n === 'description') { run.description = toStr(v); return; }
        if (n === 'displayName') { run.displayName = toStr(v); return; }
        if (n === 'keepLog') return;
        throw new GError('groovy.lang.ReadOnlyPropertyException', `Cannot set read-only property: ${n}`);
      },
      __call: (name, args) => {
        if (name === 'getBuildCauses') {
          const list = run.causes.map((c) => ({ _class: c.cls, shortDescription: c.text, userId: c.detail ?? null }));
          return args.length ? list.filter((c) => c._class.includes(toStr(args[0]))) : list;
        }
        if (name === 'resultIsBetterOrEqualTo') return ORDER.indexOf(run.result) <= ORDER.indexOf(toStr(args[0]));
        if (name === 'resultIsWorseOrEqualTo') return ORDER.indexOf(run.result) >= ORDER.indexOf(toStr(args[0]));
        return undefined;
      },
    };
    const scm = {
      __special: 'hudson.plugins.git.GitSCM',
      branches: [{ name: run.branchLabel }],
      userRemoteConfigs: [{ url: `https://github.com/acme/${ctx.job}.git`, credentialsId: 'github' }],
      extensions: [],
      __str: () => 'hudson.plugins.git.GitSCM@scm',
    };
    const docker = {
      __special: 'org.jenkinsci.plugins.docker.workflow.Docker',
      __call: (name, args, node) => {
        const cl = args.find((a) => a instanceof GClosure);
        if (name === 'image') return run.dockerImage(toStr(args[0]), node);
        if (name === 'build') {
          const tag = toStr(args[0]);
          run.shellLike('docker.build', `docker build -t ${tag} ${args[1] != null ? toStr(args[1]) : '.'}`, node, {});
          return run.dockerImage(tag, node);
        }
        if (name === 'withRegistry' || name === 'withServer' || name === 'withTool') {
          run.pl(`withDockerRegistry`);
          run.record('docker.' + name, node, `docker.${name}(${args.filter((a) => !(a instanceof GClosure)).map(toStr).join(', ')})`);
          return cl ? cl.call() : null;
        }
        return undefined;
      },
    };
    return { env: envObj, params: paramsObj, currentBuild, scm, docker };
  }

  dockerImage(name, node) {
    const run = this;
    return {
      __special: 'org.jenkinsci.plugins.docker.workflow.Docker$Image',
      id: name,
      __str: () => name,
      __getProp: (n) => (n === 'id' ? name : n === 'imageName' ? name : null),
      __call: (m, args, callNode) => {
        const cl = args.find((a) => a instanceof GClosure);
        const n2 = callNode || node;
        if (m === 'inside') {
          if (run.nodeDepth === 0) throw run.missingContext('docker.image().inside');
          run.pl('withDockerContainer');
          run.out(`$ docker run -t -d -u 1000:1000 -w $WORKSPACE ${name} cat`, 'cmd');
          const rec = run.record('docker.inside', n2, `inside ${name}`);
          run.clock += 5;
          rec.dur = 5;
          return cl ? cl.call() : null;
        }
        if (m === 'push') { run.shellLike('docker.push', `docker push ${name}${args[0] ? ':' + toStr(args[0]) : ''}`, n2, {}); return null; }
        if (m === 'pull') { run.shellLike('docker.pull', `docker pull ${name}`, n2, {}); return null; }
        if (m === 'tag') { run.shellLike('docker.tag', `docker tag ${name} ${toStr(args[0])}`, n2, {}); return null; }
        if (m === 'run') { run.shellLike('docker.run', `docker run -d ${args[0] ? toStr(args[0]) + ' ' : ''}${name}`, n2, {}); return { __special: 'Container', id: 'c0ffee', stop: () => null }; }
        if (m === 'withRun') {
          run.shellLike('docker.run', `docker run -d ${args[0] && !(args[0] instanceof GClosure) ? toStr(args[0]) + ' ' : ''}${name}`, n2, {});
          return cl ? cl.call({ __special: 'Container', id: 'c0ffee', port: () => '0.0.0.0:32768' }) : null;
        }
        if (m === 'imageName') return name;
        return undefined;
      },
    };
  }

  /**
   * A waited-for downstream build outlives the step that started it when that
   * step was interrupted (a timeout, failFast, the pipeline timeout): Jenkins
   * aborts it then. The child ran to the end in the simulation, so cut it here.
   */
  cutInterruptedBuilds() {
    const base = this.opts.offset || 0;
    for (const d of this.downstream) {
      if (!d.run || !d.wait) continue;
      const start = d.offset - base;
      const end = start + d.run.duration;
      let cut = this.cutoff != null ? this.cutoff : Infinity;
      const sr = d.stage ? this.stages.get(d.stage) : null;
      if (sr && sr.end != null) cut = Math.min(cut, sr.end);
      else if (!sr) cut = Math.min(cut, this.clock);
      if (cut >= end - 1e-9) continue;
      if (abortRun(d.run, base + cut, `the upstream step that waited for it was interrupted at ${fmtDur(cut)}`)) {
        d.result = 'ABORTED';
        for (const l of this.log) {
          if (l.t > cut && l.text.includes(`Build ${d.display} #${d.number} completed:`)) {
            l.text = `${this.prefix}Aborting ${d.display} #${d.number}: the build step was interrupted`;
            l.kind = 'error';
            l.t = cut;
          }
        }
      }
    }
  }

  // ---------------- downstream builds
  /**
   * `build job: '...'`: start another job. When the workspace has a Jenkinsfile
   * for it (resolveJob), that build is simulated for real, as a child run that
   * starts at this point on the clock. Otherwise it is mocked, as before.
   */
  buildJob(a) {
    const job = str(a.named.job ?? a.args[0]);
    const wait = a.named.wait !== false;
    const propagate = a.named.propagate !== false;
    this.pl('build');
    const passed = (Array.isArray(a.named.parameters) ? a.named.parameters : [])
      .filter((p) => p && typeof p === 'object' && p.name != null)
      .map((p) => ({ name: str(p.name), value: p.kind === 'booleanParam' ? truthy(p.value) : str(p.value), kind: p.kind || 'string' }));
    const m = this.mockFor(`build ${job}`);
    let target = m.rule == null && this.opts.resolveJob ? this.opts.resolveJob(job, this.ctx) : null;
    let stopped = null;
    let mockedBy = m.rule != null ? 'rule' : 'missing';
    if (target && !target.notFound) {
      if (this.chain.includes(target.fullName)) { stopped = `"${target.fullName}" is already running further up this chain`; mockedBy = 'loop'; }
      else if (this.depth >= MAX_CHAIN) { stopped = `the chain is ${MAX_CHAIN + 1} builds deep`; mockedBy = 'limit'; }
      else if (this.budget.builds >= MAX_BUILDS) { stopped = `this context already simulated ${MAX_BUILDS} builds`; mockedBy = 'limit'; }
    }
    if (stopped) {
      this.warnOnce(`loop:${job}`, `build job: '${job}' was not simulated: ${stopped}`, a.node,
        'In Jenkins this would keep starting builds. The simulation mocks this build as SUCCESS instead.');
      target = null;
    }
    const notFound = target?.notFound ? target : null;
    if (notFound) target = null;
    const tctx = target ? this.downstreamContext(target, passed) : null;
    const display = tctx ? jobDisplayName(tctx) : job.replace(/^\/+/, '').split('/').map(decode).join(' » ');
    const number = tctx ? tctx.buildNumber : this.nextNumber(job);
    const rec = this.record('build', a.node, `build ${job}${wait ? '' : ' (no wait)'}`, { kind: 'downstream', mockRule: m.rule, ds: this.downstream.length });
    const entry = {
      job, display, wait, propagate, number, result: 'SUCCESS', s: a.node.s, e: a.node.e, stage: this.cur?.id || null,
      params: passed.map((p) => `${p.name}=${p.value}`), resolved: null, run: null, offset: (this.opts.offset || 0) + this.clock,
      mocked: !target, mockedBy: target ? null : mockedBy, duration: 0,
    };
    this.downstream.push(entry);
    if (notFound) {
      entry.result = 'NOT_BUILT';
      entry.mockedBy = 'notfound';
      entry.error = `No item named ${job} found`;
      rec.status = 'failed';
      throw new StepFailure(`No item named ${job} found`, 'FAILURE', 'hudson.AbortException', { hint: notFound.hint });
    }
    if (!target && m.rule == null && this.opts.resolveJob && !stopped) {
      this.warnOnce(`ds:${job}`, `No Jenkinsfile for job "${job}" in this workspace: the build is mocked as SUCCESS`, a.node,
        `Add a job named "${job}" (+ Job above the editor), or name a branch of this pipeline: build job: "${this.ctx.job}/<branch>".`);
    }
    if (target && validAnalysis(target.analysis)) {
      try {
        this.checkPassedParams(target, passed, job, a.node);
      } catch (e) {
        entry.result = 'NOT_BUILT';
        entry.error = e.message;
        rec.status = 'failed';
        throw e;
      }
    }
    this.out(`Scheduling project: ${display}`, 'info');

    let result;
    if (target) {
      entry.resolved = target.standalone ? 'job' : 'branch';
      this.budget.builds++;
      const child = this.runDownstream(target, tctx, entry.offset);
      entry.duration = child.duration;
      entry.run = child;
      result = child.result;
      if (wait) {
        this.out(`Starting building: ${display} #${number}`, 'info');
        this.clock += child.duration;
        rec.dur = child.duration;
      }
    } else {
      result = m.exitCode ? 'FAILURE' : 'SUCCESS';
      if (wait) {
        this.out(`Starting building: ${display} #${number}`, 'info');
        this.clock += m.duration ?? 60;
        rec.dur = m.duration ?? 60;
        entry.duration = rec.dur;
      }
    }
    entry.result = result;
    if (!wait) return null;
    this.out(`Build ${display} #${number} completed: ${result}`, result === 'SUCCESS' ? 'info' : 'error');
    if (result !== 'SUCCESS' && propagate) {
      rec.status = result === 'UNSTABLE' ? 'warn' : 'failed';
      throw new StepFailure(`${display} #${number} completed with status ${result} (propagate: false to ignore)`, ['UNSTABLE', 'ABORTED', 'NOT_BUILT'].includes(result) ? result : 'FAILURE');
    }
    if (result !== 'SUCCESS') rec.status = 'warn';
    const vars = entry.run ? { ...entry.run.env } : {};
    return {
      __special: 'RunWrapper', result, number,
      __str: () => `#${number}`,
      __getProp: (n) => ({
        result, number, currentResult: result, id: String(number), displayName: `#${number}`, fullDisplayName: `${display} #${number}`,
        projectName: display.split(' » ').pop(), fullProjectName: tctx ? jobFullName(tctx) : job,
        absoluteUrl: tctx ? contextEnv(tctx).BUILD_URL : `https://jenkins.example.com/job/${job}/${number}/`,
        buildVariables: vars, duration: Math.round((entry.run?.duration ?? rec.dur) * 1000),
      }[n] ?? null),
      __call: (name) => (name === 'getBuildVariables' ? vars : undefined),
    };
  }

  /** The run context of a downstream build: started by this build, with the parameters it passes. */
  downstreamContext(target, passed) {
    const n = this.nextNumber(target.fullName);
    return normalizeContext({
      id: `${this.ctx.id}>${target.fullName}#${n}`,
      name: target.fullName,
      kind: 'branch',
      branch: target.branch || 'main',
      standalone: target.standalone,
      job: target.job,
      cause: 'upstream',
      upstream: { job: jobFullName(this.ctx), number: this.ctx.buildNumber },
      params: Object.fromEntries(passed.map((p) => [p.name, p.value])),
      mocks: this.ctx.mocks,
      user: this.ctx.user,
      input: this.ctx.input,
      previousResult: 'SUCCESS',
      commits: this.ctx.commits,
      changedFiles: [],
      missingCredentials: this.ctx.missingCredentials,
      buildNumber: n,
    });
  }

  /** The next build number of a job: stable for its first build in a chain, then counting up as in Jenkins. */
  nextNumber(fullName) {
    const n = this.numbers.has(fullName) ? this.numbers.get(fullName) + 1 : 10 + (parseInt(hashStr(fullName), 16) % 80);
    this.numbers.set(fullName, n);
    return n;
  }

  /** Warn about parameters Jenkins would drop; fail on a value a choice parameter does not allow. */
  checkPassedParams(target, passed, job, node) {
    const defs = target.analysis?.model?.params;
    if (!defs) return;
    // values a choice allows are only checked when the choices are written out
    for (const p of passed) {
      const d = defs.find((x) => x.name === p.name);
      if (!d) {
        this.warnOnce(`undeclared:${job}:${p.name}`, `Parameter "${p.name}" is not defined by job "${target.fullName}": Jenkins drops it, so the downstream build never sees it`, node,
          defs.length ? `That job defines: ${defs.map((x) => x.name).join(', ')}.` : 'That job has no parameters { } block.');
      } else if (d.type === 'choice' && !d.dynamicChoices && p.kind !== 'booleanParam' && !d.choices.includes(String(p.value))) {
        throw new StepFailure(`Illegal choice for parameter ${p.name}: ${p.value}`, 'FAILURE', 'java.lang.IllegalArgumentException',
          { hint: `"${target.fullName}" allows: ${d.choices.join(', ')}.` });
      }
    }
  }

  runDownstream(target, tctx, offset) {
    const an = target.analysis;
    let child;
    if (!validAnalysis(an)) {
      // Jenkins compiles the Jenkinsfile first: the build fails before any stage runs.
      const causes = contextCauses(tctx);
      const errs = an ? an.diagnostics.filter((d) => d.severity === 'error') : [];
      const lines = [
        ...causes.map((c) => ({ text: c.text, kind: 'info' })),
        { text: 'org.codehaus.groovy.control.MultipleCompilationErrorsException: startup failed:', kind: 'error' },
        ...errs.slice(0, 5).map((d) => ({ text: `WorkflowScript: ${an.lines.line(d.s)}: ${d.message}`, kind: 'error' })),
        { text: 'Finished: FAILURE', kind: 'error' },
      ].map((l) => ({ ...l, stage: null, t: 0 }));
      child = {
        result: 'FAILURE', stages: {}, log: lines, steps: [], hits: new Map(), branches: new Map(), warnings: [],
        firstError: { message: errs[0]?.message || 'The Jenkinsfile does not compile', cls: 'org.codehaus.groovy.control.MultipleCompilationErrorsException' },
        duration: 1, postRuns: [], downstream: [], causes, context: tctx, params: {}, env: contextEnv(tctx), invalid: true,
      };
    } else {
      child = new Run(an, tctx, { resolveJob: this.opts.resolveJob, depth: this.depth + 1, chain: this.chain, offset, numbers: this.numbers, budget: this.budget }).execute();
    }
    return Object.assign(child, { job: jobFullName(tctx), display: jobDisplayName(tctx), file: target.file, offset, number: tctx.buildNumber, depth: this.depth + 1 });
  }

  missingContext(step) {
    return new StepFailure(`Required context class hudson.FilePath is missing\nPerhaps you forgot to surround the ${step} step with a step that provides this, such as: node`,
      'FAILURE', 'org.jenkinsci.plugins.workflow.steps.MissingContextVariableException',
      { hint: this.model.mode === 'declarative' ? 'With "agent none", give this stage its own agent.' : 'Wrap the steps in node { ... }.' });
  }

  // ---------------- execution entry
  execute() {
    const ctx = this.ctx;
    for (const c of this.causes) this.out(c.text, 'info');
    if (this.model.mode === 'scripted') this.pl('Start of Pipeline');
    try {
      this.interp.execBlock(this.an.program.body, this.interp.script);
    } catch (e) {
      if (!(e && e.constructor && e.constructor.name === 'ReturnSig')) {
        const err = this.interp.asGroovyError(e);
        this.fail(err);
      }
    }
    if (this.model.mode === 'scripted') this.pl('End of Pipeline');
    this.markUnreached();
    this.cutInterruptedBuilds();
    if (this.firstError) {
      const m = this.firstError;
      this.out(m.cls && !m.cls.endsWith('AbortException') && !(m.cls.endsWith('FlowInterruptedException')) ? `${m.cls}: ${m.message}` : `ERROR: ${m.message}`, 'error');
    }
    this.out(`Finished: ${this.result}`, this.result === 'SUCCESS' ? 'success' : this.result === 'UNSTABLE' ? 'warn' : 'error');
    return {
      result: this.result,
      stages: Object.fromEntries(this.stages),
      log: this.log,
      steps: this.steps,
      hits: this.hits,
      branches: this.branches,
      warnings: this.warnings,
      firstError: this.firstError ? { message: this.firstError.message, cls: this.firstError.cls, s: this.firstError.node?.s ?? this.firstError.s, e: this.firstError.node?.e ?? this.firstError.e, hint: this.firstError.hint } : null,
      duration: this.clock,
      postRuns: this.postRuns,
      downstream: this.downstream,
      causes: this.causes,
      context: ctx,
      params: this.params,
      env: this.env.layers[0],
      job: jobFullName(ctx),
      display: jobDisplayName(ctx),
      offset: this.opts.offset || 0,
      depth: this.depth,
      number: ctx.buildNumber,
    };
  }

  fail(err, node) {
    if (!this.firstError) {
      this.firstError = err;
      if (!err.node && node) err.node = node;
    }
    this.setResult(err.result || 'FAILURE');
  }

  stageRun(id, name, extra = {}) {
    let sr = this.stages.get(id);
    if (sr) {
      sr.instances++;
      if (!sr.names.includes(name)) sr.names.push(name);
      return sr;
    }
    sr = {
      id, name, names: [name], status: 'running', result: 'SUCCESS', skip: null, reason: null, when: null, phases: [], steps: [],
      post: [], start: this.clock, end: null, instances: 1, agent: null, error: null, ...extra,
    };
    this.stages.set(id, sr);
    return sr;
  }

  finishStage(sr) {
    sr.end = this.clock;
    if (sr.status !== 'skipped') sr.status = STATUS[sr.result] || 'success';
    const parent = this.stack[this.stack.length - 1];
    if (parent && sr.status !== 'skipped') parent.result = worse(parent.result, sr.result);
  }

  // Mark every stage that never ran.
  markUnreached() {
    const all = flattenView(this.an.viewTree);
    for (const { node } of all) {
      if (this.stages.has(node.id)) continue;
      if (node.dynamic) continue;
      let reason = 'never reached';
      if (this.model.mode === 'scripted') reason = this.unreachedReason(node);
      else if (this.firstError) reason = 'never reached: the pipeline stopped before this stage';
      this.stages.set(node.id, {
        id: node.id, name: node.name, names: [node.name], status: 'not-run', result: 'NOT_BUILT', skip: 'unreached', reason, when: null,
        phases: [], steps: [], post: [], start: null, end: null, instances: 0, agent: null,
      });
    }
    // dynamic stage ids discovered at runtime stay in this.stages
  }

  unreachedReason(node) {
    for (let i = node.conds.length - 1; i >= 0; i--) {
      const c = node.conds[i];
      if (c.kind === 'if') {
        const b = this.branches.get(c.s);
        if (!b) continue;
        if (c.branch === 'then' && b.then === 0) return `skipped: if (${c.src}) was false`;
        if (c.branch === 'else' && b.else === 0) return `skipped: if (${c.src}) was true`;
      }
      if (c.kind === 'loop' && this.hits.has(c.s)) return `not run: the loop ${c.src} had no iterations`;
      if (c.kind === 'catch' && this.hits.has(c.s)) return `not run: no error reached ${c.src}`;
    }
    for (const c of node.conds) {
      if (c.kind === 'if' && !this.branches.get(c.s)) return this.firstError ? 'never reached: the pipeline stopped with an error before this point' : `not reached: the code around if (${c.src}) never ran`;
      if (c.kind === 'call' && !this.hits.size) return `not run: ${c.src} was never called`;
    }
    if (this.firstError) return 'never reached: the pipeline stopped with an error before this point';
    return 'never reached';
  }

  // ---------------- steps
  step(name, pos, named, node, scope) {
    const closure = pos.length && pos[pos.length - 1] instanceof GClosure ? pos[pos.length - 1] : null;
    const args = closure ? pos.slice(0, -1) : pos;
    const a = { args, named, closure, node, scope };
    const impl = STEPS[name];
    if (!impl) {
      this.warnOnce(`step:${name}`, `Unknown step "${name}" was mocked as a successful no-op`, node.callee || node,
        'If it comes from a shared library or plugin, add a mock rule to make it fail.');
      const cmd = `${name} ${args.map(toStr).join(' ')}`.trim();
      const m = this.mockFor(cmd);
      this.pl(name);
      const rec = this.record(name, node, cmd, { mocked: true });
      if (m.exitCode) {
        rec.status = 'failed';
        throw new StepFailure(`${name} failed (mocked exit code ${m.exitCode})`);
      }
      if (closure) return closure.call();
      return m.stdout;
    }
    if (NEEDS_NODE.has(name) && this.nodeDepth === 0) throw this.missingContext(name);
    return impl.call(this, a);
  }

  shellLike(name, script, node, a) {
    const firstLine = script.split('\n').find((l) => l.trim()) || script;
    this.pl(a.label ? `${name} (${a.label})` : name);
    const m = this.mockFor(script);
    const dur = m.duration ?? estimate(script);
    const rec = this.record(name, node, a.label || firstLine.trim(), { kind: 'sh', command: script });
    for (const l of script.split('\n')) if (l.trim()) this.out(`+ ${l.trim()}`, 'cmd');
    const stdout = m.stdout ?? this.defaultStdout(script);
    if (stdout && !a.returnStdout) this.out(stdout, 'out');
    rec.output = stdout;
    rec.exitCode = m.exitCode;
    rec.mockRule = m.rule;
    this.clock += dur;
    rec.dur = dur;
    if (m.exitCode !== 0) {
      if (a.returnStatus) return m.exitCode;
      rec.status = 'failed';
      throw new StepFailure(`script returned exit code ${m.exitCode}`, 'FAILURE', 'hudson.AbortException', { node });
    }
    if (a.returnStatus) return 0;
    if (a.returnStdout) return stdout ? stdout + '\n' : '';
    return null;
  }

  wrapStep(name, a, label) {
    this.pl(name);
    this.record(name, a.node, label ?? `${name}(${a.args.map(toStr).join(', ')})`);
    return a.closure ? a.closure.call() : null;
  }

  enterAgent(agent, scope, where) {
    let desc = agent.type;
    let label = null;
    if (agent.label) label = toStr(this.interp.eval(agent.label, scope));
    const name = label ? `${label.replace(/[^\w-]/g, '').slice(0, 12) || 'agent'}-agent-1` : 'agent-1';
    this.pl('node');
    if (agent.type === 'docker' || agent.type === 'dockerfile') {
      const image = agent.image ? toStr(this.interp.eval(agent.image, scope)) : 'Dockerfile';
      desc = agent.type === 'docker' ? `docker ${image}` : 'dockerfile';
      this.out(`Running on ${name} in /home/jenkins/workspace/${this.wsName}`, 'info');
      this.out(agent.type === 'docker' ? `+ docker pull ${image}` : '+ docker build -t pipeline-agent -f Dockerfile .', 'cmd');
      this.clock += agent.type === 'docker' ? 8 : 40;
    } else if (agent.type === 'kubernetes') {
      desc = 'kubernetes pod';
      this.out(`Created Pod: ${this.ctx.job}-${this.ctx.buildNumber}-xk2p9 in namespace jenkins`, 'info');
      this.clock += 12;
    } else {
      if (label) desc = `label ${label}`;
      this.out(`Running on ${name} in /home/jenkins/workspace/${this.wsName}`, 'info');
      this.clock += 2;
    }
    this.nodeDepth++;
    this.env.push({ NODE_NAME: name, WORKSPACE: `/home/jenkins/workspace/${this.wsName}`, NODE_LABELS: label || name });
    return desc;
  }
  exitAgent() { this.nodeDepth--; this.env.pop(); }

  evalEnv(list, layer, scope) {
    for (const en of list) {
      if (en.cred) {
        layer[en.name] = this.secret(en.name);
        layer[`${en.name}_USR`] = this.secret(`${en.name}_USR`);
        layer[`${en.name}_PSW`] = this.secret(`${en.name}_PSW`);
        const id = literal(en.value.args[0]);
        if (this.ctx.missingCredentials.includes(id)) {
          throw new StepFailure(`Could not find credentials entry with ID '${id}'`, 'FAILURE', 'org.jenkinsci.plugins.credentialsbinding.impl.CredentialNotFoundException', { node: en });
        }
        continue;
      }
      const v = this.interp.eval(en.value, scope);
      layer[en.name] = v == null ? 'null' : toStr(v);
    }
  }

  // ---------------- declarative
  runDeclarative(a) {
    const P = this.model.pipeline;
    const scope = a.scope;
    this.pl('Start of Pipeline');
    const opt = Object.fromEntries(P.options.map((o) => [o.name, o]));
    this.skipAfterUnstable = !!opt.skipStagesAfterUnstable;
    this.parallelsFailFast = !!opt.parallelsAlwaysFailFast;
    const timeoutSec = opt.timeout ? this.timeoutSeconds(opt.timeout, scope) : null;
    const layer = this.env.push({});
    let agentOn = false;
    this.pipelineAgent = P.agent ? P.agent.type : null;
    try {
      this.evalEnv(P.environment, layer, scope);
      if (P.agent && P.agent.type !== 'none') {
        this.pipelineAgentDesc = this.enterAgent(P.agent, scope, 'pipeline');
        agentOn = true;
        if (!opt.skipDefaultCheckout) {
          this.pl('stage');
          this.pl('{ (Declarative: Checkout SCM)');
          this.pl('checkout');
          this.out(`Checking out Revision ${this.sha()} (${this.branchLabel})`, 'info');
          this.env.setGlobal('GIT_COMMIT', this.sha());
          this.env.setGlobal('GIT_BRANCH', this.branchLabel);
          this.clock += 3;
          this.pl('}');
        }
      }
      const flow = { failed: false };
      this.runStages(P.stages, scope, flow, '');
      if (timeoutSec != null && this.clock > timeoutSec) {
        const deadline = timeoutSec;
        this.cutoff = deadline;
        this.out('Timeout has been exceeded', 'error');
        for (const sr of this.stages.values()) {
          if (sr.start != null && sr.start >= deadline && sr.status !== 'skipped') { sr.status = 'aborted'; sr.reason = 'aborted: the pipeline timeout had already expired'; }
        }
        for (const st of this.steps) if (st.t >= deadline) st.status = 'not-run';
        this.fail(new StepFailure('Timeout has been exceeded', 'ABORTED', 'org.jenkinsci.plugins.workflow.steps.FlowInterruptedException'));
      }
    } catch (e) {
      if (e instanceof SkipSignal) throw e;
      this.fail(this.interp.asGroovyError(e), a.node);
    }
    if (P.post) this.runPost(P.post, null, scope, 'pipeline');
    if (agentOn) this.exitAgent();
    this.env.pop();
    this.pl('End of Pipeline');
    return null;
  }

  timeoutSeconds(o, scope) {
    const ev = (n) => (n ? this.interp.eval(n, scope) : null);
    const time = ev(o.named.time) ?? ev(o.pos[0]);
    const unit = toStr(ev(o.named.unit) ?? 'MINUTES').toUpperCase();
    return Number(time) * (UNIT[unit] ?? 60);
  }

  runStages(list, scope, flow, suffix) {
    for (const st of list) this.runStage(st, scope, flow, suffix);
  }

  runStage(st, scope, flow, suffix, extra = {}) {
    const self = this;
    this.runStageLike({
      id: st.id + suffix,
      name: st.name,
      model: st,
      when: st.when,
      agent: st.agent,
      environment: st.environment,
      input: st.input,
      options: st.options,
      post: st.post,
      extraEnv: extra.env || null,
      body(sr, sc) {
        if (st.steps) {
          self.interp.execBlock(st.steps.stmts, new (sc.constructor)(sc));
          return { failed: false };
        }
        if (st.stages) {
          const child = { failed: false };
          self.runStages(st.stages, sc, child, suffix);
          return child;
        }
        if (st.parallel) return self.runParallel(st.parallel.map((p) => ({ kind: 'stage', st: p })), sc, suffix, st.failFast || self.parallelsFailFast);
        if (st.matrix) {
          const M = st.matrix;
          const cells = M.cells.map((cell, i) => ({ kind: 'cell', st, cell, i }));
          return self.runParallel(cells, sc, suffix, st.failFast || self.parallelsFailFast);
        }
        return { failed: false };
      },
      skipChildren: (kind, reason) => this.skipTree(st, suffix, kind, reason),
    }, scope, flow);
  }

  runCell(owner, cell, i, scope, flow, suffix) {
    const M = owner.matrix;
    const self = this;
    const cellSuffix = `${suffix}@${i}`;
    this.runStageLike({
      id: `${owner.id}#${i}${suffix}`,
      name: cell.label,
      cell: true,
      when: M.when,
      agent: M.agent,
      environment: M.environment,
      input: null,
      options: M.options,
      post: M.post,
      extraEnv: cell.values,
      body(sr, sc) {
        const child = { failed: false };
        self.runStages(M.stages, sc, child, cellSuffix);
        return child;
      },
      skipChildren: (kind, reason) => { for (const s of M.stages) this.skipTree(s, cellSuffix, kind, reason); },
    }, scope, flow);
  }

  skipTree(st, suffix, kind, reason) {
    const mark = (s, suf) => {
      const sr = this.stageRun(s.id + suf, s.name);
      sr.status = 'skipped';
      sr.skip = kind;
      sr.reason = reason;
      sr.end = this.clock;
      sr.result = 'NOT_BUILT';
      if (s.stages) s.stages.forEach((c) => mark(c, suf));
      if (s.parallel) s.parallel.forEach((c) => mark(c, suf));
      if (s.matrix) {
        s.matrix.cells.forEach((cell, i) => {
          const cr = this.stageRun(`${s.id}#${i}${suf}`, cell.label);
          Object.assign(cr, { status: 'skipped', skip: kind, reason, end: this.clock, result: 'NOT_BUILT' });
          s.matrix.stages.forEach((c) => mark(c, `${suf}@${i}`));
        });
      }
    };
    if (st.stages) st.stages.forEach((c) => mark(c, suffix));
    if (st.parallel) st.parallel.forEach((c) => mark(c, suffix));
    if (st.matrix) {
      st.matrix.cells.forEach((cell, i) => {
        const cr = this.stageRun(`${st.id}#${i}${suffix}`, cell.label);
        Object.assign(cr, { status: 'skipped', skip: kind, reason, end: this.clock, result: 'NOT_BUILT' });
        st.matrix.stages.forEach((c) => mark(c, `${suffix}@${i}`));
      });
    }
  }

  evalWhenNow(spec, sr, scope) {
    const host = {
      env: (n) => { const v = this.env.get(n); return v === undefined ? null : v; },
      evalNode: (n) => this.interp.eval(n, scope),
      callClosure: (cl) => this.interp.invokeClosure(new GClosure(cl, scope, this.interp), []),
      changedFiles: () => this.ctx.changedFiles,
      commitMessages: () => this.ctx.commits,
      causes: () => this.causes,
      truthy, equals: gEquals, str: (v) => (typeof v === 'string' ? `'${v}'` : toStr(v)),
    };
    const r = evaluateWhen(spec.when, host, this.an.src);
    sr.when = r;
    sr.phases.push({ name: 'when', ok: r.value });
    if (!r.value) {
      const leaf = failingLeaf(r.tree);
      throw new SkipSignal(leaf ? `${leaf.text}${leaf.detail ? ` → false (${leaf.detail})` : ' → false'}` : 'when → false', r.tree);
    }
  }

  runStageLike(spec, scope, flow) {
    const sr = this.stageRun(spec.id, spec.name, { cell: !!spec.cell });
    sr.start = this.clock;
    this.pl('stage');
    this.pl(`{ (${spec.name})`);
    if (flow.failed) {
      this.markSkip(sr, spec, 'failure', `Stage "${spec.name}" skipped due to earlier failure(s)`);
      return;
    }
    if (this.skipAfterUnstable && this.result === 'UNSTABLE') {
      this.markSkip(sr, spec, 'unstable', `Stage "${spec.name}" skipped due to earlier stage(s) marking the build as unstable`);
      return;
    }
    this.stack.push(sr);
    const layer = this.env.push({ STAGE_NAME: spec.name, ...(spec.extraEnv || {}) });
    const W = spec.when;
    const whenAt = W ? (W.beforeOptions ? 'options' : W.beforeInput ? 'input' : W.beforeAgent ? 'agent' : 'body') : null;
    let agentOn = false;
    let skipped = false;
    const sc = new (scope.constructor)(scope);
    try {
      if (whenAt === 'options') this.evalWhenNow(spec, sr, sc);
      const opts = Object.fromEntries((spec.options || []).map((o) => [o.name, o]));
      if (spec.options?.length) sr.phases.push({ name: 'options', ok: true, detail: spec.options.map((o) => o.name).join(', ') });
      if (whenAt === 'input') this.evalWhenNow(spec, sr, sc);
      if (spec.input) this.doInput(spec.input, sc, sr, spec.input);
      if (whenAt === 'agent') this.evalWhenNow(spec, sr, sc);
      if (spec.agent && spec.agent.type !== 'none') {
        sr.agent = this.enterAgent(spec.agent, sc, spec.name);
        agentOn = true;
        sr.phases.push({ name: 'agent', ok: true, detail: sr.agent });
      }
      if (spec.environment?.length) {
        this.evalEnv(spec.environment, layer, sc);
        sr.phases.push({ name: 'environment', ok: true, detail: spec.environment.map((e) => e.name).join(', ') });
      }
      if (whenAt === 'body') this.evalWhenNow(spec, sr, sc);
      const runBody = () => spec.body(sr, sc);
      let r;
      const retry = opts.retry ? Number(literal(opts.retry.pos[0]) ?? literal(opts.retry.named.count) ?? 1) : 1;
      const tmo = opts.timeout ? this.timeoutSeconds(opts.timeout, sc) : null;
      for (let attempt = 1; ; attempt++) {
        try {
          const t0 = this.clock;
          r = runBody();
          if (tmo != null && this.clock - t0 > tmo) {
            for (const st of sr.steps) if (st.t >= t0 + tmo) st.status = 'not-run';
            this.clock = t0 + tmo;
            throw new StepFailure('Timeout has been exceeded', 'ABORTED', 'org.jenkinsci.plugins.workflow.steps.FlowInterruptedException');
          }
          if (r && r.failed && attempt < retry) {
            this.out(`Retrying stage (attempt ${attempt + 1} of ${retry})`, 'warn');
            continue;
          }
          break;
        } catch (e) {
          if (e instanceof SkipSignal || attempt >= retry || (e instanceof StepFailure && e.result === 'ABORTED')) throw e;
          this.out(`ERROR: ${e.message}`, 'error');
          this.out(`Retrying stage "${spec.name}" (attempt ${attempt + 1} of ${retry})`, 'warn');
          sr.result = 'SUCCESS';
          sr.retries = attempt;
        }
      }
      if (r && r.failed) {
        flow.failed = true;
        sr.result = worse(sr.result, 'FAILURE');
        sr.failedAt = this.clock;
      }
    } catch (e) {
      if (e instanceof SkipSignal) {
        skipped = true;
        sr.status = 'skipped';
        sr.skip = 'when';
        sr.reason = e.reason;
        sr.result = 'NOT_BUILT';
        this.out(`Stage "${spec.name}" skipped due to when conditional`, 'skip');
        spec.skipChildren('parent', `parent stage "${spec.name}" was skipped`);
      } else {
        const err = this.interp.asGroovyError(e);
        sr.result = worse(sr.result, err.result || 'FAILURE');
        sr.error = { message: err.message, cls: err.cls, s: err.node?.s, e: err.node?.e };
        sr.reason = err.message;
        sr.failedAt = this.clock;
        flow.failed = true;
        this.fail(err);
        this.setResult(err.result || 'FAILURE');
        this.out(`ERROR: ${err.message}`, 'error');
        if (spec.skipChildren) {
          // children that never started inside a failing stage
        }
      }
    } finally {
      if (!skipped && spec.post) {
        this.runPost(spec.post, sr, sc, spec.name);
        if (sr.result === 'FAILURE' && !flow.failed && sr.postFailed) flow.failed = true;
      }
      if (agentOn) this.exitAgent();
      this.env.pop();
      this.stack.pop();
      this.finishStage(sr);
      this.pl('}');
      this.pl('// stage');
    }
  }

  markSkip(sr, spec, kind, reason) {
    sr.status = 'skipped';
    sr.skip = kind;
    sr.reason = reason;
    sr.result = 'NOT_BUILT';
    sr.end = this.clock;
    this.out(reason, 'skip');
    spec.skipChildren(kind, reason);
    this.pl('}');
    this.pl('// stage');
  }

  runParallel(branches, scope, suffix, failFast) {
    this.pl('parallel');
    const t0 = this.clock;
    const results = [];
    const savedPrefix = this.prefix;
    for (const b of branches) {
      this.clock = t0;
      const name = b.kind === 'stage' ? b.st.name : b.cell.label;
      this.prefix = `[${name}] `;
      const bflow = { failed: false };
      if (b.kind === 'stage') this.runStage(b.st, scope, bflow, suffix);
      else this.runCell(b.st, b.cell, b.i, scope, bflow, suffix);
      const id = b.kind === 'stage' ? b.st.id + suffix : `${b.st.id}#${b.i}${suffix}`;
      const sr = this.stages.get(id);
      results.push({ id, name, sr, end: this.clock, failed: bflow.failed, failedAt: sr.failedAt ?? null });
    }
    this.prefix = savedPrefix;
    this.clock = Math.max(t0, ...results.map((r) => r.end));
    const failed = results.filter((r) => r.failed);
    if (failFast && failed.length) {
      const first = failed.reduce((m, r) => (r.failedAt < m.failedAt ? r : m));
      const tf = first.failedAt;
      for (const r of results) {
        if (r === first || r.failed) continue;
        if (r.sr.status === 'skipped') continue;
        if (r.end > tf) {
          r.sr.status = 'aborted';
          r.sr.result = 'ABORTED';
          r.sr.reason = `aborted by failFast: "${first.name}" failed first`;
          r.sr.end = tf;
          for (const st of this.steps) if (st.t >= tf && this.isInside(st.stage, r.id)) st.status = 'not-run';
          // nothing inside the aborted branch may outlive the abort
          for (const s2 of this.stages.values()) {
            if (s2 === r.sr || !this.isInside(s2.id, r.id) || s2.start == null) continue;
            const late = s2.end == null || s2.end > tf;
            if (late && s2.status !== 'skipped') {
              s2.status = 'aborted';
              s2.result = 'ABORTED';
              s2.reason = `aborted by failFast: "${first.name}" failed first`;
            }
            s2.start = Math.min(s2.start, tf);
            if (late) s2.end = tf;
          }
        }
      }
      this.clock = Math.max(tf, ...results.filter((r) => r.failed).map((r) => r.end));
      this.out(`Failed in branch ${first.name}`, 'error');
    }
    return { failed: failed.length > 0 };
  }

  isInside(stageId, ancestorId) {
    if (!stageId) return false;
    if (stageId === ancestorId) return true;
    // declarative ids: children share no prefix, so look the tree up
    const anc = this.findView(ancestorId);
    if (!anc) return false;
    return flattenView(anc.children).some(({ node }) => node.id === stageId);
  }

  findView(id) {
    return flattenView(this.an.viewTree).map((x) => x.node).find((n) => n.id === id) || null;
  }

  runPost(post, sr, scope, owner) {
    const prev = this.ctx.previousResult && this.ctx.previousResult !== 'none' ? this.ctx.previousResult : null;
    const byCond = new Map(post.blocks.map((b) => [b.cond, b]));
    if (!sr) {
      this.pl('stage');
      this.pl('{ (Declarative: Post Actions)');
    }
    for (const cond of POST_CONDITIONS) {
      const b = byCond.get(cond);
      if (!b) continue;
      const cur = sr ? sr.result : this.result;
      let run;
      let why;
      switch (cond) {
        case 'always': run = true; why = 'always runs'; break;
        case 'cleanup': run = true; why = 'always runs, after every other post condition'; break;
        case 'changed': run = prev == null || prev !== cur; why = prev == null ? 'no previous build' : `previous ${prev}, now ${cur}`; break;
        case 'fixed': run = cur === 'SUCCESS' && (prev === 'FAILURE' || prev === 'UNSTABLE'); why = `previous ${prev ?? 'none'}, now ${cur}`; break;
        case 'regression': run = ['FAILURE', 'UNSTABLE', 'ABORTED'].includes(cur) && prev === 'SUCCESS'; why = `previous ${prev ?? 'none'}, now ${cur}`; break;
        case 'aborted': run = cur === 'ABORTED'; why = `result is ${cur}`; break;
        case 'failure': run = cur === 'FAILURE'; why = `result is ${cur}`; break;
        case 'success': run = cur === 'SUCCESS'; why = `result is ${cur}`; break;
        case 'unstable': run = cur === 'UNSTABLE'; why = `result is ${cur}`; break;
        case 'unsuccessful': run = cur !== 'SUCCESS'; why = `result is ${cur}`; break;
        case 'notBuilt': run = cur === 'NOT_BUILT'; why = `result is ${cur}`; break;
        default: run = false;
      }
      const entry = { owner, stage: sr?.id || null, cond, ran: run, why, s: b.s, e: b.e, error: null };
      (sr ? sr.post : this.postRuns).push(entry);
      if (!run) continue;
      this.out(`Post condition "${cond}" ran (${why})`, 'info');
      const saved = this.stack.length;
      try {
        this.interp.execBlock(b.stmts, new (scope.constructor)(scope));
      } catch (e) {
        this.stack.length = saved;
        const err = this.interp.asGroovyError(e);
        entry.error = err.message;
        this.out(`Error when executing ${cond} post condition: ${err.message}`, 'error');
        this.fail(err);
        if (sr) { sr.result = worse(sr.result, err.result || 'FAILURE'); sr.postFailed = true; }
      }
    }
    if (!sr) this.pl('}');
  }

  doInput(spec, scope, sr, directive) {
    const msg = toStr(spec.message ? this.interp.eval(spec.message, scope) : 'Proceed?');
    const okText = spec.ok ? toStr(this.interp.eval(spec.ok, scope)) : 'Proceed';
    this.pl('input');
    this.out(`${msg}\n${okText} or Abort`, 'info');
    const rec = this.record('input', spec, `input: ${msg}`, { kind: 'input' });
    const wait = 120;
    this.clock += wait;
    rec.dur = wait;
    const who = this.ctx.user || 'alice';
    if (sr) sr.phases.push({ name: 'input', ok: this.ctx.input !== 'abort', detail: msg });
    if (this.ctx.input === 'abort') {
      rec.status = 'failed';
      this.out(`Rejected by ${who}`, 'error');
      throw new StepFailure(`Rejected by ${who} at input "${msg}"`, 'ABORTED', 'org.jenkinsci.plugins.workflow.steps.FlowInterruptedException');
    }
    this.out(`Approved by ${who}`, 'info');
    const params = directive?.parameters || [];
    if (params.length) {
      const layer = this.env.layers[this.env.layers.length - 1];
      for (const p of params) layer[p.name] = String(p.default);
    }
    return null;
  }

  // ---------------- scripted stages & parallel
  scriptedStage(a) {
    const name = toStr(a.args[0] ?? a.named.name);
    const id = `site:${a.node.s}`;
    if (!a.closure) {
      this.pl(`stage (${name})`);
      this.out('Using the ‘stage’ step without a block argument is deprecated', 'warn');
      return null;
    }
    const sr = this.stageRun(id, name);
    if (sr.instances === 1) sr.start = this.clock;
    const spanStart = this.clock;
    sr.status = 'running';
    this.pl('stage');
    this.pl(`{ (${name})`);
    this.stack.push(sr);
    this.env.push({ STAGE_NAME: name });
    try {
      return a.closure.call();
    } catch (e) {
      const err = this.interp.asGroovyError(e);
      sr.result = worse(sr.result, err.result || 'FAILURE');
      sr.error = { message: err.message, cls: err.cls, s: err.node?.s, e: err.node?.e };
      sr.reason = err.message;
      sr.failedAt = this.clock;
      throw err;
    } finally {
      this.env.pop();
      this.stack.pop();
      this.finishStage(sr);
      (sr.spans = sr.spans || []).push([spanStart, this.clock]);
      this.pl('}');
      this.pl('// stage');
    }
  }

  scriptedParallel(a) {
    const map = a.args[0] && isMap(a.args[0]) ? a.args[0] : a.named;
    const failFast = truthy(map.failFast);
    const entries = Object.entries(map).filter(([, v]) => v instanceof GClosure);
    this.pl('parallel');
    const t0 = this.clock;
    const savedPrefix = this.prefix;
    const results = [];
    for (const [name, cl] of entries) {
      this.clock = t0;
      this.prefix = `[${name}] `;
      const id = `par:${a.node.s}:${name}`;
      const sr = this.stageRun(id, name, { branch: true });
      sr.start = t0;
      this.pl(`{ (Branch: ${name})`);
      this.stack.push(sr);
      let err = null;
      try { cl.call(); } catch (e) {
        err = this.interp.asGroovyError(e);
        sr.result = worse(sr.result, err.result || 'FAILURE');
        sr.error = { message: err.message, cls: err.cls, s: err.node?.s, e: err.node?.e };
        sr.reason = err.message;
        sr.failedAt = this.clock;
      } finally {
        this.stack.pop();
        this.finishStage(sr);
        this.pl('}');
      }
      results.push({ id, name, sr, end: this.clock, err, failedAt: sr.failedAt });
    }
    this.prefix = savedPrefix;
    this.clock = Math.max(t0, ...results.map((r) => r.end));
    const failed = results.filter((r) => r.err);
    if (!failed.length) return null;
    const first = failed.reduce((m, r) => (r.failedAt < m.failedAt ? r : m));
    if (failFast) {
      for (const r of results) {
        if (r.err || r.end <= first.failedAt) continue;
        r.sr.status = 'aborted';
        r.sr.result = 'ABORTED';
        r.sr.reason = `aborted by failFast: "${first.name}" failed first`;
        r.sr.end = first.failedAt;
        for (const st of this.steps) if (st.t >= first.failedAt && st.stage === r.id) st.status = 'not-run';
      }
      this.clock = Math.max(first.failedAt, ...failed.map((r) => r.end));
    }
    this.out(`Failed in branch ${first.name}`, 'error');
    throw first.err;
  }
}

// ------------------------------------------------------------------ step implementations
// `this` is the Run.

const str = (v) => (v == null ? '' : toStr(v));
const arg = (a, key, i = 0) => (a.named[key] !== undefined ? a.named[key] : a.args[i]);

function bindingVars(b) {
  return b && b.__special === 'binding' ? b.vars : [];
}

const notify = (label) => function notifyStep(a) {
  const text = str(a.named.message ?? a.named.subject ?? a.named.body ?? a.args[0]);
  this.pl(label);
  this.record(label, a.node, `${label}: ${text.slice(0, 80)}`, { kind: 'notify' });
  const cmd = `${label} ${str(a.named.channel ?? a.named.to ?? '')} ${text}`;
  const m = this.mockFor(cmd);
  this.out(`${label}${a.named.channel ? ' ' + str(a.named.channel) : a.named.to ? ' to ' + str(a.named.to) : ''}: ${text}`, 'info');
  if (m.exitCode) throw new StepFailure(`${label} failed (mocked exit code ${m.exitCode})`);
  return null;
};

const logOnly = (label, describeFn) => function logStep(a) {
  this.pl(label);
  const d = describeFn ? describeFn(a) : a.args.map(str).join(' ') || Object.entries(a.named).map(([k, v]) => `${k}: ${str(v)}`).join(', ');
  const cmd = `${label} ${d}`;
  const m = this.mockFor(cmd);
  const rec = this.record(label, a.node, d ? `${label} ${d}` : label);
  this.clock += 1;
  rec.dur = 1;
  if (m.stdout) this.out(m.stdout);
  if (m.exitCode) {
    rec.status = 'failed';
    throw new StepFailure(`${label} failed (mocked exit code ${m.exitCode})`);
  }
  return a.closure ? a.closure.call() : null;
};

const wrapper = (label) => function wrapStep(a) {
  return this.wrapStep(label, a, `${label}${a.args.length ? ' ' + a.args.map(str).join(', ') : ''}`);
};

const descriptor = (kind) => function desc(a) {
  return { __special: kind, kind, ...a.named, args: a.args, __str: () => `${kind}(${Object.entries(a.named).map(([k, v]) => `${k}: ${str(v)}`).join(', ')})` };
};

function credBinding(varKeys) {
  return function bind(a) {
    if (a.named.credentialsId === undefined && a.named.name !== undefined) {
      return { __special: 'parameter', kind: 'string', ...a.named };
    }
    const vars = varKeys.map((k) => a.named[k]).filter((v) => v != null).map(String);
    return { __special: 'binding', id: str(a.named.credentialsId), vars, __str: () => `binding(${str(a.named.credentialsId)})` };
  };
}

const STEPS = {
  pipeline(a) {
    if (!a.closure) throw new GError('groovy.lang.MissingMethodException', 'pipeline needs a block');
    return this.runDeclarative(a);
  },
  echo(a) {
    const msg = str(arg(a, 'message'));
    this.pl('echo');
    this.record('echo', a.node, msg, { kind: 'echo' });
    this.out(msg, 'echo');
    return null;
  },
  println(a) { return STEPS.echo.call(this, a); },
  print(a) { return STEPS.echo.call(this, a); },
  sh(a) { return shStep.call(this, 'sh', a); },
  bat(a) { return shStep.call(this, 'bat', a); },
  powershell(a) { return shStep.call(this, 'powershell', a); },
  pwsh(a) { return shStep.call(this, 'pwsh', a); },
  git(a) {
    const url = str(arg(a, 'url'));
    const branch = str(a.named.branch ?? 'master');
    this.pl('git');
    this.record('git', a.node, `git ${url} (${branch})`, { kind: 'scm' });
    this.out(`Cloning repository ${url}\n > git fetch --tags --force --progress -- ${url} +refs/heads/*:refs/remotes/origin/*\nChecking out Revision ${this.sha()} (refs/remotes/origin/${branch})`, 'info');
    this.clock += 3;
    return null;
  },
  checkout(a) {
    this.pl('checkout');
    const target = a.args[0] ?? a.named.scm;
    const label = target && target.__special === 'hudson.plugins.git.GitSCM' ? 'checkout scm' : `checkout ${str(target).slice(0, 60)}`;
    this.record('checkout', a.node, label, { kind: 'scm' });
    const sha = this.sha();
    const br = this.branchLabel;
    this.out(`The recommended git tool is: NONE\nCloning the remote Git repository\nChecking out Revision ${sha} (${br})\nCommit message: "${(this.ctx.commits[0] || '').split('\n')[0]}"`, 'info');
    this.env.setGlobal('GIT_COMMIT', sha);
    this.env.setGlobal('GIT_BRANCH', br);
    this.clock += 3;
    return { GIT_COMMIT: sha, GIT_BRANCH: br, GIT_URL: `https://github.com/acme/${this.ctx.job}.git`, GIT_PREVIOUS_COMMIT: sha.split('').reverse().join(''), GIT_PREVIOUS_SUCCESSFUL_COMMIT: sha.split('').reverse().join('') };
  },
  deleteDir: logOnly('deleteDir'),
  cleanWs: logOnly('cleanWs', () => ''),
  dir(a) {
    const path = str(arg(a, 'path'));
    this.pl(`dir`);
    this.out(`Running in ${this.env.get('WORKSPACE') || '/home/jenkins/workspace'}/${path}`, 'info');
    this.record('dir', a.node, `dir('${path}')`);
    this.env.push({ PWD: path });
    try { return a.closure ? a.closure.call() : null; } finally { this.env.pop(); }
  },
  withEnv(a) {
    const list = a.args[0] || [];
    const layer = {};
    for (const kv of list) {
      const s = str(kv);
      const i = s.indexOf('=');
      if (i > 0) layer[s.slice(0, i)] = s.slice(i + 1);
    }
    this.pl('withEnv');
    this.record('withEnv', a.node, `withEnv ${Object.keys(layer).join(', ')}`);
    this.env.push(layer);
    try { return a.closure ? a.closure.call() : null; } finally { this.env.pop(); }
  },
  withCredentials(a) {
    const bindings = a.args[0] || [];
    const layer = {};
    const ids = [];
    for (const b of bindings) {
      if (b?.__special !== 'binding') continue;
      ids.push(b.id);
      if (this.ctx.missingCredentials.includes(b.id)) {
        throw new StepFailure(`Could not find credentials entry with ID '${b.id}'`, 'FAILURE', 'org.jenkinsci.plugins.credentialsbinding.impl.CredentialNotFoundException', { node: a.node });
      }
      for (const v of bindingVars(b)) layer[v] = this.secret(v);
    }
    this.pl('withCredentials');
    this.out(`Masking supported pattern matches of ${Object.keys(layer).map((k) => `$${k}`).join(' or ')}`, 'info');
    this.record('withCredentials', a.node, `withCredentials ${ids.join(', ')}`);
    this.env.push(layer);
    try { return a.closure ? a.closure.call() : null; } finally { this.env.pop(); }
  },
  string: credBinding(['variable']),
  usernamePassword: credBinding(['usernameVariable', 'passwordVariable']),
  usernameColonPassword: credBinding(['variable']),
  file(a) {
    if (a.named.credentialsId === undefined && a.named.name !== undefined) return { __special: 'parameter', kind: 'file', ...a.named };
    return credBinding(['variable']).call(this, a);
  },
  sshUserPrivateKey: credBinding(['keyFileVariable', 'usernameVariable', 'passphraseVariable']),
  certificate: credBinding(['keystoreVariable', 'passwordVariable', 'aliasVariable']),
  credentials(a) { return this.secret(str(a.args[0])); },
  timeout(a) {
    const time = Number(a.named.time ?? a.args[0] ?? 0);
    const unit = str(a.named.unit ?? 'MINUTES').toUpperCase();
    const limit = time * (UNIT[unit] ?? 60);
    this.pl('timeout');
    const rec = this.record('timeout', a.node, `timeout ${time} ${unit.toLowerCase()}`);
    this.out(`Timeout set to expire in ${fmtDur(limit)}`, 'info');
    const t0 = this.clock;
    const r = a.closure ? a.closure.call() : null;
    if (this.clock - t0 > limit) {
      for (const st of this.steps) if (st.t >= t0 + limit && st !== rec) st.status = 'not-run';
      this.clock = t0 + limit;
      rec.status = 'failed';
      this.out('Cancelling nested steps due to timeout', 'error');
      throw new StepFailure('Timeout has been exceeded', 'ABORTED', 'org.jenkinsci.plugins.workflow.steps.FlowInterruptedException', { node: a.node });
    }
    return r;
  },
  retry(a) {
    const n = Number(a.named.count ?? a.args[0] ?? 1);
    this.pl('retry');
    const rec = this.record('retry', a.node, `retry ${n}`);
    for (let attempt = 1; ; attempt++) {
      try {
        return a.closure ? a.closure.call() : null;
      } catch (e) {
        if (e instanceof StepFailure && e.result === 'ABORTED') throw e;
        if (attempt >= n) throw e;
        this.out(`ERROR: ${e.message}\nRetrying`, 'warn');
        rec.attempts = attempt + 1;
      }
    }
  },
  sleep(a) {
    const time = Number(a.named.time ?? a.args[0] ?? 0);
    const unit = str(a.named.unit ?? 'SECONDS').toUpperCase();
    const sec = time * (UNIT[unit] ?? 1);
    this.pl('sleep');
    const rec = this.record('sleep', a.node, `sleep ${fmtDur(sec)}`);
    this.out(`Sleeping for ${fmtDur(sec)}`, 'info');
    this.clock += sec;
    rec.dur = sec;
    return null;
  },
  error(a) {
    const msg = str(arg(a, 'message'));
    this.pl('error');
    const rec = this.record('error', a.node, `error: ${msg}`);
    rec.status = 'failed';
    throw new StepFailure(msg, 'FAILURE', 'hudson.AbortException', { node: a.node });
  },
  unstable(a) {
    const msg = str(arg(a, 'message'));
    this.pl('unstable');
    this.record('unstable', a.node, `unstable: ${msg}`, { status: 'warn' });
    this.out(`WARNING: ${msg}`, 'warn');
    this.setResult('UNSTABLE');
    this.setStageResult('UNSTABLE');
    return null;
  },
  catchError(a) {
    const buildResult = a.named.buildResult === null ? null : str(a.named.buildResult ?? 'FAILURE').toUpperCase();
    const stageResult = a.named.stageResult === null ? null : str(a.named.stageResult ?? 'SUCCESS').toUpperCase();
    this.pl('catchError');
    const rec = this.record('catchError', a.node, `catchError (build → ${buildResult}, stage → ${stageResult})`);
    const depth = this.stack.length;
    try {
      return a.closure ? a.closure.call() : null;
    } catch (e) {
      this.stack.length = depth;
      const err = this.interp.asGroovyError(e);
      if (a.named.message) this.out(str(a.named.message), 'warn');
      this.out(`ERROR: ${err.message}`, 'error');
      rec.caught = err.message;
      if (buildResult) this.setResult(buildResult);
      if (stageResult) this.setStageResult(stageResult);
      return null;
    }
  },
  warnError(a) {
    const msg = str(arg(a, 'message'));
    this.pl('warnError');
    const rec = this.record('warnError', a.node, `warnError: ${msg}`);
    const depth = this.stack.length;
    try {
      return a.closure ? a.closure.call() : null;
    } catch (e) {
      this.stack.length = depth;
      const err = this.interp.asGroovyError(e);
      this.out(`${msg}\nERROR: ${err.message}`, 'warn');
      rec.caught = err.message;
      this.setResult('UNSTABLE');
      this.setStageResult('UNSTABLE');
      return null;
    }
  },
  script(a) { return a.closure ? a.closure.call() : null; },
  stash: logOnly('stash', (a) => `${str(a.named.name ?? a.args[0])}${a.named.includes ? ` (${str(a.named.includes)})` : ''}`),
  unstash: logOnly('unstash', (a) => str(a.named.name ?? a.args[0])),
  archiveArtifacts: logOnly('archiveArtifacts', (a) => str(a.named.artifacts ?? a.args[0])),
  archive: logOnly('archive'),
  junit(a) {
    const pattern = str(a.named.testResults ?? a.args[0]);
    this.pl('junit');
    const m = this.mockFor(`junit ${pattern}`);
    const rec = this.record('junit', a.node, `junit ${pattern}`, { kind: 'tests' });
    if (m.exitCode) {
      const n = m.exitCode;
      this.out(`Recording test results\nTest results: ${n} failure${n === 1 ? '' : 's'}`, 'warn');
      rec.status = 'warn';
      this.setResult('UNSTABLE');
      this.setStageResult('UNSTABLE');
    } else this.out('Recording test results\nTest results: all passed', 'info');
    return null;
  },
  publishHTML: logOnly('publishHTML', () => ''),
  recordIssues: logOnly('recordIssues', () => ''),
  jacoco: logOnly('jacoco', () => ''),
  cobertura: logOnly('cobertura', () => ''),
  publishChecks: logOnly('publishChecks', (a) => str(a.named.name)),
  input(a) {
    const msg = arg(a, 'message');
    const params = a.named.parameters || [];
    this.doInput({ message: { type: 'Literal', value: str(msg), s: 0, e: 0 }, ok: a.named.ok != null ? { type: 'Literal', value: str(a.named.ok) } : null, s: a.node.s, e: a.node.e }, a.scope, this.cur, null);
    if (Array.isArray(params) && params.length) {
      const vals = params.map((p) => ({ name: str(p.name), v: p.defaultValue ?? (Array.isArray(p.choices) ? p.choices[0] : '') }));
      if (vals.length === 1) return vals[0].v;
      return Object.fromEntries(vals.map((x) => [x.name, x.v]));
    }
    return null;
  },
  milestone: logOnly('milestone'),
  lock: wrapper('lock'),
  writeFile: logOnly('writeFile', (a) => str(a.named.file)),
  readFile(a) {
    const file = str(arg(a, 'file'));
    this.pl('readFile');
    const m = this.mockFor(`readFile ${file}`);
    this.record('readFile', a.node, `readFile ${file}`);
    if (m.exitCode) throw new StepFailure(`java.nio.file.NoSuchFileException: ${file}`, 'FAILURE', 'java.nio.file.NoSuchFileException');
    if (m.stdout != null) return m.stdout;
    return /version/i.test(file) ? '1.4.0\n' : '';
  },
  fileExists(a) {
    const file = str(arg(a, 'file'));
    this.pl('fileExists');
    const m = this.mockFor(`fileExists ${file}`);
    this.record('fileExists', a.node, `fileExists ${file} → ${m.exitCode ? 'false' : 'true'}`);
    return !m.exitCode;
  },
  readJSON(a) { return readStructured.call(this, 'readJSON', a, (t) => JSON.parse(t)); },
  readYaml(a) { return readStructured.call(this, 'readYaml', a, () => ({})); },
  readProperties(a) {
    return readStructured.call(this, 'readProperties', a, (t) => Object.fromEntries(t.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
  },
  readMavenPom(a) {
    this.pl('readMavenPom');
    this.record('readMavenPom', a.node, `readMavenPom ${str(a.named.file ?? 'pom.xml')}`);
    return { version: '1.4.0-SNAPSHOT', artifactId: this.ctx.job, groupId: 'com.acme', packaging: 'jar' };
  },
  writeJSON: logOnly('writeJSON', (a) => str(a.named.file)),
  writeYaml: logOnly('writeYaml', (a) => str(a.named.file)),
  findFiles(a) {
    this.pl('findFiles');
    this.record('findFiles', a.node, `findFiles ${str(a.named.glob)}`);
    return [];
  },
  touch: logOnly('touch'),
  zip: logOnly('zip', (a) => str(a.named.zipFile)),
  unzip: logOnly('unzip', (a) => str(a.named.zipFile)),
  sha1(a) { return 'da39a3ee5e6b4b0d3255bfef95601890afd80709'; },
  tee: wrapper('tee'),
  httpRequest(a) {
    const url = str(a.named.url ?? a.args[0]);
    const method = str(a.named.httpMode ?? 'GET');
    this.pl('httpRequest');
    const m = this.mockFor(`httpRequest ${method} ${url}`);
    const status = m.exitCode ? (m.exitCode >= 100 ? m.exitCode : 500) : 200;
    const rec = this.record('httpRequest', a.node, `${method} ${url} → ${status}`, { kind: 'http' });
    this.out(`HttpMethod: ${method}\nURL: ${url}\nResponse Code: HTTP/1.1 ${status}`, 'info');
    this.clock += 1;
    const range = str(a.named.validResponseCodes ?? '100:399');
    const [lo, hi] = range.split(':').map(Number);
    if (status < lo || status > (hi || lo)) {
      rec.status = 'failed';
      throw new StepFailure(`Fail: Status code ${status} is not in the accepted range: ${range}`);
    }
    return { status, content: m.stdout ?? '{}', __special: 'jenkins.plugins.http_request.ResponseContentSupplier', __getProp: (n) => (n === 'status' ? status : n === 'content' ? (m.stdout ?? '{}') : null) };
  },
  slackSend: notify('slackSend'),
  mail: notify('mail'),
  emailext: notify('emailext'),
  office365ConnectorSend: notify('office365ConnectorSend'),
  githubNotify: notify('githubNotify'),
  setGitHubPullRequestStatus: notify('setGitHubPullRequestStatus'),
  gitlabCommitStatus: wrapper('gitlabCommitStatus'),
  updateGitlabCommitStatus: notify('updateGitlabCommitStatus'),
  notifyBitbucket: notify('notifyBitbucket'),
  build(a) { return this.buildJob(a); },
  node(a) {
    const label = a.args.length ? str(a.args[0]) : a.named.label != null ? str(a.named.label) : null;
    const desc = this.enterAgent({ type: 'label', label: label ? { type: 'Literal', value: label, s: 0, e: 0 } : null }, a.scope);
    this.record('node', a.node, label ? `node('${label}')` : 'node', { kind: 'agent', detail: desc });
    try {
      return a.closure ? a.closure.call() : null;
    } finally {
      this.exitAgent();
      this.pl('}');
      this.pl('// node');
    }
  },
  stage(a) { return this.scriptedStage(a); },
  parallel(a) { return this.scriptedParallel(a); },
  withDockerRegistry: wrapper('withDockerRegistry'),
  withDockerContainer: wrapper('withDockerContainer'),
  withKubeConfig: wrapper('withKubeConfig'),
  sshagent: wrapper('sshagent'),
  withMaven: wrapper('withMaven'),
  withGradle: wrapper('withGradle'),
  withAWS: wrapper('withAWS'),
  withSonarQubeEnv: wrapper('withSonarQubeEnv'),
  waitForQualityGate(a) {
    this.pl('waitForQualityGate');
    const m = this.mockFor('waitForQualityGate');
    this.record('waitForQualityGate', a.node, `quality gate → ${m.exitCode ? 'ERROR' : 'OK'}`);
    if (m.exitCode && a.named.abortPipeline) throw new StepFailure('Pipeline aborted due to quality gate failure: ERROR');
    return { status: m.exitCode ? 'ERROR' : 'OK' };
  },
  ansiColor: wrapper('ansiColor'),
  timestamps: wrapper('timestamps'),
  wrap: wrapper('wrap'),
  container: wrapper('container'),
  podTemplate: wrapper('podTemplate'),
  ws: wrapper('ws'),
  tool(a) {
    const name = str(a.named.name ?? a.args[0]);
    this.record('tool', a.node, `tool ${name}`);
    return `/opt/tools/${name}`;
  },
  isUnix() { return true; },
  pwd() { return this.env.get('WORKSPACE') || '/home/jenkins/workspace'; },
  properties(a) {
    this.pl('properties');
    this.record('properties', a.node, 'properties (job configuration)');
    return null;
  },
  pipelineTriggers: descriptor('pipelineTriggers'),
  parameters: descriptor('parameters'),
  booleanParam: descriptor('booleanParam'),
  choice: descriptor('choice'),
  text: descriptor('text'),
  password: descriptor('password'),
  cron: descriptor('cron'),
  pollSCM: descriptor('pollSCM'),
  upstream: descriptor('upstream'),
  buildDiscarder: descriptor('buildDiscarder'),
  logRotator: descriptor('logRotator'),
  disableConcurrentBuilds: descriptor('disableConcurrentBuilds'),
  library(a) { this.record('library', a.node, `library ${str(a.args[0])}`); return mockObject(this, str(a.args[0])); },
  load(a) {
    const path = str(a.args[0]);
    this.pl('load');
    this.record('load', a.node, `load ${path}`);
    return mockObject(this, path);
  },
  addBadge: logOnly('addBadge', () => ''),
  addShortText: logOnly('addShortText', (a) => str(a.named.text)),
  step: logOnly('step', () => ''),
  nexusArtifactUploader: logOnly('nexusArtifactUploader', () => ''),
  kubernetesDeploy: logOnly('kubernetesDeploy', (a) => str(a.named.configs)),
  getContext() { return null; },
  validateDeclarativePipeline() { return true; },
};

function shStep(name, a) {
  const first = a.args[0];
  const script = typeof first === 'string' ? first : str(a.named.script ?? (first && first.script));
  const opts = { returnStdout: !!a.named.returnStdout, returnStatus: !!a.named.returnStatus, label: a.named.label ? str(a.named.label) : null };
  const argNode = a.node.args?.[0] || a.node.named?.find((n) => n.key === 'script')?.value;
  if (script.includes('') && argNode && argNode.type === 'GString') {
    const vars = [...new Set([...script.matchAll(SECRET_RE)].map((m) => m[1]))];
    this.out(`Warning: A secret was passed to "${name}" using Groovy String interpolation, which is insecure.\n\t\t Affected argument(s) used the following variable(s): [${vars.join(', ')}]`, 'warn');
    this.warnOnce(`secret:${a.node.s}`, `A secret was passed to "${name}" using Groovy String interpolation, which is insecure (${vars.join(', ')})`, argNode,
      `Use single quotes so the shell expands the variable instead of Groovy: ${name} '... $${vars[0]} ...'`);
  }
  return this.shellLike(name, script, a.node, opts);
}

function readStructured(label, a, parseText) {
  const file = str(a.named.file);
  const text = a.named.text != null ? str(a.named.text) : null;
  this.pl(label);
  const m = this.mockFor(`${label} ${file}`);
  this.record(label, a.node, `${label} ${file || '(text)'}`);
  if (m.exitCode) throw new StepFailure(`java.nio.file.NoSuchFileException: ${file}`, 'FAILURE', 'java.nio.file.NoSuchFileException');
  const t = text ?? m.stdout ?? '{}';
  try { return parseText(t); } catch { throw new StepFailure(`${label}: could not parse ${file || 'text'}`); }
}

function mockObject(run, name) {
  return {
    __special: `Script(${name})`,
    __str: () => `Script(${name})`,
    __getProp: () => null,
    __call: (m, args, node) => {
      const cl = args.find((x) => x instanceof GClosure);
      run.pl(`${name}.${m}`);
      const cmd = `${name}.${m} ${args.filter((x) => !(x instanceof GClosure)).map(toStr).join(' ')}`;
      const mk = run.mockFor(cmd);
      const rec = run.record(`${m}`, node, `${m}(${args.filter((x) => !(x instanceof GClosure)).map(toStr).join(', ')}) [mocked from ${name}]`, { mocked: true });
      if (mk.exitCode) { rec.status = 'failed'; throw new StepFailure(`${m} failed (mocked exit code ${mk.exitCode})`); }
      return cl ? cl.call() : mk.stdout;
    },
  };
}

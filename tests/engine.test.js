import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, simulate, flattenView } from '../src/engine/engine.js';
import { normalizeContext } from '../src/engine/contexts.js';
import { pathGlob, simpleGlob } from '../src/engine/conditions.js';
import { EXAMPLES } from '../src/examples.js';

const main = normalizeContext({ name: 'main', kind: 'branch', branch: 'main', changedFiles: ['src/A.java'] });
const pr = normalizeContext({ name: 'pr', kind: 'pr', pr: { id: 5, target: 'main', source: 'feat' } });
const tag = normalizeContext({ name: 'tag', kind: 'tag', tag: 'v2.0.0' });

function run(src, ctx = main) {
  const an = analyze(src);
  const errors = an.diagnostics.filter((d) => d.severity === 'error');
  assert.equal(errors.length, 0, `unexpected errors: ${errors.map((e) => e.message).join('; ')}`);
  const r = simulate(an, ctx);
  const byName = {};
  for (const { node } of flattenView(an.viewTree)) byName[node.name] = r.stages[node.id];
  return { an, r, st: byName };
}

const errorsOf = (src) => analyze(src).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

const pipe = (stages, extra = '') => `pipeline {\n agent any\n ${extra}\n stages {\n${stages}\n }\n}`;

test('every example parses; only the mistakes example has errors', () => {
  for (const ex of EXAMPLES) {
    const an = analyze(ex.source);
    assert.ok(an.ok, `${ex.id} should parse`);
    const errs = an.diagnostics.filter((d) => d.severity === 'error');
    if (ex.id === 'mistakes') assert.ok(errs.length >= 5);
    else assert.equal(errs.length, 0, `${ex.id}: ${errs.map((e) => e.message).join('; ')}`);
  }
});

test('syntax errors point at the unclosed block', () => {
  const an = analyze("pipeline {\n  agent any\n  stages {\n    stage('A') {\n      steps { echo 'x' }\n  }\n}\n");
  assert.equal(an.ok, false);
  assert.match(an.diagnostics[0].message, /Missing '}'/);
  const s = 'pipeline {\n  stages {\n    stage(\'A\') {\n      steps { sh \'make }\n';
  assert.match(analyze(s).diagnostics[0].message, /Unterminated string/);
});

test('declarative structure checks', () => {
  assert.ok(errorsOf("pipeline {\n stages { stage('A') { steps { echo 'a' } } }\n}").includes('Missing required section "agent"'));
  assert.ok(errorsOf(pipe("stage('A') { sh 'x' }")).some((m) => m.startsWith('Unknown stage section "sh"')));
  assert.ok(errorsOf(pipe("stage('A') { steps { def x = 1 } }")).includes('Expected a step'));
  assert.ok(errorsOf(pipe("stage('A') { steps { echo 'a' } }\nstage('A') { steps { echo 'b' } }")).includes('Duplicate stage name: "A"'));
  assert.ok(errorsOf(pipe("stage('A') { when { branches 'main' }\n steps { echo 'a' } }")).some((m) => m.startsWith('Unknown conditional branches')));
  assert.ok(errorsOf(pipe("stage('A') { steps { echo 'a' } }", "post { failed { echo 'x' } }")).some((m) => m.startsWith('Invalid condition "failed"')));
  assert.ok(errorsOf(pipe("stage('A') { steps { currentBuild.description = 'x' } }")).includes('Expected a step'));
  assert.ok(errorsOf(pipe("stage('A') { steps { echo 'a' } }", "triggers { cron('H 2 * *') }")).some((m) => m.includes('expected 5 fields')));
  assert.ok(errorsOf(pipe("stage('A') { steps { echo 'a' } }", 'environment { N = 5 }')).some((m) => m.startsWith('Environment variable values')));
});

test('branch condition: pull requests use PR-N as BRANCH_NAME', () => {
  const src = pipe("stage('Deploy') { when { branch 'main' }\n steps { echo 'deploy' } }");
  assert.equal(run(src, main).st.Deploy.status, 'success');
  const p = run(src, pr).st.Deploy;
  assert.equal(p.status, 'skipped');
  assert.match(p.reason, /PR-5/);
  const t = pipe("stage('Deploy') { when { changeRequest target: 'main' }\n steps { echo 'deploy' } }");
  assert.equal(run(t, pr).st.Deploy.status, 'success');
});

test('tag, anyOf, not and expression conditions', () => {
  const src = pipe(`stage('Img') { when { anyOf { branch 'main'; buildingTag() } }\n steps { echo 'x' } }
stage('Prod') { when { tag 'v*' }\n steps { echo 'x' } }
stage('Tests') { when { not { expression { params.SKIP } } }\n steps { echo 't' } }`,
  "parameters { booleanParam(name: 'SKIP', defaultValue: false) }");
  let { st } = run(src, tag);
  assert.equal(st.Img.status, 'success');
  assert.equal(st.Prod.status, 'success');
  ({ st } = run(src, pr));
  assert.equal(st.Img.status, 'skipped');
  assert.equal(st.Prod.status, 'skipped');
  assert.equal(st.Tests.status, 'success');
  ({ st } = run(src, normalizeContext({ ...main, params: { SKIP: true } })));
  assert.equal(st.Tests.status, 'skipped');
});

test('changeset uses path globs; first build has no changeset', () => {
  assert.ok(pathGlob('frontend/**').test('frontend/src/a.ts'));
  assert.ok(!pathGlob('docs/*.md').test('docs/a/b.md'));
  assert.ok(simpleGlob('release/*').test('release/1.0'));
  const src = pipe("stage('FE') { when { changeset 'frontend/**' }\n steps { echo 'x' } }");
  assert.equal(run(src, normalizeContext({ ...main, changedFiles: ['frontend/x.ts'] })).st.FE.status, 'success');
  assert.equal(run(src, normalizeContext({ ...main, changedFiles: [] })).st.FE.status, 'skipped');
});

test('a failing sh fails the stage and skips the rest; post failure runs', () => {
  const src = pipe("stage('Build') { steps { sh 'make' } }\nstage('Deploy') { steps { echo 'd' } }", "post { failure { echo 'boom' }\n success { echo 'ok' } }");
  const ctx = normalizeContext({ ...main, mocks: [{ match: 'make', exitCode: 2 }] });
  const { r, st } = run(src, ctx);
  assert.equal(r.result, 'FAILURE');
  assert.equal(st.Build.status, 'failure');
  assert.equal(st.Build.reason, 'script returned exit code 2');
  assert.equal(st.Deploy.status, 'skipped');
  assert.equal(st.Deploy.skip, 'failure');
  assert.deepEqual(r.postRuns.filter((p) => p.ran).map((p) => p.cond), ['failure']);
});

test('git commands succeed with plausible output', () => {
  const src = pipe(`stage('A') { steps { script {
    env.SHA = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
    env.FILES = sh(script: 'git diff --name-only HEAD~1', returnStdout: true).trim()
  } } }`);
  const { r } = run(src);
  assert.equal(r.result, 'SUCCESS');
  assert.equal(r.env.SHA.length, 7);
  assert.equal(r.env.FILES, 'src/A.java');
});

test('parallel failFast aborts slower siblings', () => {
  const src = pipe(`stage('Tests') { failFast true
  parallel {
    stage('Fast') { steps { sh 'lint.sh' } }
    stage('Slow') { steps { sh './gradlew integrationTest' } }
  } }`);
  const { st } = run(src, normalizeContext({ ...main, mocks: [{ match: 'lint.sh', exitCode: 1 }] }));
  assert.equal(st.Fast.status, 'failure');
  assert.equal(st.Slow.status, 'aborted');
  assert.equal(st.Tests.status, 'failure');
});

test('matrix expands cells, applies excludes and per-cell when', () => {
  const ex = EXAMPLES.find((e) => e.id === 'matrix');
  const { an, r } = run(ex.source);
  const cells = flattenView(an.viewTree).filter(({ node }) => node.cell);
  assert.equal(cells.length, 5);
  const smoke = flattenView(an.viewTree).filter(({ node }) => node.name === 'Windows smoke test').map(({ node }) => r.stages[node.id].status);
  assert.deepEqual(smoke.sort(), ['skipped', 'skipped', 'skipped', 'success', 'success']);
});

test('catchError and unstable set results without stopping later stages', () => {
  const src = pipe(`stage('Tests') { steps {
    catchError(buildResult: 'UNSTABLE', stageResult: 'FAILURE') { sh 'make test' }
  } }
  stage('Next') { steps { echo 'still runs' } }`);
  const { r, st } = run(src, normalizeContext({ ...main, mocks: [{ match: 'make test', exitCode: 1 }] }));
  assert.equal(r.result, 'UNSTABLE');
  assert.equal(st.Tests.status, 'failure');
  assert.equal(st.Next.status, 'success');
});

test('retry with a mock that fails only once', () => {
  const src = pipe("stage('IT') { options { retry(2) }\n steps { sh './it.sh' } }");
  const { r, st } = run(src, normalizeContext({ ...main, mocks: [{ match: 'it.sh', exitCode: 1, times: 1 }] }));
  assert.equal(r.result, 'SUCCESS');
  assert.equal(st.IT.status, 'success');
});

test('input directive: abort marks the build ABORTED', () => {
  const src = pipe("stage('Prod') { input { message 'Ship?' }\n steps { echo 'x' } }");
  const { r, st } = run(src, normalizeContext({ ...main, input: 'abort' }));
  assert.equal(r.result, 'ABORTED');
  assert.equal(st.Prod.status, 'aborted');
});

test('agent none without a stage agent cannot run sh', () => {
  const src = "pipeline {\n agent none\n stages { stage('A') { steps { sh 'make' } } }\n}";
  const { r } = run(src);
  assert.equal(r.result, 'FAILURE');
  assert.match(r.firstError.message, /Required context class hudson.FilePath is missing/);
});

test('Groovy runtime errors are reported with their class', () => {
  const src = pipe("stage('A') { steps { script { echo undefinedVar } } }");
  const { r } = run(src);
  assert.equal(r.firstError.cls, 'groovy.lang.MissingPropertyException');
  assert.match(r.firstError.message, /No such property: undefinedVar/);
});

test('scripted: stages behind a false if are explained', () => {
  const ex = EXAMPLES.find((e) => e.id === 'scripted');
  const { st } = run(ex.source, normalizeContext({ kind: 'branch', branch: 'feature/x' }));
  assert.equal(st.Publish.status, 'not-run');
  assert.match(st.Publish.reason, /if \(env.BRANCH_NAME == 'main' \|\| isRelease\) was false/);
  const rel = run(ex.source, normalizeContext({ kind: 'branch', branch: 'release/2.0', params: { DEPLOY: true } }));
  assert.equal(rel.st.Deploy.status, 'success');
  assert.equal(rel.st['Smoke ${region}'].instances, 2);
});

test('secrets interpolated into sh produce a warning; single quotes do not', () => {
  const ex = EXAMPLES.find((e) => e.id === 'secrets');
  const { r } = run(ex.source);
  assert.equal(r.warnings.filter((w) => /Groovy String interpolation/.test(w.message)).length, 1);
  assert.ok(!r.log.some((l) => l.text.includes('')), 'secret markers must be masked in the log');
});

test('playback: nothing inside a failFast-aborted branch outlives the run', async () => {
  const { timedStatus } = await import('../src/ui/graph.js');
  const src = pipe(`stage('P') { failFast true
  parallel {
    stage('Bad') { steps { error 'boom' } }
    stage('Long') { stages {
      stage('L1') { steps { sh 'npm ci'; sh 'npm test' } }
      stage('L2') { steps { sh 'npm run build' } }
    } }
  } }`);
  const { r, st } = run(src);
  for (const s of Object.values(r.stages)) {
    if (s.start != null) assert.ok(s.end <= r.duration, `${s.name} ends at ${s.end} after the run (${r.duration})`);
    assert.notEqual(timedStatus(s, r.duration, r.duration), 'running', `${s.name} still running at the end`);
  }
  assert.equal(st.L1.status, 'aborted');
});

test('playback: a scripted stage in a loop runs only inside its own iterations', async () => {
  const { timedStatus } = await import('../src/ui/graph.js');
  const src = "node {\n  for (r in ['a', 'b']) {\n    stage(\"Smoke ${r}\") { sh './smoke.sh' }\n    stage(\"Wait ${r}\") { sleep 30 }\n  }\n}";
  const an = analyze(src);
  const r = simulate(an, main);
  const smoke = Object.values(r.stages).find((s) => s.name.startsWith('Smoke'));
  const wait = Object.values(r.stages).find((s) => s.name.startsWith('Wait'));
  assert.equal(smoke.spans.length, 2);
  const midWait = (wait.spans[0][0] + wait.spans[0][1]) / 2;
  assert.equal(timedStatus(wait, midWait, r.duration), 'running');
  assert.notEqual(timedStatus(smoke, midWait, r.duration), 'running');
});

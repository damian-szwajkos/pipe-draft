import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, simulate, flattenView } from '../src/engine/engine.js';
import { normalizeContext } from '../src/engine/contexts.js';
import { makeJobResolver, chainRuns, chainTotal, runAt } from '../src/engine/jobs.js';

const UPSTREAM = `pipeline {
  agent any
  parameters {
    choice(name: 'BUILD_TYPE', choices: ['Snapshot', 'PreRelease', 'Release'])
  }
  stages {
    stage('Build') { steps { sh './gradlew assemble' } }
    stage('Trigger pre-release') {
      when { allOf { branch 'main'; expression { params.BUILD_TYPE == 'PreRelease' } } }
      steps {
        build job: "\${env.JOB_NAME.split('/')[0]}/prerelease", parameters: [string(name: 'VERSION', value: '1.4.0-rc.1')]
      }
    }
    stage('Pre-release checks') {
      when { branch 'prerelease' }
      steps { sh "echo checking \${params.VERSION}" }
    }
  }
}`.replace(/parameters \{\n    choice/, `parameters {\n    string(name: 'VERSION', defaultValue: '0.0.0')\n    choice`);

const DEPLOY = `pipeline {
  agent any
  parameters {
    string(name: 'VERSION', defaultValue: '')
    choice(name: 'TARGET', choices: ['staging', 'production'])
  }
  stages {
    stage('Deploy') { steps { sh "helm upgrade shop --set image.tag=\${params.VERSION}" } }
  }
}`;

function workspace(mainSrc, jobs = {}) {
  const main = analyze(mainSrc);
  const list = Object.entries(jobs).map(([name, src], i) => ({ id: `job${i}`, name, analysis: analyze(src) }));
  return { main, resolveJob: makeJobResolver({ project: 'shop-api', main, jobs: list }) };
}

const ctx = (extra = {}) => normalizeContext({ name: 'manual', kind: 'branch', branch: 'main', cause: 'user', ...extra });

function stagesByName(an, r) {
  const out = {};
  for (const { node } of flattenView(an.viewTree)) out[node.name] = r.stages[node.id];
  return out;
}

test('a branch job runs the same Jenkinsfile on that branch, with the passed parameters', () => {
  const { main, resolveJob } = workspace(UPSTREAM);
  const r = simulate(main, ctx({ params: { BUILD_TYPE: 'PreRelease' } }), { resolveJob });
  assert.equal(r.result, 'SUCCESS');
  assert.equal(r.downstream.length, 1);
  const d = r.downstream[0];
  assert.equal(d.resolved, 'branch');
  assert.equal(d.display, 'shop-api » prerelease');
  const child = d.run;
  assert.equal(child.job, 'shop-api/prerelease');
  assert.equal(child.env.BRANCH_NAME, 'prerelease');
  assert.equal(child.params.VERSION, '1.4.0-rc.1');
  assert.match(child.causes[0].text, /Started by upstream project "shop-api\/main" build number 42/);
  const st = stagesByName(main, child);
  assert.equal(st['Pre-release checks'].status, 'success');
  assert.equal(st['Trigger pre-release'].status, 'skipped');
  // the upstream waits for it: the build step lasts as long as the downstream build
  const step = r.steps.find((s) => s.name === 'build');
  assert.equal(step.dur, child.duration);
  assert.equal(child.offset, step.t);
  assert.equal(chainTotal(r), r.duration);
  assert.deepEqual(chainRuns(r).map((x) => x.path), ['', '0']);
  assert.equal(runAt(r, '0'), child);
});

test('without the parameter value the trigger stage is skipped and nothing is started', () => {
  const { main, resolveJob } = workspace(UPSTREAM);
  const r = simulate(main, ctx(), { resolveJob });
  assert.equal(r.downstream.length, 0);
  assert.equal(stagesByName(main, r)['Trigger pre-release'].status, 'skipped');
});

const CALLS = (body) => `pipeline {
  agent any
  stages {
    stage('Ship') { steps { ${body} } }
  }
}`;

test('a standalone job runs its own Jenkinsfile; relative and absolute names resolve', () => {
  for (const name of ['deploy', '/deploy', '../deploy']) {
    const { main, resolveJob } = workspace(CALLS(`build job: '${name}', parameters: [string(name: 'VERSION', value: '2.0.0'), string(name: 'TARGET', value: 'production')]`), { deploy: DEPLOY });
    const r = simulate(main, ctx(), { resolveJob });
    const d = r.downstream[0];
    assert.equal(d.resolved, 'job', name);
    assert.equal(d.run.env.JOB_NAME, 'deploy');
    assert.equal(d.run.env.BRANCH_NAME, undefined);
    assert.equal(d.run.params.TARGET, 'production');
    assert.ok(d.run.log.some((l) => /helm upgrade shop --set image.tag=2.0.0/.test(l.text)));
  }
});

test('a parameter the downstream job does not declare is dropped, with a warning', () => {
  const { main, resolveJob } = workspace(CALLS(`build job: 'deploy', parameters: [string(name: 'VERSON', value: '2.0.0')]`), { deploy: DEPLOY });
  const r = simulate(main, ctx(), { resolveJob });
  assert.ok(r.warnings.some((w) => /Parameter "VERSON" is not defined by job "deploy"/.test(w.message)));
  assert.equal(r.downstream[0].run.params.VERSON, undefined);
  assert.equal(r.downstream[0].run.params.VERSION, '');
});

test('a value a choice parameter does not allow fails the build step', () => {
  const { main, resolveJob } = workspace(CALLS(`build job: 'deploy', parameters: [string(name: 'TARGET', value: 'prod')]`), { deploy: DEPLOY });
  const r = simulate(main, ctx(), { resolveJob });
  assert.equal(r.result, 'FAILURE');
  assert.match(r.firstError.message, /Illegal choice for parameter TARGET: prod/);
  assert.equal(r.downstream[0].result, 'NOT_BUILT');
});

test('a failing downstream build fails the upstream stage unless propagate is false', () => {
  const mocks = [{ match: 'helm', exitCode: 1 }];
  let w = workspace(CALLS(`build job: 'deploy'`), { deploy: DEPLOY });
  let r = simulate(w.main, ctx({ mocks }), { resolveJob: w.resolveJob });
  assert.equal(r.downstream[0].run.result, 'FAILURE');
  assert.equal(r.result, 'FAILURE');
  assert.match(r.firstError.message, /deploy #\d+ completed with status FAILURE/);
  w = workspace(CALLS(`script { def b = build(job: 'deploy', propagate: false); echo "downstream: \${b.result}" }`), { deploy: DEPLOY });
  r = simulate(w.main, ctx({ mocks }), { resolveJob: w.resolveJob });
  assert.equal(r.result, 'SUCCESS');
  assert.ok(r.log.some((l) => l.text === 'downstream: FAILURE'));
});

test('wait: false queues the build and goes on without waiting', () => {
  const { main, resolveJob } = workspace(CALLS(`build job: 'deploy', wait: false\n sh 'echo after'`), { deploy: DEPLOY });
  const r = simulate(main, ctx({ mocks: [{ match: 'helm', exitCode: 1 }] }), { resolveJob });
  assert.equal(r.result, 'SUCCESS');
  const d = r.downstream[0];
  assert.equal(d.run.result, 'FAILURE');
  assert.equal(r.steps.find((s) => s.name === 'build').dur, 0);
  assert.ok(chainTotal(r) > r.duration);
});

test('a chain that triggers itself stops with a warning', () => {
  const { main, resolveJob } = workspace(CALLS(`build job: 'shop-api/main'`));
  const r = simulate(main, ctx(), { resolveJob });
  assert.equal(r.downstream[0].run, null);
  assert.ok(r.warnings.some((w) => /already running further up this chain/.test(w.message)));
  const { main: m2, resolveJob: res2 } = workspace(CALLS(`build job: 'shop-api/' + (env.BRANCH_NAME == 'main' ? 'develop' : 'main')`));
  const r2 = simulate(m2, ctx(), { resolveJob: res2 });
  assert.equal(chainRuns(r2).length, 2);
});

test('an unknown job is mocked as before, with a hint; a mock rule wins over a Jenkinsfile', () => {
  let w = workspace(CALLS(`build job: 'nowhere'`));
  let r = simulate(w.main, ctx(), { resolveJob: w.resolveJob });
  assert.equal(r.result, 'SUCCESS');
  assert.equal(r.downstream[0].mocked, true);
  assert.ok(r.warnings.some((w2) => /No Jenkinsfile for job "nowhere"/.test(w2.message)));
  w = workspace(CALLS(`build job: 'deploy'`), { deploy: DEPLOY });
  r = simulate(w.main, ctx({ mocks: [{ match: 'build deploy', exitCode: 1 }] }), { resolveJob: w.resolveJob });
  assert.equal(r.downstream[0].mocked, true);
  assert.equal(r.result, 'FAILURE');
});

test('a downstream Jenkinsfile that does not compile fails before any stage', () => {
  const { main, resolveJob } = workspace(CALLS(`build job: 'deploy', propagate: false`), { deploy: 'pipeline { agent any stages { stage("x") { steps { sh "y" } }' });
  const r = simulate(main, ctx(), { resolveJob });
  assert.equal(r.downstream[0].run.result, 'FAILURE');
  assert.equal(r.downstream[0].run.invalid, true);
});

test('build parameters in a scripted pipeline are not mistaken for its own parameters', () => {
  const an = analyze(`node {\n  properties([parameters([string(name: 'A', defaultValue: 'x')])])\n  build job: 'other', parameters: [string(name: 'B', value: 'y')]\n}`);
  assert.deepEqual(an.model.params.map((p) => p.name), ['A']);
});

const LEAF = `pipeline {
  agent any
  stages {
    stage('Long') { steps { sh 'sleep 600' } }
    stage('After') { steps { echo 'late' } }
  }
}`;

test('review: a downstream build is aborted when the step waiting for it times out', () => {
  const { main, resolveJob } = workspace(CALLS(`timeout(time: 1, unit: 'MINUTES') { build job: 'leaf' }`), { leaf: LEAF });
  const r = simulate(main, ctx(), { resolveJob });
  assert.equal(r.result, 'ABORTED');
  const child = r.downstream[0].run;
  assert.equal(child.result, 'ABORTED');
  assert.equal(r.downstream[0].result, 'ABORTED');
  assert.ok(child.offset + child.duration <= r.duration + 1e-9);
  assert.equal(chainTotal(r), r.duration);
  assert.equal(Object.values(child.stages).find((s) => s.name === 'After').status, 'not-run');
});

test('review: a downstream build is aborted when failFast stops its branch', () => {
  const src = `pipeline {
  agent any
  stages {
    stage('P') {
      failFast true
      parallel {
        stage('a') { steps { sh 'exit 1' } }
        stage('b') { steps { build job: 'leaf' } }
      }
    }
  }
}`;
  const { main, resolveJob } = workspace(src, { leaf: LEAF });
  const r = simulate(main, ctx({ mocks: [{ match: 'exit 1', exitCode: 1 }] }), { resolveJob });
  assert.equal(r.downstream[0].run.result, 'ABORTED');
  assert.ok(chainTotal(r) <= r.duration + 1e-9);
});

test('review: choices computed at runtime are not checked; an invalid job is not param-checked first', () => {
  const dyn = `def envs = ['staging', 'production']\nproperties([parameters([choice(name: 'ENV', choices: envs)])])\nnode { echo "env=\${params.ENV}" }`;
  let w = workspace(CALLS(`build job: 'dyn', parameters: [string(name: 'ENV', value: 'staging')]`), { dyn });
  let r = simulate(w.main, ctx(), { resolveJob: w.resolveJob });
  assert.equal(r.result, 'SUCCESS');
  w = workspace(CALLS(`build job: 'bad', propagate: false, parameters: [string(name: 'X', value: 'y')]`), { bad: 'pipeline { agent any stages {' });
  r = simulate(w.main, ctx(), { resolveJob: w.resolveJob });
  assert.equal(r.downstream[0].run.invalid, true);
  assert.ok(!r.warnings.some((x) => /is not defined by job/.test(x.message)));
});

test('review: a malformed % in a job name does not crash the step', () => {
  const { main, resolveJob } = workspace(CALLS(`build job: 'other/release%', wait: false, propagate: false`));
  const r = simulate(main, ctx(), { resolveJob });
  assert.equal(r.result, 'SUCCESS');
});

test('review: an unencoded branch slash fails like Jenkins; ./branch resolves to a branch', () => {
  let w = workspace(CALLS(`build job: 'shop-api/feature/login'`));
  let r = simulate(w.main, ctx(), { resolveJob: w.resolveJob });
  assert.equal(r.result, 'FAILURE');
  assert.match(r.firstError.message, /No item named shop-api\/feature\/login found/);
  assert.match(r.firstError.hint, /feature%2Flogin/);
  w = workspace(CALLS(`build job: 'shop-api/feature%2Flogin', propagate: false`));
  r = simulate(w.main, ctx(), { resolveJob: w.resolveJob });
  assert.equal(r.downstream[0].run.env.BRANCH_NAME, 'feature/login');
  w = workspace(`pipeline { agent any\n stages { stage('x') { when { branch 'main' }\n steps { build job: './develop' } } } }`);
  r = simulate(w.main, ctx(), { resolveJob: w.resolveJob });
  assert.equal(r.downstream[0].resolved, 'branch');
  assert.equal(r.downstream[0].run.env.BRANCH_NAME, 'develop');
});

test('review: each build of a job gets the next number', () => {
  const { main, resolveJob } = workspace(CALLS(`script { def a = build('deploy'); def b = build('deploy'); echo "a=\${a.number} b=\${b.number}" }`), { deploy: DEPLOY.replace("defaultValue: ''", "defaultValue: '1'") });
  const r = simulate(main, ctx(), { resolveJob });
  const [a, b] = r.downstream.map((d) => d.number);
  assert.equal(b, a + 1);
  assert.ok(r.log.some((l) => l.text === `a=${a} b=${b}`));
  assert.notEqual(r.downstream[0].run.context.id, r.downstream[1].run.context.id);
});

test('review: a fan-out that starts itself stays bounded', () => {
  const names = Array.from({ length: 10 }, (_, i) => `'e${i}'`).join(', ');
  const { main, resolveJob } = workspace(CALLS(`script { for (e in [${names}]) { build job: "shop-api/\${e}", wait: false } }`));
  const r = simulate(main, ctx(), { resolveJob });
  assert.ok(chainRuns(r).length <= 41, `${chainRuns(r).length} builds`);
  assert.ok(chainRuns(r).some(({ run }) => run.warnings.some((w) => /already simulated 40 builds/.test(w.message))));
});

// Run contexts: what triggered the build and what the world looks like
// (branch, pull request, tag, changed files, parameters, mocks...).

let seq = 0;
export const newId = () => `ctx-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const CAUSES = {
  push: { label: 'Push (branch event)', cls: 'jenkins.branch.BranchEventCause', text: (c) => `Push event to branch ${c.branch}` },
  pr: { label: 'Pull request event', cls: 'jenkins.branch.BranchEventCause', text: (c) => `Pull request #${c.pr.id} updated` },
  scm: { label: 'SCM polling', cls: 'hudson.triggers.SCMTrigger$SCMTriggerCause', text: () => 'Started by an SCM change' },
  timer: { label: 'Timer (cron)', cls: 'hudson.triggers.TimerTrigger$TimerTriggerCause', text: () => 'Started by timer' },
  user: { label: 'Manual (Build with Parameters)', cls: 'hudson.model.Cause$UserIdCause', text: (c) => `Started by user ${c.user}` },
  upstream: { label: 'Upstream job', cls: 'hudson.model.Cause$UpstreamCause', text: () => 'Started by upstream project "platform/libs" build number 211' },
  indexing: { label: 'Branch indexing', cls: 'jenkins.branch.BranchIndexingCause', text: () => 'Branch indexing' },
};

export function normalizeContext(c = {}) {
  const kind = c.kind || 'branch';
  const pr = { id: 42, target: 'main', source: 'feature/login', author: 'alice', title: 'Add login page', fork: false, ...(c.pr || {}) };
  const branch = c.branch || 'main';
  const tag = c.tag || 'v1.2.0';
  const branchName = kind === 'pr' ? `PR-${pr.id}` : kind === 'tag' ? tag : branch;
  const lines = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => x.trim()).filter(Boolean);
  return {
    id: c.id || newId(),
    name: c.name || 'Context',
    kind,
    branch,
    pr,
    tag,
    branchName,
    cause: c.cause || (kind === 'pr' ? 'pr' : 'push'),
    user: c.user || 'alice',
    changedFiles: lines(c.changedFiles),
    commits: (Array.isArray(c.commits) ? c.commits : lines(c.commits)).length ? (Array.isArray(c.commits) ? c.commits : lines(c.commits)) : ['Update service'],
    params: c.params || {},
    env: c.env || {},
    previousResult: c.previousResult || 'SUCCESS',
    input: c.input || 'approve',
    mocks: (c.mocks || []).filter((m) => m && m.match),
    buildNumber: Number(c.buildNumber) || 42,
    job: c.job || 'shop-api',
    missingCredentials: c.missingCredentials || [],
  };
}

export function contextCauses(ctx) {
  const c = CAUSES[ctx.cause] || CAUSES.push;
  const out = [{ cls: c.cls, text: c.text(ctx), detail: ctx.cause === 'user' ? ctx.user : null }];
  return out;
}

export function contextEnv(ctx) {
  const n = ctx.buildNumber;
  const enc = encodeURIComponent(ctx.branchName);
  const e = {
    BRANCH_NAME: ctx.branchName,
    BUILD_NUMBER: String(n),
    BUILD_ID: String(n),
    BUILD_DISPLAY_NAME: `#${n}`,
    JOB_NAME: `${ctx.job}/${enc}`,
    JOB_BASE_NAME: ctx.branchName,
    BUILD_TAG: `jenkins-${ctx.job}-${ctx.branchName.replace(/\//g, '-')}-${n}`,
    JENKINS_URL: 'https://jenkins.example.com/',
    JOB_URL: `https://jenkins.example.com/job/${ctx.job}/job/${enc}/`,
    BUILD_URL: `https://jenkins.example.com/job/${ctx.job}/job/${enc}/${n}/`,
    RUN_DISPLAY_URL: `https://jenkins.example.com/job/${ctx.job}/job/${enc}/${n}/display/redirect`,
    EXECUTOR_NUMBER: '0',
    HUDSON_HOME: '/var/jenkins_home',
    CI: 'true',
  };
  if (['main', 'master'].includes(ctx.branchName)) e.BRANCH_IS_PRIMARY = 'true';
  if (ctx.kind === 'pr') {
    Object.assign(e, {
      CHANGE_ID: String(ctx.pr.id),
      CHANGE_TARGET: ctx.pr.target,
      CHANGE_BRANCH: ctx.pr.source,
      CHANGE_AUTHOR: ctx.pr.author,
      CHANGE_AUTHOR_DISPLAY_NAME: ctx.pr.author,
      CHANGE_AUTHOR_EMAIL: `${ctx.pr.author}@example.com`,
      CHANGE_TITLE: ctx.pr.title,
      CHANGE_URL: `https://github.com/acme/${ctx.job}/pull/${ctx.pr.id}`,
      CHANGE_FORK: ctx.pr.fork ? 'true' : undefined,
    });
    if (!ctx.pr.fork) delete e.CHANGE_FORK;
  }
  if (ctx.kind === 'tag') {
    e.TAG_NAME = ctx.tag;
    e.TAG_TIMESTAMP = '1795000000000';
    e.TAG_UNIXTIME = '1795000000';
    e.TAG_DATE = 'Mon Nov 23 10:00:00 UTC 2026';
  }
  return e;
}

export function presetContexts() {
  return [
    { name: 'Push to main', kind: 'branch', branch: 'main', cause: 'push', changedFiles: ['src/main/java/shop/OrderService.java'], commits: ['Merge pull request #41 from feature/cart'] },
    { name: 'Feature branch', kind: 'branch', branch: 'feature/login', cause: 'push', changedFiles: ['src/main/java/shop/LoginController.java'], commits: ['Add login form'] },
    { name: 'Pull request #42', kind: 'pr', pr: { id: 42, target: 'main', source: 'feature/login', author: 'alice', title: 'Add login page' }, cause: 'pr', changedFiles: ['src/main/java/shop/LoginController.java'], commits: ['Add login form'] },
    { name: 'Release tag v1.2.0', kind: 'tag', tag: 'v1.2.0', cause: 'push', changedFiles: [], commits: ['Release 1.2.0'] },
    { name: 'Nightly (cron)', kind: 'branch', branch: 'main', cause: 'timer', changedFiles: [], commits: ['Merge pull request #41 from feature/cart'] },
    { name: 'Tests fail on main', kind: 'branch', branch: 'main', cause: 'push', changedFiles: ['src/main/java/shop/OrderService.java'], commits: ['Refactor order totals'], previousResult: 'SUCCESS', mocks: [{ match: '/\\btest\\b/', exitCode: 1, stdout: 'OrderServiceTest > totals FAILED' }] },
  ].map((c) => normalizeContext(c));
}

/** Contexts that flip the conditions found in the pipeline (static, best-effort). */
export function suggestContexts(analysis) {
  const out = [];
  const add = (c) => {
    const n = normalizeContext(c);
    if (!out.some((o) => o.name === n.name)) out.push(n);
  };
  const model = analysis?.model;
  if (!model) return out;
  const conds = [];
  const visit = (stages) => {
    for (const s of stages || []) {
      if (s.when) conds.push(...flat(s.when.conds));
      visit(s.stages);
      visit(s.parallel);
      if (s.matrix) { if (s.matrix.when) conds.push(...flat(s.matrix.when.conds)); visit(s.matrix.stages); }
    }
  };
  const flat = (list) => list.flatMap((c) => [c, ...flat(c.children || [])]);
  if (model.pipeline) visit(model.pipeline.stages);
  const lit = (c, k) => {
    const n = c.pos[0] || c.named[k];
    return n && n.type === 'Literal' ? String(n.value) : null;
  };
  const sample = (p) => p.replace(/\*\*/g, 'x').replace(/\*/g, '1.0').replace(/\?/g, 'a');
  for (const c of conds) {
    if (c.type === 'branch') {
      const p = lit(c, 'pattern');
      if (p) add({ name: `Push to ${sample(p)}`, kind: 'branch', branch: sample(p), changedFiles: ['src/App.java'] });
    }
    if (c.type === 'buildingTag' || c.type === 'tag') {
      const p = lit(c, 'pattern');
      const t = p ? sample(p) : 'v1.2.0';
      add({ name: `Tag ${t}`, kind: 'tag', tag: t });
    }
    if (c.type === 'changeRequest') {
      const target = c.named.target?.type === 'Literal' ? c.named.target.value : 'main';
      add({ name: `PR into ${target}`, kind: 'pr', pr: { id: 7, target, source: 'feature/x', author: 'bob', title: 'Change' }, changedFiles: ['src/App.java'] });
    }
    if (c.type === 'changeset') {
      const p = lit(c, 'pattern');
      if (p) add({ name: `Change in ${p}`, kind: 'branch', branch: 'main', changedFiles: [sample(p).replace(/x$/, 'file.txt')] });
    }
    if (c.type === 'triggeredBy') {
      const cause = lit(c, 'cause') || '';
      if (/Timer/.test(cause)) add({ name: 'Nightly (cron)', kind: 'branch', branch: 'main', cause: 'timer' });
      if (/UserId/.test(cause)) add({ name: 'Manual build', kind: 'branch', branch: 'main', cause: 'user' });
      if (/Upstream/.test(cause)) add({ name: 'Upstream trigger', kind: 'branch', branch: 'main', cause: 'upstream' });
    }
    if (c.type === 'changelog') {
      const p = lit(c, 'pattern');
      if (p) add({ name: 'Commit message match', kind: 'branch', branch: 'main', commits: [p.replace(/\\\[/g, '[').replace(/\\\]/g, ']').replace(/\.\*/g, ' ').replace(/[\\^$]/g, '').trim() || 'deploy'] });
    }
  }
  for (const p of model.params || []) {
    if (p.type === 'booleanParam') add({ name: `Manual: ${p.name}=${!p.default}`, kind: 'branch', branch: 'main', cause: 'user', params: { [p.name]: !p.default } });
    if (p.type === 'choice') for (const ch of p.choices.slice(1, 3)) add({ name: `Manual: ${p.name}=${ch}`, kind: 'branch', branch: 'main', cause: 'user', params: { [p.name]: ch } });
  }
  return out.slice(0, 8);
}

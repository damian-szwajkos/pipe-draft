// Downstream jobs: which Jenkinsfile a `build job: '...'` step starts, and the
// builds a run triggered, as one flat list for the UI.

import { jobFullName } from './contexts.js';

/** Resolve "." and ".." in a job path. Returns null when it climbs above the root. */
function normalize(segments) {
  const out = [];
  for (const s of segments) {
    if (!s || s === '.') continue;
    if (s === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(s);
  }
  return out.length ? out : null;
}

export const decode = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

/**
 * Build the resolver the engine uses for `build job:` steps.
 *
 *   project – the multibranch project the main Jenkinsfile belongs to ("shop-api")
 *   main    – the analysis of the main Jenkinsfile
 *   jobs    – standalone pipeline jobs: [{ id, name: "deploy-staging", analysis }]
 *
 * Like Jenkins, a relative name is looked up next to the calling job first
 * (inside its multibranch project or folder), then from the root; a name
 * starting with "/" only from the root. Jobs in the workspace win over
 * branches, because any branch name is assumed to exist, and a branch needs
 * the project in its name. "shop-api/prerelease" is the
 * "prerelease" branch of the "shop-api" project, so it runs the main
 * Jenkinsfile with BRANCH_NAME=prerelease. Branch names with a slash are
 * written URL-encoded, as in Jenkins: "shop-api/release%2F1.4".
 */
export function makeJobResolver({ project, main, jobs = [] }) {
  const projectSegs = String(project || '').split('/').filter(Boolean);
  const matchJob = (segs) => {
    const path = segs.join('/');
    const job = jobs.find((j) => j.name.replace(/^\/+|\/+$/g, '') === path);
    return job ? { analysis: job.analysis, file: job.id, job: path, standalone: true, branch: null, fullName: path } : null;
  };
  const matchBranch = (segs) => {
    if (main && projectSegs.length && segs.length === projectSegs.length + 1 && projectSegs.every((p, i) => p === segs[i])) {
      const branch = decode(segs[segs.length - 1]);
      return { analysis: main, file: 'main', job: projectSegs.join('/'), standalone: false, branch, fullName: `${projectSegs.join('/')}/${encodeURIComponent(branch)}` };
    }
    return null;
  };
  return function resolve(name, from) {
    const raw = String(name ?? '').trim();
    if (!raw) return null;
    const own = raw.replace(/^\/+/, '').split('/');
    const candidates = [];
    if (!raw.startsWith('/') && from) {
      const parent = jobFullName(from).split('/').slice(0, -1);
      candidates.push(normalize([...parent, ...own]));
    }
    candidates.push(normalize(own));
    // A job in the workspace is certain to exist; a branch is only assumed to.
    // So jobs win, and a bare name ("deploy") never means a branch: most
    // `build 'x'` calls start a separate job, which may simply be missing here.
    const explicit = /^\.\.?\//.test(raw);
    const matchers = explicit || own.filter((x) => x && x !== '.').length > 1 ? [matchJob, matchBranch] : [matchJob];
    for (const match of matchers) {
      for (const c of candidates) {
        const hit = c && match(c);
        if (hit) return hit;
      }
    }
    // "shop-api/feature/login": inside the project, but a branch with a slash is one
    // URL-encoded segment in Jenkins, so this item does not exist there.
    // only when the name itself spells out the project (a relative lookup could still find another job)
    for (const c of explicit ? candidates : [candidates[candidates.length - 1]]) {
      if (c && projectSegs.length && c.length > projectSegs.length + 1 && projectSegs.every((p, i) => p === c[i])) {
        const branch = c.slice(projectSegs.length).join('/');
        return { notFound: true, fullName: c.join('/'), hint: `A branch name with a slash is one URL-encoded segment of the job name: "${projectSegs.join('/')}/${encodeURIComponent(branch)}". In a Jenkinsfile: "${projectSegs.join('/')}/\${URLEncoder.encode(env.BRANCH_NAME, 'UTF-8')}".` };
      }
    }
    return null;
  };
}

/**
 * Every build in a chain, depth first: the run itself, then the builds it
 * triggered. `path` addresses a run ("" is the root, "0.1" the second build
 * started by the first downstream build).
 */
export function chainRuns(root) {
  const out = [];
  const walk = (run, path, parent, via) => {
    if (!run) return;
    out.push({ run, path, parent, via, depth: path ? path.split('.').length : 0 });
    (run.downstream || []).forEach((d, i) => {
      if (d.run) walk(d.run, path ? `${path}.${i}` : String(i), run, d);
    });
  };
  walk(root, '', null, null);
  return out;
}

/** Simulated time from the start of the root build until the last build in the chain finishes. */
export function chainTotal(root) {
  return Math.max(1, ...chainRuns(root).map(({ run }) => (run.offset || 0) + run.duration));
}

/** The run at `path`, or null. */
export function runAt(root, path) {
  if (!root) return null;
  if (!path) return root;
  let r = root;
  for (const i of path.split('.')) {
    r = r?.downstream?.[Number(i)]?.run;
    if (!r) return null;
  }
  return r;
}

// Prints every example × context outcome. Run: node tests/smoke.mjs [exampleId]
import { analyze, simulate, flattenView } from '../src/engine/engine.js';
import { presetContexts, normalizeContext } from '../src/engine/contexts.js';
import { EXAMPLES } from '../src/examples.js';

const only = process.argv[2];
for (const ex of EXAMPLES) {
  if (only && ex.id !== only) continue;
  const an = analyze(ex.source);
  console.log(`\n=== ${ex.id} (${an.mode})`);
  for (const d of an.diagnostics) console.log(`  [${d.severity}] ${d.message}`);
  if (!an.ok || an.diagnostics.some((d) => d.severity === 'error')) continue;
  const ctxs = (ex.contexts || presetContexts()).map(normalizeContext);
  for (const c of ctxs) {
    const r = simulate(an, c);
    console.log(`-- ${c.name} → ${r.result}${r.firstError ? `  ERR ${r.firstError.message}` : ''}`);
    for (const { node, depth } of flattenView(an.viewTree)) {
      const s = r.stages[node.id];
      console.log(`   ${'  '.repeat(depth)}${node.name}: ${s?.status}${s?.reason ? ` (${s.reason})` : ''}`);
    }
    for (const w of r.warnings) console.log(`   ! ${w.message}`);
  }
}

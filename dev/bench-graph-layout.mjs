#!/usr/bin/env node
// Manual dev tool: times the plan-graph pipeline the graph view runs on open, per log and stage:
// buildPlanGraphModel, then the compound Dagre layout PlanGraphCanvas performs for the same node
// set (segment groups, plus stage groups in the full scope). Reports the heaviest graphs and the
// median over repeats: a cold layout, then the layout of the same plan rebuilt in the other
// duration mode (same topology, new node data), which is the cost of flipping that setting.
// A plan whose layout throws is reported as such. Logs are labelled by index, never by file name.
//
// Usage:
//   node dev/bench-graph-layout.mjs [--repeat N] [--top K] [--scope full|segment] <log>...
import { statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, '..', 'packages', 'core', 'src');
const LAYOUT = join(HERE, '..', 'src', 'view', 'plan-graph', 'dagre-layout.ts');

const args = process.argv.slice(2);
const opt = { repeat: 5, top: 3, scope: 'full' };
const logs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repeat') opt.repeat = Number(args[++i]);
  else if (args[i] === '--top') opt.top = Number(args[++i]);
  else if (args[i] === '--scope') opt.scope = args[++i];
  else logs.push(args[i]);
}
if (!logs.length) {
  console.error('usage: node dev/bench-graph-layout.mjs [--repeat N] [--top K] [--scope full|segment] <log>...');
  process.exit(2);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (t0) => performance.now() - t0;

const { collectRun } = await import(join(CORE, 'cli', 'collect-run.ts'));
const { buildPlanGraphModel } = await import(join(CORE, 'plan-graph-model.ts'));
const layoutModule = await import(LAYOUT);
const { layoutWithDagre, computeGroupBoundsWithFallback } = layoutModule;
const clearLayoutCache = layoutModule.clearLayoutCache ?? (() => {});

const groupOf = (n) => `segment-${n.segmentIndex}`;

for (const [idx, path] of logs.entries()) {
  const label = `log ${String.fromCharCode(65 + idx)}, ${(statSync(path).size / 1e6).toFixed(0)} MB`;
  const { appModel } = await collectRun(path);
  const rows = [];
  for (const [stageId, stage] of appModel.stages) {
    const sql = stage.sqlExecutionId != null ? appModel.sql.get(stage.sqlExecutionId) : null;
    if (!sql?.planTree) continue;
    const t0 = performance.now();
    const model = buildPlanGraphModel(sql.planTree, { scope: opt.scope, stageId, appModel, findings: [] });
    const buildMs = ms(t0);
    rows.push({ stageId, model, buildMs });
  }
  // Heaviest graphs first, de-duplicated by node count since stages of one execution share a plan.
  rows.sort((a, b) => b.model.nodes.length - a.model.nodes.length);
  const seen = new Set();
  const picked = rows.filter((r) => (seen.has(r.model.nodes.length) ? false : seen.add(r.model.nodes.length))).slice(0, opt.top);
  console.log(`${label}: ${rows.length} stages with a plan`);
  for (const { stageId, model, buildMs } of picked) {
    const flipped = buildPlanGraphModel(appModel.sql.get(appModel.stages.get(stageId).sqlExecutionId).planTree, {
      scope: opt.scope, stageId, appModel, findings: [], durationMode: 'inclusive',
    });
    const layout = (m) => {
      const t = performance.now();
      const laid = layoutWithDagre(m.nodes, m.edges, { groupOf, direction: 'RL' });
      computeGroupBoundsWithFallback(groupOf, [laid, laid]);
      return ms(t);
    };
    const cold = [];
    const flip = [];
    try {
      for (let i = 0; i < opt.repeat; i++) {
        clearLayoutCache();
        cold.push(layout(model));
        flip.push(layout(flipped));
      }
    } catch (error) {
      console.log(`  stage ${stageId}: nodes=${model.nodes.length} layout throws: ${error.message}`);
      continue;
    }
    console.log(
      `  stage ${stageId}: nodes=${model.nodes.length} edges=${model.edges.length} build=${buildMs.toFixed(1)}ms` +
        ` cold layout median=${median(cold).toFixed(1)}ms (runs ${cold.map((r) => r.toFixed(0)).join('/')})` +
        ` duration-mode flip median=${median(flip).toFixed(1)}ms`,
    );
  }
}

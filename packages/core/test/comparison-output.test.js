import { describe, it, expect } from 'vitest';
import { buildComparison } from '../src/run-comparison.js';
import { comparisonVerdict } from '../src/comparison-verdict.js';
import { comparisonOutput, buildComparisonOutput } from '../src/comparison-output.js';
import { redactComparison } from '../src/redact.js';
import { runOutputBlocks } from '../src/run-output.js';

function appModel(name, id) {
  return {
    app: { id, name, startTime: 0, endTime: 1000, config: {} },
    stages: new Map(), jobs: new Map(), sql: new Map(),
    executors: { added: [], removed: [] }, runAggregates: null,
  };
}

const run = (label, name, id) => ({ label, appModel: appModel(name, id), catalog: [] });

describe('comparisonOutput', () => {
  it('projects the fields the CLI reports, in the CLI\'s key order', () => {
    const built = buildComparison(run('baseline', 'App', 'app-1'), run('candidate', 'App', 'app-2'));
    const out = comparisonOutput(built);
    expect(Object.keys(out)).toEqual([
      'verdict', 'confidence', 'reason', 'matchedCoverage', 'runtimeCoverage', 'metrics', 'findings',
      'comparisonSchemaVersion', 'stagePairs', 'unmatched', 'replanned', 'bookkeepingStageIds',
    ]);
    expect(out.verdict).toEqual(comparisonVerdict(built));
    expect(out.metrics).toBe(built.metrics);
  });
});

describe('buildComparisonOutput', () => {
  it('returns the raw comparison and its projection', () => {
    const { comparison, output } = buildComparisonOutput(run('baseline', 'App', 'app-1'), run('candidate', 'App', 'app-2'));
    expect(comparison.baselineLabel).toBe('baseline');
    expect(output).toEqual(comparisonOutput(comparison));
  });

  it('applies redaction to both the comparison and its projection', () => {
    const base = run('baseline', 'App', 'app-1');
    const cand = run('candidate', 'App', 'app-2');
    const withHost = (r) => ({ ...r, appModel: { ...r.appModel, stages: new Map([[1, { id: 1, name: 'collect at ip-10-1-2-3.ec2.internal:42', status: 'COMPLETE' }]]) } });
    const raw = buildComparisonOutput(withHost(base), withHost(cand));
    const redacted = buildComparisonOutput(withHost(base), withHost(cand), { redact: true });
    expect(JSON.stringify(raw.comparison)).toContain('ip-10-1-2-3.ec2.internal');
    expect(JSON.stringify(redacted.comparison)).not.toContain('ip-10-1-2-3.ec2.internal');
    expect(redacted.comparison).toEqual(redactComparison(raw.comparison));
    expect(redacted.output).toEqual(comparisonOutput(redacted.comparison));
  });
});

describe('runOutputBlocks', () => {
  it('returns the run\'s metrics and effective conf', () => {
    const blocks = runOutputBlocks(appModel('App', 'app-1'));
    expect(Object.keys(blocks)).toEqual(['metrics', 'effectiveConf']);
    expect(blocks.metrics.schemaVersion).toBeTypeOf('number');
  });
});

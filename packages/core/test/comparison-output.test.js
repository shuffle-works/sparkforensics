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
      'verdict', 'baselineApp', 'candidateApp', 'confidence', 'reason', 'matchedCoverage', 'runtimeCoverage', 'metrics', 'findings',
      'comparisonSchemaVersion', 'stagePairs', 'unmatched', 'replanned', 'bookkeepingStageIds', 'executionAlignment', 'comparability',
    ]);
    expect(out.verdict).toEqual(comparisonVerdict(built));
    expect(out.metrics).toBe(built.metrics);
  });

  it('names both applications, with a null attempt id when the log has none', () => {
    const cand = run('candidate', 'App', 'app-2');
    cand.appModel.app.attemptId = '2';
    const out = comparisonOutput(buildComparison(run('baseline', 'App', 'app-1'), cand));
    expect(out.baselineApp).toEqual({ id: 'app-1', attemptId: null });
    expect(out.candidateApp).toEqual({ id: 'app-2', attemptId: '2' });
  });

  it('carries the generator the surface passes, first, and leaves it out otherwise', () => {
    const built = buildComparison(run('baseline', 'App', 'app-1'), run('candidate', 'App', 'app-2'));
    const generator = { name: 'sparkforensics-mcp', version: '1.2.3', buildId: 'abc123' };
    const out = comparisonOutput(built, 'full', generator);
    expect(Object.keys(out)[0]).toBe('generator');
    expect(out.generator).toEqual(generator);
    expect('generator' in comparisonOutput(built)).toBe(false);
  });
});

describe('comparisonOutput views', () => {
  it('leaves only stagePairs out of the summary view', () => {
    const built = buildComparison(run('baseline', 'App', 'app-1'), run('candidate', 'App', 'app-2'));
    const full = comparisonOutput(built, 'full');
    const summary = comparisonOutput(built, 'summary');
    expect(Object.keys(full)).toContain('stagePairs');
    expect(Object.keys(summary)).toEqual(Object.keys(full).filter((k) => k !== 'stagePairs'));
    expect(comparisonOutput(built)).toEqual(full);
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
    expect(Object.keys(blocks)).toEqual(['app', 'metrics', 'effectiveConf']);
    expect(blocks.metrics.schemaVersion).toBeTypeOf('number');
  });

  it('names the application, with a null attempt id when the log has none', () => {
    expect(runOutputBlocks(appModel('App', 'app-1')).app).toEqual({ id: 'app-1', attemptId: null });
    const withAttempt = appModel('App', 'app-1');
    withAttempt.app.attemptId = '1';
    expect(runOutputBlocks(withAttempt).app).toEqual({ id: 'app-1', attemptId: '1' });
  });

  it('carries the generator the surface passes, first, and leaves it out otherwise', () => {
    const generator = { name: 'sparkforensics-cli', version: '1.2.3', buildId: 'abc123' };
    const blocks = runOutputBlocks(appModel('App', 'app-1'), { generator });
    expect(Object.keys(blocks)).toEqual(['generator', 'app', 'metrics', 'effectiveConf']);
    expect(blocks.generator).toEqual(generator);
    expect(runOutputBlocks(appModel('App', 'app-1'), { redact: true, generator }).generator).toEqual(generator);
    expect('generator' in runOutputBlocks(appModel('App', 'app-1'))).toBe(false);
  });
});

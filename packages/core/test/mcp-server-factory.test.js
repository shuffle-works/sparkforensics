import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer } from '../src/mcp-server-factory.js';
import { parseThresholdOverrides } from '../src/threshold-overrides.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

function tmpEventLog() {
  const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-factory-'));
  const path = join(dir, 'eventlog');
  writeFileSync(path,
    '{"Event":"SparkListenerApplicationStart","App ID":"app-1","App Name":"t","Timestamp":0}\n'
    + '{"Event":"SparkListenerApplicationEnd","Timestamp":100}\n');
  return { dir, path };
}

// Produces exactly 2 findings (memoryUtilization info/no-stage, straggler info/stage 1): one slow task among 9 fast ones.
function tmpEventLogWithFindings() {
  const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-factory-'));
  const path = join(dir, 'eventlog');
  const lines = [
    '{"Event":"SparkListenerApplicationStart","App ID":"app-findings","App Name":"t","Timestamp":0}',
    '{"Event":"SparkListenerStageSubmitted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10}}',
  ];
  for (let i = 0; i < 9; i++) {
    lines.push(JSON.stringify({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Task ID': i, 'Launch Time': 0, 'Finish Time': 100, Failed: false, Killed: false, Speculative: false },
      'Task Metrics': { 'Executor Run Time': 100, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
    }));
  }
  lines.push(JSON.stringify({
    Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
    'Task Info': { 'Task ID': 9, 'Launch Time': 0, 'Finish Time': 2000, Failed: false, Killed: false, Speculative: false },
    'Task Metrics': { 'Executor Run Time': 2000, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
  }));
  lines.push('{"Event":"SparkListenerStageCompleted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10,"Completion Time":2000}}');
  lines.push('{"Event":"SparkListenerApplicationEnd","Timestamp":2000}');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { dir, path };
}

async function connectedClient(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('createMcpServer', () => {
  it('registers all 9 tools', async () => {
    const server = createMcpServer();
    const client = await connectedClient(server);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'compare_runs', 'diagnose_run', 'evaluate_budgets', 'get_finding_documentation',
      'get_finding_evidence', 'get_reference_doc', 'get_run_summary', 'list_detectors', 'list_runs',
    ]);
  });

  it('round-trips list_detectors with filters and the server\'s own thresholds', async () => {
    const client = await connectedClient(createMcpServer({ thresholds: { skew: { ratioWarn: 6 } } }));
    const all = await client.callTool({ name: 'list_detectors', arguments: {} });
    expect(all.isError).toBeFalsy();
    expect(all.structuredContent.count).toBe(all.structuredContent.detectors.length);
    const one = await client.callTool({ name: 'list_detectors', arguments: { type: 'skew' } });
    expect(one.structuredContent.detectors).toHaveLength(1);
    expect(one.structuredContent.detectors[0].detectors[0].thresholds.ratioWarn).toBe(6);
    expect(JSON.parse(one.content[0].text)).toEqual(one.structuredContent);
    const family = await client.callTool({ name: 'list_detectors', arguments: { family: 'plan' } });
    expect(family.structuredContent.detectors.every((r) => r.family === 'plan')).toBe(true);
  });

  it('refuses a list_detectors filter value that is not in the catalog', async () => {
    const client = await connectedClient(createMcpServer());
    for (const arguments_ of [{ type: 'nope' }, { tag: 'NOPE' }, { family: 'nope' }, { scope: 'nope' }]) {
      const result = await client.callTool({ name: 'list_detectors', arguments: arguments_ }).catch((e) => ({ isError: true, thrown: e }));
      expect(result.isError, JSON.stringify(arguments_)).toBe(true);
    }
  });

  it('round-trips list_runs for a local directory', async () => {
    const { dir } = tmpEventLog();
    try {
      const server = createMcpServer();
      const client = await connectedClient(server);
      const result = await client.callTool({ name: 'list_runs', arguments: { dir } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.runs).toHaveLength(1);
      expect(result.structuredContent.runs[0].appId).toBe('app-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)('maps an unreadable event log to invalid-event-log without the path or the raw errno code', async () => {
    const { dir, path } = tmpEventLog();
    try {
      chmodSync(path, 0o000);
      const client = await connectedClient(createMcpServer());
      const result = await client.callTool({ name: 'diagnose_run', arguments: { source: { path } } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ code: 'invalid-event-log' });
      expect(result.content[0].text).toBe('The event log could not be read (EACCES).');
      expect(result.content[0].text).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a missing directory to isError + structuredContent.code directory-not-found', async () => {
    const server = createMcpServer();
    const client = await connectedClient(server);
    const result = await client.callTool({ name: 'list_runs', arguments: { dir: '/definitely/does/not/exist' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('directory-not-found');
  });

  it('rejects list_runs given both dir and shsBaseUrl, instead of silently dropping one', async () => {
    const { dir } = tmpEventLog();
    try {
      const server = createMcpServer();
      const client = await connectedClient(server);
      const result = await client.callTool({
        name: 'list_runs', arguments: { dir, shsBaseUrl: 'http://shs:18080' },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/only one of dir or shsBaseUrl/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the default History Server for a source or list_runs call without shsBaseUrl', async () => {
    const appId = 'application_0000000000000_0001';
    // Nothing listens on port 1: a call that reaches the default server fails on the fetch, not on input validation.
    const withDefault = await connectedClient(createMcpServer({ defaultShsBaseUrl: 'http://127.0.0.1:1' }));
    const viaSource = await withDefault.callTool({ name: 'get_run_summary', arguments: { source: { appId } } });
    expect(viaSource.content[0].text).toMatch(/SHS fetch failed/);
    const viaList = await withDefault.callTool({ name: 'list_runs', arguments: {} });
    expect(viaList.isError).toBe(true);
    expect(viaList.content[0].text).not.toMatch(/Provide either dir or shsBaseUrl/);

    const without = await connectedClient(createMcpServer());
    const result = await without.callTool({ name: 'get_run_summary', arguments: { source: { appId } } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Input validation error/);
  });

  it('round-trips diagnose_run for a path source', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const server = createMcpServer();
      const client = await connectedClient(server);
      const result = await client.callTool({ name: 'diagnose_run', arguments: { source: { path } } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.findings).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the generator version in the handshake and the generator and app in diagnose_run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-factory-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path,
      '{"Event":"SparkListenerApplicationStart","App ID":"app-1","App Name":"t","App Attempt ID":"2","Timestamp":0}\n'
      + '{"Event":"SparkListenerApplicationEnd","Timestamp":100}\n');
    try {
      const generator = { name: 'sparkforensics-mcp', version: '4.5.6', buildId: 'abc123' };
      const client = await connectedClient(createMcpServer({ generator }));
      expect(client.getServerVersion()).toMatchObject({ name: 'sparkforensics', version: '4.5.6' });
      const result = await client.callTool({ name: 'diagnose_run', arguments: { source: { path } } });
      expect(result.structuredContent.generator).toEqual(generator);
      expect(result.structuredContent.app).toEqual({ id: 'app-1', attemptId: '2' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the generator and both applications in compare_runs', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const generator = { name: 'sparkforensics-mcp', version: '4.5.6', buildId: 'abc123' };
      const client = await connectedClient(createMcpServer({ generator }));
      const result = await client.callTool({ name: 'compare_runs', arguments: { sourceA: { path }, sourceB: { path } } });
      expect(result.structuredContent.generator).toEqual(generator);
      expect(result.structuredContent.baselineApp).toEqual({ id: 'app-1', attemptId: null });
      expect(result.structuredContent.candidateApp).toEqual({ id: 'app-1', attemptId: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says in the tool descriptions that runId differs per tool by design', async () => {
    const client = await connectedClient(createMcpServer());
    const { tools } = await client.listTools();
    for (const name of ['diagnose_run', 'compare_runs', 'evaluate_budgets']) {
      expect(tools.find((t) => t.name === name).description).toMatch(/differs per tool by design/);
    }
  });

  it('maps a thrown run-not-found error to isError + structuredContent.code', async () => {
    const server = createMcpServer();
    const client = await connectedClient(server);
    const result = await client.callTool({ name: 'get_run_summary', arguments: { runId: 'nonexistent' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('run-not-found');
  });

  it('round-trips get_finding_documentation for a known type', async () => {
    const server = createMcpServer();
    const client = await connectedClient(server);
    const result = await client.callTool({ name: 'get_finding_documentation', arguments: { type: 'skew' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.name).toBe('Task Skew');
    expect(result.structuredContent.detectionDoc.content.length).toBeGreaterThan(0);
  });

  it('maps an unknown type to isError + structuredContent.code invalid-type', async () => {
    const server = createMcpServer();
    const client = await connectedClient(server);
    const result = await client.callTool({ name: 'get_finding_documentation', arguments: { type: 'zetaSignal' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('invalid-type');
  });

  it('round-trips evaluate_budgets for a path source', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const server = createMcpServer();
      const client = await connectedClient(server);
      const result = await client.callTool({
        name: 'evaluate_budgets', arguments: { source: { path }, maxRuntimeMs: 5000 },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.results).toEqual([
        { name: 'max-runtime', status: 'pass', detail: 'Runtime 100ms within budget 5000ms.' },
      ]);
      expect(result.structuredContent.violated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('input validation', () => {
    // The SDK reports a schema failure as an isError result or a rejected call, depending on its
    // version; either way the message names the offending field.
    async function schemaError(name, args) {
      const client = await connectedClient(createMcpServer());
      try {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        return result.content[0].text;
      } catch (e) {
        return e.message;
      }
    }

    const { dir, path } = tmpEventLog();
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it.each([
      ['maxRuntimeMs', -1], ['maxSpillGb', -0.5], ['maxSkewRatio', -2], ['maxFailedTaskRatePct', -1],
      ['minEfficiencyPct', -5], ['maxRegressionPct', -1],
    ])('rejects a negative %s on evaluate_budgets', async (field, value) => {
      expect(await schemaError('evaluate_budgets', { source: { path }, [field]: value })).toMatch(new RegExp(field));
    });

    it('rejects an unknown regressionMetric, regressionBudgets metric and failOnIntroduced', async () => {
      expect(await schemaError('evaluate_budgets', { source: { path }, sourceB: { path }, maxRegressionPct: 10, regressionMetric: 'bogus' })).toMatch(/regressionMetric/);
      expect(await schemaError('evaluate_budgets', { source: { path }, sourceB: { path }, regressionBudgets: [{ metric: 'bogus', maxPct: 10 }] })).toMatch(/regressionBudgets/);
      expect(await schemaError('evaluate_budgets', { source: { path }, sourceB: { path }, failOnIntroduced: 'bogus' })).toMatch(/failOnIntroduced/);
    });

    it('rejects an unknown impactBand or type and a negative stageId on diagnose_run', async () => {
      expect(await schemaError('diagnose_run', { source: { path }, impactBand: ['bogus'] })).toMatch(/impactBand/);
      expect(await schemaError('diagnose_run', { source: { path }, type: ['nonsense'] })).toMatch(/type/);
      expect(await schemaError('diagnose_run', { source: { path }, stageId: -1 })).toMatch(/stageId/);
    });

    it('accepts every known band, a known type, metric and failOnIntroduced value', async () => {
      const client = await connectedClient(createMcpServer());
      const diagnose = await client.callTool({
        name: 'diagnose_run', arguments: { source: { path }, impactBand: ['critical', 'warning', 'info'], type: ['straggler'], stageId: 0 },
      });
      expect(diagnose.isError).toBeFalsy();
      const budgets = await client.callTool({
        name: 'evaluate_budgets',
        arguments: { source: { path }, sourceB: { path }, maxRuntimeMs: 0, regressionMetric: 'gcTime', maxRegressionPct: 5, failOnIntroduced: 'all', regressionBudgets: [{ metric: 'wallClock', maxPct: 5 }] },
      });
      expect(budgets.isError).toBeFalsy();
    });
  });

  it('maps a thrown run-not-found error for evaluate_budgets', async () => {
    const server = createMcpServer();
    const client = await connectedClient(server);
    const result = await client.callTool({
      name: 'evaluate_budgets', arguments: { runId: 'nonexistent', maxRuntimeMs: 5000 },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('run-not-found');
  });

  it('accepts a redact param on diagnose_run, get_run_summary, compare_runs, and get_finding_evidence', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const server = createMcpServer();
      const client = await connectedClient(server);

      const diagnose = await client.callTool({ name: 'diagnose_run', arguments: { source: { path }, redact: true, minBand: 'info' } });
      expect(diagnose.isError).toBeFalsy();

      const summary = await client.callTool({ name: 'get_run_summary', arguments: { source: { path }, redact: true } });
      expect(summary.isError).toBeFalsy();
      expect(summary.structuredContent.app.id).toBe('app-1');

      const compare = await client.callTool({
        name: 'compare_runs', arguments: { sourceA: { path }, sourceB: { path }, redact: true },
      });
      expect(compare.isError).toBeFalsy();

      const findingId = diagnose.structuredContent.findings[0]?.id;
      const evidence = await client.callTool({
        name: 'get_finding_evidence', arguments: { runId: diagnose.structuredContent.runId, findingId, redact: true },
      });
      expect(evidence.isError).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips diagnose_run\'s include param through the in-memory transport', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const server = createMcpServer();
      const client = await connectedClient(server);

      const plain = await client.callTool({ name: 'diagnose_run', arguments: { source: { path } } });
      expect(plain.isError).toBeFalsy();
      expect('summary' in plain.structuredContent).toBe(false);

      const included = await client.callTool({
        name: 'diagnose_run', arguments: { source: { path }, include: ['summary', 'evidenceAvailability', 'detectors'] },
      });
      expect(included.isError).toBeFalsy();
      expect('summary' in included.structuredContent).toBe(true);
      expect('evidenceAvailability' in included.structuredContent).toBe(true);
      expect('detectors' in included.structuredContent).toBe(true);
      expect(included.structuredContent.summary.stageCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips diagnose_run\'s impactBand/type/stageId filter params, leaving recommendations/cleanChecks full', async () => {
    const { dir, path } = tmpEventLogWithFindings();
    try {
      const server = createMcpServer();
      const client = await connectedClient(server);

      const full = await client.callTool({ name: 'diagnose_run', arguments: { source: { path } } });
      expect(full.isError).toBeFalsy();

      const filtered = await client.callTool({
        name: 'diagnose_run',
        arguments: { source: { path }, type: ['straggler'], stageId: 1, impactBand: ['critical'] },
      });
      expect(filtered.isError).toBeFalsy();
      expect(filtered.structuredContent.findings).toHaveLength(1);
      expect(filtered.structuredContent.findings[0].type).toBe('straggler');
      expect(filtered.structuredContent.recommendations).toEqual(full.structuredContent.recommendations);
      expect(filtered.structuredContent.cleanChecks).toEqual(full.structuredContent.cleanChecks);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a fractional diagnose_run stageId with isError', async () => {
    const { dir, path } = tmpEventLogWithFindings();
    try {
      const server = createMcpServer();
      const client = await connectedClient(server);

      const result = await client.callTool({
        name: 'diagnose_run', arguments: { source: { path }, stageId: 1.5 },
      });
      expect(result.isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid diagnose_run include value with isError', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const server = createMcpServer();
      const client = await connectedClient(server);
      const result = await client.callTool({
        name: 'diagnose_run', arguments: { source: { path }, include: ['findings'] },
      });
      expect(result.isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('diagnose_run: format "md" puts markdown in content[0].text and the same markdown with a few headline fields in structuredContent', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const server = createMcpServer();
      const client = await connectedClient(server);

      const jsonResult = await client.callTool({ name: 'diagnose_run', arguments: { source: { path } } });
      const omittedResult = await client.callTool({ name: 'diagnose_run', arguments: { source: { path }, format: 'json' } });
      const mdResult = await client.callTool({ name: 'diagnose_run', arguments: { source: { path }, format: 'md' } });

      expect(jsonResult.content[0].text).toBe(JSON.stringify(jsonResult.structuredContent));
      expect(JSON.parse(jsonResult.content[0].text)).toEqual(jsonResult.structuredContent);

      expect(omittedResult.structuredContent).toEqual(jsonResult.structuredContent);
      expect(omittedResult.content[0].text).toBe(jsonResult.content[0].text);

      expect(mdResult.content[0].text).toMatch(/^# Spark run evidence report/);
      expect(mdResult.structuredContent).toEqual({
        runId: jsonResult.structuredContent.runId,
        runComplete: true,
        title: jsonResult.structuredContent.verdict.title,
        findingCount: jsonResult.structuredContent.findings.length,
        findingsOmitted: 0,
        notesHidden: jsonResult.structuredContent.notesHidden,
        recommendationCount: jsonResult.structuredContent.recommendations.length,
        markdown: mdResult.content[0].text,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('diagnose_run: answers compact by default, full on request, and keeps writeTargets and effectiveConf in both', async () => {
    const { dir, path } = tmpEventLogWithFindings();
    try {
      const client = await connectedClient(createMcpServer());
      const byDefault = (await client.callTool({ name: 'diagnose_run', arguments: { source: { path } } })).structuredContent;
      const compact = (await client.callTool({ name: 'diagnose_run', arguments: { source: { path }, view: 'compact' } })).structuredContent;
      const full = (await client.callTool({ name: 'diagnose_run', arguments: { source: { path }, view: 'full' } })).structuredContent;
      expect(byDefault).toEqual(compact);
      expect(compact.view).toBe('compact');
      expect(full.view).toBe('full');
      for (const answer of [compact, full]) {
        expect(answer).toHaveProperty('writeTargets');
        expect(answer).toHaveProperty('effectiveConf');
        expect(answer).toHaveProperty('metrics');
      }
      expect(compact).not.toHaveProperty('cleanChecks');
      expect(full).toHaveProperty('cleanChecks');
      expect(compact.findings[0]).not.toHaveProperty('evidence');
      expect(full.findings[0]).toHaveProperty('evidence');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('diagnose_run: maxFindings and minBand limit the rows', async () => {
    const { dir, path } = tmpEventLogWithFindings();
    try {
      const client = await connectedClient(createMcpServer());
      const call = async (args) => (await client.callTool({ name: 'diagnose_run', arguments: { source: { path }, ...args } })).structuredContent;
      const all = await call({});
      const limited = await call({ maxFindings: 1 });
      expect(limited.findings).toHaveLength(1);
      expect(limited.findingsOmitted).toBe(all.findings.length - 1);
      expect((await call({ minBand: 'critical' })).findings.every((f) => f.impactBand === 'critical')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compare_runs: format "md" puts markdown in content[0].text and keeps structuredContent JSON-shaped', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const server = createMcpServer();
      const client = await connectedClient(server);

      const jsonResult = await client.callTool({
        name: 'compare_runs', arguments: { sourceA: { path }, sourceB: { path } },
      });
      const mdResult = await client.callTool({
        name: 'compare_runs', arguments: { sourceA: { path }, sourceB: { path }, format: 'md' },
      });

      expect(mdResult.structuredContent).toEqual(jsonResult.structuredContent);
      expect('markdown' in mdResult.structuredContent).toBe(false);
      expect(mdResult.content[0].text).toMatch(/^\n## Comparison to baseline\n/);
      expect(mdResult.content[0].text).not.toBe(JSON.stringify(mdResult.structuredContent));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('applies the server\'s threshold overrides to every analyzing tool and labels them', async () => {
    const { dir, path } = tmpEventLogWithFindings();
    // minTasks 10 -> 2: the 10-task straggler stage still qualifies, now under a tuned detector.
    const tuned = { straggler: { minTasks: { value: 2, default: 10 } } };
    try {
      const client = await connectedClient(createMcpServer({ thresholds: parseThresholdOverrides({ straggler: { minTasks: 2 } }) }));
      const diagnosed = (await client.callTool({ name: 'diagnose_run', arguments: { source: { path }, minBand: 'info' } })).structuredContent;
      expect(diagnosed.tunedThresholds).toEqual(tuned);
      expect(diagnosed.findings.find((f) => f.type === 'straggler').tunedThresholds).toEqual(tuned.straggler);
      expect(diagnosed.findings.find((f) => f.type === 'memoryUtilization').tunedThresholds).toBeUndefined();
      const { runId } = diagnosed;
      const [finding] = diagnosed.findings.filter((f) => f.type === 'straggler');
      const evidence = (await client.callTool({ name: 'get_finding_evidence', arguments: { runId, findingId: finding.id } })).structuredContent;
      expect(evidence.finding.tunedThresholds).toEqual(tuned.straggler);
      const compared = (await client.callTool({ name: 'compare_runs', arguments: { sourceA: { path }, sourceB: { path } } })).structuredContent;
      expect(compared.tunedThresholds).toEqual(tuned);
      const budgets = (await client.callTool({ name: 'evaluate_budgets', arguments: { source: { path }, maxRuntimeMs: 1e9 } })).structuredContent;
      expect(budgets.tunedThresholds).toEqual(tuned);

      const plain = await connectedClient(createMcpServer());
      const untuned = (await plain.callTool({ name: 'diagnose_run', arguments: { source: { path } } })).structuredContent;
      expect(JSON.stringify(untuned)).not.toContain('tunedThresholds');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

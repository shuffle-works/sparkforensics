import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer } from '../src/mcp-server-factory.js';
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
  it('registers all 8 tools', async () => {
    const server = createMcpServer();
    const client = await connectedClient(server);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'compare_runs', 'diagnose_run', 'evaluate_budgets', 'get_finding_documentation',
      'get_finding_evidence', 'get_reference_doc', 'get_run_summary', 'list_runs',
    ]);
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

      const diagnose = await client.callTool({ name: 'diagnose_run', arguments: { source: { path }, redact: true } });
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

  it('diagnose_run: format "md" puts markdown in content[0].text and keeps structuredContent JSON-shaped', async () => {
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

      expect(mdResult.structuredContent).toEqual(jsonResult.structuredContent);
      expect('markdown' in mdResult.structuredContent).toBe(false);
      expect(mdResult.content[0].text).toMatch(/^# Spark run evidence report/);
      expect(mdResult.content[0].text).not.toBe(JSON.stringify(mdResult.structuredContent));
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
});

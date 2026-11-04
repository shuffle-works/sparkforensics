import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer, MCP_TOOL_NAMES } from '../src/mcp-server-factory.js';
import { mcpToolEntries } from '../src/mcp-tool-table.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-table-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// One slow task among nine fast ones: the run has findings, so get_finding_evidence has an id to read.
/**
 * @param {string} name
 * @param {string} appId
 */
function writeEventLog(name, appId) {
  const path = join(dir, name);
  const lines = [
    `{"Event":"SparkListenerApplicationStart","App ID":"${appId}","App Name":"t","Timestamp":0}`,
    '{"Event":"SparkListenerStageSubmitted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10}}',
  ];
  for (let i = 0; i < 10; i++) {
    const finish = i === 9 ? 2000 : 100;
    lines.push(JSON.stringify({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Task ID': i, 'Launch Time': 0, 'Finish Time': finish, Failed: false, Killed: false, Speculative: false },
      'Task Metrics': { 'Executor Run Time': finish, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
    }));
  }
  lines.push('{"Event":"SparkListenerStageCompleted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10,"Completion Time":2000}}');
  lines.push('{"Event":"SparkListenerApplicationEnd","Timestamp":2000}');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

/** @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server */
async function connectedClient(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('MCP tool table', () => {
  const entries = mcpToolEntries();

  it('gives every entry a CLI twin or a stated reason for having none', () => {
    for (const entry of entries) {
      const { cli } = entry;
      const text = 'twin' in cli ? cli.twin : cli.none;
      expect(typeof text, entry.name).toBe('string');
      expect(text.trim().length, entry.name).toBeGreaterThan(0);
      expect('twin' in cli && 'none' in cli, entry.name).toBe(false);
    }
  });

  it('registers exactly the tools of the table', async () => {
    const client = await connectedClient(createMcpServer());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(entries.map((e) => e.name).sort());
    expect([...MCP_TOOL_NAMES].sort()).toEqual(entries.map((e) => e.name).sort());
  });

  it('advertises an outputSchema for every tool and accepts a real successful call of each', async () => {
    const baseline = writeEventLog('baseline', 'app-baseline');
    const candidate = writeEventLog('candidate', 'app-candidate');
    const client = await connectedClient(createMcpServer());
    const { tools } = await client.listTools();
    for (const t of tools) expect(t.outputSchema, t.name).toBeDefined();

    /**
     * @param {string} name
     * @param {Record<string, unknown>} args
     * @returns {Promise<Record<string, unknown>>}
     */
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).toBeFalsy();
      expect(result.structuredContent, name).toBeDefined();
      if (!result.structuredContent) throw new Error(`${name}: no structuredContent`);
      return { ...result.structuredContent };
    };

    const diagnosis = await call('diagnose_run', { source: { path: candidate } });
    /** @param {unknown} row @returns {row is { id: string }} */
    const hasId = (row) => typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'string' && row.id !== '';
    const rows = diagnosis.findings;
    const findingId = Array.isArray(rows) ? rows.find(hasId)?.id : undefined;
    expect(findingId).toBeDefined();
    await call('diagnose_run', { source: { path: candidate }, format: 'md' });
    await call('list_runs', { dir });
    await call('get_run_summary', { runId: diagnosis.runId });
    const compared = await call('compare_runs', { sourceA: { path: baseline }, sourceB: { path: candidate } });
    for (const removed of ['runIdA', 'runIdB', 'metricDeltas', 'findingsDelta']) expect(compared).not.toHaveProperty(removed);
    const budgets = await call('evaluate_budgets', { source: { path: candidate }, maxRuntimeMs: 10_000 });
    expect(budgets.violated).toBe(false);
    expect(budgets).not.toHaveProperty('runId');
    await call('evaluate_budgets', { runId: compared.baselineRunId, runIdB: compared.candidateRunId, maxRegressionPct: 50 });
    await call('get_finding_evidence', { runId: diagnosis.runId, findingId });
    await call('get_finding_documentation', { type: 'skew' });
    await call('list_detectors', {});
    await call('get_reference_doc', { anchor: '#joins' });
  });
});

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DEPRECATIONS, deprecationNote } from '../src/deprecations.ts';
import { createMcpServer } from '../src/mcp-server-factory.js';

const PACKAGE_JSON = {
  cli: '../../cli/package.json',
  mcp: '../../mcp/package.json',
};

const versionOf = (surface) => JSON.parse(readFileSync(new URL(PACKAGE_JSON[surface], import.meta.url), 'utf8')).version;

// -1, 0 or 1 for plain MAJOR.MINOR.PATCH versions.
function compareVersions(a, b) {
  const [pa, pb] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

const dirs = [];
function eventLog(appId, endTime) {
  const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-deprecations-'));
  dirs.push(dir);
  const path = join(dir, 'eventlog');
  writeFileSync(path,
    `{"Event":"SparkListenerApplicationStart","App ID":"${appId}","App Name":"t","Timestamp":0}\n`
    + `{"Event":"SparkListenerApplicationEnd","Timestamp":${endTime}}\n`);
  return path;
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// One probe per table entry: does the live surface still carry the item?
const PROBES = {
  async 'compare_runs input'(client, item) {
    const { tools } = await client.listTools();
    return item in tools.find((t) => t.name === 'compare_runs').inputSchema.properties;
  },
  async 'compare_runs result'(client, item) {
    const result = await client.callTool({
      name: 'compare_runs',
      arguments: { sourceA: { path: eventLog('app-a', 2000) }, sourceB: { path: eventLog('app-b', 1000) } },
    });
    return item in result.structuredContent;
  },
  async 'evaluate_budgets result'(client, item) {
    const result = await client.callTool({
      name: 'evaluate_budgets', arguments: { source: { path: eventLog('app-c', 1000) }, maxRuntimeMs: 5000 },
    });
    return item in result.structuredContent;
  },
};

describe('deprecated public fields', () => {
  it('has a probe for every table entry, so a new entry cannot skip the removal check', () => {
    for (const { surface, where } of DEPRECATIONS) {
      if (surface === 'mcp') expect(PROBES, where).toHaveProperty([where]);
    }
  });

  it('are gone from the surface at and after their removal version', async () => {
    const client = await connect();
    for (const { surface, where, item, removeIn } of DEPRECATIONS.filter((d) => d.surface === 'mcp')) {
      const due = compareVersions(versionOf(surface), removeIn) >= 0;
      const present = await PROBES[where](client, item);
      expect(due && present, `${where}: ${item} is still present in ${surface} ${versionOf(surface)}, removeIn ${removeIn}`).toBe(false);
    }
  });

  it('are present until then, with the replacement beside them', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'compare_runs',
      arguments: { sourceA: { path: eventLog('app-d', 2000) }, sourceB: { path: eventLog('app-e', 1000) } },
    });
    expect(result.structuredContent.runIdA).toBe(result.structuredContent.baselineRunId);
    expect(result.structuredContent.runIdB).toBe(result.structuredContent.candidateRunId);
  });

  it('words each notice from the table', () => {
    expect(deprecationNote('compare_runs input', 'runIdA')).toBe('Deprecated: use baselineRunId. Removed in 0.13.0.');
    expect(() => deprecationNote('compare_runs input', 'nope')).toThrow();
  });
});

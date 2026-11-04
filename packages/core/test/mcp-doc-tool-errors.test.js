import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('node:fs', async (importOriginal) => {
  /** @type {typeof import('node:fs')} */
  const actual = await importOriginal();
  /** @param {Parameters<typeof actual.readFileSync>} args */
  const readFileSync = (...args) => {
    const [path] = args;
    if (String(path).includes('docs-content')) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
    }
    return actual.readFileSync(...args);
  };
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const { createMcpServer } = await import('../src/mcp-server-factory.ts');

async function connectedClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('documentation tools on an unreadable bundled file', () => {
  it.each([
    ['get_finding_documentation', { type: 'skew' }],
    ['get_reference_doc', { anchor: '#joins' }],
  ])('%s reports access-or-upstream-failure, not invalid-event-log, without the path', async (name, args) => {
    const client = await connectedClient();
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: 'access-or-upstream-failure' });
    expect(result.content).toHaveProperty('0.text', 'A documentation file could not be read (ENOENT).');
  });
});

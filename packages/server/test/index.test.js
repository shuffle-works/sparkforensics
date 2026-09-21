import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer, serverStartupGuidance } from '../index.js';

// node:http (unlike fetch) lets a caller send an explicit Host header, needed
// to simulate a DNS-rebinding attempt against the /mcp route.
function requestWithHost(port, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: { Host: hostHeader, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  });
}

let server;
afterEach(() => server && server.close());

function listen(opts) {
  server = createServer(opts);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

describe('createServer routing', () => {
  it('names the exact SHS disclosure in local-server startup guidance', () => {
    expect(serverStartupGuidance(4173)).toEqual([
      'sparkforensics-server running at http://127.0.0.1:4173',
      'Open that URL in Chrome, then use the Fetch from Spark History Server disclosure.',
    ]);
  });

  it('routes proxy failures as a stable safe code', async () => {
    const port = await listen({
      staticRoot: process.cwd(),
      fetchImpl: async () => { throw new TypeError('ECONNREFUSED'); },
    });
    const res = await fetch(`http://127.0.0.1:${port}/shs-proxy?baseUrl=http%3A%2F%2Fshs%3A18080&appId=application_1_1`);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ code: 'upstream-unreachable' });
    expect(body).toHaveProperty('code');
    expect(body).not.toHaveProperty('reason');
    expect(body).not.toHaveProperty('upstreamStatus');
  });

  it('returns a safe code from the proxy for a bad appId', async () => {
    const port = await listen({ staticRoot: process.cwd(), fetchImpl: async () => { throw new Error('nope'); } });
    const res = await fetch(`http://127.0.0.1:${port}/shs-proxy?baseUrl=http%3A%2F%2Fshs%3A18080&appId=bad`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'access-or-upstream-failure' });
  });

  it('serves a 404 for an unknown static path (simulating a static deploy for the frontend)', async () => {
    const port = await listen({ staticRoot: process.cwd(), fetchImpl: fetch });
    const res = await fetch(`http://127.0.0.1:${port}/does-not-exist.js`);
    expect(res.status).toBe(404);
  });
});

describe('/mcp route', () => {
  it('lists all 6 tools over streamable HTTP', async () => {
    const port = await listen({ staticRoot: process.cwd(), fetchImpl: fetch });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'compare_runs', 'diagnose_run', 'evaluate_budgets', 'get_finding_documentation', 'get_finding_evidence', 'get_reference_doc', 'get_run_summary', 'list_runs',
    ]);
    await client.close();
  });

  it('surfaces run-not-found as isError with structuredContent.code over HTTP', async () => {
    const port = await listen({ staticRoot: process.cwd(), fetchImpl: fetch });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'get_run_summary', arguments: { runId: 'nonexistent' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('run-not-found');
    await client.close();
  });

  it('rejects a spoofed Host header with 403 (DNS-rebinding protection)', async () => {
    const port = await listen({ staticRoot: process.cwd(), fetchImpl: fetch });
    const res = await requestWithHost(port, 'evil.example.com');
    expect(res.status).toBe(403);
  });

  it('accepts the real bound host/port', async () => {
    const port = await listen({ staticRoot: process.cwd(), fetchImpl: fetch });
    const res = await requestWithHost(port, `127.0.0.1:${port}`);
    expect(res.status).not.toBe(403);
  });

  // Regression: createServer()'s no-op .catch() on the eager
  // loadCreateMcpServer(dir) promise must NOT swallow a genuine failure for a
  // real /mcp caller; the handler's own await observes the same rejection and
  // must still turn it into a 500. Injected via the loadCreateMcpServer override
  // rather than the real vendor-core/ dir, which bin.test.js races.
  it('surfaces a genuine loadCreateMcpServer failure as a 500, not a swallowed error', async () => {
    const port = await listen({
      staticRoot: process.cwd(),
      fetchImpl: fetch,
      loadCreateMcpServer: async () => { throw new Error('boom: mcp-server-factory failed to load'); },
    });
    const res = await requestWithHost(port, `127.0.0.1:${port}`);
    expect(res.status).toBe(500);
    expect(res.body).toContain('boom: mcp-server-factory failed to load');
  });
});

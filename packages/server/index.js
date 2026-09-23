#!/usr/bin/env node
import http from 'node:http';
import { realpathSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveStaticRoot, serveStatic } from './lib/static-files.js';
// No install-mode fallback needed for the sdk package (unlike core below):
// packages/server/package.json declares '@modelcontextprotocol/sdk' as a direct
// dependency, so node resolution finds it in both published and monorepo layouts.
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = '127.0.0.1';

// vendor-core/ exists only in a published install (populated by vendor-core.mjs
// at publish time); the monorepo falls back to the packages/core/src/ sibling.
// load-vendored.js is the one module located by hand; the rest load through its
// exported loadVendored().
async function loadVendoredCore(dir, moduleName, opts) {
  const vendoredHelper = join(dir, 'vendor-core', 'load-vendored.js');
  const helperPath = existsSync(vendoredHelper) ? vendoredHelper : join(dir, '..', 'core', 'src', 'load-vendored.js');
  const { loadVendored } = await import(pathToFileURL(helperPath).href);
  return loadVendored(dir, moduleName, opts);
}

async function loadCreateMcpServer(dir) {
  const mod = await loadVendoredCore(dir, 'mcp-server-factory');
  return mod.createMcpServer;
}

async function loadHandleShsProxy(dir) {
  const mod = await loadVendoredCore(dir, 'proxy', { srcExt: 'js' });
  return mod.handleShsProxy;
}

export function createServer({
  staticRoot,
  fetchImpl = fetch,
  // Test-only override: lets test/index.test.js inject a rejecting promise to
  // prove a real failure still surfaces as a /mcp error, not swallowed by the
  // no-op .catch() below.
  loadCreateMcpServer: loadCreateMcpServerImpl = loadCreateMcpServer,
} = {}) {
  const dir = dirname(fileURLToPath(import.meta.url));
  const root = staticRoot ?? resolveStaticRoot(dir);
  const createMcpServerPromise = loadCreateMcpServerImpl(dir);
  const handleShsProxyPromise = loadHandleShsProxy(dir);
  handleShsProxyPromise.catch(() => {});
  // Only awaited later in the /mcp branch, so a request that never hits /mcp
  // leaves it unconsumed; a rejection there would be an unhandled rejection.
  // This no-op handler marks it handled without hiding the failure from the
  // /mcp handler's own await (rejections are observable per-consumer).
  createMcpServerPromise.catch(() => {});

  return http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/shs-proxy') {
        const handleShsProxy = await handleShsProxyPromise;
        await handleShsProxy(req, res, { fetchImpl });
      } else if (pathname === '/mcp') {
        // Stateless mode (sessionIdGenerator: undefined): a transport handles
        // one request and the SDK throws on reuse, so make a fresh
        // server+transport pair per request.
        const createMcpServer = await createMcpServerPromise;
        const mcpServer = createMcpServer();
        // allowedHosts is matched against the raw Host header (host:port), so
        // derive the port from the actual socket, not a hardcode: tests bind to
        // an ephemeral port via listen(0, ...).
        const localPort = req.socket.localPort;
        const mcpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableDnsRebindingProtection: true,
          allowedHosts: [`127.0.0.1:${localPort}`, `localhost:${localPort}`],
        });
        await mcpServer.connect(mcpTransport);
        // Each close() is isolated: a throw or rejection from one must not
        // skip the other (leaking it) or become an unhandled rejection.
        const closeQuietly = (target) => {
          try { Promise.resolve(target.close()).catch(() => {}); } catch { /* already closed */ }
        };
        res.on('close', () => { closeQuietly(mcpTransport); closeQuietly(mcpServer); });
        await mcpTransport.handleRequest(req, res);
      } else {
        await serveStatic(req, res, root);
      }
    } catch (err) {
      console.error('[server] %s %s failed:', req.method, req.url, err?.stack ?? err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`Internal server error: ${err.message}`);
    }
  });
}

export function startServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, staticRoot } = {}) {
  const server = createServer({ staticRoot });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

export function serverStartupGuidance(port) {
  return [
    `sparkforensics-server running at http://${DEFAULT_HOST}:${port}`,
    'Open that URL in Chrome, then use the Fetch from Spark History Server disclosure.',
  ];
}

function parsePort(argv) {
  const flagIdx = argv.indexOf('--port');
  if (flagIdx !== -1 && argv[flagIdx + 1]) return Number(argv[flagIdx + 1]);
  if (process.env.PORT) return Number(process.env.PORT);
  return DEFAULT_PORT;
}

const USAGE = `Usage: sparkforensics-server [--port <n>]

Serves the SparkForensics dashboard locally and proxies Spark History
Server fetches on your behalf (server-to-server, so no browser CORS
restriction). Binds to 127.0.0.1 only. Default port ${DEFAULT_PORT},
overridden by --port or the PORT env var.

See https://github.com/shuffle-works/sparkforensics#readme for details.
`;

// argv[1] is the bin symlink path via the published `.bin` entry, so
// realpath-resolve it before comparing against this module's real path.
const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stderr.write(USAGE);
  } else {
    const port = parsePort(process.argv);
    startServer({ port }).then(() => {
      for (const line of serverStartupGuidance(port)) console.log(line);
    });
  }
}

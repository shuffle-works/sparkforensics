#!/usr/bin/env node
import http from 'node:http';
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveStaticRoot, serveStatic } from './lib/static-files.js';
// No install-mode fallback needed for the sdk package (unlike core below):
// packages/server/package.json declares '@modelcontextprotocol/sdk' as a direct
// dependency, so node resolution finds it in both published and monorepo layouts.
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = '127.0.0.1';

// Core loading (vendor-core/ vs core/src): docs-site/contributor-guide/development-setup.md, "Generated and vendored files".
async function loadVendoredCore(dir, moduleName, opts) {
  const srcHelper = join(dir, '..', 'core', 'src', 'load-vendored.js');
  const helperPath = existsSync(srcHelper) ? srcHelper : join(dir, 'vendor-core', 'load-vendored.js');
  const { loadVendored } = await import(pathToFileURL(helperPath).href);
  return loadVendored(dir, moduleName, opts);
}

// The provenance stamp the MCP tools report: this package's name and version, and the build id of
// the core it loaded.
async function loadGenerator(dir) {
  const srcHelper = join(dir, '..', 'core', 'src', 'load-vendored.js');
  const helperPath = existsSync(srcHelper) ? srcHelper : join(dir, 'vendor-core', 'load-vendored.js');
  const { coreBuildId } = await import(pathToFileURL(helperPath).href);
  const { name, version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return { name, version, buildId: coreBuildId(dir) };
}

async function loadCreateMcpServer(dir) {
  const mod = await loadVendoredCore(dir, 'mcp-server-factory');
  return mod.createMcpServer;
}

async function loadHandleShsProxy(dir) {
  const mod = await loadVendoredCore(dir, 'proxy', { srcExt: 'js' });
  return mod.handleShsProxy;
}

// The Host values this server answers to, matched against the raw Host header (host:port). The
// port comes from the actual socket, not a hardcode: tests bind to an ephemeral port via listen(0, ...).
function allowedHostsFor(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
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
  // Hashing core's sources is not free: started on the first /mcp request, then shared.
  let generatorPromise;

  return http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/shs-proxy') {
        // A DNS-rebinding page reaches this socket with its own hostname in Host (and a matching
        // Origin), which the proxy's same-origin check accepts, so refuse any non-local Host first.
        if (!allowedHostsFor(req.socket.localPort).includes(String(req.headers.host).toLowerCase())) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'access-or-upstream-failure' }));
          return;
        }
        const handleShsProxy = await handleShsProxyPromise;
        await handleShsProxy(req, res, { fetchImpl });
      } else if (pathname === '/mcp') {
        // Stateless mode (sessionIdGenerator: undefined): a transport handles
        // one request and the SDK throws on reuse, so make a fresh
        // server+transport pair per request.
        const createMcpServer = await createMcpServerPromise;
        generatorPromise ??= loadGenerator(dir);
        const mcpServer = createMcpServer({ generator: await generatorPromise });
        const mcpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableDnsRebindingProtection: true,
          allowedHosts: allowedHostsFor(req.socket.localPort),
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
      // The message stays in the server log: it can carry paths and other internals.
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal server error');
    }
  });
}

export function startServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, staticRoot } = {}) {
  const server = createServer({ staticRoot });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export function serverStartupGuidance(port) {
  return [
    `sparkforensics-server running at http://${DEFAULT_HOST}:${port}`,
    'Open that URL in Chrome, then use the Fetch from Spark History Server disclosure.',
  ];
}

class UsageError extends Error {}

// A port is a whole number from 0 (the OS picks one) to 65535; anything else is a usage error.
function parsePortValue(text, source) {
  if (!/^\d+$/.test(text) || Number(text) > 65535) {
    throw new UsageError(`${source} must be a whole number from 0 to 65535 (got "${text}").`);
  }
  return Number(text);
}

export function parseServerArgs(argv, env = process.env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { port: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: false,
    }));
  } catch (e) {
    if (e?.code?.startsWith('ERR_PARSE_ARGS_')) throw new UsageError(e.message);
    throw e;
  }
  if (values.help) return { help: true };
  if (values.port !== undefined) return { port: parsePortValue(values.port, '--port') };
  if (env.PORT) return { port: parsePortValue(env.PORT, 'PORT') };
  return { port: DEFAULT_PORT };
}

// One line for a failed start, without a stack trace.
export function startupErrorMessage(err, port) {
  if (err?.code === 'EADDRINUSE') return `Port ${port} is already in use. Pass another one with --port <n>.`;
  return `Could not start the server: ${err?.message ?? err}`;
}

const USAGE = `Usage: sparkforensics-server [--port <n>]

Serves the SparkForensics dashboard locally and proxies Spark History
Server fetches on your behalf (server-to-server, so no browser CORS
restriction). Binds to 127.0.0.1 only. Default port ${DEFAULT_PORT},
overridden by --port or the PORT env var.

Also serves the SparkForensics MCP tools over streamable HTTP at /mcp,
for clients on this machine, with the default detector thresholds.

See https://github.com/shuffle-works/sparkforensics#readme for details.
`;

// argv[1] is the bin symlink path via the published `.bin` entry, so
// realpath-resolve it before comparing against this module's real path.
const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let args;
  try {
    args = parseServerArgs(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`${e.message}\n${USAGE}`);
    process.exitCode = 2;
  }
  if (args?.help) {
    process.stderr.write(USAGE);
  } else if (args) {
    try {
      const server = await startServer({ port: args.port });
      for (const line of serverStartupGuidance(server.address().port)) console.log(line);
    } catch (e) {
      process.stderr.write(`${startupErrorMessage(e, args.port)}\n`);
      process.exitCode = 1;
    }
  }
}

#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const binDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = dirname(binDir);

// vendor-core/ exists only in a published install (populated by vendor-core.mjs
// at pack time); the monorepo falls back to the packages/core/src/ sibling.
// load-vendored.js is the one module located by hand; the rest load through its
// exported loadVendored().
async function loadCreateMcpServer() {
  const vendoredHelper = join(pkgDir, 'vendor-core', 'load-vendored.js');
  const helperPath = existsSync(vendoredHelper) ? vendoredHelper : join(pkgDir, '..', 'core', 'src', 'load-vendored.js');
  const { loadVendored } = await import(pathToFileURL(helperPath).href);
  const mod = await loadVendored(pkgDir, 'mcp-server-factory');
  return mod.createMcpServer;
}

// Tool names come from the server the bin actually builds, so --help can't drift
// from the registered set. Building the server registers tools only: no transport,
// no I/O. _registeredTools is the SDK's registry; the MCP package test checks that
// this list matches what listTools reports.
function usage(toolNames) {
  return `Usage: sparkforensics-mcp

Starts the SparkForensics MCP server, speaking the MCP protocol over
stdio. Point an MCP client (Claude Desktop, Claude Code, etc.) at this
command; it exposes ${toolNames.length} tools for diagnosing Apache Spark event logs:
${toolNames.join(', ')}.

See https://github.com/shuffle-works/sparkforensics#readme for details.
`;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    const createMcpServer = await loadCreateMcpServer();
    process.stderr.write(usage(Object.keys(createMcpServer()._registeredTools)));
    return;
  }
  const createMcpServer = await loadCreateMcpServer();
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

await main();

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

const USAGE = `Usage: sparkforensics-mcp

Starts the SparkForensics MCP server, speaking the MCP protocol over
stdio. Point an MCP client (Claude Desktop, Claude Code, etc.) at this
command; it exposes five tools for diagnosing Apache Spark event logs:
diagnose_run, get_run_summary, compare_runs, evaluate_budgets,
get_finding_evidence.

See https://github.com/shuffle-works/sparkforensics#readme for details.
`;

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stderr.write(USAGE);
    return;
  }
  const createMcpServer = await loadCreateMcpServer();
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

await main();

#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const binDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = dirname(binDir);

// vendor-core/ is populated by vendor-core.mjs at pack time. In the monorepo the
// packages/core/src/ sibling's load-vendored.js is used, which prefers a leftover
// vendor-core/ only while it still matches core/src and warns when it does not.
// load-vendored.js is the one module located by hand; the rest load through its
// exported loadVendored().
async function loadCoreModule(moduleName) {
  const srcHelper = join(pkgDir, '..', 'core', 'src', 'load-vendored.js');
  const helperPath = existsSync(srcHelper) ? srcHelper : join(pkgDir, 'vendor-core', 'load-vendored.js');
  const { loadVendored } = await import(pathToFileURL(helperPath).href);
  return loadVendored(pkgDir, moduleName);
}

async function loadCreateMcpServer() {
  return (await loadCoreModule('mcp-server-factory')).createMcpServer;
}

// Tool names come from the server the bin actually builds, so --help can't drift
// from the registered set. Building the server registers tools only: no transport,
// no I/O. _registeredTools is the SDK's registry; the MCP package test checks that
// this list matches what listTools reports.
function usage(toolNames) {
  return `Usage: sparkforensics-mcp [--thresholds <file>]

Starts the SparkForensics MCP server, speaking the MCP protocol over
stdio. Point an MCP client (Claude Desktop, Claude Code, etc.) at this
command; it exposes ${toolNames.length} tools for diagnosing Apache Spark event logs:
${toolNames.join(', ')}.

  --thresholds <file>  Run every tool's detectors with the threshold overrides in
                       this JSON file ({"<detector>": {"<threshold>": value}}).
                       Findings a tuned detector produces carry tunedThresholds.
                       An unreadable or invalid file stops the server from starting.

See https://github.com/shuffle-works/sparkforensics#readme for details.
`;
}

async function main() {
  // Not strict: arguments this server never read before stay ignored, as they always were.
  const { values } = parseArgs({
    args: process.argv.slice(2), strict: false,
    options: { thresholds: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    const createMcpServer = await loadCreateMcpServer();
    process.stderr.write(usage(Object.keys(createMcpServer()._registeredTools)));
    return;
  }
  let thresholds;
  if (values.thresholds !== undefined) {
    if (typeof values.thresholds !== 'string') {
      process.stderr.write('--thresholds requires a file path.\n');
      process.exitCode = 2;
      return;
    }
    // Refuse to start rather than serve default-threshold results the user meant to change.
    try {
      thresholds = (await loadCoreModule('cli/threshold-config')).loadThresholdOverrides(values.thresholds);
    } catch (e) {
      process.stderr.write(`--thresholds: ${e.message}\n`);
      process.exitCode = 2;
      return;
    }
  }
  const createMcpServer = await loadCreateMcpServer();
  const server = createMcpServer({ thresholds });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

await main();

#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const binDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = dirname(binDir);

// Core loading (vendor-core/ vs core/src): docs-site/contributor-guide/development-setup.md, "Generated and vendored files".
async function loadVendoredHelper() {
  const srcHelper = join(pkgDir, '..', 'core', 'src', 'load-vendored.js');
  const helperPath = existsSync(srcHelper) ? srcHelper : join(pkgDir, 'vendor-core', 'load-vendored.js');
  return import(pathToFileURL(helperPath).href);
}

async function loadCoreModule(moduleName) {
  const { loadVendored } = await loadVendoredHelper();
  return loadVendored(pkgDir, moduleName);
}

// The provenance stamp every report carries: this package's name and version, and the build id of
// the core it loaded (vendor-core/'s stamp or core/src's hash). It is also the handshake version.
async function generatorInfo() {
  const { name, version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const { coreBuildId } = await loadVendoredHelper();
  return { name, version, buildId: coreBuildId(pkgDir) };
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
  // Not strict: arguments this server does not read are ignored.
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
  const server = createMcpServer({ thresholds, generator: await generatorInfo() });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

await main();

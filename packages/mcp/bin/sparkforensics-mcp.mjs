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
  return `Usage: sparkforensics-mcp [--thresholds <file>] [--shs-base-url <url>]

Starts the SparkForensics MCP server, speaking the MCP protocol over
stdio. Point an MCP client (Claude Desktop, Claude Code, etc.) at this
command; it exposes ${toolNames.length} tools for diagnosing Apache Spark event logs:
${toolNames.join(', ')}.

  --thresholds <file>  Run every tool's detectors with the threshold overrides in
                       this JSON file ({"<detector>": {"<threshold>": value}}).
                       Findings a tuned detector produces carry tunedThresholds.
                       An unreadable or invalid file stops the server from starting.
  --shs-base-url <url> Default Spark History Server for a source or list_runs call that
                       gives no shsBaseUrl. Defaults to $SPARKFORENSICS_SHS_BASE_URL.

See https://shuffle-works.github.io/sparkforensics/docs/user-guide/mcp-tools for every tool and its parameters.
`;
}

async function main() {
  // Strict: an unknown flag (a typo such as --threshold) is a usage error, never a server that
  // silently runs with default thresholds. Stray positional arguments are ignored.
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2), allowPositionals: true,
      options: { thresholds: { type: 'string' }, 'shs-base-url': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (e) {
    if (!e?.code?.startsWith('ERR_PARSE_ARGS_')) throw e;
    const createMcpServer = await loadCreateMcpServer();
    process.stderr.write(`${e.message}\n${usage(Object.keys(createMcpServer()._registeredTools))}`);
    process.exitCode = 2;
    return;
  }
  if (values.help) {
    const createMcpServer = await loadCreateMcpServer();
    process.stderr.write(usage(Object.keys(createMcpServer()._registeredTools)));
    return;
  }
  let thresholds;
  if (values.thresholds !== undefined) {
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
  const defaultShsBaseUrl = values['shs-base-url'] ?? process.env.SPARKFORENSICS_SHS_BASE_URL;
  const server = createMcpServer({ thresholds, generator: await generatorInfo(), defaultShsBaseUrl });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

await main();

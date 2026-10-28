// Generates the docs site's detector catalog: docs-site/detectors/index.md, one page per finding
// type, and the data file the Vue components (DetectorIndex.vue, DetectorPage.vue) render. Reads the
// catalog from core, so the pages state what the MCP `list_detectors` tool and the CLI `detectors`
// command state. Every output a page shows is captured from a real run of those two surfaces here.
// The example finding on each page is the real dashboard widget: dev/detector-examples.json names
// the finding and dev/detector-example-runs.json holds its run (both gated by
// `node dev/detector-examples.mjs --check`), and each page's finding id and run are written to
// docs-site/public/detector-widget/data/<type>.json for the example app (docs-widget.html) to load.
// The output is gitignored; docs:dev and docs:build run this script before vitepress.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildDetectorCatalog } from '../packages/core/src/detector-catalog.ts';
import { runDetectorsCommand } from '../packages/core/src/cli/detectors-command.ts';
import { DETECTOR_FAMILIES } from '../packages/core/src/finding-presentation.ts';
import { createMcpServer } from '../packages/core/src/mcp-server-factory.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT_DIR = join(REPO_ROOT, 'docs-site', 'detectors');
export const DEFAULT_DATA_FILE = join(REPO_ROOT, 'docs-site', '.vitepress', 'detectors-data.json');
export const DEFAULT_EXAMPLES_FILE = join(REPO_ROOT, 'dev', 'detector-examples.json');
export const DEFAULT_RUNS_FILE = join(REPO_ROOT, 'dev', 'detector-example-runs.json');
export const DEFAULT_WIDGET_DATA_DIR = join(REPO_ROOT, 'docs-site', 'public', 'detector-widget', 'data');

// The placeholders the command examples use for the user's own log.
const LOG_PLACEHOLDER = '<event-log>';

// A long documentation body is cut to its length in the stored MCP response: the page shows the
// shape of the real response without pasting a whole chapter.
function shortenDocContent(value) {
  if (Array.isArray(value)) return value.map(shortenDocContent);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [
      k, k === 'content' && typeof v === 'string' ? `<${v.length} characters of Markdown>` : shortenDocContent(v),
    ]));
  }
  return value;
}

async function connectMcp() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ generator: { name: 'sparkforensics-mcp', version: 'docs', buildId: 'docs' } });
  await server.connect(serverTransport);
  const client = new Client({ name: 'detector-pages', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} ${JSON.stringify(args)} failed: ${result.content?.[0]?.text}`);
  // The in-memory transport skips the JSON step stdio does, which drops undefined-valued keys.
  return JSON.parse(JSON.stringify(result.structuredContent));
}

function cliDetectors(type) {
  const argv = ['--type', type, '--format', 'md'];
  const result = runDetectorsCommand(argv);
  if (result.exitCode !== 0) throw new Error(`detectors ${argv.join(' ')} failed: ${result.stderr}`);
  return { command: `sparkforensics-analyze detectors ${argv.join(' ')}`, output: result.stdout };
}

function loadJson(file) {
  if (!existsSync(file)) throw new Error(`${file} is missing. Run: node dev/detector-examples.mjs --update`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

// The data file entry for one catalog record: the record, its example and the real tool outputs the
// page shows.
async function buildEntry(client, record, example) {
  const { type } = record;
  const mcpResponse = await callTool(client, 'list_detectors', { type });
  const docsArgs = { type };
  const docsResponse = shortenDocContent(await callTool(client, 'get_finding_documentation', docsArgs));
  const cli = cliDetectors(type);
  return {
    ...record,
    example,
    surfaces: {
      mcp: {
        listCall: { tool: 'list_detectors', arguments: { type } },
        listResponse: mcpResponse,
        docsCall: { tool: 'get_finding_documentation', arguments: docsArgs },
        docsResponse,
      },
      cli: {
        detectorsCommand: cli.command,
        detectorsOutput: cli.output,
        filterCommand: `sparkforensics-analyze ${LOG_PLACEHOLDER} --type ${type} --impact critical,warning,info`,
        budgetCommand: record.gate ? `sparkforensics-analyze ${LOG_PLACEHOLDER} ${record.gate.cliFlag} <n>` : null,
      },
    },
  };
}

function pageSource(title, description, component) {
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    'outline: false',
    'aside: false',
    'pageClass: detector-doc',
    '---',
    '',
    component,
    '',
  ].join('\n');
}

/**
 * Writes the detector pages, the data file and each page's example data. Returns the data object
 * it wrote.
 * @param {{ outDir?: string, dataFile?: string, examplesFile?: string, runsFile?: string, widgetDataDir?: string }} [options]
 */
export async function buildDetectorPages({
  outDir = DEFAULT_OUT_DIR, dataFile = DEFAULT_DATA_FILE, examplesFile = DEFAULT_EXAMPLES_FILE,
  runsFile = DEFAULT_RUNS_FILE, widgetDataDir = DEFAULT_WIDGET_DATA_DIR,
} = {}) {
  const examples = loadJson(examplesFile);
  const runs = loadJson(runsFile);
  const catalog = buildDetectorCatalog();
  const client = await connectMcp();
  let records;
  try {
    records = [];
    for (const record of catalog) {
      if (!(record.type in examples)) {
        throw new Error(`${examplesFile} has no entry for ${record.type}. Run: node dev/detector-examples.mjs --update`);
      }
      if (examples[record.type] === null) {
        throw new Error(
          `${examplesFile} has no example for ${record.type}: no log fires it. A recorded fixture or a synthetic log under packages/core/test/fixtures/synthetic must fire it, then run: node dev/detector-examples.mjs --update`,
        );
      }
      const { source, log } = examples[record.type];
      if (!(`${source}/${log}` in runs)) {
        throw new Error(`${runsFile} has no run for ${source}/${log}. Run: node dev/detector-examples.mjs --update`);
      }
      records.push(await buildEntry(client, record, examples[record.type]));
    }
  } finally {
    await client.close();
  }

  const data = { families: DETECTOR_FAMILIES, records };
  rmSync(outDir, { recursive: true, force: true });
  rmSync(widgetDataDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(widgetDataDir, { recursive: true });
  mkdirSync(dirname(dataFile), { recursive: true });
  writeFileSync(dataFile, `${JSON.stringify(data)}\n`);
  for (const { type, example } of records) {
    const payload = runs[`${example.source}/${example.log}`];
    writeFileSync(join(widgetDataDir, `${type}.json`), JSON.stringify({ findingId: example.finding.id, payload }));
  }
  writeFileSync(
    join(outDir, 'index.md'),
    pageSource(
      'Detector catalog',
      `${records.length} things SparkForensics checks in a Spark run, grouped by outcome: speed, cost, reliability, SQL plans and setup.`,
      '<DetectorIndex />',
    ),
  );
  for (const record of records) {
    writeFileSync(
      join(outDir, `${record.type}.md`),
      pageSource(`${record.tag}: ${record.name}`, record.pitch, `<DetectorPage type="${record.type}" />`),
    );
  }
  return data;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = await buildDetectorPages();
  console.log(`build-detector-pages: wrote ${data.records.length} detector pages and the index.`);
}

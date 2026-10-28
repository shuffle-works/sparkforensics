import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDetectorPages, DEFAULT_EXAMPLES_FILE } from '../scripts/build-detector-pages.mjs';
import { buildDetectorCatalog } from '../packages/core/src/detector-catalog.ts';
import { DETECTOR_FAMILIES } from '../packages/core/src/finding-presentation.ts';

// The generated detector catalog pages (docs-site/detectors/): one page per finding type, the
// index, and the data file the Vue components render. Built into a temp dir, so the test never
// touches the gitignored output the docs build writes.
let tmp;
let outDir;
let data;
const catalog = buildDetectorCatalog();
const read = (name) => readFileSync(join(outDir, name), 'utf8');
const entry = (type) => data.records.find((r) => r.type === type);

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'detector-pages-'));
  outDir = join(tmp, 'detectors');
  data = await buildDetectorPages({ outDir, dataFile: join(tmp, 'detectors-data.json') });
}, 60000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('generated pages', () => {
  it('writes one page per catalog type plus the index, and the data file', () => {
    expect(readdirSync(outDir).sort()).toEqual(['index.md', ...catalog.map((r) => `${r.type}.md`)].sort());
    expect(existsSync(join(tmp, 'detectors-data.json'))).toBe(true);
    expect(data.records.map((r) => r.type)).toEqual(catalog.map((r) => r.type));
  });

  it('lists every type on the index data under its family, in family order', () => {
    expect(data.families).toEqual(DETECTOR_FAMILIES);
    for (const family of data.families) {
      const inFamily = data.records.filter((r) => r.family === family.id).map((r) => r.type);
      expect(inFamily).toEqual(catalog.filter((r) => r.family === family.id).map((r) => r.type));
    }
    expect(data.records.every((r) => data.families.some((f) => f.id === r.family))).toBe(true);
    expect(read('index.md')).toContain('<DetectorIndex />');
  });

  it('gives each page its pitch and its component, and no images', () => {
    for (const record of catalog) {
      const page = read(`${record.type}.md`);
      expect(page).toContain(record.pitch);
      expect(page).toContain(`<DetectorPage type="${record.type}" />`);
    }
    for (const name of readdirSync(outDir)) {
      expect(read(name)).not.toMatch(/<img|!\[|\.(png|jpe?g|gif|svg|webp)\b/i);
    }
    expect(JSON.stringify(data)).not.toMatch(/<img|\.(png|jpe?g|gif|svg|webp)\b/i);
  });
});

describe('real outputs on the pages', () => {
  it('stores the real list_detectors response and CLI output for the type', () => {
    for (const record of data.records) {
      const { mcp, cli } = record.surfaces;
      expect(mcp.listResponse.count).toBe(1);
      expect(mcp.listResponse.detectors[0].type).toBe(record.type);
      expect(cli.detectorsOutput).toContain(`\`${record.type}\``);
      expect(cli.detectorsCommand).toContain(`--type ${record.type}`);
    }
  });
});

describe('examples file', () => {
  const examples = JSON.parse(readFileSync(DEFAULT_EXAMPLES_FILE, 'utf8'));

  it('has a key for every catalog type', () => {
    for (const record of catalog) expect(examples).toHaveProperty(record.type);
  });

  it('keeps only findings of the key type', () => {
    for (const [type, example] of Object.entries(examples)) {
      if (example !== null) expect(example.finding.type).toBe(type);
    }
  });

  // Every page shows a finding card. A new detector needs a corpus log, a recorded fixture or a
  // small synthetic log (packages/core/test/fixtures/synthetic) that fires it at default thresholds.
  it('gives every type an example from a corpus log, a fixture or a synthetic log', () => {
    for (const record of catalog) {
      const example = examples[record.type];
      expect(example, `${record.type} has no log that fires it`).not.toBeNull();
      expect(['corpus', 'fixture', 'synthetic']).toContain(example.source);
    }
  });

  it('names a committed file for each fixture and synthetic example', () => {
    const fixtures = join(import.meta.dirname, '..', 'packages', 'core', 'test', 'fixtures');
    for (const example of Object.values(examples)) {
      if (example?.source === 'fixture') expect(existsSync(join(fixtures, example.log))).toBe(true);
      if (example?.source === 'synthetic') expect(existsSync(join(fixtures, 'synthetic', example.log))).toBe(true);
    }
  });

  it('puts the example from the file on each record', () => {
    for (const record of data.records) expect(record.example).toEqual(examples[record.type]);
  });
});

describe('special cases', () => {
  it('carries the tuning page kind', () => {
    expect(entry('configAudit').tuning).toBeNull();
    expect(entry('stageShape').tuning.kind).toBe('section');
    expect(entry('pythonUdf').tuning.kind).toBe('chapter');
    expect(entry('skew').tuning.kind).toBe('page');
    for (const type of ['rightSizing', 'utilization', 'failures', 'stageFailed', 'overBroadcast', 'underBroadcast']) {
      expect(entry(type).tuning.kind).toBe('shared');
    }
  });

  it('carries a tag shared by two types', () => {
    expect(entry('utilization').tagSharedWith).toContain('rightSizing');
    expect(entry('rightSizing').tagSharedWith).toContain('utilization');
    expect(entry('skew').tagSharedWith).toEqual([]);
  });

  it('carries the reference region', () => {
    expect(entry('memoryUtilization').region).toBe('reference');
    expect(entry('skew').region).toBe('action');
  });

  it('carries a budget gate and its budget command', () => {
    expect(entry('skew').gate.cliFlag).toBe('--max-skew');
    expect(entry('failures').gate.cliFlag).toBe('--max-failed-task-rate');
    expect(entry('jobFailureRate').gate).toBeNull();
    expect(entry('stageShape').gate).toBeNull();
    expect(entry('skew').surfaces.cli.budgetCommand).toContain('--max-skew');
    expect(entry('failures').surfaces.cli.budgetCommand).toContain('--max-failed-task-rate');
    expect(entry('stageShape').surfaces.cli.budgetCommand).toBeNull();
  });

  it('carries a suppressed detector', () => {
    expect(entry('stageSlowness').detectors.map((d) => d.suppressedBy)).toEqual(['slowHost']);
    expect(entry('skew').detectors.every((d) => d.suppressedBy === undefined)).toBe(true);
  });
});

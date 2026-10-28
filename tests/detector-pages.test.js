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

  it('marks hasExample from the file', () => {
    for (const record of data.records) expect(record.flags.hasExample).toBe(examples[record.type] != null);
  });
});

describe('special cases', () => {
  it('flags the tuning page kind', () => {
    expect(entry('configAudit').flags.tuning).toBe('none');
    expect(entry('stageShape').flags.tuning).toBe('section');
    expect(entry('pythonUdf').flags.tuning).toBe('chapter');
    expect(entry('skew').flags.tuning).toBe('page');
  });

  it('flags a tag shared by two types', () => {
    expect(entry('utilization').flags.sharedTag).toBe(true);
    expect(entry('rightSizing').flags.sharedTag).toBe(true);
    expect(entry('utilization').tagSharedWith).toContain('rightSizing');
    expect(entry('skew').flags.sharedTag).toBe(false);
  });

  it('flags the reference region', () => {
    expect(entry('memoryUtilization').flags.reference).toBe(true);
    expect(entry('skew').flags.reference).toBe(false);
  });

  it('flags a budget gate', () => {
    expect(entry('skew').flags.gate).toBe('--max-skew');
    expect(entry('stageShape').flags.gate).toBe('none');
    expect(entry('skew').surfaces.cli.budgetCommand).toContain('--max-skew');
    expect(entry('stageShape').surfaces.cli.budgetCommand).toBeNull();
  });

  it('flags a suppressed detector', () => {
    expect(entry('stageSlowness').flags.suppressedBy).toEqual(['slowHost']);
    expect(entry('skew').flags.suppressedBy).toEqual([]);
  });
});

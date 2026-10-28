import { describe, it, expect } from 'vitest';
import { buildDetectorCatalog, listDetectors, renderDetectorCatalogMarkdown } from '../src/detector-catalog.js';
import { ENTRY_BY_TYPE } from '../src/detectors.js';
import { DETECTOR_FAMILIES, FINDING_PRESENTATION } from '../src/finding-presentation.js';

const catalog = buildDetectorCatalog();
const byType = (type) => catalog.find((record) => record.type === type);

// A new detector must arrive with its presentation row, and so with its pitch and family: the row
// type requires them. These tests cover what the type cannot: one record per type, and copy that
// reads as one plain sentence.
describe('detector catalog coverage', () => {
  it('has one record per emitted finding type, in detector order', () => {
    expect(catalog.map((r) => r.type)).toEqual([...ENTRY_BY_TYPE.keys()]);
    expect([...catalog.map((r) => r.type)].sort()).toEqual(Object.keys(FINDING_PRESENTATION).sort());
  });

  it('gives every type a known family and a pitch of one plain sentence', () => {
    const families = DETECTOR_FAMILIES.map((f) => f.id);
    for (const record of catalog) {
      expect(families, `${record.type} family`).toContain(record.family);
      expect(record.pitch, `${record.type} pitch`).toMatch(/^[A-Z][^.\n]*\.$/);
      expect(record.pitch.length, `${record.type} pitch length`).toBeLessThanOrEqual(110);
      expect(record.pitch, `${record.type} pitch has a figure`).not.toMatch(/\d/);
    }
  });

  it('puts every type on a catalog page and a findings-guide anchor', () => {
    for (const record of catalog) {
      expect(record.pages).toEqual({
        catalog: `docs/detectors/${record.type}.html`,
        guide: `docs/user-guide/understanding-findings.html#${record.tag.toLowerCase()}`,
      });
    }
  });
});

describe('detector catalog special cases', () => {
  it('says where the tuning docs live: a page, a section of another page, a chapter, or nowhere', () => {
    expect(byType('skew').tuning).toMatchObject({ kind: 'page', anchor: '#bottleneck-skew' });
    expect(byType('stageShape').tuning).toMatchObject({ kind: 'section', anchor: '#bottleneck-stage-shape' });
    expect(byType('stageShape').tuning.path).toContain('bottleneck-skew.html');
    expect(byType('pythonUdf').tuning).toMatchObject({ kind: 'chapter', anchor: '#pyspark' });
    expect(byType('configAudit').tuning).toBeNull();
    expect(byType('incompleteRun').tuning).toBeNull();
  });

  it('lists the other types that share a tag', () => {
    expect(byType('utilization').tagSharedWith).toEqual(['rightSizing']);
    expect(byType('smallFiles').tagSharedWith).toContain('mergeRewrite');
    expect(byType('skew').tagSharedWith).toEqual([]);
  });

  it('names the budget flag and operator parameter of exactly the gated types', () => {
    const gated = Object.fromEntries(catalog.filter((r) => r.gate).map((r) => [r.type, r.gate]));
    expect(gated).toEqual({
      skew: { cliFlag: '--max-skew', airflowParam: 'max_skew_ratio' },
      spill: { cliFlag: '--max-spill', airflowParam: 'max_spill_gb' },
      utilization: { cliFlag: '--min-efficiency', airflowParam: 'min_efficiency_pct' },
      failures: { cliFlag: '--max-failed-task-rate', airflowParam: 'max_failed_task_rate_pct' },
    });
  });

  it('marks the dashboard reference region', () => {
    expect(catalog.filter((r) => r.region === 'reference').map((r) => r.type).sort())
      .toEqual(['cacheUtilization', 'coreLocality', 'memoryUtilization', 'utilization']);
  });

  it('lists every detector entry behind a type and the one that suppresses it', () => {
    expect(byType('configAudit').detectors).toHaveLength(3);
    expect(byType('stageSlowness').detectors[0].suppressedBy).toBe('slowHost');
    expect(byType('overBroadcast').detectors[0].detector).toBe('broadcastSizing');
  });
});

describe('listDetectors', () => {
  it('returns every record, or the one of a type, and counts the result', () => {
    expect(listDetectors()).toEqual({ count: catalog.length, detectors: catalog });
    expect(listDetectors('skew')).toEqual({ count: 1, detectors: [byType('skew')] });
  });

  it('reports the default thresholds', () => {
    expect(byType('skew').detectors[0].thresholds.ratioWarn).toBe(3);
  });
});

describe('renderDetectorCatalogMarkdown', () => {
  it('groups the records by family in family order, one row per type', () => {
    const markdown = renderDetectorCatalogMarkdown(catalog);
    expect(markdown).toMatch(new RegExp(`^# Detectors \\(${catalog.length}\\)`));
    const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(DETECTOR_FAMILIES.map((f) => f.label).filter((label) => headings.includes(label)));
    for (const record of catalog) expect(markdown).toContain(`\`${record.type}\``);
  });
});

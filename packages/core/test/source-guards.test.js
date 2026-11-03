import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Structural guards over the core sources: each fails on a shape that hides a type error or couples
// modules the architecture keeps apart.

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir = srcDir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|js)$/.test(entry.name) ? [full] : [];
  });
}

describe('type escape hatches', () => {
  // The count may fall, never rise: a new `as unknown as` bridges two shapes the compiler cannot
  // relate, and each one is a place a renamed field compiles and goes quiet.
  const MAX_UNKNOWN_CASTS = 12;

  it('does not add `as unknown as` casts to core sources', () => {
    const hits = sourceFiles().flatMap((file) => {
      const count = (readFileSync(file, 'utf8').match(/\bas unknown as\b/g) ?? []).length;
      return count > 0 ? [`${path.relative(srcDir, file)}: ${count}`] : [];
    });
    const total = hits.reduce((sum, hit) => sum + Number(hit.split(': ')[1]), 0);
    expect(total, `casts through unknown:\n${hits.join('\n')}`).toBeLessThanOrEqual(MAX_UNKNOWN_CASTS);
  });
});

// The site (/src) reaches core through named entry points only, so a core file can move without
// touching its importers. The exports map in packages/core/package.json lists the same names.
const siteDir = path.resolve(srcDir, '..', '..', '..', 'src');
const CORE_PACKAGE = '@sparkforensics/core';
// The entry points the site may import. `cli`, `mcp` and `node` are Node-only entry points.
const SITE_ENTRY_POINTS = ['analysis', 'browser', 'export', 'types', 'view-model'];

function siteSourceFiles(dir = siteDir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return siteSourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

// The docs site and the app's frames talk through the typed messages in src/docs-widget/frame-messages.ts;
// reading the other side's document couples them to its markup.
describe('frame isolation', () => {
  it('the site never reads a frame or host document', () => {
    const offenders = siteSourceFiles().flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return ['window.parent.document', '.contentDocument'].filter((probe) => text.includes(probe)).map((probe) => `${path.relative(siteDir, file)}: ${probe}`);
    });
    expect(offenders, `exchange docs-widget/frame-messages instead:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('core entry points', () => {
  it('the site imports core only through its entry points', () => {
    const offenders = siteSourceFiles().flatMap((file) => {
      const specifiers = readFileSync(file, 'utf8').match(/@sparkforensics\/core[^'"`\s]*/g) ?? [];
      return specifiers
        .filter((specifier) => !SITE_ENTRY_POINTS.map((name) => `${CORE_PACKAGE}/${name}`).includes(specifier))
        .map((specifier) => `${path.relative(siteDir, file)}: ${specifier}`);
    });
    expect(offenders, `import core through ${SITE_ENTRY_POINTS.join(', ')}:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the exports map names explicit entry points, each a file, and no wildcard', () => {
    const { exports } = JSON.parse(readFileSync(path.join(srcDir, '..', 'package.json'), 'utf8'));
    for (const [name, target] of Object.entries(exports)) {
      expect(name).not.toContain('*');
      expect(existsSync(path.resolve(srcDir, '..', target)), `${name} -> ${target}`).toBe(true);
    }
    expect(Object.keys(exports)).toEqual(expect.arrayContaining(SITE_ENTRY_POINTS.map((name) => `./${name}`)));
  });
});

// detectors.ts assembles the DETECTORS list. Only the analyzer and the entry catalog import it by
// value; every other module reads the entries through detector-catalog.ts and the helpers from
// the detectors/ modules, so the shared helpers never depend on the list that is built from them.
describe('detector modules', () => {
  const DETECTORS_MODULE = path.join(srcDir, 'detectors.ts');
  const MAY_IMPORT_DETECTORS = ['analyzer.ts', 'detector-catalog.ts'].map((name) => path.join(srcDir, name));
  const IMPORT_STATEMENT = /^import\s+(type\s+)?[^;]*?\sfrom\s+'([^']+)'/gm;
  const MAX_DETECTOR_MODULE_LINES = 1200;

  it('only the analyzer and the entry catalog import detectors.ts by value', () => {
    const offenders = sourceFiles().flatMap((file) => {
      if (MAY_IMPORT_DETECTORS.includes(file)) return [];
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(IMPORT_STATEMENT)]
        .filter(([, typeOnly, specifier]) => !typeOnly && path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts')) === DETECTORS_MODULE)
        .map(() => path.relative(srcDir, file));
    });
    expect(offenders, `import type from detectors.ts, or read the entries through detector-catalog.ts:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps each detectors/ module under the size limit', () => {
    const oversized = sourceFiles(path.join(srcDir, 'detectors')).flatMap((file) => {
      const lines = readFileSync(file, 'utf8').trimEnd().split('\n').length;
      return lines > MAX_DETECTOR_MODULE_LINES ? [`${path.relative(srcDir, file)}: ${lines} lines`] : [];
    });
    expect(oversized, `split these by family or helper (limit ${MAX_DETECTOR_MODULE_LINES} lines):\n${oversized.join('\n')}`).toEqual([]);
  });
});

describe('core model types', () => {
  // types.ts holds the plain model the analysis and every surface share. A callback-typed field
  // belongs to a view's own node or props type.
  it('declares no function-typed fields in types.ts', () => {
    const source = readFileSync(path.join(srcDir, 'types.ts'), 'utf8');
    const callbackFields = source.split('\n').filter((line) => /^\s*\w+\??:\s*\(.*\)\s*=>/.test(line));
    expect(callbackFields).toEqual([]);
  });
});

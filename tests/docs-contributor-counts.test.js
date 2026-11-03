import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Counts of detectors, Plan Advisor widgets and tools drift when a detector or tool is added.
// The contributor guide renders lists from the detector catalog (DetectorTypeList,
// DetectorThresholds) and names no count of them.
const GUIDE_DIR = join(import.meta.dirname, '../docs-site/contributor-guide');

const NUMBER_WORDS =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|' +
  'seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred';
// A number before the noun, with at most one modifier between ("9 MCP tools"), or right after it
// ("detectors: 34").
const COUNTED = new RegExp(
  `\\b(?:\\d[\\d,]*|${NUMBER_WORDS})\\s+(?:[\\w\`-]+\\s+)?(?:Plan Advisor|detectors|tools)\\b` +
    `|\\b(?:Plan Advisor|detectors|tools)\\s*[:(=]\\s*\\d`,
  'i',
);

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? markdownFiles(join(dir, entry.name)) : entry.name.endsWith('.md') ? [join(dir, entry.name)] : [],
  );
}

describe('contributor guide counts', () => {
  it('has no number word or digit next to "Plan Advisor", "detectors" or "tools"', () => {
    const offenders = markdownFiles(GUIDE_DIR).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (COUNTED.test(line) ? [`${file.slice(GUIDE_DIR.length + 1)}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(offenders).toEqual([]);
  });

  it('catches the shapes it guards against', () => {
    for (const line of ['the nine Plan Advisor widgets', 'registers 9 tools', 'all 34 detectors', 'six MCP tools']) {
      expect(COUNTED.test(line), line).toBe(true);
    }
    expect(COUNTED.test('the Plan Advisor widgets')).toBe(false);
  });
});

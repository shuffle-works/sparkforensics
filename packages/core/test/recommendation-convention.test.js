import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditConfig } from '../src/analyzer.js';
import { recommendationParts } from '../src/finding-names.js';

// Every detector recommendation reads "<measurement>: <fix>". recommendationParts splits it at
// the last ": " and the UI shows the two halves in different places, so a recommendation that
// breaks the convention puts the wrong text under "What to try". Nothing else enforces it.
//
// A recommendation only exists once a log trips its detector, and the corpus trips few of the
// ~45 wordings, so this reads them out of detectors.ts instead. Every `${...}` in a template becomes the
// placeholder "1".

const DETECTORS_SOURCE = fileURLToPath(new URL('../src/detectors.ts', import.meta.url));

// Wordings with no measurement to split off, and why. Matched as a prefix of the rendered text.
const NO_MEASUREMENT = [
  {
    prefix: 'This stage attempt failed outright.',
    reason: 'the stage failure itself is the whole finding: there is no figure to quote, only where to look',
  },
];

/** Reads the string or template literal starting at `i`; returns its text and the index after it. */
function readLiteral(src, i) {
  const quote = src[i];
  let text = '';
  for (i += 1; src[i] !== quote; i += 1) {
    if (src[i] === '\\') { text += src[i + 1]; i += 1; continue; }
    if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
      let depth = 1;
      for (i += 2; depth > 0; i += 1) {
        if (/['"`]/.test(src[i])) i = readLiteral(src, i).end - 1;
        else if (src[i] === '{') depth += 1;
        else if (src[i] === '}') depth -= 1;
      }
      text += '1';
      i -= 1;
      continue;
    }
    text += src[i];
  }
  return { text, end: i + 1 };
}

/** Every string/template literal in the expression that starts at `i` (ternary branches and `+` operands included). */
function expressionLiterals(src, i) {
  const found = [];
  for (let depth = 0; i < src.length; i += 1) {
    if (/['"`]/.test(src[i])) {
      const { text, end } = readLiteral(src, i);
      found.push(text);
      i = end - 1;
    } else if ('([{'.includes(src[i])) depth += 1;
    else if (')]}'.includes(src[i])) {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && src[i] === '?' && src[i + 1] !== '.' && src[i + 1] !== '?') {
      found.length = 0; // what came before a ternary's `?` is its condition, not a wording
    } else if (depth === 0 && (src[i] === ',' || src[i] === ';')) break;
  }
  return found;
}

/** Every wording bound to `recommendation` (a property or a const) or to a `...RECOMMENDATION` const in detectors.ts. */
function detectorRecommendations() {
  const src = readFileSync(DETECTORS_SOURCE, 'utf8');
  const binding = /(?:\brecommendation\s*[:=]|\b[A-Z_]*RECOMMENDATION\s*=)\s*/g;
  return [...src.matchAll(binding)].flatMap((m) => expressionLiterals(src, m.index + m[0].length));
}

describe('detector recommendations follow "<measurement>: <fix>"', () => {
  const all = detectorRecommendations();

  it('finds the detectors\' recommendations to check', () => {
    expect(all.length).toBeGreaterThan(40);
  });

  it.each(all.map((text) => [text]))('%s', (text) => {
    const { measured, fix } = recommendationParts(text);
    if (NO_MEASUREMENT.some(({ prefix }) => text.startsWith(prefix))) {
      expect(measured).toBeNull();
      return;
    }
    expect(measured, 'no ": " between a measurement and a fix').toBeTruthy();
    expect(fix.length).toBeGreaterThan(0);
  });

  it('keeps every allowlist entry pointing at a real recommendation', () => {
    for (const { prefix } of NO_MEASUREMENT) expect(all.some((text) => text.startsWith(prefix))).toBe(true);
  });
});

describe('inverted autoscaling bounds', () => {
  it('splits into the bounds as the measurement and "set min ≤ max" as the fix', () => {
    const app = {
      config: { 'spark.dynamicAllocation.minExecutors': '5', 'spark.dynamicAllocation.maxExecutors': '3' },
      resources: { dynamicAllocationEnabled: true },
    };
    const finding = auditConfig(app).find((f) => f.property === 'spark.dynamicAllocation.minExecutors');
    expect(recommendationParts(finding.recommendation)).toEqual({
      measured: 'spark.dynamicAllocation.minExecutors (5) exceeds maxExecutors (3)',
      fix: 'set min ≤ max.',
    });
  });
});

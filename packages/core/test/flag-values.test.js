import { describe, it, expect } from 'vitest';
import {
  parseNonNegativeNumber, parseStageId, parseImpactBands, parseFindingTypes, parseFailOnIntroduced, FINDING_TYPES,
} from '../src/cli/flag-values.ts';
import { FINDING_NAMES } from '../src/finding-names.ts';

describe('parseNonNegativeNumber', () => {
  it.each([['0', 0], ['90', 90], ['1.5', 1.5], ['007', 7]])('parses %j', (raw, value) => {
    expect(parseNonNegativeNumber(raw, '--f')).toBe(value);
  });

  it.each(['', ' ', '-5', '+5', '0x10', '1e3', '.5', '5.', 'Infinity', 'NaN', '5%', '1,5', `${'9'.repeat(400)}`])(
    'rejects %j and names the flag', (raw) => {
      expect(() => parseNonNegativeNumber(raw, '--min-efficiency')).toThrow(/^--min-efficiency needs a non-negative decimal number/);
    },
  );
});

describe('parseStageId', () => {
  it.each([['0', 0], ['12', 12]])('parses %j', (raw, value) => {
    expect(parseStageId(raw, '--stage')).toBe(value);
  });

  it.each(['', ' ', '-1', '1.5', '0x2', '1e2', 'abc', '9'.repeat(30)])('rejects %j', (raw) => {
    expect(() => parseStageId(raw, '--stage')).toThrow(/^--stage needs a non-negative integer stage id/);
  });
});

describe('parseImpactBands', () => {
  it('parses a trimmed comma list', () => {
    expect(parseImpactBands('critical, info', '--impact')).toEqual(['critical', 'info']);
  });

  it.each(['bogus', 'critical,bogus', 'Critical', '', ' , '])('rejects %j', (list) => {
    expect(() => parseImpactBands(list, '--impact')).toThrow(/^--impact: /);
  });

  it('lists the accepted bands', () => {
    expect(() => parseImpactBands('bogus', '--impact')).toThrow('expected a list from: critical, warning, info');
  });
});

describe('parseFindingTypes', () => {
  it('accepts every finding type', () => {
    expect(parseFindingTypes(Object.keys(FINDING_NAMES).join(','), '--type')).toEqual(Object.keys(FINDING_NAMES));
    expect(FINDING_TYPES).toContain('straggler');
  });

  it.each(['nonsense', 'skew,nonsense', ''])('rejects %j', (list) => {
    expect(() => parseFindingTypes(list, '--type')).toThrow(/^--type: /);
  });
});

describe('parseFailOnIntroduced', () => {
  it.each(['all', 'critical', 'warning', 'info'])('accepts %j', (raw) => {
    expect(parseFailOnIntroduced(raw, '--fail-on-introduced')).toBe(raw);
  });

  it.each(['bogus', '', 'ALL'])('rejects %j', (raw) => {
    expect(() => parseFailOnIntroduced(raw, '--fail-on-introduced')).toThrow(/expected one of: all, critical, warning, info/);
  });
});

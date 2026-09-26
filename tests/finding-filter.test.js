import { test, expect } from 'vitest';
import {
  emptySelection,
  excludingDimensions,
  isEmptySelection,
  matchesFilter,
  filterFindings,
  deriveOptions,
  parseFilterSelection,
  serializeFilterSelection,
} from '../src/view/finding-filter.ts';

const f = (over) => ({ type: 'skew', stageId: 1, impactBand: 'critical', ...over });

test('empty selection matches every finding', () => {
  const sel = emptySelection();
  expect(isEmptySelection(sel)).toBe(true);
  expect(matchesFilter(f(), sel)).toBe(true);
  expect(matchesFilter(f({ impactBand: 'info', stageId: null, type: 'coldStart' }), sel)).toBe(true);
});

test('impact-band dimension: union within, constrains when non-empty', () => {
  const sel = { ...emptySelection(), impactBands: new Set(['critical', 'warning']) };
  expect(matchesFilter(f({ impactBand: 'critical' }), sel)).toBe(true);
  expect(matchesFilter(f({ impactBand: 'warning' }), sel)).toBe(true);
  expect(matchesFilter(f({ impactBand: 'info' }), sel)).toBe(false);
});

test('raw-type predicate distinguishes two types sharing one display tag', () => {
  const sel = { ...emptySelection(), types: new Set(['smallFiles']) };
  expect(matchesFilter(f({ type: 'smallFiles' }), sel)).toBe(true);
  expect(matchesFilter(f({ type: 'underBroadcast' }), sel)).toBe(false); // both render as PLAN
});

test('stage dimension excludes stageId:null findings when active', () => {
  const sel = { ...emptySelection(), stages: new Set([3]) };
  expect(matchesFilter(f({ stageId: 3 }), sel)).toBe(true);
  expect(matchesFilter(f({ stageId: 7 }), sel)).toBe(false);
  expect(matchesFilter(f({ stageId: null, type: 'coldStart' }), sel)).toBe(false);
});

test('dimensions combine with AND', () => {
  const sel = { impactBands: new Set(['critical']), types: new Set(['spill']), stages: new Set([2]) };
  expect(matchesFilter(f({ impactBand: 'critical', type: 'spill', stageId: 2 }), sel)).toBe(true);
  expect(matchesFilter(f({ impactBand: 'critical', type: 'spill', stageId: 9 }), sel)).toBe(false);
  expect(matchesFilter(f({ impactBand: 'warning', type: 'spill', stageId: 2 }), sel)).toBe(false);
});

test('filterFindings returns the matching subset', () => {
  const a = f({ stageId: 1 }); const b = f({ stageId: 2 });
  const out = filterFindings([a, b], { ...emptySelection(), stages: new Set([2]) });
  expect(out).toEqual([b]);
});

test('deriveOptions surfaces only present values, incl. CFG-only types', () => {
  const catalog = [f({ type: 'skew', impactBand: 'critical', stageId: 5 }), f({ type: 'spill', impactBand: 'warning', stageId: 2 })];
  const config = [f({ type: 'configAudit', impactBand: 'info', stageId: null })];
  const opts = deriveOptions(catalog, config);
  expect(opts.impactBands).toEqual(['critical', 'warning', 'info']); // fixed order, only present
  expect(opts.types).toEqual(['configAudit', 'skew', 'spill']); // sorted, includes CFG-only
  expect(opts.stages).toEqual([2, 5]); // ascending, null excluded
});

test('parseFilterSelection seeds valid values and drops unknown/malformed', () => {
  const options = { impactBands: ['critical', 'warning', 'info'], types: ['skew', 'spill'], stages: [3, 7] };
  const sel = parseFilterSelection('?impact=critical,bogus&type=skew,nope&stage=3,x,7.5', options);
  expect([...sel.impactBands]).toEqual(['critical']);
  expect([...sel.types]).toEqual(['skew']);
  expect([...sel.stages]).toEqual([3]);
});

test('parseFilterSelection with no params yields an empty selection', () => {
  const sel = parseFilterSelection('', { impactBands: [], types: [], stages: [] });
  expect(isEmptySelection(sel)).toBe(true);
});

test('serializeFilterSelection round-trips and uses impact/type/stage with literal commas', () => {
  const sel = { impactBands: new Set(['critical', 'warning']), types: new Set(['spill', 'skew']), stages: new Set([7, 3]) };
  const query = serializeFilterSelection(sel);
  expect(query).toBe('?impact=critical,warning&type=skew,spill&stage=3,7');
  const options = { impactBands: ['critical', 'warning', 'info'], types: ['skew', 'spill'], stages: [3, 7] };
  const round = parseFilterSelection(query, options);
  expect([...round.impactBands].sort()).toEqual(['critical', 'warning']);
  expect([...round.types].sort()).toEqual(['skew', 'spill']);
  expect([...round.stages].sort((a, b) => a - b)).toEqual([3, 7]);
});

test('serializeFilterSelection of an empty selection is the empty string', () => {
  expect(serializeFilterSelection(emptySelection())).toBe('');
});

test('excludingDimensions names only the active dimensions that hide a finding', () => {
  const sel = { impactBands: new Set(['critical']), types: new Set(['skew']), stages: new Set([2]) };
  expect(excludingDimensions(f({ type: 'spill', stageId: 2 }), sel)).toEqual(['types']);
  expect(excludingDimensions(f({ type: 'spill', impactBand: 'info', stageId: null }), sel)).toEqual(['impactBands', 'types', 'stages']);
  expect(excludingDimensions(f({ stageId: 2 }), sel)).toEqual([]);
  expect(excludingDimensions(f({ type: 'spill' }), emptySelection())).toEqual([]);
});

import { describe, it, expect } from 'vitest';
import { normalizeTablePath, soleLogPath } from '../src/delta-log-paths.ts';

const scan = (path) => ({ id: 'n0', name: `Scan State - ${path}/_delta_log`, detail: '', metrics: [], children: [] });
const execWith = (...paths) => ({ planTree: { id: 'r', name: 'Root', detail: '', metrics: [], children: paths.map(scan) } });

describe('normalizeTablePath', () => {
  it.each([
    ['file:/tmp/t', 'file:///tmp/t'],
    ['file:///tmp/t', 'file:///tmp/t'],
    ['file:///tmp/t/', 'file:///tmp/t'],
    ['file://host/tmp/t', 'file://host/tmp/t'],
    ['hdfs://nn/db/t', 'hdfs://nn/db/t'],
    ['/tmp/t', '/tmp/t'],
  ])('reads %s as %s', (input, expected) => {
    expect(normalizeTablePath(input)).toBe(expected);
  });
});

describe('soleLogPath', () => {
  it('counts the two local-file spellings of one table as one path', () => {
    expect(soleLogPath([execWith('file:/tmp/t'), execWith('file:///tmp/t')])).toEqual({ kind: 'path', target: 'file:///tmp/t' });
  });

  it('still names no table when two different tables appear', () => {
    expect(soleLogPath([execWith('file:/tmp/a'), execWith('file:///tmp/b')])).toBeNull();
    expect(soleLogPath([execWith('file://hostA/tmp/t'), execWith('file:///tmp/t')])).toBeNull();
  });
});

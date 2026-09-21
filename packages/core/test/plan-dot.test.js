import { describe, it, expect } from 'vitest';
import { planTreeToDot } from '../src/plan-dot.js';

describe('planTreeToDot', () => {
  it('emits a digraph with labelled nodes and parent->child edges', () => {
    const tree = { name: 'Project', detail: 'Project [a, b]', metrics: [], children: [
      { name: 'Scan parquet', detail: '', metrics: [], children: [] } ] };
    const dot = planTreeToDot(tree, { title: 'q1' });
    expect(dot.startsWith('digraph')).toBe(true);
    expect(dot).toContain('label="Project');
    expect(dot).toContain('label="Scan parquet"');
    expect(dot).toMatch(/n0 -> n1/);
    expect(dot.trim().endsWith('}')).toBe(true);
  });

  it('escapes quotes and backslashes in labels', () => {
    const tree = { name: 'Filter "x"\\y', detail: '', metrics: [], children: [] };
    const dot = planTreeToDot(tree, {});
    expect(dot).toContain('Filter \\"x\\"\\\\y');
  });

  it('returns empty string for a null tree', () => {
    expect(planTreeToDot(null, {})).toBe('');
  });

  it('emits two boxes and a linking edge for a split Exchange pair', () => {
    const write = { name: 'Exchange', detail: '', metrics: [], children: [{ name: 'Scan parquet', detail: '', metrics: [], children: [] }], exchangeRole: 'write' };
    const read = { name: 'Exchange', detail: 'hashpartitioning(200)', metrics: [], children: [write], exchangeRole: 'read' };
    const tree = { name: 'Project', detail: '', metrics: [], children: [read] };
    const dot = planTreeToDot(tree, { title: 'q1' });
    expect((dot.match(/label="Exchange/g) ?? []).length).toBe(2);
    expect(dot.match(/-> n\d+;/g)?.length).toBe(3); // Project->read, read->write, write->Scan
  });
});

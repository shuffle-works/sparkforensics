import { describe, it, expect } from 'vitest';
import { classifyNode, parseOperatorDetail, buildDurationMap, isExchangeNode, isBroadcastExchangeNode } from '../src/plan-node-detail.js';

describe('plan-node-detail', () => {
  describe('classifyNode', () => {
    it('classifies Union as boilerplate', () => {
      expect(classifyNode('Union')).toBe('boilerplate');
    });

    it('classifies WholeStageCodegen as boilerplate', () => {
      expect(classifyNode('WholeStageCodegen')).toBe('boilerplate');
    });

    it('classifies Exchange as exchange', () => {
      expect(classifyNode('Exchange')).toBe('exchange');
    });

    it('classifies Join as join', () => {
      expect(classifyNode('Join')).toBe('join');
    });

    it('classifies SerializeFromObject as boilerplate', () => {
      expect(classifyNode('SerializeFromObject')).toBe('boilerplate');
    });

    it('classifies DeserializeToObject as boilerplate', () => {
      expect(classifyNode('DeserializeToObject')).toBe('boilerplate');
    });
  });

  describe('parseOperatorDetail', () => {
    it('returns empty string for Union', () => {
      const result = parseOperatorDetail('Union', 'Union (order)');
      expect(result).toBe('');
    });

    it('returns codegen number for WholeStageCodegen', () => {
      const result = parseOperatorDetail('WholeStageCodegen (1)', 'WholeStageCodegen(1) ...');
      expect(result).toBe('codegen #1');
    });

    it('returns empty string for WholeStageCodegen without parens', () => {
      const result = parseOperatorDetail('WholeStageCodegen', 'WholeStageCodegen');
      expect(result).toBe('');
    });

    it('parses Exchange with hash partitioning', () => {
      const result = parseOperatorDetail(
        'Exchange',
        'Exchange hashpartitioning(id#1, 200)'
      );
      expect(result).toContain('hash');
      expect(result).toContain('id');
    });

    it('returns empty string for SerializeFromObject', () => {
      const result = parseOperatorDetail('SerializeFromObject', 'SerializeFromObject');
      expect(result).toBe('');
    });

    it('parses Join with condition', () => {
      const result = parseOperatorDetail(
        'Join',
        'Join [id#1], [id#2], Inner'
      );
      expect(result).toBeTruthy();
      expect(result).toContain('Inner');
    });

    it('strips the leading operator-name repeat for operators with no dedicated branch (e.g. InMemoryTableScan)', () => {
      const result = parseOperatorDetail(
        'InMemoryTableScan',
        'InMemoryTableScan [DATE#1, COUNTRY#2]'
      );
      expect(result).toBe('[DATE, COUNTRY]');
      expect(result).not.toMatch(/InMemoryTableScan/i);
    });
  });

});

describe('isExchangeNode', () => {
  it('is true for a plain Exchange name with no exchangeRole', () => {
    expect(isExchangeNode({ name: 'Exchange' })).toBe(true);
  });
  it('is true for BroadcastExchange', () => {
    expect(isExchangeNode({ name: 'BroadcastExchange' })).toBe(true);
  });
  it('is true for ReusedExchange (name-based fallback, not split)', () => {
    expect(isExchangeNode({ name: 'ReusedExchange' })).toBe(true);
  });
  it('is true for a node carrying exchangeRole even if its name did not match (defensive)', () => {
    expect(isExchangeNode({ name: 'SomethingElse', exchangeRole: 'write' })).toBe(true);
  });
  it('is false for a non-exchange node', () => {
    expect(isExchangeNode({ name: 'SortMergeJoin' })).toBe(false);
  });
});

describe('isBroadcastExchangeNode', () => {
  it('is true only for the exact literal name', () => {
    expect(isBroadcastExchangeNode('BroadcastExchange')).toBe(true);
    expect(isBroadcastExchangeNode('Exchange')).toBe(false);
    expect(isBroadcastExchangeNode('ReusedExchange')).toBe(false);
  });
});

describe('buildDurationMap', () => {
  it('derives stage linkage from stage.sqlExecutionId even when sqlExec.stageIds is empty (real-data shape)', () => {
    const leaf = { name: 'Scan parquet', detail: '', metrics: [{ name: 'duration', value: 100, metricType: 'timing' }], children: [] };
    const root = { name: 'SortMergeJoin', detail: '', metrics: [], children: [leaf] };
    const appModel = {
      stages: new Map([[1, { id: 1, sqlExecutionId: 7, submittedAt: 0, completedAt: 500 }]]),
      sql: new Map(),
    };
    const sqlExec = { executionId: 7, planTree: root, stageIds: [] };

    const durationMap = buildDurationMap(root, appModel, sqlExec, 7);

    expect(durationMap).not.toBeNull();
    expect(durationMap.get(root)).not.toBeNull();
  });

  it('returns null when no stage links back to this executionId at all', () => {
    const root = { name: 'SortMergeJoin', detail: '', metrics: [], children: [] };
    const appModel = { stages: new Map(), sql: new Map() };
    const sqlExec = { executionId: 7, planTree: root, stageIds: [] };

    expect(buildDurationMap(root, appModel, sqlExec, 7)).toBeNull();
  });
});

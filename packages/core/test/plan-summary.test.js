import { describe, it, expect } from 'vitest';
import { describePlanNode, summarizePlanTree, scanRelationId } from '../src/plan-summary.js';

const node = (name, detail, children = []) => ({ name, detail, metrics: [], children });

describe('summarizePlanTree: FileScan parquet', () => {
  it('extracts path, format, columns, pushed filters', () => {
    const tree = node('Scan parquet', 'FileScan parquet [order_id#1,store_id#2,amount#3] Batched: true, DataFilters: [isnotnull(store_id#2)], Format: Parquet, Location: InMemoryFileIndex(1 paths)[hdfs://cluster/warehouse/orders], PushedFilters: [IsNotNull(store_id), GreaterThan(amount,0.0)], ReadSchema: struct<order_id:int>');
    const r = summarizePlanTree(tree);
    expect(r.scans).toHaveLength(1);
    expect(r.scans[0].path).toBe('orders');
    expect(r.scans[0].format).toBe('parquet');
    expect(r.scans[0].projectedColumns).toContain('order_id');
    expect(r.scans[0].pushedFilters).toContain('IsNotNull(store_id)');
  });
});

describe('summarizePlanTree: SortMergeJoin', () => {
  it('extracts join type and keys', () => {
    const tree = node('SortMergeJoin', 'SortMergeJoin [store_id#1, date#2], [store_id#3, date#4], Inner');
    const r = summarizePlanTree(tree);
    expect(r.joins[0].joinType).toBe('SortMergeJoin');
    expect(r.joins[0].leftKeys).toContain('store_id');
    expect(r.joins[0].rightKeys).toContain('store_id');
  });
});

describe('summarizePlanTree: BroadcastHashJoin', () => {
  it('extracts broadcast join keys', () => {
    const tree = node('BroadcastHashJoin', 'BroadcastHashJoin [id#1], [id#2], Inner, BuildRight');
    const r = summarizePlanTree(tree);
    expect(r.joins[0].joinType).toBe('BroadcastHashJoin');
    expect(r.joins[0].leftKeys).toEqual(['id']);
  });
});

describe('summarizePlanTree: HashAggregate', () => {
  it('extracts group keys and aggregations', () => {
    const tree = node('HashAggregate', 'HashAggregate(keys=[store_id#1, date#2], functions=[sum(amount#3), count(1)])');
    const r = summarizePlanTree(tree);
    expect(r.aggs[0].groupByKeys).toContain('store_id');
    expect(r.aggs[0].aggregations.join(' ')).toContain('sum');
  });
  it('skips a partial-aggregation node', () => {
    const tree = node('HashAggregate', 'HashAggregate(keys=[], functions=[partial_count(a#1)])');
    const r = summarizePlanTree(tree);
    expect(r.aggs).toHaveLength(0);
  });
});

describe('summarizePlanTree: Exchange', () => {
  it('extracts hash / range / roundrobin / single', () => {
    const tree = node('Union', 'Union', [
      { ...node('Exchange', 'Exchange hashpartitioning(store_id#1, 200), ENSURE_REQUIREMENTS, [plan_id=42]'), exchangeRole: 'read' },
      { ...node('Exchange', 'Exchange rangepartitioning(date#2 ASC NULLS FIRST, 100), ENSURE_REQUIREMENTS'), exchangeRole: 'read' },
      { ...node('Exchange', 'Exchange RoundRobinPartitioning(50)'), exchangeRole: 'read' },
      { ...node('Exchange', 'Exchange SinglePartition, ENSURE_REQUIREMENTS'), exchangeRole: 'read' },
    ]);
    const r = summarizePlanTree(tree);
    const kinds = r.exchanges.map(e => e.partitioning);
    expect(kinds).toEqual(['hash', 'range', 'roundrobin', 'single']);
    expect(r.exchanges[0].keys).toContain('store_id');
    expect(r.exchanges[0].numPartitions).toBe(200);
    expect(r.exchanges[2].numPartitions).toBe(50);
    expect(r.exchanges[3].numPartitions).toBe(1);
  });

  it('counts a split Exchange pair once, gated on exchangeRole "read"', () => {
    const write = { ...node('Exchange', ''), exchangeRole: 'write' };
    const read = { ...node('Exchange', 'Exchange hashpartitioning(store_id#1, 200)'), exchangeRole: 'read', children: [write] };
    const tree = node('Union', 'Union', [read]);
    const r = summarizePlanTree(tree);
    expect(r.exchanges).toHaveLength(1);
  });

  it('excludes ReusedExchange from the count (it performs no write of its own)', () => {
    const tree = node('Union', 'Union', [
      { ...node('Exchange', 'Exchange hashpartitioning(store_id#1, 200)'), exchangeRole: 'read' },
      node('ReusedExchange', 'ReusedExchange [store_id#1]'), // no exchangeRole: references another Exchange, not split
    ]);
    const r = summarizePlanTree(tree);
    expect(r.exchanges).toHaveLength(1);
    expect(r.exchanges[0].partitioning).toBe('hash');
  });
});

describe('describePlanNode: Exchange classification', () => {
  it('classifies a write half, a read half, and a ReusedExchange as exchange kind', () => {
    expect(describePlanNode({ ...node('Exchange', 'Exchange hashpartitioning(a#1, 10)'), exchangeRole: 'read' }).kind).toBe('exchange');
    expect(describePlanNode({ ...node('Exchange', ''), exchangeRole: 'write' }).kind).toBeNull(); // write half carries no parseable detail
    expect(describePlanNode(node('ReusedExchange', 'ReusedExchange [a#1]')).kind).toBe('exchange');
  });
});

describe('summarizePlanTree: JDBC scan', () => {
  it('extracts table and sql from a Scan JDBCRelation node', () => {
    const tree = node('Scan JDBCRelation', 'Scan JDBCRelation((SELECT id, name FROM dw.DIM_PRODUCT) SPARK_GEN_SUBQ_0) [numPartitions=1]');
    const r = summarizePlanTree(tree);
    expect(r.scans[0].format).toBe('jdbc');
    expect(r.scans[0].path).toBe('dw.dim_product');
    expect(r.scans[0].sql).toContain('SELECT id, name FROM dw.DIM_PRODUCT');
  });
});

describe('summarizePlanTree: named catalog Delta data read', () => {
  it('pushes a delta scan using the catalog-qualified name (not the Location path)', () => {
    const detail = 'FileScan parquet spark_catalog.mx.t[c#1] Batched: true, Location: PreparedDeltaFileIndex[hdfs://192.0.2.10:8020/data/mx/t], PushedFilters: []';
    const tree = node('Scan parquet spark_catalog.mx.t', detail);
    const r = summarizePlanTree(tree);
    expect(r.scans).toHaveLength(1);
    expect(r.scans[0].format).toBe('delta');
    expect(r.scans[0].path).toBe('mx.t');
  });
});

describe('summarizePlanTree: warnings', () => {
  it('flags CartesianProduct', () => {
    const r = summarizePlanTree(node('CartesianProduct', 'CartesianProduct'));
    expect(r.warnings.some(w => w.type === 'crossJoin')).toBe(true);
  });
  it('flags a Cross join type', () => {
    const r = summarizePlanTree(node('SortMergeJoin', 'SortMergeJoin [a#1], [b#2], Cross'));
    expect(r.warnings.some(w => w.type === 'crossJoin')).toBe(true);
  });
  it('does not flag an Inner join', () => {
    const r = summarizePlanTree(node('SortMergeJoin', 'SortMergeJoin [a#1], [b#2], Inner'));
    expect(r.warnings.some(w => w.type === 'crossJoin')).toBe(false);
  });
  it('flags a long filter condition (>1000 chars)', () => {
    const long = 'a#1 = 1 OR '.repeat(100);
    const r = summarizePlanTree(node('Filter', `Filter (${long})`));
    expect(r.warnings.some(w => w.type === 'longFilterCondition')).toBe(true);
  });
  it('does not flag a short filter', () => {
    const r = summarizePlanTree(node('Filter', 'Filter isnotnull(a#1)'));
    expect(r.warnings.some(w => w.type === 'longFilterCondition')).toBe(false);
  });
});

describe('summarizePlanTree: empty', () => {
  it('returns empty arrays for null', () => {
    expect(summarizePlanTree(null)).toEqual({ scans: [], joins: [], aggs: [], exchanges: [], warnings: [] });
  });
});

describe('scanRelationId', () => {
  it('returns "<format>:<basename>" for an anonymous InMemoryFileIndex FileScan', () => {
    const detail = 'FileScan parquet [price#1] Batched: true, Format: Parquet, Location: InMemoryFileIndex(1 paths)[hdfs://cluster/warehouse/prices], PushedFilters: [], ReadSchema: struct<price:int>';
    expect(scanRelationId('Scan parquet', detail)).toBe('parquet:prices');
  });
  it('uses the untruncated catalog name from the nodeName', () => {
    const detail = 'FileScan parquet spark_catalog.mx.store_map[a#1] Location: InMemoryFileIndex[hdfs://cluster/wh/mx/store_map]';
    expect(scanRelationId('Scan parquet spark_catalog.mx.store_map', detail)).toBe('parquet:mx.store_map');
  });
  it('marks a catalog-named PreparedDeltaFileIndex read as delta', () => {
    const detail = 'FileScan parquet spark_catalog.mx.t[c#1] Location: PreparedDeltaFileIndex[hdfs://cluster/wh/mx/t]';
    expect(scanRelationId('Scan parquet spark_catalog.mx.t', detail)).toBe('delta:mx.t');
  });
  it('returns null for an anonymous Delta metadata read (DeltaLogFileIndex)', () => {
    const detail = 'FileScan parquet [path#1] Location: DeltaLogFileIndex[hdfs://cluster/wh/mx/t/_delta_log]';
    expect(scanRelationId('Scan parquet', detail)).toBeNull();
  });
  it('returns null for a truncated Delta-log read via its column signature', () => {
    const detail = 'FileScan parquet [checkpointMetadata#1,sidecar#2,commitInfo#3] Location: InMemoryFileIndex(1 paths)[hdfs://cluster/wh/mx/t/_del...';
    expect(scanRelationId('Scan parquet', detail)).toBeNull();
  });
  it('returns "<format>:<basename>" for an anonymous InMemoryFileIndex path', () => {
    const detail = 'FileScan parquet [c#1] Location: InMemoryFileIndex(1 paths)[hdfs://cluster/wh/products]';
    expect(scanRelationId('Scan parquet', detail)).toBe('parquet:products');
  });
  it('returns "jdbc:<table>" from a JDBCRelation FROM clause (lowercased)', () => {
    const detail = 'Scan JDBCRelation((SELECT id, name FROM dw.dim_store) SPARK_GEN_SUBQ_0) [numPartitions=1]';
    expect(scanRelationId('Scan JDBCRelation', detail)).toBe('jdbc:dw.dim_store');
  });
  it('extracts the real table from an aliased JDBC subquery without a trailing paren', () => {
    const detail = 'Scan JDBCRelation((SELECT distinct store_id FROM ref.store_allowlist) as e) [numPartitions=1]';
    expect(scanRelationId('Scan JDBCRelation', detail)).toBe('jdbc:ref.store_allowlist');
  });
  it('returns null when the first FROM token is a subquery (CTE/UNION)', () => {
    const detail = 'Scan JDBCRelation((SELECT * FROM ( SELECT x FROM t )) SPARK_GEN_SUBQ_0) [numPartitions=1]';
    expect(scanRelationId('Scan JDBCRelation', detail)).toBeNull();
  });
  it('lowercases an uppercase JDBC table name', () => {
    const detail = 'Scan JDBCRelation((SELECT a FROM STAGING.D_X) SPARK_GEN_SUBQ_0) [numPartitions=1]';
    expect(scanRelationId('Scan JDBCRelation', detail)).toBe('jdbc:staging.d_x');
  });
  it('returns null for a Scan ExistingRDD Delta Table State node', () => {
    expect(scanRelationId('Scan ExistingRDD Delta Table State #36 - hdfs://192.0.2.10:8020/data/foo', 'Scan ExistingRDD Delta Table State')).toBeNull();
  });
  it('returns null for a non-scan node', () => {
    expect(scanRelationId('Project', '')).toBeNull();
  });
});

describe('describePlanNode', () => {
  it('returns the full scan fields for a FileScan node', () => {
    const n = node('Scan parquet', 'FileScan parquet [order_id#1,store_id#2] Batched: true, DataFilters: [isnotnull(store_id#2)], Format: Parquet, Location: InMemoryFileIndex(1 paths)[hdfs://cluster/warehouse/orders], PushedFilters: [IsNotNull(store_id)], ReadSchema: struct<order_id:int>');
    const d = describePlanNode(n);
    expect(d.kind).toBe('scan');
    expect(d.path).toBe('orders');
    expect(d.format).toBe('parquet');
    expect(d.projectedColumns).toContain('order_id');
    expect(d.pushedFilters).toContain('IsNotNull(store_id)');
    expect(d.warning).toBeNull();
  });

  it('returns the full join fields for a SortMergeJoin node', () => {
    const n = node('SortMergeJoin', 'SortMergeJoin [store_id#1, date#2], [store_id#3, date#4], Inner');
    const d = describePlanNode(n);
    expect(d.kind).toBe('join');
    expect(d.joinType).toBe('SortMergeJoin');
    expect(d.leftKeys).toContain('store_id');
    expect(d.rightKeys).toContain('store_id');
    expect(d.warning).toBeNull();
  });

  it('flags a Cross join type as both a join and a warning', () => {
    const n = node('SortMergeJoin', 'SortMergeJoin [a#1], [b#2], Cross');
    const d = describePlanNode(n);
    expect(d.kind).toBe('join');
    expect(d.warning?.type).toBe('crossJoin');
  });

  it('returns the full agg fields for a final HashAggregate node', () => {
    const n = node('HashAggregate', 'HashAggregate(keys=[store_id#1], functions=[sum(amount#2)])');
    const d = describePlanNode(n);
    expect(d.kind).toBe('agg');
    expect(d.groupByKeys).toContain('store_id');
    expect(d.aggregations.join(' ')).toContain('sum');
  });

  it('returns null for a partial-aggregation pass', () => {
    const n = node('HashAggregate', 'HashAggregate(keys=[], functions=[partial_count(a#1)])');
    expect(describePlanNode(n)).toBeNull();
  });

  it('returns the full exchange fields for a hash-partitioned Exchange node', () => {
    const n = node('Exchange', 'Exchange hashpartitioning(store_id#1, 200), ENSURE_REQUIREMENTS, [plan_id=42]');
    const d = describePlanNode(n);
    expect(d.kind).toBe('exchange');
    expect(d.partitioning).toBe('hash');
    expect(d.keys).toContain('store_id');
    expect(d.numPartitions).toBe(200);
  });

  it('flags a CartesianProduct node as a warning with no kind', () => {
    const d = describePlanNode(node('CartesianProduct', 'CartesianProduct'));
    expect(d.kind).toBeNull();
    expect(d.warning?.type).toBe('crossJoin');
  });

  it('flags a long filter condition as a warning with no kind', () => {
    const long = 'a#1 = 1 OR '.repeat(100);
    const d = describePlanNode(node('Filter', `Filter (${long})`));
    expect(d.kind).toBeNull();
    expect(d.warning?.type).toBe('longFilterCondition');
  });

  it('returns null for an unrelated node', () => {
    expect(describePlanNode(node('Project', 'Project [a#1]'))).toBeNull();
  });

  it('returns null for a node with no name or detail, without throwing', () => {
    expect(() => describePlanNode({})).not.toThrow();
    expect(describePlanNode({})).toBeNull();
  });

  it('returns null for null, without throwing', () => {
    expect(() => describePlanNode(null)).not.toThrow();
    expect(describePlanNode(null)).toBeNull();
  });

  it('returns null for undefined, without throwing', () => {
    expect(() => describePlanNode(undefined)).not.toThrow();
    expect(describePlanNode(undefined)).toBeNull();
  });

  it('extracts broadcast join keys', () => {
    const n = node('BroadcastHashJoin', 'BroadcastHashJoin [id#1], [id#2], Inner, BuildRight');
    const d = describePlanNode(n);
    expect(d.kind).toBe('join');
    expect(d.joinType).toBe('BroadcastHashJoin');
    expect(d.leftKeys).toEqual(['id']);
  });

  it('extracts a range-partitioned Exchange node', () => {
    const n = node('Exchange', 'Exchange rangepartitioning(date#2 ASC NULLS FIRST, 100), ENSURE_REQUIREMENTS');
    const d = describePlanNode(n);
    expect(d.kind).toBe('exchange');
    expect(d.partitioning).toBe('range');
    expect(d.numPartitions).toBe(100);
  });

  it('extracts a roundrobin-partitioned Exchange node', () => {
    const n = node('Exchange', 'Exchange RoundRobinPartitioning(50)');
    const d = describePlanNode(n);
    expect(d.kind).toBe('exchange');
    expect(d.partitioning).toBe('roundrobin');
    expect(d.numPartitions).toBe(50);
  });

  it('extracts a single-partition Exchange node', () => {
    const n = node('Exchange', 'Exchange SinglePartition, ENSURE_REQUIREMENTS');
    const d = describePlanNode(n);
    expect(d.kind).toBe('exchange');
    expect(d.partitioning).toBe('single');
    expect(d.numPartitions).toBe(1);
  });

  it('extracts table and sql from a Scan JDBCRelation node', () => {
    const n = node('Scan JDBCRelation', 'Scan JDBCRelation((SELECT id, name FROM dw.DIM_PRODUCT) SPARK_GEN_SUBQ_0) [numPartitions=1]');
    const d = describePlanNode(n);
    expect(d.kind).toBe('scan');
    expect(d.format).toBe('jdbc');
    expect(d.path).toBe('dw.dim_product');
    expect(d.sql).toContain('SELECT id, name FROM dw.DIM_PRODUCT');
  });

  it('pushes a delta scan using the catalog-qualified name (not the Location path)', () => {
    const detail = 'FileScan parquet spark_catalog.mx.t[c#1] Batched: true, Location: PreparedDeltaFileIndex[hdfs://192.0.2.10:8020/data/mx/t], PushedFilters: []';
    const n = node('Scan parquet spark_catalog.mx.t', detail);
    const d = describePlanNode(n);
    expect(d.kind).toBe('scan');
    expect(d.format).toBe('delta');
    expect(d.path).toBe('mx.t');
  });

  it('does not flag a filter under the length threshold', () => {
    expect(describePlanNode(node('Filter', 'Filter isnotnull(a#1)'))).toBeNull();
  });
});

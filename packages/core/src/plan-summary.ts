// Best-effort summary of a resolved plan tree (parser-worker `resolvePlanTree`).
// Unparseable fragments are silently skipped, never surfaced as an error.

import type { PlanNode } from './types.ts';
import { pathBasename } from './format-utils.ts';
import { walkPlanTree } from './plan-tree-walk.ts';
import { isExchangeNode } from './plan-node-detail.ts';

export interface ScanRow { path: string; format: string; projectedColumns: string[]; pushedFilters: string[]; sql?: string; }
export interface JoinRow { joinType: string; leftKeys: string[]; rightKeys: string[]; }
export interface AggRow { groupByKeys: string[]; aggregations: string[]; }
export interface ExchangeRow { partitioning: 'hash' | 'range' | 'roundrobin' | 'single'; keys: string[]; numPartitions: number; }
export interface WarningRow { type: 'crossJoin' | 'longFilterCondition'; detail: string; }

interface PlanSummary {
  scans: ScanRow[];
  joins: JoinRow[];
  aggs: AggRow[];
  exchanges: ExchangeRow[];
  warnings: WarningRow[];
}

function cleanColRef(ref: string): string { return ref.trim().replace(/#\w+$/, ''); }

function parseColList(bracketed: string): string[] {
  return bracketed.replace(/^\[|\]$/g, '').split(',').map(cleanColRef).filter(Boolean);
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = []; let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) { parts.push(s.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(s.slice(start).trim());
  return parts.filter(Boolean);
}

function pushCrossJoinWarning(result: PlanSummary, label: string): void {
  result.warnings.push({ type: 'crossJoin', detail: `${label} detected: this can cause severe data explosion.` });
}
function pushLongFilterWarning(result: PlanSummary, len: number): void {
  result.warnings.push({ type: 'longFilterCondition', detail: `Filter condition is ${len} characters: consider simplifying or pushing the filter down closer to the scan.` });
}

// Stable relation-identity key for a scan node: "<format>:<relation>" (e.g.
// "delta:mx.store_map", "parquet:warehouse.sales", "jdbc:dw.dim_product")
// or null when the node is internal Delta metadata / a non-scan / un-nameable.
// The single source of truth for scan identity, shared by `visitScan` (summary)
// and the `cachingOpportunity` detector so the regexes live in one place.
export function scanRelationId(name: string, detail: string): string | null {
  // 1. Named catalog table, untruncated, from the nodeName (the key fix; the
  //    Location: path is truncated at ~100 chars and points at _delta_log for
  //    Delta tables). All catalog tables surface as `spark_catalog.<db>.<table>`.
  let format = null, table = null;
  const nameM = name.match(/^Scan\s+(parquet|orc|csv|json)\s+(spark_catalog\.\S+)$/i);
  // Fast reject: every branch below that returns a key needs this name match, a FileScan
  // detail or a JDBCRelation detail. Most plan nodes (Project, Filter, joins) have none, and
  // their long details otherwise pay every regex below.
  if (!nameM && !/FileScan/i.test(detail) && !detail.includes('JDBCRelation')) return null;
  if (nameM) { format = nameM[1].toLowerCase(); table = nameM[2]; }
  else {
    const detM = detail.match(/FileScan\s+(parquet|orc|csv|json)\s+(spark_catalog\.[^[\s]+)\[/i);
    if (detM) { format = detM[1].toLowerCase(); table = detM[2]; }
  }
  if (table) {
    // A Delta data read keeps its Delta index marker; report format `delta`.
    if (/PreparedDeltaFileIndex/i.test(detail)) format = 'delta';
    return `${format}:${table.replace(/^spark_catalog\./, '')}`;
  }

  // 2. Internal Delta metadata (the _delta_log state scan and anonymous
  //    commit/checkpoint reads) → null. Location: is often truncated to `Del...`,
  //    so also key off DeltaLogFileIndex or the Delta-log action column signature.
  //    (Column-signature heuristic: a future Spark renaming those action columns
  //    would leak a noise row; acceptable.)
  if (/_delta_log/.test(name) || /_delta_log/.test(detail) ||
      /DeltaLogFileIndex/i.test(name + detail) ||
      /checkpointMetadata#|sidecar#|commitInfo#/.test(name + detail)) {
    return null;
  }

  // 3. Anonymous real file read (InMemoryFileIndex, no catalog name) →
  //    best-effort Location basename. Preserves temp/snapshot self-reuse; a
  //    truncated Location can still fragment these; inherent, unrecoverable.
  const fileM = detail.match(/FileScan\s+(parquet|orc|csv|json)\b/i);
  if (fileM) {
    const locM = detail.match(/Location:[^[]*\[([^\]]+)\]/);
    if (!locM) return null;
    return `${fileM[1].toLowerCase()}:${pathBasename(locM[1].split(',')[0].trim())}`;
  }

  // 4. JDBC: the inner SQL's first real table, lowercased. null when the first
  //    post-FROM token is a subquery `(` or there is no single table (CTE/UNION).
  if (/JDBCRelation/.test(detail)) {
    const fromM = jdbcSql(detail).match(/\bFROM\s+(\(|[A-Za-z_][\w.]*)/i);
    if (!fromM || fromM[1] === '(') return null;
    return `jdbc:${fromM[1].toLowerCase()}`;
  }

  // 5. Non-scan / unrecognized.
  return null;
}

// Extracts the inner SQL text from a JDBCRelation detail string (used for both
// the relation table name and the scan's `sql` summary field).
function jdbcSql(detail: string): string {
  const jdbcM = detail.match(/JDBCRelation\(([\s\S]+?)\)\s*(?:SPARK_GEN_SUBQ_\d+\)?)?\s*\[numPartitions/);
  const sqlM = detail.match(/JDBCRelation\(\(([\s\S]+?)\)\s*SPARK_GEN_SUBQ/);
  return (sqlM ? sqlM[1] : (jdbcM ? jdbcM[1] : '')).replace(/\s+/g, ' ').trim();
}

function visitScan(name: string, detail: string, result: PlanSummary): boolean {
  // Identity (path + format) comes from the shared classifier; a null key means
  // internal Delta metadata / an un-nameable read; no Sources bullet.
  const rid = scanRelationId(name, detail);
  if (!rid) return false;
  const colon = rid.indexOf(':');
  const format = rid.slice(0, colon);
  const path = rid.slice(colon + 1);

  if (format === 'jdbc') {
    result.scans.push({ path, format, projectedColumns: [], pushedFilters: [], sql: jdbcSql(detail) });
    return true;
  }
  // FileScan <fmt> [cols] ... PushedFilters: [...] (format may be `delta`).
  const colsM = detail.match(/FileScan\s+\w+\s+(\[[^\]]*\])/i) ?? detail.match(/(\[[^\]]*\])/);
  const filM = detail.match(/PushedFilters:\s*\[([^\]]*)\]/);
  result.scans.push({
    path,
    format,
    projectedColumns: colsM ? parseColList(colsM[1]) : [],
    pushedFilters: filM && filM[1] ? filM[1].split(',').map(s => s.trim()).filter(Boolean) : [],
  });
  return true;
}

function visitJoin(_name: string, detail: string, result: PlanSummary): boolean {
  // <JoinOp> [leftKeys], [rightKeys], <JoinType>[, BuildSide]
  const m = detail.match(/^(SortMergeJoin|BroadcastHashJoin|ShuffledHashJoin|BroadcastNestedLoopJoin)\s+(\[[^\]]*\]),\s*(\[[^\]]*\]),\s*(\w+)/);
  if (m) {
    result.joins.push({ joinType: m[1], leftKeys: parseColList(m[2]), rightKeys: parseColList(m[3]) });
    if (/^Cross$/i.test(m[4])) pushCrossJoinWarning(result, 'Cross join');
    return true;
  }
  return false;
}

function visitAgg(_name: string, detail: string, result: PlanSummary): boolean {
  const m = detail.match(/(?:Object)?HashAggregate\(keys=(\[[^\]]*\]),\s*functions=(\[[\s\S]*\])\)/);
  if (!m) return false;
  const funcs = m[2].replace(/^\[|\]$/g, '');
  if (/\bpartial_/.test(funcs)) return true;   // skip partial pass
  const aggregations = splitTopLevel(funcs).map(f => f.replace(/#\w+/g, '').trim()).filter(Boolean).slice(0, 8);
  const groupByKeys = parseColList(m[1]);
  if (groupByKeys.length || aggregations.length) result.aggs.push({ groupByKeys, aggregations });
  return true;
}

function visitExchange(detail: string, result: PlanSummary): void {
  const h = detail.match(/hashpartitioning\((.+?),\s*(\d+)\)/i);
  const r = detail.match(/rangepartitioning\((.+?),\s*(\d+)\)/i);
  if (h) {
    result.exchanges.push({ partitioning: 'hash', keys: splitTopLevel(h[1]).map(s => cleanColRef(s.replace(/\s+(ASC|DESC)(\s+NULLS\s+\w+)?/i, ''))).filter(Boolean), numPartitions: parseInt(h[2], 10) });
  } else if (r) {
    result.exchanges.push({ partitioning: 'range', keys: splitTopLevel(r[1]).map(s => cleanColRef(s.replace(/\s+(ASC|DESC)(\s+NULLS\s+\w+)?/i, ''))).filter(Boolean), numPartitions: parseInt(r[2], 10) });
  } else if (/RoundRobinPartitioning/i.test(detail)) {
    const n = detail.match(/RoundRobinPartitioning\((\d+)\)/i);
    result.exchanges.push({ partitioning: 'roundrobin', keys: [], numPartitions: n ? parseInt(n[1], 10) : 0 });
  } else if (/SinglePartition/i.test(detail)) {
    result.exchanges.push({ partitioning: 'single', keys: [], numPartitions: 1 });
  }
}

export function summarizePlanTree(planTree: PlanNode | null): PlanSummary {
  const result: PlanSummary = { scans: [], joins: [], aggs: [], exchanges: [], warnings: [] };
  if (!planTree) return result;

  walkPlanTree(planTree, (n) => {
    const name = n.name ?? '';
    const detail = n.detail ?? '';
    if (/CartesianProduct/i.test(name) || /CartesianProduct/i.test(detail)) pushCrossJoinWarning(result, 'CartesianProduct');
    else if (visitScan(name, detail, result)) { /* handled */ }
    else if (/Join/i.test(name) && visitJoin(name, detail, result)) { /* handled */ }
    else if (/Aggregate/i.test(name) && visitAgg(name, detail, result)) { /* handled */ }
    else if (n.exchangeRole === 'read') visitExchange(detail, result);
    else if (/^Filter/i.test(name)) {
      const condM = detail.match(/^Filter\s+([\s\S]+)/);
      if (condM && condM[1].trim().length > 1000) pushLongFilterWarning(result, condM[1].trim().length);
    }
  }, { dedupe: true });
  return result;
}

// Per-node structured detail: the same regex visitors as summarizePlanTree
// (visitScan/visitJoin/visitAgg/visitExchange, plus the crossJoin/
// longFilterCondition warning checks), scoped to a single node instead of
// folded into a tree-wide array. Used to attach the flat summary's full
// fields (every pushed filter, every join key, every partitioning key) to
// the exact operator they describe, and to attach a plan-text warning to
// the node that caused it instead of a disconnected list entry.
export function describePlanNode(
  node: PlanNode | null,
): ({ kind: 'scan' | 'join' | 'agg' | 'exchange' | null; warning: WarningRow | null } & Partial<ScanRow & JoinRow & AggRow & ExchangeRow>) | null {
  if (!node) return null;
  const name = node.name ?? '';
  const detail = node.detail ?? '';
  const result: PlanSummary = { scans: [], joins: [], aggs: [], exchanges: [], warnings: [] };
  let recognizedType: 'scan' | 'join' | 'agg' | 'exchange' | 'filter' | 'cartesian' | null = null;

  if (/CartesianProduct/i.test(name) || /CartesianProduct/i.test(detail)) {
    recognizedType = 'cartesian';
    pushCrossJoinWarning(result, 'CartesianProduct');
  } else if (visitScan(name, detail, result)) {
    recognizedType = 'scan';
    // handled
  } else if (/Join/i.test(name) && visitJoin(name, detail, result)) {
    recognizedType = 'join';
    // handled (a Cross join type may also have pushed a crossJoin warning)
  } else if (/Aggregate/i.test(name) && visitAgg(name, detail, result)) {
    recognizedType = 'agg';
    // handled (a partial-aggregation pass pushes nothing into result.aggs)
  } else if (isExchangeNode(node)) {
    recognizedType = 'exchange';
    visitExchange(detail, result);
  } else if (/^Filter/i.test(name)) {
    recognizedType = 'filter';
    const condM = detail.match(/^Filter\s+([\s\S]+)/);
    if (condM && condM[1].trim().length > 1000) pushLongFilterWarning(result, condM[1].trim().length);
  }

  const kind = result.scans[0] ? 'scan'
    : result.joins[0] ? 'join'
    : result.aggs[0] ? 'agg'
    : result.exchanges[0] ? 'exchange'
    : recognizedType === 'exchange' && node.exchangeRole !== 'write' ? 'exchange' // ReusedExchange recognized as exchange but no pattern match; write halves stay null
    : null;
  const fields = result.scans[0] ?? result.joins[0] ?? result.aggs[0] ?? result.exchanges[0] ?? null;
  const warning = result.warnings[0] ?? null;

  // Return null if no recognized type, or if it's agg/filter with no content/warning
  if (!recognizedType) return null;
  if ((recognizedType === 'agg' || recognizedType === 'filter') && !kind && !warning) return null;

  // For exchange or other types, or if there's content/warning, return the object
  return { kind, warning, ...(fields ?? {}) };
}

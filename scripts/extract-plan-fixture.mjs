#!/usr/bin/env node
// One-off extraction: pulls stage 394's planTree out of a private local event
// log into a small JSON test fixture, so tests/plan-graph-model.test.js can
// pin real-world node/edge/badge counts without the multi-hundred-MB event log.
// The log is private-log-04.zstd (see the private-log table in
// docs-site/contributor-guide/testing.md). The fixture is committed to a public
// repo, so every node name and detail goes through sanitizePlanTree() first:
// the tree shape, ids, exchange roles and metrics stay, while every table,
// database, column, path and literal is replaced by a consistent neutral name.
import { writeFileSync } from 'node:fs';
import { collectRun } from '../packages/core/src/cli/collect-run.ts';

const LOG_PATH = process.argv[2] ?? 'examples/private-log-04.zstd';
const STAGE_ID = 394;
const FIXTURE_PATH = 'packages/core/test/fixtures/plan-graph-stage-394.json';

// Spark plan and SQL vocabulary kept verbatim. Any other identifier is
// treated as private (a table, column, alias or job name) and renamed, so a
// word missing from this list is anonymized, never leaked.
const PLAN_VOCABULARY = new Set([
  'AND', 'AS', 'ASC', 'CASE', 'DESC', 'DISTINCT', 'ELSE', 'END', 'FIRST', 'FROM', 'IN', 'JOIN',
  'LAST', 'NOT', 'NULLS', 'ON', 'OR', 'SELECT', 'THEN', 'WHEN', 'WHERE', 'WITH',
  'as', 'case', 'else', 'end', 'from', 'in', 'not', 'null', 'or', 'select', 'then', 'when', 'distinct',
  'AdaptiveSparkPlan', 'BroadcastExchange', 'BroadcastHashJoin', 'BuildLeft', 'BuildRight',
  'ColumnarToRow', 'DataFilters', 'ENSURE_REQUIREMENTS', 'ErrorIfExists', 'Exchange', 'Execute',
  'ExistenceJoin', 'FileScan', 'Filter', 'Format', 'HashAggregate', 'HashedRelationBroadcastMode',
  'InMemoryFileIndex', 'InMemoryTableScan', 'Inner', 'InputAdapter', 'InsertIntoHadoopFsRelationCommand',
  'IsNotNull', 'JDBCRelation', 'LeftOuter', 'LeftSemi', 'List', 'Location', 'ObjectHashAggregate',
  'Parquet', 'PartitionFilters', 'PreparedDeltaFileIndex', 'Project', 'PushedFilters', 'ReadSchema',
  'RowFrame', 'Scan', 'SinglePartition', 'Sort', 'SortMergeJoin', 'Subquery', 'Union',
  'WholeStageCodegen', 'Window', 'WriteFiles',
  'bigint', 'cast', 'coalesce', 'collect_set', 'count', 'currentrow', 'decimal', 'double', 'false',
  'fields', 'functions', 'hashpartitioning', 'id', 'if', 'input', 'int', 'isFinalPlan', 'isnotnull',
  'keys', 'knownfloatingpointnormalized', 'lower', 'max', 'merge_max', 'merge_min', 'min', 'more',
  'normalizenanandzero', 'numPartitions', 'parquet', 'partial_collect_set', 'partial_count',
  'partial_max', 'partial_min', 'path', 'paths', 'plan_id', 'replace', 'size', 'spark_catalog',
  'specifiedwindowframe', 'string', 'struct', 'subquery', 'sum', 'true', 'unboundedfollowing',
  'unboundedpreceding', 'windowspecdefinition',
]);

// Filesystem URIs and absolute paths, up to the next delimiter.
const PATH_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s,\])]+|(?<![\w.])\/[\w.\-=]+(?:\/[\w.\-=]*)+/g;
const LITERAL_PATTERN = /'[^']*'/g;
const WORD_PATTERN = /[\p{L}_][\p{L}\p{N}_]*/gu;
const NUMERIC_SUFFIX_PATTERN = /^(?:[LDFSYB]|BD|E\d*)$/i;

function sanitizePlanTree(planTree) {
  const names = new Map();
  const paths = new Map();
  const literals = new Map();
  const neutral = (map, key, prefix) => {
    if (!map.has(key)) map.set(key, `${prefix}_${map.size + 1}`);
    return map.get(key);
  };

  function sanitizeText(text) {
    return text
      .replace(PATH_PATTERN, (p) => `/${neutral(paths, p, 'path')}`)
      // Punctuation-only literals ('|', ' ', '') carry nothing private.
      .replace(LITERAL_PATTERN, (lit) => (/[\p{L}\p{N}]/u.test(lit) ? `'${neutral(literals, lit, 'lit')}'` : lit))
      .replace(WORD_PATTERN, (word, offset, whole) => {
        // Numeric literal suffixes glued to a digit (10L, 1.5BD, 1E5) stay verbatim.
        if (offset > 0 && /\p{N}/u.test(whole[offset - 1]) && NUMERIC_SUFFIX_PATTERN.test(word)) return word;
        if (PLAN_VOCABULARY.has(word) || /^(?:path|lit)_\d+$/.test(word)) return word;
        return neutral(names, word, 'name');
      });
  }

  function sanitizeNode(node) {
    return {
      ...node,
      name: sanitizeText(node.name),
      detail: sanitizeText(node.detail ?? ''),
      children: (node.children ?? []).map(sanitizeNode),
    };
  }

  return sanitizeNode(planTree);
}

const { appModel } = await collectRun(LOG_PATH);
const stage = appModel.stages.get(STAGE_ID);
if (!stage) throw new Error(`Stage ${STAGE_ID} not found in ${LOG_PATH}`);
const sqlExec = appModel.sql.get(stage.sqlExecutionId);
if (!sqlExec?.planTree) throw new Error(`No planTree for stage ${STAGE_ID}`);

const fixture = {
  stageId: STAGE_ID,
  sqlExecutionId: stage.sqlExecutionId,
  stage: { submittedAt: stage.submittedAt, completedAt: stage.completedAt },
  sqlExec: { executionId: sqlExec.executionId, stageIds: sqlExec.stageIds },
  planTree: sanitizePlanTree(sqlExec.planTree),
  // Real findings for this stage, to reproduce the skew/gc/straggler badge scenario.
  findings: [],
};

writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));
console.log(`Wrote ${FIXTURE_PATH}`);

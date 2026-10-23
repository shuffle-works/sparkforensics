// Which operators of a spilling stage hold the spilled rows, and how wide those rows are, read
// from the stage's plan nodes. The plan text lists no output columns on an exchange, so its column
// count comes from the nearest operator below it that does (a Project, a file scan or a
// ReusedExchange). Best-effort: a shape this cannot read yields no figure, never a guess.

import { formatBytes } from './format-utils.ts';
import { isExchangeNode } from './plan-node-detail.ts';
import { walkPlanTree } from './plan-tree-walk.ts';
import type { SpillExchange, SpillOperator } from './finding-types.ts';
import type { PlanNode } from './types.ts';

const MAX_OPERATORS = 5;
const SPILL_SIZE = 'spill size';

// Operators that buffer rows in memory and spill them: a sort (alone or under a SortMergeJoin),
// a hash aggregate and a window.
const SPILLING_OPERATOR = /^(Sort|HashAggregate|ObjectHashAggregate|Window)$/;
// Operators above a column list that pass its columns through unchanged.
const PASS_THROUGH = /^(Sort|Filter|InputAdapter|WholeStageCodegen|ShuffleQueryStage|AQEShuffleRead|CustomShuffleReader|ColumnarToRow|Coalesce)\b/;
// The codegen wrappers an executed plan puts between a SortMergeJoin and each of its child Sorts.
const CODEGEN_WRAPPER = /^(InputAdapter|WholeStageCodegen)\b/;
const SORT_MERGE_JOIN = /^SortMergeJoin(\(skew=true\))?$/;
// Spark prints a column list past spark.sql.debug.maxToStringFields as `... N more fields`.
const MORE_FIELDS = /^\.\.\.\s*(\d+)\s+more\s+fields$/;

const OPEN = '([{';
const CLOSE = ')]}';

// The text between the bracket that opens at `from` and its match, or null when it never closes.
function bracketed(text: string, from: number): string | null {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (OPEN.includes(text[i])) depth++;
    else if (CLOSE.includes(text[i]) && --depth === 0) return text.slice(from + 1, i);
  }
  return null;
}

// The entries of a Spark column list, counting the ones its `... N more fields` tail leaves out;
// null when the brackets inside do not balance (a literal holding a bracket).
function countColumns(list: string): number | null {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    if (OPEN.includes(list[i])) depth++;
    else if (CLOSE.includes(list[i])) depth--;
    else if (list[i] === ',' && depth === 0) { parts.push(list.slice(start, i).trim()); start = i + 1; }
    if (depth < 0) return null;
  }
  if (depth !== 0) return null;
  parts.push(list.slice(start).trim());
  const entries = parts.filter(Boolean);
  const more = entries.length > 0 ? MORE_FIELDS.exec(entries[entries.length - 1]) : null;
  return more ? entries.length - 1 + Number(more[1]) : entries.length;
}

// The columns a node itself lists in its plan text, or null when it lists none.
function listedColumns(node: PlanNode): number | null {
  const detail = node.detail ?? '';
  let open = -1;
  if (node.name === 'Project') open = detail.indexOf('[');
  else if (node.name === 'ReusedExchange') open = detail.startsWith('ReusedExchange [') ? detail.indexOf('[') : -1;
  else {
    // `FileScan <format> <table>[cols]` or `FileScan <format> [cols]`.
    const scan = /FileScan\s+\w+\s+(?:[^\s[]+)?\[/.exec(detail);
    if (scan) open = scan.index + scan[0].length - 1;
  }
  if (open < 0) return null;
  const list = bracketed(detail, open);
  return list === null ? null : countColumns(list);
}

// The columns of the rows `node` outputs: the nearest column list at or below it, looking through
// operators that keep the columns and stopping at any that change them (a join, an aggregate).
function outputColumns(node: PlanNode): number | null {
  let current: PlanNode = node;
  for (;;) {
    const listed = listedColumns(current);
    if (listed !== null) return listed;
    const children = current.children ?? [];
    if (children.length !== 1 || !(isExchangeNode(current) || PASS_THROUGH.test(current.name))) return null;
    current = children[0];
  }
}

function metricValue(node: PlanNode, name: string): number | null {
  return node.metrics?.find((m) => m.name === name)?.value ?? null;
}

// The exchange `node` reads its rows from: the first one below it through single-child operators.
function inputExchange(node: PlanNode): PlanNode | null {
  let current: PlanNode | undefined = node.children?.[0];
  while (current) {
    if (isExchangeNode(current)) return current.name === 'BroadcastExchange' ? null : current;
    current = (current.children ?? []).length === 1 ? current.children[0] : undefined;
  }
  return null;
}

/** The columns and estimated bytes per row of an exchange (the read half of a split Exchange, or a
 * ReusedExchange); null when neither is known. The write half holds the metrics and the plan below. */
export function exchangeWidth(exchange: PlanNode): SpillExchange | null {
  const write = exchange.exchangeRole === 'read' ? exchange.children?.[0] : exchange;
  if (!write) return null;
  const columns = outputColumns(exchange.exchangeRole === 'read' ? write : exchange);
  const dataSize = metricValue(write, 'data size');
  const records = metricValue(write, 'shuffle records written');
  const bytesPerRow = dataSize != null && records != null && records > 0 ? Math.round(dataSize / records) : null;
  if (columns === null && bytesPerRow === null) return null;
  return {
    nodeId: exchange.id ?? '',
    ...(columns !== null ? { columns } : {}),
    ...(bytesPerRow !== null ? { bytesPerRow } : {}),
  };
}

// Every spilling operator of one plan, by the stages it ran in: the index spares each stage a walk of
// the whole tree. Keyed by the tree, so it lives as long as the model does.
const operatorsByStage = new WeakMap<PlanNode, Map<number, { node: PlanNode; feeds?: string }[]>>();

function indexOperators(plan: PlanNode): Map<number, { node: PlanNode; feeds?: string }[]> {
  const cached = operatorsByStage.get(plan);
  if (cached) return cached;
  const index = new Map<number, { node: PlanNode; feeds?: string }[]>();
  // Each node's nearest ancestor-or-self that is not a codegen wrapper; pre-order sets a parent first.
  const unwrapped = new Map<PlanNode, PlanNode | null>();
  walkPlanTree(plan, (node, parent) => {
    const consumer = parent ? unwrapped.get(parent) ?? null : null;
    unwrapped.set(node, CODEGEN_WRAPPER.test(node.name) ? consumer : node);
    if (!SPILLING_OPERATOR.test(node.name)) return;
    const feeds = node.name === 'Sort' && consumer && SORT_MERGE_JOIN.test(consumer.name) ? 'SortMergeJoin' : undefined;
    for (const stageId of node.stageIds ?? []) {
      const entries = index.get(stageId);
      const entry = { node, ...(feeds ? { feeds } : {}) };
      if (entries) entries.push(entry); else index.set(stageId, [entry]);
    }
  });
  operatorsByStage.set(plan, index);
  return index;
}

/** The operators of stage `stageId` that report a "spill size" above zero, largest first, with the
 * exchanges they read. Empty when the plan ties no such operator to the stage. */
export function attributeSpill(
  plan: PlanNode | null | undefined, stageId: number,
): { operators: SpillOperator[]; exchanges: SpillExchange[] } {
  const found = plan ? indexOperators(plan).get(stageId) ?? [] : [];
  const chosen = found
    .map((entry) => ({ ...entry, spillBytes: metricValue(entry.node, SPILL_SIZE) ?? 0 }))
    .filter((entry) => entry.spillBytes > 0)
    .sort((a, b) => b.spillBytes - a.spillBytes)
    .slice(0, MAX_OPERATORS);
  const operators: SpillOperator[] = chosen.map((entry) => ({
    nodeId: entry.node.id ?? '',
    name: entry.node.name,
    spillBytes: entry.spillBytes,
    ...(entry.feeds ? { feeds: entry.feeds } : {}),
  }));
  const exchanges: SpillExchange[] = [];
  const seen = new Set<PlanNode>();
  for (const { node } of chosen) {
    const exchange = inputExchange(node);
    if (!exchange || seen.has(exchange)) continue;
    seen.add(exchange);
    const width = exchangeWidth(exchange);
    if (width) exchanges.push(width);
  }
  return { operators, exchanges };
}

/** Memory spill over the stage's input plus shuffle read, to one decimal. Null when that input is
 * under `minInputBytes`: a stage that reads next to nothing (generated rows) spills for another reason,
 * and a ratio over it would only look large. */
export function spillToInputRatio(
  memoryBytesSpilled: number, inputBytes: number, shuffleReadBytes: number, minInputBytes: number,
): number | null {
  const read = inputBytes + shuffleReadBytes;
  return read > 0 && read >= minInputBytes ? Math.round((memoryBytesSpilled / read) * 10) / 10 : null;
}

function operatorLabel(op: SpillOperator): string {
  const feeds = op.feeds ? ` feeding ${op.feeds}` : '';
  return `${op.name} ${op.nodeId}${feeds} ${formatBytes(op.spillBytes)}`;
}

/** The finding's sentences on where the spill sits: the operators with their plan node ids, then the
 * spill-to-input ratio, saying the rows are wide when `wide` (a spill several times the data read
 * points at rows decompressed and sorted in memory, not at a partition count). Empty when the plan
 * names no operator and the stage has no ratio. Free of ": ", so a recommendation it ends still
 * splits at its advice (recommendationParts). */
export function describeSpillCause(operators: SpillOperator[], ratio: number | null, wide: boolean): string {
  const sentences: string[] = [];
  if (operators.length > 0) sentences.push(`Spilled by ${operators.map(operatorLabel).join(', ')}.`);
  if (ratio !== null) {
    sentences.push(wide
      ? `Memory spill is ${ratio}x the stage's input, so the rows are wide.`
      : `Memory spill is ${ratio}x the stage's input.`);
  }
  return sentences.join(' ');
}

/** One short line for an exchange: `Exchange n12: 128 columns, ~410 B/row`. */
export function describeExchange(exchange: SpillExchange): string {
  const figures = [
    exchange.columns != null ? `${exchange.columns} columns` : null,
    exchange.bytesPerRow != null ? `~${exchange.bytesPerRow} B/row` : null,
  ].filter((figure): figure is string => figure !== null);
  return `Exchange ${exchange.nodeId}: ${figures.join(', ')}`;
}

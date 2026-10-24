// Which operators of a spilling stage hold the spilled rows, and how wide those rows are. The plan
// text lists no output columns on an exchange, so its column count comes from the nearest node
// below it that lists them. A shape this cannot read yields no figure.

import { formatBytes } from './format-utils.ts';
import { isExchangeNode } from './plan-node-detail.ts';
import { walkPlanTree } from './plan-tree-walk.ts';
import type { SpillExchange, SpillOperator } from './finding-types.ts';
import type { PlanNode } from './types.ts';

const MAX_OPERATORS = 5;
const SPILLING_OPERATOR = /^(Sort|HashAggregate|ObjectHashAggregate|Window)$/;
const PASS_THROUGH = /^(Sort|Filter|InputAdapter|WholeStageCodegen|ShuffleQueryStage|AQEShuffleRead|CustomShuffleReader|ColumnarToRow|Coalesce)\b/;
// An executed plan puts these between a SortMergeJoin and each of its child Sorts.
const CODEGEN_WRAPPER = /^(InputAdapter|WholeStageCodegen)\b/;
const SORT_MERGE_JOIN = /^SortMergeJoin(\(skew=true\))?$/;
// Spark ends a column list past spark.sql.debug.maxToStringFields with `... N more fields`.
const MORE_FIELDS = /^\.\.\.\s*(\d+)\s+more\s+fields$/;

// The columns of the bracketed list that opens at `open`, counting those its `... N more fields`
// tail leaves out; null when the list never closes.
function countColumns(text: string, open: number): number | null {
  const entries: string[] = [];
  let depth = 0, start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth === 0) {
      entries.push(text.slice(start, i).trim());
      const listed = entries.filter(Boolean);
      const more = MORE_FIELDS.exec(listed[listed.length - 1] ?? '');
      return more ? listed.length - 1 + Number(more[1]) : listed.length;
    } else if (c === ',' && depth === 1) {
      entries.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

// The columns a node lists in its own plan text: a Project, a ReusedExchange or a file scan.
function listedColumns(node: PlanNode): number | null {
  const detail = node.detail ?? '';
  let open = -1;
  if (node.name === 'Project' || node.name === 'ReusedExchange') open = detail.indexOf('[');
  else {
    const scan = /FileScan\s+\w+\s+(?:[^\s[]+)?\[/.exec(detail);
    if (scan) open = scan.index + scan[0].length - 1;
  }
  return open < 0 ? null : countColumns(detail, open);
}

// The columns `node` outputs: the nearest list at or below it, looking through operators that keep
// the columns and stopping at any that change them (a join, an aggregate).
function outputColumns(node: PlanNode): number | null {
  for (let current = node; ;) {
    const listed = listedColumns(current);
    if (listed !== null) return listed;
    if (current.children.length !== 1 || !(isExchangeNode(current) || PASS_THROUGH.test(current.name))) return null;
    current = current.children[0];
  }
}

function metricValue(node: PlanNode, name: string): number | null {
  return node.metrics?.find((m) => m.name === name)?.value ?? null;
}

// The first exchange below `node` through single-child operators.
function inputExchange(node: PlanNode): PlanNode | null {
  let current: PlanNode | undefined = node.children[0];
  while (current && !isExchangeNode(current)) current = current.children.length === 1 ? current.children[0] : undefined;
  return current ?? null;
}

/** The columns and estimated bytes per row of an exchange (the read half of a split Exchange, or a
 * ReusedExchange); null when neither is known. The write half holds the metrics and the plan below. */
export function exchangeWidth(exchange: PlanNode): SpillExchange | null {
  const write = exchange.exchangeRole === 'read' ? exchange.children[0] : exchange;
  const columns = outputColumns(write);
  const dataSize = metricValue(write, 'data size');
  const records = metricValue(write, 'shuffle records written');
  const bytesPerRow = dataSize !== null && records ? Math.round(dataSize / records) : null;
  if (columns === null && bytesPerRow === null) return null;
  return {
    nodeId: exchange.id!,
    ...(columns !== null ? { columns } : {}),
    ...(bytesPerRow !== null ? { bytesPerRow } : {}),
  };
}

type IndexedOperator = { node: PlanNode; feeds?: string };

// Each plan's spilling operators by stage, so a stage does not walk the whole tree.
const operatorsByStage = new WeakMap<PlanNode, Map<number, IndexedOperator[]>>();

function indexOperators(plan: PlanNode): Map<number, IndexedOperator[]> {
  const cached = operatorsByStage.get(plan);
  if (cached) return cached;
  const index = new Map<number, IndexedOperator[]>();
  // Each node's nearest ancestor-or-self that is not a codegen wrapper.
  const unwrapped = new Map<PlanNode, PlanNode | null>();
  walkPlanTree(plan, (node, parent) => {
    const consumer = parent ? unwrapped.get(parent) ?? null : null;
    unwrapped.set(node, CODEGEN_WRAPPER.test(node.name) ? consumer : node);
    if (!SPILLING_OPERATOR.test(node.name)) return;
    const feeds = node.name === 'Sort' && consumer && SORT_MERGE_JOIN.test(consumer.name) ? 'SortMergeJoin' : undefined;
    for (const stageId of node.stageIds ?? []) {
      const entry = { node, ...(feeds ? { feeds } : {}) };
      index.set(stageId, [...(index.get(stageId) ?? []), entry]);
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
  const spilled = (plan ? indexOperators(plan).get(stageId) ?? [] : [])
    .map(({ node, feeds }) => ({ node, feeds, spillBytes: metricValue(node, 'spill size') ?? 0 }))
    .filter((entry) => entry.spillBytes > 0)
    .sort((a, b) => b.spillBytes - a.spillBytes)
    .slice(0, MAX_OPERATORS);
  const operators = spilled.map(({ node, feeds, spillBytes }): SpillOperator => ({
    nodeId: node.id!, name: node.name, spillBytes, ...(feeds ? { feeds } : {}),
  }));
  const exchanges = [...new Set(spilled.map(({ node }) => inputExchange(node)))]
    .flatMap((exchange) => (exchange ? exchangeWidth(exchange) ?? [] : []));
  return { operators, exchanges };
}

/** Memory spill over the stage's input plus shuffle read, to one decimal. Null when that input is
 * under `minInputBytes`: over a stage that reads next to nothing, a ratio only looks large. */
export function spillToInputRatio(
  memoryBytesSpilled: number, inputBytes: number, shuffleReadBytes: number, minInputBytes: number,
): number | null {
  const read = inputBytes + shuffleReadBytes;
  return read > 0 && read >= minInputBytes ? Math.round((memoryBytesSpilled / read) * 10) / 10 : null;
}

function operatorLabel({ name, nodeId, feeds, spillBytes }: SpillOperator): string {
  return `${name} ${nodeId}${feeds ? ` feeding ${feeds}` : ''} ${formatBytes(spillBytes)}`;
}

/** Where the spill sits: the operators with their plan node ids, then the spill-to-input ratio, with
 * the rows called wide when `wide`. Free of ": ", so the recommendation it ends still splits at its
 * advice (recommendationParts). */
export function describeSpillCause(operators: SpillOperator[], ratio: number | null, wide: boolean): string {
  const sentences: string[] = [];
  if (operators.length > 0) sentences.push(`Spilled by ${operators.map(operatorLabel).join(', ')}.`);
  if (ratio !== null) sentences.push(`Memory spill is ${ratio}x the stage's input${wide ? ', so the rows are wide' : ''}.`);
  return sentences.join(' ');
}

/** `Exchange e1:n4: 128 columns, ~410 B/row`. */
export function describeExchange({ nodeId, columns, bytesPerRow }: SpillExchange): string {
  const figures = [columns != null && `${columns} columns`, bytesPerRow != null && `~${bytesPerRow} B/row`];
  return `Exchange ${nodeId}: ${figures.filter(Boolean).join(', ')}`;
}

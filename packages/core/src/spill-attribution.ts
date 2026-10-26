// Which operators of a spilling stage hold the spilled rows, and how wide those rows are. An
// exchange's column count is the one its plan description gives (`inputColumns`), else the nearest
// node below it that lists its columns. A shape this cannot read yields no figure.

import { describeSpillRatio, formatBytes } from './format-utils.ts';
import { isExchangeNode } from './plan-node-detail.ts';
import { walkPlanTree } from './plan-tree-walk.ts';
import type { ExchangeWidth, SpillExchange, SpillOperator } from './finding-types.ts';
import type { PlanNode } from './types.ts';

const MAX_OPERATORS = 5;
const MAX_ARGUMENTS_CHARS = 300;
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

// What a node's plan text says after its name, cut to MAX_ARGUMENTS_CHARS.
function operatorArguments(node: PlanNode): string | undefined {
  const text = (node.detail ?? '').slice(node.name.length).trim();
  if (!text) return undefined;
  return text.length > MAX_ARGUMENTS_CHARS ? `${text.slice(0, MAX_ARGUMENTS_CHARS)}...` : text;
}

// `Exchange hashpartitioning(k#1, 200), REPARTITION_BY_NUM, [plan_id=5]`: the partitioning, its
// partition count and the shuffle origin. A ReusedExchange prints the exchange it reuses the same way.
function exchangeArguments(exchange: PlanNode): Pick<SpillExchange, 'partitioning' | 'partitions' | 'origin'> {
  const match = /\bExchange\s+(\w+\(.*\)|SinglePartition)(?:,\s*([A-Z_]+))?(?:,\s*\[plan_id=\d+\])?\s*$/.exec(exchange.detail ?? '');
  if (!match) return {};
  const [, partitioning, origin] = match;
  const partitions = /(\d+)\)$/.exec(partitioning)?.[1];
  return { partitioning, ...(partitions ? { partitions: Number(partitions) } : {}), ...(origin ? { origin } : {}) };
}

/** The width of an exchange (the read half of a split Exchange, or a ReusedExchange); null when
 * neither its columns nor its bytes per row are known. The write half holds the metrics and the plan below. */
export function exchangeWidth(exchange: PlanNode): ExchangeWidth | null {
  const write = exchange.exchangeRole === 'read' ? exchange.children[0] : exchange;
  const columns = write.inputColumns ?? outputColumns(write);
  const dataSize = metricValue(write, 'data size');
  const records = metricValue(write, 'shuffle records written');
  const bytesPerRow = dataSize !== null && records ? Math.round(dataSize / records) : null;
  if (columns === null && bytesPerRow === null) return null;
  return {
    ...(columns !== null ? { columns } : {}),
    ...(bytesPerRow !== null ? { bytesPerRow } : {}),
  };
}

/** The operators of stage `stageId` that report a "spill size" above zero, largest first, with the
 * exchanges they read. Empty when the plan ties no such operator to the stage. */
export function attributeSpill(
  plan: PlanNode | null | undefined, stageId: number,
): { operators: SpillOperator[]; exchanges: SpillExchange[] } {
  const candidates: { node: PlanNode; feeds?: string; spillBytes: number }[] = [];
  // Each node's nearest ancestor-or-self that is not a codegen wrapper.
  const unwrapped = new Map<PlanNode, PlanNode | null>();
  if (plan) walkPlanTree(plan, (node, parent) => {
    const consumer = parent ? unwrapped.get(parent) ?? null : null;
    unwrapped.set(node, CODEGEN_WRAPPER.test(node.name) ? consumer : node);
    if (!SPILLING_OPERATOR.test(node.name) || !node.stageIds?.includes(stageId)) return;
    const spillBytes = metricValue(node, 'spill size') ?? 0;
    if (spillBytes <= 0) return;
    const feeds = node.name === 'Sort' && consumer && SORT_MERGE_JOIN.test(consumer.name) ? 'SortMergeJoin' : undefined;
    candidates.push({ node, feeds, spillBytes });
  });
  const spilled = candidates
    .sort((a, b) => b.spillBytes - a.spillBytes)
    .slice(0, MAX_OPERATORS);
  const operators = spilled.map(({ node, feeds, spillBytes }): SpillOperator => {
    const args = operatorArguments(node);
    const sortGlobal = node.name === 'Sort' ? /\],\s*(true|false),\s*\d+$/.exec(node.detail ?? '')?.[1] : undefined;
    return {
      nodeId: node.id!, name: node.name, spillBytes, ...(feeds ? { feeds } : {}),
      ...(args ? { arguments: args } : {}), ...(sortGlobal ? { global: sortGlobal === 'true' } : {}),
    };
  });
  const exchanges = [...new Set(spilled.map(({ node }) => inputExchange(node)))].flatMap((exchange) => {
    const known = exchange && { ...exchangeWidth(exchange), ...exchangeArguments(exchange) };
    return known && Object.keys(known).length > 0 ? { nodeId: exchange.id!, ...known } : [];
  });
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

/** Where the spill sits: the operators with their plan node ids, then the spill-to-input ratio. Free
 * of ": ", so the recommendation it ends still splits at its advice (recommendationParts). */
export function describeSpillCause(
  operators: SpillOperator[], ratio: number | null, wide: boolean, fromScan: boolean, exchange?: SpillExchange,
): string {
  const sentences: string[] = [];
  if (operators.length > 0) sentences.push(`Spilled by ${operators.map(operatorLabel).join(', ')}.`);
  if (ratio !== null) sentences.push(describeSpillRatio(ratio, wide, fromScan, exchange?.columns));
  if (exchange?.origin === 'REPARTITION_BY_NUM') {
    sentences.push(`Its input is the job's own repartition(${exchange.partitions ?? 'n'}), so spark.sql.shuffle.partitions does not change it.`);
  }
  return sentences.join(' ');
}

// Write targets: every SQL write command in a run's plans, with the path or table it writes to.
// Read by automation that halts a session when a target leaves its sandbox, so every rule here
// fails toward "target unknown" (null), never toward a guessed or partial target:
//   - a write node whose target cannot be parsed is still reported, with target null and its raw
//     simpleString;
//   - a target Spark cut short (no delimiter after it, or a "..." marker in it) is unparseable;
//   - a write-like node outside the known list is reported as an unrecognized write;
//   - an execution whose plan is not in the model (or whose start event could not be read) is
//     listed, never skipped, and the count of unreadable log lines is reported.
// Targets are verbatim from the simpleString: nothing is resolved (relative paths, ${var}
// placeholders, catalog-relative table names all pass through as the log states them).
import { walkPlanTree } from './plan-tree-walk.ts';
import type { PlanNode, SqlExecution } from './types.ts';

export interface WriteTarget {
  sqlExecutionId: number;
  /** PlanNode.id of the write node, null only for a hand-built plan without ids. */
  nodeId: string | null;
  /** Node name without the "Execute " prefix, e.g. InsertIntoHadoopFsRelationCommand. */
  command: string;
  /** False for a write-like node that is not in the known list. */
  recognized: boolean;
  /**
   * path: a filesystem location. table: a table name whose catalog is stated or implied by the
   * command (Hive and V1 commands, a V2 name with a catalog part). unqualifiedTable: a V2 table
   * name with no catalog part, so the catalog it lives in is not stated. jdbcTable: a table in an
   * external JDBC database, whose name says nothing about a Spark catalog or database.
   */
  kind: 'path' | 'table' | 'unqualifiedTable' | 'jdbcTable' | null;
  target: string | null;
  /** The node's "number of output rows" SQL metric, null when the log has none for it. */
  outputRows: number | null;
  /** The node's simpleString (its name when the log has no simpleString). */
  raw: string;
}

export interface ExecutionWithoutPlan {
  sqlExecutionId: number;
  /** noPlan: started but no plan was read (still running or cut off). unreadableStart: the start event failed to parse or validate. */
  reason: 'noPlan' | 'unreadableStart';
}

export interface WriteTargetsReport {
  writes: WriteTarget[];
  /** SQL executions whose plan is not in the model: a write made there would be invisible. */
  executionsWithoutPlan: ExecutionWithoutPlan[];
  /** Lines of the log that could not be read. Any of them may have held a write; null when the count is unknown. */
  skippedLines: number | null;
}

type Parsed = { kind: NonNullable<WriteTarget['kind']>; target: string };

// Write-like detection: a known command, any CamelCase word of the node name in this set, or a
// TableAsSelect name.
const WRITE_WORDS = new Set([
  'Write', 'Insert', 'Save', 'Overwrite', 'Append', 'Merge', 'Update', 'Delete', 'Truncate', 'Replace', 'Drop',
  'Load', 'Vacuum', 'Convert', 'Clone', 'Restore', 'Optimize', 'Alter', 'Reorg', 'Rename', 'Call',
]);
// Names that contain no write word of their own: ADD/DROP/RENAME PARTITION (which can name a LOCATION).
const WRITE_SUBSTRINGS = ['TableAsSelect', 'AddPartition', 'DropPartition', 'RenamePartition', 'RecoverPartitions'];
// Plan nodes whose name matches a write word but which write no user data: WriteFiles is the child
// of a write command (the command is the write), the rest are query or streaming-state operators.
// Any join (SortMergeJoin) is excluded by name in isWriteLike.
const NOT_WRITES = new Set([
  'WriteFiles', 'AppendColumns', 'AppendColumnsWithObject', 'MergeRows', 'StateStoreSave',
  'StateStoreRestore', 'SessionWindowStateStoreSave', 'SessionWindowStateStoreRestore',
  'UpdateEventTimeWatermarkColumn',
]);

const IDENT_PART = String.raw`(?:\`(?:[^\`]|\`\`)*\`|[A-Za-z0-9_$]+)`;
const IDENTIFIER = new RegExp(`^${IDENT_PART}(?:\\.${IDENT_PART})*$`);
const IDENT_PARTS = new RegExp(IDENT_PART, 'g');
const TRUNCATION_MARKER = /\.\.\.(?:\s*\d+ more fields)?/;

function commandOf(nodeName: string): string {
  return nodeName.replace(/^Execute\s+/, '').trim().replace(/Exec$/, '');
}

function isWriteLike(command: string): boolean {
  if (isKnownWrite(command)) return true;
  if (NOT_WRITES.has(command) || command.includes('Join')) return false;
  if (WRITE_SUBSTRINGS.some((part) => command.includes(part))) return true;
  return (command.match(/[A-Z][a-z0-9]*/g) ?? []).some((word) => WRITE_WORDS.has(word));
}

interface Arg { text: string; terminated: boolean }

// Splits at top-level commas, ignoring commas inside (), [], {} and backticks. `terminated` is
// true when a comma follows the arg: the last arg of a cut-off string is never terminated.
function splitArgs(args: string): Arg[] {
  const out: Arg[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '`') quoted = !quoted;
    else if (quoted) continue;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push({ text: args.slice(start, i).trim(), terminated: true });
      start = i + 1;
    }
  }
  out.push({ text: args.slice(start).trim(), terminated: false });
  return out;
}

// Text after the command name in the simpleString. Empty when the simpleString does not start
// with the command (so nothing after it can be trusted).
function argsOf(detail: string, command: string): string {
  const m = /^(?:Execute\s+)?(\S+)\s*([\s\S]*)$/.exec(detail.trim());
  if (!m || commandOf(m[1]) !== command) return '';
  return m[2];
}

function isCut(text: string): boolean {
  return text === '' || TRUNCATION_MARKER.test(text);
}

// `db`.`t` or db.t -> db.t. A part that itself contains a dot or backtick keeps its quoting.
function tableName(ident: string): string | null {
  if (!IDENTIFIER.test(ident)) return null;
  const parts = (ident.match(IDENT_PARTS) ?? []).map((p) => {
    if (!p.startsWith('`')) return p;
    const inner = p.slice(1, -1).replace(/``/g, '`');
    return /[.`]/.test(inner) ? p : inner;
  });
  return parts.join('.');
}

// First arg of a path-writing command. The next arg must be the boolean that follows it in
// InsertIntoHadoopFsRelationCommand, or the static-partition map (INSERT OVERWRITE ... PARTITION
// (dt='x')) that precedes that boolean, which Spark prints as `[dt=x]` (or `Map(dt -> x)`); this also rejects a path Spark printed with ", " inside.
function parseHadoopFsPath(args: Arg[]): Parsed | null {
  const [path, second, third] = args;
  const flag = second && /^(Map\(.*\)|\[.*\])$/s.test(second.text) && second.terminated ? third : second;
  if (!path?.terminated || isCut(path.text) || !flag || !/^(true|false)$/.test(flag.text)) return null;
  return { kind: 'path', target: path.text };
}

// A quoted or plain identifier, or the `[Database: d, TableName: t, ...]` form Hive commands print.
function parseTableArg(args: Arg[]): Parsed | null {
  const first = args[0];
  if (!first) return null;
  const hive = /^\[Database: ([^,\]]+), TableName: ([^,\]]+)[,\]]/.exec(first.text);
  if (hive && /\]$/.test(first.text)) {
    const name = tableName(`${hive[1].trim()}.${hive[2].trim()}`);
    return name && !isCut(name) ? { kind: 'table', target: name } : null;
  }
  if (!first.terminated || isCut(first.text)) return null;
  const name = tableName(first.text);
  return name ? { kind: 'table', target: name } : null;
}

// Options of `Map(k -> v, k2 -> v2)`, or null when the Map is missing or not closed.
function parseOptionMap(text: string): Map<string, string> | null {
  const m = /^Map\(([\s\S]*)\)$/.exec(text);
  if (!m) return null;
  const body = m[1];
  const keys = [...body.matchAll(/(?:^|, )([A-Za-z0-9_.\-]+) -> /g)];
  const options = new Map<string, string>();
  keys.forEach((key, i) => {
    const valueStart = key.index! + key[0].length;
    const valueEnd = i + 1 < keys.length ? keys[i + 1].index! : body.length;
    options.set(key[1].toLowerCase(), body.slice(valueStart, valueEnd));
  });
  return options;
}

// SaveIntoDataSourceCommand: `<provider>, Map(options), <mode>`. The target is the `path` option or
// the JDBC `dbtable`/`table` option; a redacted or missing value, or both options, is unparseable.
function parseSaveIntoDataSource(args: Arg[]): Parsed | null {
  const [, options, mode] = args;
  if (!options?.terminated || !mode || mode.text === '') return null;
  const map = parseOptionMap(options.text);
  if (!map) return null;
  const path = map.get('path');
  const table = map.get('dbtable') ?? map.get('table');
  if ((path === undefined) === (table === undefined)) return null;
  const value = (path ?? table)!;
  if (isCut(value) || /\*{5,}\(redacted\)/.test(value)) return null;
  return path !== undefined ? { kind: 'path', target: value } : { kind: 'jdbcTable', target: value };
}

// The one target every match of `pattern` names, or null when there is none, when they name
// different targets, or when one of them is cut: a string that also prints another plan (a
// subquery) cannot tell which match is written. `pattern` captures the target, then its closing
// delimiter; a match without the delimiter was cut before it.
function soleMatch(detail: string, pattern: RegExp, normalize: (text: string) => string | null): string | null {
  const targets = new Set<string | null>();
  for (const m of detail.matchAll(pattern)) targets.add(m[2] === undefined || isCut(m[1]) ? null : normalize(m[1]));
  const [target] = targets;
  return targets.size === 1 ? target : null;
}

// A V2 name states its catalog only as a leading part (catalog.namespace.table). With two parts or
// fewer the catalog is implicit, so a database check on the name alone could match another catalog.
function v2Table(name: string | null): Parsed | null {
  if (!name) return null;
  const parts = name.match(IDENT_PARTS)?.length ?? 0;
  return { kind: parts >= 3 ? 'table' : 'unqualifiedTable', target: name };
}

// DataSource V2 writes print the connector's Write object; Iceberg's is IcebergWrite(table=t, ...).
function parseV2Write(detail: string): Parsed | null {
  return v2Table(soleMatch(detail, /\b\w*Write\(table=([^,()\s]*)([,)])?/g, tableName));
}

// V2 CTAS/RTAS: `<catalog>@<hash>, <identifier>, <query plan>, ...`. The catalog shape is checked
// so a plan printed in a different layout is not misread.
function parseV2TableAsSelect(args: Arg[]): Parsed | null {
  const [catalog, ident] = args;
  if (!catalog?.terminated || !/^[\w.$]+@[0-9a-f]+$/.test(catalog.text)) return null;
  if (!ident?.terminated || isCut(ident.text)) return null;
  return v2Table(tableName(ident.text));
}

// Delta prints a path-based table as delta.`<path>`. Only the command's own first argument is the
// written table: later arguments print other plans (a source relation, a condition's subquery).
function parseDeltaPath(args: Arg[]): Parsed | null {
  const [first] = args;
  const m = first?.terminated ? /^delta\.`([^`]*)`$/.exec(first.text) : null;
  return m && !isCut(m[1]) ? { kind: 'path', target: m[1] } : null;
}

const V2_WRITES = new Set([
  'AppendData', 'OverwriteByExpression', 'OverwritePartitionsDynamic', 'ReplaceData', 'WriteDelta',
  'WriteToDataSourceV2',
]);
const V2_TABLE_AS_SELECT = new Set([
  'CreateTableAsSelect', 'AtomicCreateTableAsSelect', 'ReplaceTableAsSelect', 'AtomicReplaceTableAsSelect',
]);
const DELTA_COMMANDS = new Set([
  'WriteIntoDelta', 'WriteIntoDeltaCommand', 'MergeIntoCommand', 'UpdateCommand', 'DeleteCommand',
  'CreateDeltaTableCommand', 'OptimizeTableCommand', 'RestoreTableCommand', 'DeltaReorgTableCommand',
]);

const ARG_PARSERS: Record<string, (args: Arg[]) => Parsed | null> = {
  InsertIntoHadoopFsRelationCommand: parseHadoopFsPath,
  InsertIntoHiveTable: parseTableArg,
  CreateHiveTableAsSelectCommand: parseTableArg,
  OptimizedCreateHiveTableAsSelectCommand: parseTableArg,
  CreateDataSourceTableAsSelectCommand: parseTableArg,
  SaveIntoDataSourceCommand: parseSaveIntoDataSource,
};

function isKnownWrite(command: string): boolean {
  return command in ARG_PARSERS || V2_WRITES.has(command) || V2_TABLE_AS_SELECT.has(command) || DELTA_COMMANDS.has(command);
}

// [recognized, parsed target or null] for one write-like node.
function parseWrite(command: string, detail: string): [boolean, Parsed | null] {
  const argParser = ARG_PARSERS[command];
  if (argParser) return [true, argParser(splitArgs(argsOf(detail, command)))];
  if (V2_WRITES.has(command)) return [true, parseV2Write(detail)];
  if (V2_TABLE_AS_SELECT.has(command)) return [true, parseV2TableAsSelect(splitArgs(argsOf(detail, command)))];
  // A MERGE prints its source relation too, so a delta. path in it may be the source, not the target.
  if (command === 'MergeIntoCommand') return [true, null];
  if (DELTA_COMMANDS.has(command)) return [true, parseDeltaPath(splitArgs(argsOf(detail, command)))];
  return [false, null];
}

function outputRowsOf(node: PlanNode): number | null {
  const metric = node.metrics?.find((m) => m.name === 'number of output rows');
  return metric !== undefined && Number.isFinite(metric.value) ? metric.value : null;
}

function collectWrites(executionId: number, root: PlanNode, out: WriteTarget[]): void {
  walkPlanTree(root, (node) => {
    const command = commandOf(node.name);
    if (!isWriteLike(command)) return;
    const detail = node.detail ?? '';
    const [recognized, parsed] = parseWrite(command, detail);
    out.push({
      sqlExecutionId: executionId,
      nodeId: node.id ?? null,
      command,
      recognized,
      kind: parsed?.kind ?? null,
      target: parsed?.target ?? null,
      outputRows: outputRowsOf(node),
      raw: detail !== '' ? detail : node.name,
    });
  }, { dedupe: true });
}

export interface WriteTargetsInput {
  /** Start events the parser could not read: their executions are not in `sql`. */
  unreadableSqlExecutions?: number[];
  skippedLines?: number;
}

export function extractWriteTargets(sql: Map<number, SqlExecution>, input: WriteTargetsInput = {}): WriteTargetsReport {
  const writes: WriteTarget[] = [];
  const withoutPlan = new Map<number, ExecutionWithoutPlan['reason']>();
  for (const id of input.unreadableSqlExecutions ?? []) if (!sql.get(id)?.planTree) withoutPlan.set(id, 'unreadableStart');
  for (const id of [...sql.keys()].sort((a, b) => a - b)) {
    const planTree = sql.get(id)!.planTree;
    if (!planTree) withoutPlan.set(id, withoutPlan.get(id) ?? 'noPlan');
    else collectWrites(id, planTree, writes);
  }
  const executionsWithoutPlan = [...withoutPlan].sort((a, b) => a[0] - b[0])
    .map(([sqlExecutionId, reason]) => ({ sqlExecutionId, reason }));
  return { writes, executionsWithoutPlan, skippedLines: input.skippedLines ?? null };
}

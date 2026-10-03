// Delta write targets that the plan node's simpleString does not carry. A Delta command node is a
// bare name in sparkPlanInfo on real logs; its target is read from the `Arguments:` line the parser
// keeps (SqlExecution.commandArguments, one reader per command in COMMANDS), and for a command that
// always scans its target (MERGE, UPDATE, DELETE) from the single `_delta_log` path of the executions
// sharing its root. A write command may read another Delta table as its source, so it never takes
// that step. Otherwise the target is null: a rule that cannot name exactly one target names none.
import { isDeltaCommand, type DeltaCommand } from './delta-commands.ts';
import { soleLogPath } from './delta-log-paths.ts';
import { isCut, splitArgs, tableName, type FoundTarget } from './write-target-args.ts';
import type { PlanNode, SqlExecution } from './types.ts';
import type { WriteTarget } from './write-targets.ts';

type CommandExecution = Pick<SqlExecution, 'id' | 'rootExecutionId' | 'commandArguments' | 'planTree'>;

export type ExecutionsByRoot = ReadonlyMap<number, CommandExecution[]>;

/** Executions grouped by rootExecutionId, each group excluding the root itself. */
export function indexByRoot(sql: Map<number, CommandExecution>): ExecutionsByRoot {
  const byRoot = new Map<number, CommandExecution[]>();
  for (const exec of sql.values()) {
    if (exec.rootExecutionId === undefined || exec.rootExecutionId === exec.id) continue;
    const list = byRoot.get(exec.rootExecutionId);
    if (list) list.push(exec);
    else byRoot.set(exec.rootExecutionId, [exec]);
  }
  return byRoot;
}

// The text after `<Command>\nArguments: `, or null when the execution kept none for this command.
function argumentsOf(exec: CommandExecution, command: string): string | null {
  const kept = exec.commandArguments;
  const head = `${command}\nArguments: `;
  return kept !== undefined && kept.startsWith(head) ? kept.slice(head.length) : null;
}

// A catalog table is printed as its quoted identifier, `catalog`.`db`.`t`, as one top-level
// argument. Two or more such arguments (or none) leave the table unnamed. The session catalog is
// implied by a Hive or V1 table name, so it is dropped: `spark_catalog`.`db`.`t` is db.t.
const QUOTED_TABLE = /^`[^`]+`(?:\.`[^`]+`){1,2}$/;

function tableFromArguments(args: string): FoundTarget | null {
  const candidates = splitArgs(args).filter((arg) => QUOTED_TABLE.test(arg.text));
  if (candidates.length !== 1 || !candidates[0].terminated) return null;
  const name = tableName(candidates[0].text);
  if (!name || isCut(name)) return null;
  const parts = name.split('.');
  return { kind: 'table', target: parts.length === 3 && parts[0] === 'spark_catalog' ? parts.slice(1).join('.') : name };
}

// SaveIntoDataSourceCommand prints `<provider>@<hash>, [k=v, k2=v2], <mode>`. The target is the
// one `path` option of a Delta provider.
function pathFromSaveOptions(args: string): FoundTarget | null {
  const options = splitArgs(args)[1];
  if (!options?.terminated || !/^\[[\s\S]*\]$/.test(options.text)) return null;
  const body = options.text.slice(1, -1);
  const keys = [...body.matchAll(/(?:^|, )([A-Za-z0-9_.-]+)=/g)];
  const paths = keys.flatMap((key, i) => {
    if (key[1].toLowerCase() !== 'path') return [];
    return [body.slice(key.index! + key[0].length, i + 1 < keys.length ? keys[i + 1].index! : body.length)];
  });
  if (paths.length !== 1 || isCut(paths[0]) || /\*{5,}\(redacted\)/.test(paths[0])) return null;
  return { kind: 'path', target: paths[0] };
}

interface CommandHandler {
  /** Reads the target from the text after `<Command>\nArguments: `. */
  fromArguments(args: string): FoundTarget | null;
  /** The command always scans its target, so the one Delta log in its root's children is it. */
  scansTarget: boolean;
}

const tableCommand: CommandHandler = { fromArguments: tableFromArguments, scansTarget: false };
const scanningTableCommand: CommandHandler = { ...tableCommand, scansTarget: true };

// One entry per Delta command: a new command is added here (and to DELTA_COMMANDS), not in the resolver.
const COMMANDS: Record<DeltaCommand, CommandHandler> = {
  MergeIntoCommand: scanningTableCommand,
  UpdateCommand: scanningTableCommand,
  DeleteCommand: scanningTableCommand,
  WriteIntoDelta: tableCommand,
  WriteIntoDeltaCommand: tableCommand,
  // Only the arguments say a save is a Delta one; a JDBC save with a Delta table in its source
  // would otherwise take that table as its target.
  SaveIntoDataSourceCommand: {
    fromArguments: (args) => (args.includes('DeltaDataSource') ? pathFromSaveOptions(args) : null),
    scansTarget: false,
  },
};

/** Target of a Delta command whose simpleString names none; `node` must be the root of `exec`'s plan. */
export function resolveDeltaCommandTarget(
  command: string, exec: CommandExecution, node: PlanNode, byRoot: ExecutionsByRoot,
): FoundTarget | null {
  if (!isDeltaCommand(command) || node !== exec.planTree) return null;
  const handler = COMMANDS[command];
  const args = argumentsOf(exec, command);
  const found = args === null ? null : handler.fromArguments(args);
  if (found || !handler.scansTarget) return found;
  // Child executions are the root's own only when it is the root: a command run under another
  // execution shares that execution's children, which may belong to unrelated work.
  return exec.rootExecutionId === exec.id ? soleLogPath(byRoot.get(exec.id) ?? []) : null;
}

// An append or overwrite of an existing Delta table (saveAsTable, INSERT INTO or OVERWRITE) is an
// `AppendDataExecV1` or `OverwriteByExpressionExecV1` whose first argument is the table object:
// `DeltaTableV2(<session>,<path>,Some(CatalogTable(\nCatalog: c\nDatabase: d\nTable: t\n...)),...)`.
// Its CatalogTable block names the table; a path-based table has `None` there and only the path.
const DELTA_TABLE_V2 = /^\w+ DeltaTableV2\([^,\s]*,([^,\n]*),(?:Some\(CatalogTable\(\n(?:Catalog: (\S+)\n)?Database: (\S+)\nTable: (\S+)\n|None,)/;
const SIMPLE_NAME = /^[A-Za-z0-9_$]+$/;

/** Target of a V1-fallback write on a DeltaTableV2 table, or null when the detail has another shape. */
export function parseDeltaTableV2(detail: string): FoundTarget | null {
  const m = DELTA_TABLE_V2.exec(detail);
  if (!m) return null;
  const [, path, catalog, database, table] = m;
  if (table === undefined) return path && !isCut(path) ? { kind: 'path', target: path } : null;
  if (![database, table, catalog ?? 'spark_catalog'].every((part) => SIMPLE_NAME.test(part))) return null;
  // The session catalog is implied by a V1 name, so it is dropped (as for a Delta command).
  const name = `${database}.${table}`;
  return { kind: 'table', target: catalog === undefined || catalog === 'spark_catalog' ? name : `${catalog}.${name}` };
}

/** The append a Delta CTAS or RTAS runs under its own root: its staged table has no name. */
export function isStagedDeltaWrite(write: Pick<WriteTarget, 'command' | 'raw'>): boolean {
  return (write.command === 'AppendDataExecV1' || write.command === 'OverwriteByExpressionExecV1')
    && /^\w+ \S*DeltaCatalog\$StagedDeltaTableV2@/.test(write.raw);
}

// Delta write targets that the plan node's simpleString does not carry. A Delta command node
// (MERGE, UPDATE, DELETE, WriteIntoDelta, SaveIntoDataSourceCommand) is a bare name in
// sparkPlanInfo on real logs; the target lives in two other places:
//   1. the `Arguments:` line of the command in the physical plan description, which the parser
//      keeps for these commands only (SqlExecution.commandArguments). It names the table.
//   2. the `_delta_log` path in the plans of executions that share the command's root execution.
// resolveDeltaCommandTarget tries them in that order and otherwise reports null: a rule that
// cannot name exactly one target never names one (see the header of write-targets.ts).
//
// A DeltaTable.merge(...).execute() call runs no command node at all: each of its internal
// queries is its own root execution, tied together only by a "MERGE operation" description and
// adjacent ids. apiMergeWrites reports one DeltaMerge write per run of such executions.
import { walkPlanTree } from './plan-tree-walk.ts';
import { isCut, splitArgs, tableName } from './write-target-args.ts';
import type { PlanNode, SqlExecution } from './types.ts';
import type { WriteTarget } from './write-targets.ts';

type Resolved = { kind: 'path' | 'table'; target: string };

/** Commands whose root node carries its target outside the simpleString. */
export const DELTA_COMMANDS_WITH_HIDDEN_TARGET: ReadonlySet<string> = new Set([
  'MergeIntoCommand', 'UpdateCommand', 'DeleteCommand', 'WriteIntoDelta', 'WriteIntoDeltaCommand',
  'SaveIntoDataSourceCommand',
]);

export type ExecutionsByRoot = ReadonlyMap<number, SqlExecution[]>;

/** Executions grouped by rootExecutionId, each group excluding the root itself. */
export function indexByRoot(sql: Map<number, SqlExecution>): ExecutionsByRoot {
  const byRoot = new Map<number, SqlExecution[]>();
  for (const exec of sql.values()) {
    if (exec.rootExecutionId === undefined || exec.rootExecutionId === exec.id) continue;
    const list = byRoot.get(exec.rootExecutionId);
    if (list) list.push(exec);
    else byRoot.set(exec.rootExecutionId, [exec]);
  }
  return byRoot;
}

// ---- _delta_log paths ------------------------------------------------------------------------

// A table path printed before `/_delta_log`: a URI or an absolute path with no spaces or list
// punctuation. Delta prints it in scans as `... State #0 - <path>/_delta_log[cols]` and in
// DeltaLogFileIndex as `[<path>/_delta_log/<file>, ...]`.
const DELTA_LOG_PATH = /((?:[A-Za-z][A-Za-z0-9+.-]*:\/{1,3}|\/)[^\s,[\]()#]+?)\/_delta_log(?=[/[\],\s)]|$)/g;

interface LogPaths { paths: Set<string>; unreliable: boolean }

// Every distinct `<table path>/_delta_log` named in the plans. `unreliable` is set when a plan is
// missing or a printed path is cut short, so the set may be missing a table.
function deltaLogPaths(executions: SqlExecution[]): LogPaths {
  const paths = new Set<string>();
  let unreliable = false;
  for (const exec of executions) {
    if (!exec.planTree) { unreliable = true; continue; }
    walkPlanTree(exec.planTree, (node) => {
      for (const text of [node.name, node.detail ?? '']) {
        const mentions = text.split('/_delta_log').length - 1;
        if (mentions === 0) continue;
        const matches = [...text.matchAll(DELTA_LOG_PATH)];
        // A `/_delta_log` that is not read as a path is a table this set cannot name.
        if (matches.length < mentions) unreliable = true;
        for (const m of matches) {
          if (isCut(m[1])) unreliable = true;
          else paths.add(m[1].replace(/\/+$/, ''));
        }
      }
    }, { dedupe: true });
  }
  return { paths, unreliable };
}

function soleLogPath(executions: SqlExecution[]): Resolved | null {
  const { paths, unreliable } = deltaLogPaths(executions);
  const [path] = paths;
  return !unreliable && paths.size === 1 ? { kind: 'path', target: path } : null;
}

// ---- Arguments line ---------------------------------------------------------------------------

// The text after `<Command>\nArguments: ` for this command, or null when the execution kept
// none or kept another command's.
function argumentsOf(exec: SqlExecution, command: string): string | null {
  const kept = exec.commandArguments;
  const head = `${command}\nArguments: `;
  return kept !== undefined && kept.startsWith(head) ? kept.slice(head.length) : null;
}

// A catalog table is printed as its quoted identifier, `catalog`.`db`.`t`, as one top-level
// argument. Two or more such arguments (or none) leave the table unnamed. The session catalog is
// implied by a Hive or V1 table name, so it is dropped: `spark_catalog`.`db`.`t` is db.t.
const QUOTED_TABLE = /^`[^`]+`(?:\.`[^`]+`){1,2}$/;

function tableFromArguments(args: string): Resolved | null {
  const candidates = splitArgs(args).filter((arg) => QUOTED_TABLE.test(arg.text));
  if (candidates.length !== 1 || !candidates[0].terminated) return null;
  const name = tableName(candidates[0].text);
  if (!name || isCut(name)) return null;
  const parts = name.split('.');
  return { kind: 'table', target: parts.length === 3 && parts[0] === 'spark_catalog' ? parts.slice(1).join('.') : name };
}

// SaveIntoDataSourceCommand prints `<provider>@<hash>, [k=v, k2=v2], <mode>`. The target is the
// one `path` option of a Delta provider.
function pathFromSaveOptions(args: string): Resolved | null {
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

// ---- Command target ---------------------------------------------------------------------------

/**
 * The target of a Delta command whose simpleString names none: the table on its kept `Arguments:`
 * line, else the single `_delta_log` path of the executions that share its root, else null.
 * `node` must be the root node of `exec`'s plan: the kept line is the root command's.
 */
export function resolveDeltaCommandTarget(
  command: string, exec: SqlExecution, node: PlanNode, byRoot: ExecutionsByRoot,
): Resolved | null {
  if (!DELTA_COMMANDS_WITH_HIDDEN_TARGET.has(command) || node !== exec.planTree) return null;
  const args = argumentsOf(exec, command);
  if (command === 'SaveIntoDataSourceCommand') {
    // Only the arguments say this save is a Delta one; a JDBC save with a Delta table in its
    // source would otherwise take that table as its target.
    if (args === null || !args.includes('DeltaDataSource')) return null;
    const path = pathFromSaveOptions(args);
    if (path) return path;
  } else if (args !== null) {
    const table = tableFromArguments(args);
    if (table) return table;
  }
  // Child executions are the root's own only when it is the root: a command run under another
  // execution shares that execution's children, which may belong to unrelated work.
  if (exec.rootExecutionId !== exec.id) return null;
  return soleLogPath(byRoot.get(exec.id) ?? []);
}

// ---- DeltaTable API merges ---------------------------------------------------------------------

export const API_MERGE_COMMAND = 'DeltaMerge';

// Delta labels its MERGE sub-queries "MERGE operation - <phase>", prefixed "Delta: " in some.
const MERGE_DESCRIPTION = /^(?:Delta: )?MERGE operation\b/;

interface MergeGroup { members: SqlExecution[]; unclean: string | null }

// Selected executions have a MERGE description. A SQL MERGE's own sub-queries carry the same
// description but belong to the MergeIntoCommand execution they share a root with, which is
// attributed through its own node (resolveDeltaCommandTarget), so they are left out. A sub-query
// of an API merge may have another of its executions as its root, so a root alone does not exclude.
function selectMergeExecutions(sql: Map<number, SqlExecution>): SqlExecution[] {
  const isSqlMergeRoot = (id: number | undefined): boolean =>
    id !== undefined && /^Execute\s+MergeIntoCommand\b/.test(sql.get(id)?.planTree?.name ?? '');
  return [...sql.values()]
    .filter((exec) => MERGE_DESCRIPTION.test(exec.description ?? '') && !isSqlMergeRoot(exec.rootExecutionId))
    .sort((a, b) => a.id - b.id);
}

// A run of consecutive execution ids. Nothing in the log ties the members of one merge together,
// so adjacency is a guess, and a wrong one fuses or splits merges. Each way it can go wrong is
// marked `unclean` instead of attributed:
//   - the ids of two merges that ran concurrently interleave, so their start-time spans overlap;
//   - a start time is missing, so the span is unknown.
// Merges that ran back to back with no other execution between them still fuse into one run; the
// run then names two paths and gets no target.
function groupMerges(selected: SqlExecution[]): MergeGroup[] {
  const groups: MergeGroup[] = [];
  for (const exec of selected) {
    const last = groups[groups.length - 1];
    if (last && last.members[last.members.length - 1].id + 1 === exec.id) last.members.push(exec);
    else groups.push({ members: [exec], unclean: null });
  }
  const spans = groups.map(({ members }) => {
    const starts = members.map((m) => m.startTime);
    return starts.every((t): t is number => typeof t === 'number') ? [Math.min(...starts), Math.max(...starts)] : null;
  });
  groups.forEach((group, i) => {
    const mine = spans[i];
    if (mine === null) { group.unclean = 'start time missing'; return; }
    const overlaps = spans.some((other, j) => j !== i && other !== null && other[0] <= mine[1] && mine[0] <= other[1]);
    if (overlaps) group.unclean = 'overlaps another merge in time';
  });
  return groups;
}

/** One DeltaMerge write per run of API merge executions; null target unless one path is certain. */
export function apiMergeWrites(sql: Map<number, SqlExecution>): WriteTarget[] {
  return groupMerges(selectMergeExecutions(sql)).map((group) => {
    const first = group.members[0].id;
    const last = group.members[group.members.length - 1].id;
    const resolved = group.unclean === null ? soleLogPath(group.members) : null;
    const span = first === last ? `${first}` : `${first}-${last}`;
    return {
      sqlExecutionId: first,
      nodeId: null,
      command: API_MERGE_COMMAND,
      recognized: true,
      kind: resolved?.kind ?? null,
      target: resolved?.target ?? null,
      outputRows: null,
      raw: `Delta MERGE operation, executions ${span}${group.unclean ? ` (${group.unclean})` : ''}`,
    };
  });
}

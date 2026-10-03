// The `<table path>/_delta_log` paths that plans name: the only trace of which Delta table a command
// or API merge touched when its plan carries no target. A scan may read a source too, so callers
// take a path only when exactly one is named.
import { walkPlanTree } from './plan-tree-walk.ts';
import { isCut, type FoundTarget } from './write-target-args.ts';
import type { SqlExecution } from './types.ts';

// A URI or absolute path before `/_delta_log`, as printed in `... State #0 - <path>/_delta_log[cols]`
// scans and `DeltaLogFileIndex [<path>/_delta_log/<file>, ...]`.
const DELTA_LOG_PATH = /((?:[A-Za-z][A-Za-z0-9+.-]*:\/{1,3}|\/)[^\s,[\]()#]+?)\/_delta_log(?=[/[\],\s)]|$)/g;

interface LogPaths { paths: Set<string>; unreliable: boolean }

// Every distinct table path named in the plans; `unreliable` when a plan is missing or a path cut.
function deltaLogPaths(executions: Pick<SqlExecution, 'planTree'>[]): LogPaths {
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

/** The one table path the plans of `executions` name, or null for none, several or an unreadable plan. */
export function soleLogPath(executions: Pick<SqlExecution, 'planTree'>[]): FoundTarget | null {
  const { paths, unreliable } = deltaLogPaths(executions);
  const [path] = paths;
  return !unreliable && paths.size === 1 ? { kind: 'path', target: path } : null;
}

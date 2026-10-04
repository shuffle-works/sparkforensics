// DeltaTable API merges run no command node: each internal query is its own root execution, tied
// together only by a "MERGE operation" description and adjacent ids. One DeltaMerge write is
// reported per run of such executions, with a path only when no other merge can be mixed into it.
import { soleLogPath } from './delta-log-paths.ts';
import type { SqlExecution } from './types.ts';
import type { WriteTarget } from './write-targets.ts';

type MergeExecution = Pick<SqlExecution, 'id' | 'description' | 'startTime' | 'rootExecutionId' | 'planTree'>;

const API_MERGE_COMMAND = 'DeltaMerge';

// Delta labels its MERGE sub-queries "MERGE operation - <phase>", prefixed "Delta: " in some.
const MERGE_DESCRIPTION = /^(?:Delta: )?MERGE operation\b/;

// The sub-queries that write: "writing new files ...", "Rewriting N files". A group without one
// only scanned, and a scan may read the merge's source rather than its target.
const MERGE_WRITE_PHASE = /\b(?:re)?writing\b/i;

interface MergeGroup { members: MergeExecution[]; unclean: string | null }

// Selected executions have a MERGE description. A SQL MERGE's own sub-queries carry the same
// description but belong to the MergeIntoCommand execution they share a root with, which is
// attributed through its own node (resolveDeltaCommandTarget), so they are left out. A sub-query
// of an API merge may have another of its executions as its root, so a root alone does not exclude.
function selectMergeExecutions(sql: Map<number, MergeExecution>): MergeExecution[] {
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
//   - no member writes, so the one path it names may be a source's.
// Merges that ran back to back with no other execution between them still fuse into one run; the
// run then names two paths and gets no target.
function groupMerges(selected: MergeExecution[]): MergeGroup[] {
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
    else if (!group.members.some((m) => MERGE_WRITE_PHASE.test(m.description ?? ''))) group.unclean = 'no write phase';
  });
  return groups;
}

/** One DeltaMerge write per run of API merge executions; null target unless one path is certain. */
export function apiMergeWrites(sql: Map<number, MergeExecution>): WriteTarget[] {
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

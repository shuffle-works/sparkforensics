// Per-operator plan-node rendering helpers for the stage-detail modal's
// hierarchical plan tree. Pure string-parsing / tree-walking, no DOM.
// Plan-text parsing is best-effort: unparseable fragments are silently
// skipped, never thrown.

import { pathBasename, formatBytes, formatDuration } from './format-utils.ts';
import { attributeStageDurationToPlan, attributeStageDurationToPlanInclusive } from './plan-duration-attribution.ts';
import { stageIdsForSqlExec } from './detectors.ts';
import type { PlanNode, AppModel, SqlExecution, PlanGraphDurationMode } from './types.ts';

const BOILERPLATE_PREFIXES = ['serializefromobject', 'deserializetoobject', 'mapelements',
  'mappartitions', 'inputadapter', 'columnartorow', 'rowtocolumnar', 'union'];

export function classifyNode(
  name: string,
): 'scan' | 'exchange' | 'join' | 'aggregate' | 'sort' | 'filter' | 'aqe' | 'boilerplate' | 'transform' {
  const n = (name ?? '').toLowerCase();
  if (n.startsWith('scan')) return 'scan';
  if (n.includes('exchange')) return 'exchange';
  if (n.includes('join')) return 'join';
  if (n.includes('aggregate')) return 'aggregate';
  if (n.startsWith('sort')) return 'sort';
  if (n.startsWith('filter')) return 'filter';
  if (n === 'adaptivesparkplan') return 'aqe';
  if (BOILERPLATE_PREFIXES.some(b => n.startsWith(b)) || n.startsWith('wholestagecodegen')) return 'boilerplate';
  return 'transform';
}

export function isExchangeNode(node: Pick<PlanNode, 'name' | 'exchangeRole'>): boolean {
  return node.exchangeRole !== undefined || classifyNode(node.name) === 'exchange';
}

export function isBroadcastExchangeNode(name: string): boolean {
  return name === 'BroadcastExchange';
}

export function parseOperatorDetail(name: string, simpleString: string): string {
  if (!simpleString || simpleString === name) return '';
  const n = (name ?? '').toLowerCase();
  const stripAliases = (s: string) => s.replace(/#\d+/g, '');

  if (BOILERPLATE_PREFIXES.some(b => n.startsWith(b))) return '';
  if (n === 'adaptivesparkplan') return '';
  if (n.startsWith('wholestagecodegen')) {
    const m = name.match(/\((\d+)\)/);
    return m ? `codegen #${m[1]}` : '';
  }

  if (n.includes('exchange')) {
    const m = simpleString.match(/Exchange\s+(\w+partitioning)\(([^)]+)\)/i);
    if (m) {
      const type = m[1].toLowerCase().startsWith('hash') ? 'hash' : 'range';
      const args = stripAliases(m[2]).split(',').map(s => s.trim());
      const lastIsNum = /^\d+$/.test(args[args.length - 1]);
      const partCount = lastIsNum ? args.pop() : null;
      const keys = args.map(k =>
        k.replace(/\s+ASC(\s+NULLS\s+\w+)?$/i, '↑')
         .replace(/\s+DESC(\s+NULLS\s+\w+)?$/i, '↓').trim()
      ).slice(0, 3);
      return `${type}(${keys.join(', ')}${partCount ? `, ${partCount}` : ''})`;
    }
    const singleM = simpleString.match(/Exchange\s+(\w+)/);
    return singleM ? singleM[1] : '';
  }

  if (n.startsWith('sort') && !n.includes('merge')) {
    const m = simpleString.match(/Sort\s+\[([^\]]+)\]/);
    if (m) {
      return stripAliases(m[1]).split(',').map(s =>
        s.trim()
         .replace(/\s+ASC(\s+NULLS\s+\w+)?$/i, '↑')
         .replace(/\s+DESC(\s+NULLS\s+\w+)?$/i, '↓')
      ).slice(0, 4).join(', ');
    }
  }

  if (n.includes('join')) {
    const m = simpleString.match(/Join\s+\[([^\]]*)\][^,]*,\s*\[[^\]]*\][^,]*,\s*(\w+)/i);
    if (m) {
      const leftKey = stripAliases(m[1]).split(',')[0].trim();
      return leftKey ? `${leftKey}  ${m[2]}` : m[2];
    }
  }

  if (n.includes('aggregate')) {
    const funcM = simpleString.match(/functions=\[([^\]]+)\]/);
    if (funcM) {
      const funcs = [...new Set(
        funcM[1].split(',').map(f => (f.trim().match(/^(\w+)\(/)?.[1] ?? '').replace(/^partial_/, ''))
      )].filter(Boolean);
      return funcs.slice(0, 5).join(', ') + (funcs.length > 5 ? ` +${funcs.length - 5}` : '');
    }
  }

  if (n.startsWith('filter')) {
    const m = simpleString.match(/Filter\s+(.+)/s);
    if (m) {
      const expr = stripAliases(m[1]).trim().replace(/^\((.+)\)$/s, '$1');
      return expr.length > 70 ? expr.slice(0, 70) + '…' : expr;
    }
  }

  if (n.startsWith('project')) {
    const m = simpleString.match(/Project\s+\[([^\]]+)\]/);
    if (m) {
      const cols = stripAliases(m[1]).split(',').map(s => s.trim());
      if (cols.length <= 3) return cols.join(', ');
      return `${cols.length} columns`;
    }
    return '';
  }

  if (n.startsWith('scan')) {
    if (n.includes('existingrdd')) {
      const short = pathBasename(name);
      if (short !== name) return short;
    }
    const fmtM = name.match(/Scan\s+(\S+)/);
    return fmtM ? fmtM[1] : '';
  }

  // Some operators (e.g. InMemoryTableScan) have no dedicated branch above, so
  // their simpleString falls through here unparsed and repeats the operator
  // name verbatim as a prefix ("InMemoryTableScan [DATE#1, COUNTRY#2, ...]"),
  // which would otherwise duplicate the bold node name shown right next to it.
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = stripAliases(simpleString).replace(new RegExp(`^${escapedName}\\s*`, 'i'), '').trim();
  return stripped.length > 80 ? stripped.slice(0, 80) + '…' : stripped;
}

export function formatPlanMetricValue(metric: { value: number | string; metricType?: string }): string {
  const { value, metricType } = metric;
  if (typeof value === 'string') return value;
  if (metricType === 'size') return formatBytes(value);
  if (metricType === 'timing') return formatDuration(value);
  if (metricType === 'nsTiming') return formatDuration(value / 1_000_000);
  return value.toLocaleString('en-US');
}

export function getPrimaryMetric(
  metrics: Array<{ name: string; value: number | string; metricType?: string }> | undefined,
): string {
  if (!metrics || metrics.length === 0) return '';
  const priority = ['number of output rows', 'size of files read', 'spill size', 'duration'];
  const found = priority.map(n => metrics.find(m => m.name === n)).find(Boolean) ?? metrics[0];
  return formatPlanMetricValue(found);
}

// Approximate per-node wall-time via segment attribution (see
// attributeStageDurationToPlan). Returns null when there's nothing to attribute
// (no plan tree, or the SQL execution carries no stageIds list).
export function buildDurationMap(
  planTree: PlanNode | null,
  appModel: AppModel,
  sqlExec: SqlExecution,
  executionId: number,
  durationMode: PlanGraphDurationMode = 'exclusive',
): Map<PlanNode, number> | null {
  if (!planTree || !sqlExec) return null;
  const stageIds: number[] = stageIdsForSqlExec(executionId, appModel.stages);
  if (!stageIds.length) return null;
  const stagesById = new Map<number, { submittedAt?: number; completedAt?: number }>();
  for (const id of stageIds) {
    const s = appModel.stages.get(id);
    if (s) stagesById.set(id, { submittedAt: s.submittedAt, completedAt: s.completedAt });
  }
  // attributeStageDurationToPlan reads its 3rd arg's own `.stageIds` field;
  // override it with the derived array rather than the (always-empty on real
  // data) one already on `sqlExec`.
  return durationMode === 'inclusive'
    ? attributeStageDurationToPlanInclusive(planTree, stagesById, { ...sqlExec, stageIds })
    : attributeStageDurationToPlan(planTree, stagesById, { ...sqlExec, stageIds });
}

/** Every deprecated field or flag of the public CLI and MCP surfaces, with the package version
 * that removes it. The surfaces word their notices from this table, and a test fails when a
 * deprecated item is still present at or after its removal version. */
export interface Deprecation {
  surface: 'cli' | 'mcp';
  /** The tool or command and the part of it that carries the item, such as `compare_runs input`. */
  where: string;
  item: string;
  replacement: string;
  /** The first version of the surface's package that no longer has the item. */
  removeIn: string;
}

export const DEPRECATIONS: readonly Deprecation[] = [
  { surface: 'mcp', where: 'compare_runs input', item: 'runIdA', replacement: 'baselineRunId', removeIn: '0.13.0' },
  { surface: 'mcp', where: 'compare_runs input', item: 'runIdB', replacement: 'candidateRunId', removeIn: '0.13.0' },
  { surface: 'mcp', where: 'compare_runs result', item: 'runIdA', replacement: 'baselineRunId', removeIn: '0.13.0' },
  { surface: 'mcp', where: 'compare_runs result', item: 'runIdB', replacement: 'candidateRunId', removeIn: '0.13.0' },
  { surface: 'cli', where: 'usage', item: '--legacy-json', replacement: 'the { schemaVersion, run, comparison, budgets } JSON the CLI writes by default', removeIn: '0.13.0' },
  { surface: 'mcp', where: 'evaluate_budgets result', item: 'runId', replacement: 'baselineRunId and candidateRunId', removeIn: '0.13.0' },
];

/** The sentence a tool description or help text gives for one deprecated item. */
export function deprecationNote(where: string, item: string): string {
  const entry = DEPRECATIONS.find((d) => d.where === where && d.item === item);
  if (!entry) throw new Error(`No deprecation for ${item} in ${where}.`);
  return `Deprecated: use ${entry.replacement}. Removed in ${entry.removeIn}.`;
}

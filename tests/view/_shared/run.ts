import { interpretRun } from '@sparkforensics/core/run-interpretation.ts';
import type { AnalyzedRun } from '@sparkforensics/core/analyzed-run.ts';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { emptyAppModel } from '@/store/store';

export interface RunParts {
  appModel?: AppModel;
  catalog?: Finding[];
  configFindings?: Finding[];
  taskData?: AnalyzedRun['taskData'];
}

let findingSequence = 0;

/** A run built from hand-made parts, the way `analyzeRun` would build it from a parse: the
 * interpretation is computed, and a finding with no id gets one (in place, so a test keeps holding
 * the finding it passed; ids come from one counter, so a fixture shared by several runs never
 * collides with another run's finding). Task data defaults to a worker that has none, so widgets offer the fetch. */
export function makeRun({ appModel = emptyAppModel(), catalog = [], configFindings = [], taskData }: RunParts = {}): AnalyzedRun {
  [...catalog, ...configFindings].forEach((finding) => { finding.id ??= `test-finding-${++findingSequence}`; });
  return {
    appModel,
    catalog,
    configFindings,
    interpretation: interpretRun(appModel, catalog, configFindings),
    taskData: taskData ?? { kind: 'worker', request: () => Promise.reject(new Error('This test has no worker.')) },
  };
}

/** The store state that installs `makeRun(parts)`: spread it into `store.setState({ status: 'ready', ...runState(parts) })`. */
export function runState(parts: RunParts = {}, runKey = 'test-run'): { run: AnalyzedRun; runKey: string } {
  return { run: makeRun(parts), runKey };
}

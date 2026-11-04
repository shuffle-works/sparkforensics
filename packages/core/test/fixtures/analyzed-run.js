// The analyzed run of a log file or of a hand-built model, built the way every surface builds it.
import { analyzeRun } from '../../src/analyzed-run.ts';
import { collectRun } from '../../src/cli/collect-run.ts';
import { emptyAppModel } from '../../src/run-serialization.ts';

/**
 * @overload
 * @param {string} pathOrModel
 * @param {import('../../src/analyzed-run.ts').AnalyzeRunOptions} [options]
 * @returns {Promise<import('../../src/analyzed-run.ts').AnalyzedRun>}
 */
/**
 * @overload
 * @param {Partial<import('../../src/types.ts').AppModel>} pathOrModel
 * @param {import('../../src/analyzed-run.ts').AnalyzeRunOptions} [options]
 * @returns {import('../../src/analyzed-run.ts').AnalyzedRun}
 */
/**
 * A path parses the log and resolves to its run. A model holding only the parts a test needs (such as
 * `{ app, stages, sql }`) returns the run at once, the other parts empty. `options` go to `analyzeRun`.
 * @param {string | Partial<import('../../src/types.ts').AppModel>} pathOrModel
 * @param {import('../../src/analyzed-run.ts').AnalyzeRunOptions} [options]
 */
export function analyzedRunFrom(pathOrModel, options) {
  if (typeof pathOrModel === 'string') {
    return collectRun(pathOrModel).then(({ appModel }) => analyzeRun(appModel, options));
  }
  return analyzeRun({ ...emptyAppModel(), ...pathOrModel }, options);
}

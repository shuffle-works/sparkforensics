import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadExportPayload } from '@/export/hydrate-store';

const devDir = join(import.meta.dirname, '..', '..', '..', 'dev');

/** Every finding type's example: the public log it comes from and the example finding's id. */
export const examples: Record<string, { source: string; log: string; finding: { id: string; type: string } } | null> =
  JSON.parse(readFileSync(join(devDir, 'detector-examples.json'), 'utf8'));
const runs: Record<string, string> = JSON.parse(readFileSync(join(devDir, 'detector-example-runs.json'), 'utf8'));

/** The logs the detector examples come from, as the keys of `detector-example-runs.json`. */
export function exampleRuns(): string[] {
  return [...new Set(Object.values(examples).flatMap((example) => (example ? [`${example.source}/${example.log}`] : [])))].sort();
}

/** Puts the HTML export's run of `log` in the store, as an exported dashboard has it. Null on success,
 * else why the payload cannot load. */
export function loadExampleRun(log: string): string | null {
  return loadExportPayload(runs[log]);
}

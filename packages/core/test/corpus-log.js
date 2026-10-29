import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORPUS_LOGS = fileURLToPath(new URL('../../../dev/log-corpus/logs', import.meta.url));

/** The absolute path of a log or directory in the public corpus (`dev/log-corpus/logs`), or null
 * when it is missing, so a gated test can skip locally. In CI the corpus submodule is always
 * checked out, so a missing path throws and fails the suite instead of skipping its tests. */
export function corpusLog(relativePath) {
  const path = join(CORPUS_LOGS, relativePath);
  if (existsSync(path)) return path;
  if (process.env.CI) throw new Error(`The corpus path ${relativePath} is missing in CI: check out the dev/log-corpus submodule.`);
  return null;
}

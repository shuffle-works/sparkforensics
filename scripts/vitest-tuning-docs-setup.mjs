// vitest globalSetup for the root and packages/core configs: generates the
// gitignored tuning reference (packages/core/src/docs-content/{chapters,tuning,
// diagrams}) from its pin before any test reads it. Idempotent, so it costs no
// network once the cache matches the pin. Outside CI a stale cache is kept (with
// a warning) when the fetch fails, so an offline run still works.
import { DieError, ensureTuningDocs } from './fetch-tuning-docs.mjs';

export default function setup() {
  try {
    ensureTuningDocs({ allowStale: true });
  } catch (err) {
    if (!(err instanceof DieError)) throw err;
    throw new Error(`fetch-tuning-docs: ${err.message}`, { cause: err });
  }
}

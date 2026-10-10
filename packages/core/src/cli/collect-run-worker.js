// Worker-thread entry of collect-run-pair.ts: parses one log and posts the finished model back.
// Plain JS, like the other worker entries, so a published install (which ships pre-stripped .js)
// and the monorepo (which runs the .ts directly) load it the same way.
import { parentPort, workerData } from 'node:worker_threads';
import { collectRun } from './collect-run.ts';

let run;
try {
  run = await collectRun(workerData.path);
} catch (e) {
  // A log that cannot be parsed fails the same way in the parent, so it is reported, not retried.
  parentPort.postMessage({ failed: { message: e?.message ?? String(e), code: e?.code } });
}
// A model the thread cannot clone, or a worker that dies, reaches the parent as a worker error,
// which parses the log in the parent's own thread instead.
if (run) parentPort.postMessage({ run });

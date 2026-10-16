import type { SparkAppInfo } from './types.ts';

/** Which Spark application a report describes: its id and attempt id, null where the log has none
 * (an attempt id is written only by a cluster-mode run). */
export interface RunAppIdentity {
  id: string | null;
  attemptId: string | null;
}

export function runAppIdentity(app: SparkAppInfo | null | undefined): RunAppIdentity {
  return { id: app?.id ?? null, attemptId: typeof app?.attemptId === 'string' ? app.attemptId : null };
}

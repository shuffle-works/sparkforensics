import { walkPlanTree } from '../plan-tree-walk.ts';
import { diagnoseJoinSkew, isSkewJoinNode } from '../aqe-skew.ts';
import { codeFix, decreaseConf, setConf } from '../remediation.ts';
import type { AqeSkewCase, Remediation, SkewOrigin } from '../finding-types.ts';
import { effectiveConf, loggedAs, stageApp } from './conf.ts';
import { setConfUnlessLogged, switchFix } from './fixes.ts';
import type { TailVerdict } from './tail.ts';
import type { DetectorApp, DetectorCtx, DetectorStage } from './types.ts';

const SKEW_KEY_REMEDY = 'salt the key or repartition on a better key';
// A single key (often NULL or a constant) holds the shuffle: partition count and AQE cannot split it.
export const SINGLE_KEY_REMEDY = 'broadcast the small side with a hint, filter or split out the NULL rows, or give the NULL rows a random key';
export const SINGLE_KEY_CAUSE = `almost all rows share one key (often NULL or a constant), so more partitions will not help: ${SINGLE_KEY_REMEDY}`;

// Whether the run's Spark predates 3.0, which has no AQE skew-join handling to suggest.
function predatesAqeSkewJoin(app: DetectorApp | null): boolean {
  const major = /^(\d+)\./.exec(app?.sparkVersion ?? '');
  return major != null && Number(major[1]) < 3;
}

// What a skewed stage reads, which decides whether AQE skew-join handling can act on it. It splits
// skewed partitions on the shuffle-read side of a sort-merge or shuffled-hash join, so only a stage
// that reads a shuffle, in a SQL execution whose plan has such a join, is 'shuffleJoin'. A plan does
// not say which stage runs which join, so the join is matched per execution. 'inputScan' reads mostly files (its tasks differ in input size);
// 'other' is any stage the plan cannot tie to a join (an aggregation's shuffle, no plan, no input),
// and any stage of a run on Spark before 3.0 (skewFix).
function skewOrigin(stage: DetectorStage, ctx: DetectorCtx, shuffleEvidence: boolean): 'shuffleJoin' | 'inputScan' | 'other' {
  if (shuffleEvidence || (stage.shuffleReadBytes > 0 && stage.shuffleReadBytes >= stage.inputBytes)) {
    let hasJoin = false;
    const plan = stage.sqlExecutionId != null ? ctx.sql.get(stage.sqlExecutionId)?.planTree : null;
    walkPlanTree(plan, (node) => { if (isSkewJoinNode(node.name)) hasJoin = true; });
    return hasJoin ? 'shuffleJoin' : 'other';
  }
  return stage.inputBytes > 0 ? 'inputScan' : 'other';
}

// The skew finding's fix for the stage's origin. Join-driven skew gets AQE skew-join handling,
// unless the run's effective conf already has it; uneven input gets the file-size remedy.
export function skewFix(stage: DetectorStage, ctx: DetectorCtx, shuffleEvidence = false, tail?: TailVerdict): { origin: SkewOrigin; aqeSkew?: AqeSkewCase; text: string; remediation: Remediation[] } {
  const origin = skewOrigin(stage, ctx, shuffleEvidence);
  if (origin === 'inputScan') {
    return {
      origin,
      text: 'the stage reads uneven input files: compact small files or split large ones (lower spark.sql.files.maxPartitionBytes)',
      remediation: [decreaseConf('spark.sql.files.maxPartitionBytes')],
    };
  }
  if (origin === 'other') return { origin, text: SKEW_KEY_REMEDY, remediation: [codeFix(SKEW_KEY_REMEDY)] };
  // Before Spark 3.0 there is no AQE skew-join handling, so the stage gets the generic advice.
  if (predatesAqeSkewJoin(ctx.app)) return { origin: 'other', text: SKEW_KEY_REMEDY, remediation: [codeFix(SKEW_KEY_REMEDY)] };
  const app = stageApp(ctx, stage);
  const fix = skewJoinFix(app);
  // A tail the data volume explains (input plus shuffle read, in bytes or records) is data the
  // diagnosis must not call even or cured from shuffle-read bytes alone.
  const tailData = tail?.cause === 'data' ? { ratio: tail.attribution?.dataRatio ?? null } : undefined;
  // With skew-join handling on, the final plan and conf say why it did or did not act on this stage.
  const handlingOn = !loggedAs(app, 'spark.sql.adaptive.enabled', false) && loggedAs(app, 'spark.sql.adaptive.skewJoin.enabled', true);
  const diagnosis = handlingOn && stage.sqlExecutionId != null
    ? diagnoseJoinSkew({
      plan: ctx.sql.get(stage.sqlExecutionId)?.planTree, stageId: stage.id,
      readMax: stage.shuffleReadMax, readP50: stage.shuffleReadP50, stageShuffleReadBytes: stage.shuffleReadBytes,
      ...(tailData ? { tailData } : {}),
      conf: (key) => effectiveConf(app, key), sparkVersion: app?.sparkVersion, keyRemedy: SKEW_KEY_REMEDY,
    })
    : null;
  return diagnosis == null ? { origin, ...fix } : { origin, aqeSkew: diagnosis.case, text: diagnosis.text, remediation: diagnosis.remediation };
}

function skewJoinFix(app: DetectorApp | null): { text: string; remediation: Remediation[] } {
  const key = 'spark.sql.adaptive.skewJoin.enabled';
  if (loggedAs(app, 'spark.sql.adaptive.enabled', false)) {
    return {
      text: `AQE is off, so enable it (spark.sql.adaptive.enabled) for skew-join handling to apply; otherwise ${SKEW_KEY_REMEDY}`,
      remediation: [setConf('spark.sql.adaptive.enabled', true), ...setConfUnlessLogged(app, key, true)],
    };
  }
  const fix = switchFix(loggedAs(app, key, true), key, true,
    `for join-driven skew, enable AQE skew-join handling (${key}); otherwise ${SKEW_KEY_REMEDY}`,
    `AQE skew-join handling is already on, so ${SKEW_KEY_REMEDY}`);
  // With the switch already on, only the key is left to fix: a change to the job, not a property.
  return fix.remediation.length === 0 ? { ...fix, remediation: [codeFix(SKEW_KEY_REMEDY)] } : fix;
}

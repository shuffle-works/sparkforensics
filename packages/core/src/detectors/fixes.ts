import { decreaseConf, setConf } from '../remediation.ts';
import type { Remediation } from '../finding-types.ts';
import { effectiveConf, loggedAs } from './conf.ts';
import type { DetectorApp } from './types.ts';

export function setConfUnlessLogged(app: DetectorApp | null, key: string, suggested: string | boolean): Remediation[] {
  return loggedAs(app, key, suggested) ? [] : [setConf(key, suggested)];
}

// A switch's fix worded for the run's logged conf: `recommend` names the property while the run
// doesn't have it, `alreadyOn` points at the remedy left once it does, with no remediation.
export function switchFix(on: boolean, key: string, suggested: string | boolean, recommend: string, alreadyOn: string): { text: string; remediation: Remediation[] } {
  return on ? { text: alreadyOn, remediation: [] } : { text: recommend, remediation: [setConf(key, suggested)] };
}

// The resources flag is read from the same property as the logged conf.
function dynamicAllocationFix(app: DetectorApp, recommend: string, alreadyOn: string): { text: string; remediation: Remediation[] } {
  const key = 'spark.dynamicAllocation.enabled';
  return switchFix(app.resources?.dynamicAllocationEnabled === true || loggedAs(app, key, true), key, true, recommend, alreadyOn);
}

// Idle capacity is cured by a smaller cluster, which the run's dynamic allocation decides how to
// size. With it on: the cap on how many executors it scales to, and the floor it holds when that
// is logged above 0 (both lowered together). With it off or unset: the alternatives of a fixed
// executor count or switching it on, which dynamicAllocationFix already names, so the
// recommendation reads "either ... or" and a consumer applies one entry. Not executorIdleTimeout:
// autoscalingChurn recommends raising it, so lowering it here would contradict that finding.
export function idleCapacityFix(app: DetectorApp, recommend: string, alreadyOnLead: string): { text: string; remediation: Remediation[] } {
  const fix = dynamicAllocationFix(app, recommend, alreadyOnLead);
  // dynamicAllocationFix's remediation is empty exactly when dynamic allocation is already on.
  if (fix.remediation.length > 0) return { ...fix, remediation: [...fix.remediation, decreaseConf('spark.executor.instances')] };
  const holdsFloor = Number.parseInt(effectiveConf(app, 'spark.dynamicAllocation.minExecutors') ?? '', 10) > 0;
  return holdsFloor
    ? { text: `${alreadyOnLead} by lowering spark.dynamicAllocation.maxExecutors and spark.dynamicAllocation.minExecutors`,
        remediation: [decreaseConf('spark.dynamicAllocation.maxExecutors'), decreaseConf('spark.dynamicAllocation.minExecutors')] }
    : { text: `${alreadyOnLead} by lowering spark.dynamicAllocation.maxExecutors`, remediation: [decreaseConf('spark.dynamicAllocation.maxExecutors')] };
}

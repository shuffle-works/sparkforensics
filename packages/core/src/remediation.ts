// Constructors for the structured `remediation` a detector attaches next to its prose
// `recommendation`: only where the detector already names the Spark property, never an invented one.
import type { Remediation } from './finding-types.ts';

type Suggested = Remediation['suggested'];

/** The property should be raised; `suggested` is the value when the detector computed one. */
export function increaseConf(key: string, suggested: Suggested = null): Remediation {
  return { kind: 'conf', key, direction: 'increase', suggested };
}

/** The property should be lowered; `suggested` is the value when the detector computed one. */
export function decreaseConf(key: string, suggested: Suggested = null): Remediation {
  return { kind: 'conf', key, direction: 'decrease', suggested };
}

/** The property should take a specific value (a switch or a class name), not move up or down. */
export function setConf(key: string, suggested: Suggested = null): Remediation {
  return { kind: 'conf', key, direction: 'set', suggested };
}

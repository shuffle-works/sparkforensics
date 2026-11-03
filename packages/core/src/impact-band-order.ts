import type { ImpactBand } from './types.ts';

export const IMPACT_BAND_ORDER: Record<'critical' | 'warning' | 'info', number> = { critical: 0, warning: 1, info: 2 };
export const IMPACT_BANDS = Object.keys(IMPACT_BAND_ORDER) as ImpactBand[];

/** Worst (lowest IMPACT_BAND_ORDER) impact band across findings, undefined when empty. Shared by
 * every widget that badges/colors a group of findings. */
export function worstImpactBand(
  findings: { impactBand: 'critical' | 'warning' | 'info' }[],
): 'critical' | 'warning' | 'info' | undefined {
  let worst;
  for (const f of findings) {
    if (worst === undefined || IMPACT_BAND_ORDER[f.impactBand] < IMPACT_BAND_ORDER[worst]) worst = f.impactBand;
  }
  return worst;
}

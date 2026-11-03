import type { ImpactBand } from './types.ts';

export const IMPACT_BAND_ORDER: Record<'critical' | 'warning' | 'info', number> = { critical: 0, warning: 1, info: 2 };
/** The impact bands, most severe first: the one list every surface reads. */
export const IMPACT_BANDS = Object.keys(IMPACT_BAND_ORDER) as ImpactBand[];

/** A band's severity rank, 0 for the worst. A band outside the list (a comparison row's `unknown`,
 * an unflagged entry) ranks least severe. */
export function bandRank(band: string | null | undefined): number {
  return (band ? IMPACT_BAND_ORDER[band as ImpactBand] : undefined) ?? IMPACT_BANDS.length;
}

/** Orders bands most severe first. */
export function compareImpactBand(a: string | null | undefined, b: string | null | undefined): number {
  return bandRank(a) - bandRank(b);
}

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

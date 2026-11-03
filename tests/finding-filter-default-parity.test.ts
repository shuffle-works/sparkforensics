import { describe, expect, it } from 'vitest';
import { toFindingsFilter } from '@sparkforensics/core/analysis';
import { countHiddenNotes, DEFAULT_MIN_BAND, IMPACT_BAND_ORDER, IMPACT_BANDS } from '@sparkforensics/core/view-model';
import type { Finding } from '@sparkforensics/core/types';
import { emptySelection, filterFindings } from '@/view/finding-filter';

const ofBand = (impactBand: Finding['impactBand']) => ({ type: 'gc', stageId: 1, impactBand }) as Finding;

describe('default info-note hiding', () => {
  it('lists the same bands on the dashboard as the CLI and MCP default', () => {
    const { minBand } = toFindingsFilter();
    expect(minBand).toBe(DEFAULT_MIN_BAND);
    const listed = filterFindings(IMPACT_BANDS.map(ofBand), emptySelection()).map((finding) => finding.impactBand);
    expect(listed).toEqual(IMPACT_BANDS.filter((band) => IMPACT_BAND_ORDER[band] <= IMPACT_BAND_ORDER[minBand!]));
  });

  it('counts the info notes the default leaves out', () => {
    const rows = [ofBand('critical'), ofBand('info'), ofBand('info')];
    const selection = emptySelection();
    expect(countHiddenNotes(rows, (row) => filterFindings([row], selection).length > 0)).toBe(2);
  });
});
